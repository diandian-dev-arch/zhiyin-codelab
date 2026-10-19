import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  symlink,
  readdir,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "../apps/api/src/artifacts-v2.js";
import {
  createArtifactManifest,
  encodeBase64,
  sha256,
  type Evidence,
} from "../packages/contracts/src/v2/index.js";
const storageFailure = vi.hoisted(() => ({ phase: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    unlink: async (...args:Parameters<typeof fs.unlink>) => {
      if(storageFailure.phase==='unlink')throw Object.assign(new Error('injected unlink EACCES'),{code:'EACCES'});
      await fs.unlink(...args);
      if(storageFailure.phase==='unlink_after')throw new Error('injected failure after unlink');
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[1] === "wx" && storageFailure.phase) {
        const phase = storageFailure.phase;
        if (phase === "write")
          handle.writeFile = async () => {
            throw Object.assign(new Error("injected ENOSPC"), {
              code: "ENOSPC",
            });
          };
        if (phase === "sync")
          handle.sync = async () => {
            throw Object.assign(new Error("injected EIO"), { code: "EIO" });
          };
        if (phase === "close") {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            throw new Error("injected close failure");
          };
        }
      }
      return handle;
    },
  };
});
let directory: string, store: ArtifactStore;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "codelab-evidence-test-"));
  store = new ArtifactStore({ root: path.join(directory, "objects") });
});
afterEach(async () => {
  storageFailure.phase = "";
  if (
    directory &&
    path.dirname(directory) === tmpdir() &&
    path.basename(directory).startsWith("codelab-evidence-test-")
  )
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const runId = randomUUID(),
    manifestId = randomUUID(),
    evidenceId = randomUUID(),
    hash = "1".repeat(64);
  const context = {
    runId,
    executionAttemptId: randomUUID(),
    submissionId: randomUUID(),
    originalZipSha256: hash,
    sourceManifestSha256: hash,
    ruleId: randomUUID(),
    ruleHash: hash,
    packManifestHash: hash,
    templateHash: hash,
  };
  const bytes = new TextEncoder().encode("合成存储测试字节\n");
  const evidence: Evidence = {
    evidenceId,
    manifestId,
    runId,
    submissionId: context.submissionId,
    originalZipSha256: hash,
    sourceManifestSha256: hash,
    executionAttemptId: context.executionAttemptId,
    analysisAttemptId: null,
    operationId: null,
    scope: "run",
    criterionId: null,
    caseId: null,
    phase: "diagnostic",
    collector: "runner",
    contentOrigin: "platform_diagnostic",
    ruleHash: hash,
    packManifestHash: hash,
    sha256: await sha256(bytes),
    byteSize: bytes.length,
    mediaType: "text/plain; charset=utf-8",
    storageKey: `runs/${runId}/${manifestId}/${evidenceId}.txt`,
    capturedAt: new Date().toISOString(),
  };
  return {
    bytes,
    evidence,
    manifest: await createArtifactManifest({
      manifestId,
      context,
      source: "base",
      analysisAttemptId: null,
      operationId: null,
      evidence: [evidence],
      completeness: "partial",
    }),
    payloads: [
      { evidenceId, encoding: "base64" as const, data: encodeBase64(bytes) },
    ],
  };
}
it("stores exact bytes, supports concurrent identical writes, and verifies content before reading", async () => {
  const f = await fixture();
  await Promise.all([
    store.storeManifest(f.manifest, f.payloads),
    store.storeManifest(f.manifest, f.payloads),
  ]);
  expect(await store.readEvidence(f.evidence)).toEqual(f.bytes);
  await writeFile(path.join(store.root, f.evidence.storageKey), "corrupted");
  await expect(store.readEvidence(f.evidence)).rejects.toThrow(
    "ARTIFACT_STORAGE_MISMATCH",
  );
  await expect(store.storeManifest(f.manifest, f.payloads)).rejects.toThrow(
    "ARTIFACT_STORAGE_MISMATCH",
  );
  expect(
    (await readFile(path.join(store.root, f.evidence.storageKey))).toString(),
  ).toBe("corrupted");
});
it('removes only an exact evidence object and replays after the file was already removed',async()=>{
  const f=await fixture(),other=await fixture();
  await store.storeManifest(f.manifest,f.payloads);
  await store.storeManifest(other.manifest,other.payloads);
  expect(await store.removeVerifiedEvidence(f.evidence)).toBe('removed');
  // Simulates unlink committed but the caller did not persist its receipt.
  expect(await store.removeVerifiedEvidence(f.evidence)).toBe('already_missing');
  expect(await store.readEvidence(other.evidence)).toEqual(other.bytes);
  expect(await readdir(path.dirname(path.join(store.root,f.evidence.storageKey)))).toEqual([]);
});
it('preserves corrupt and aliased evidence instead of treating it as removable',async()=>{
  const f=await fixture();await store.storeManifest(f.manifest,f.payloads);
  const file=path.join(store.root,f.evidence.storageKey),alias=path.join(directory,'alias.txt');
  await link(file,alias);
  await expect(store.removeVerifiedEvidence(f.evidence)).rejects.toThrow('UNSAFE_ARTIFACT_REMOVAL');
  expect(await readFile(file)).toEqual(Buffer.from(f.bytes));
  const other=await fixture();await store.storeManifest(other.manifest,other.payloads);
  const corrupt=path.join(store.root,other.evidence.storageKey);
  await writeFile(corrupt,'corruption retained');
  await expect(store.removeVerifiedEvidence(other.evidence)).rejects.toThrow('ARTIFACT_STORAGE_MISMATCH');
  expect(await readFile(corrupt,'utf8')).toBe('corruption retained');
  await expect(store.removeVerifiedEvidence({...other.evidence,storageKey:'../alias.txt'})).rejects.toThrow();
});
it('retries a failed unlink without losing the file and rejects a missing storage root',async()=>{
  const f=await fixture();
  await expect(store.removeVerifiedEvidence(f.evidence)).rejects.toThrow();
  await store.storeManifest(f.manifest,f.payloads);storageFailure.phase='unlink';
  await expect(store.removeVerifiedEvidence(f.evidence)).rejects.toThrow('injected unlink EACCES');
  expect(await store.readEvidence(f.evidence)).toEqual(f.bytes);
  storageFailure.phase='';expect(await store.removeVerifiedEvidence(f.evidence)).toBe('removed');
});
it('resumes after unlink succeeds but the cleanup call fails before acknowledgment',async()=>{
  const f=await fixture();await store.storeManifest(f.manifest,f.payloads);
  storageFailure.phase='unlink_after';
  await expect(store.removeVerifiedEvidence(f.evidence)).rejects.toThrow('injected failure after unlink');
  storageFailure.phase='';
  expect(await store.removeVerifiedEvidence(f.evidence)).toBe('already_missing');
});
it("rejects bad hashes and identity aliases before admitting payloads", async () => {
  const f = await fixture();
  await expect(
    store.storeManifest(f.manifest, [
      {
        ...f.payloads[0],
        data: encodeBase64(new TextEncoder().encode("other")),
      },
    ]),
  ).rejects.toThrow();
  await expect(
    store.verifyEvidence("../outside", f.evidence.sha256, f.bytes.length),
  ).rejects.toThrow("INVALID_ARTIFACT_KEY");
  await expect(
    store.readEvidence({
      ...f.evidence,
      storageKey: `runs/${f.evidence.runId}/${randomUUID()}/${f.evidence.evidenceId}.txt`,
    }),
  ).rejects.toThrow("ARTIFACT_KEY_IDENTITY_MISMATCH");
});
it("rejects a junction or symlink in the controlled storage hierarchy", async () => {
  const f = await fixture();
  await mkdir(store.root);
  const external = path.join(directory, "outside");
  await mkdir(external);
  await symlink(
    external,
    path.join(store.root, "runs"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(store.storeManifest(f.manifest, f.payloads)).rejects.toThrow(
    "UNSAFE_ARTIFACT_DIRECTORY",
  );
});
it.each(["write", "sync", "close"])(
  "removes incomplete artifacts after a %s failure without publishing them",
  async (phase) => {
    const f = await fixture();
    storageFailure.phase = phase;
    await expect(store.storeManifest(f.manifest, f.payloads)).rejects.toThrow(
      "injected",
    );
    const contents = await readdir(
      path.dirname(path.join(store.root, f.evidence.storageKey)),
    );
    expect(contents).toEqual([]);
    storageFailure.phase = "";
    await store.storeManifest(f.manifest, f.payloads);
    expect(await store.readEvidence(f.evidence)).toEqual(f.bytes);
  },
);
