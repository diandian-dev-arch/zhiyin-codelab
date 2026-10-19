import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceSpoolPrefix, reapSourceSpools } from "../apps/api/src/source-spool.js";

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped;
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "codelab-spool-test-"));
  directories.push(base);
  const child = spawn(process.execPath, ["--import", "tsx", resolve("tests/fixtures/source-upload-process.ts"), base], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  const message = await Promise.race([
    once(child, "message").then(([value]) => value as { state: string; pid: number; directory: string }),
    once(child, "exit").then(() => { throw new Error("UPLOAD_CHILD_EARLY_EXIT"); }),
  ]);
  expect(message.state).toBe("uploading");
  expect(message.pid).toBe(child.pid);
  expect(message.directory).toMatch(new RegExp(`^${sourceSpoolPrefix}${child.pid}-[a-zA-Z0-9]{6}$`));
  return { base, child, directory: join(base, message.directory) };
}
async function kill(child: ChildProcess) {
  const stopped = once(child, "exit");
  expect(child.kill("SIGKILL")).toBe(true);
  await stopped;
}
it("retains a real live upload and reclaims its spool only after the owning process is killed", async () => {
  const { base, child, directory } = await fixture();
  const before = await readFile(join(directory, "upload.zip"));
  expect(before.length).toBe(65536);
  expect(await reapSourceSpools(base)).toEqual({ removed: 0, active: 1, preserved: 0, failed: 0 });
  expect(await readFile(join(directory, "upload.zip"))).toEqual(before);
  await kill(child);
  expect(await readdir(directory)).toEqual(["upload.zip"]);
  expect(await reapSourceSpools(base)).toEqual({ removed: 1, active: 0, preserved: 0, failed: 0 });
  expect(await readdir(base)).toEqual([]);
  expect((await reapSourceSpools(base)).removed).toBe(0);
}, 20000);

it("preserves legacy, unknown files, hardlinks and directory junctions; only removes owned empty dead spools", async () => {
  const { base, child, directory } = await fixture();
  await kill(child);
  await writeFile(join(directory, "diagnostic.txt"), "retain");
  const legacy = join(base, "codelab-source-ABC123");
  await mkdir(legacy);
  await writeFile(join(legacy, "upload.zip"), "legacy");
  const hard = await mkdtemp(join(base, `${sourceSpoolPrefix}${child.pid}-`));
  await link(join(legacy, "upload.zip"), join(hard, "upload.zip"));
  const junction = join(base, `${sourceSpoolPrefix}${child.pid}-LINK00`);
  await symlink(legacy, junction, "junction");
  const empty = await mkdtemp(join(base, `${sourceSpoolPrefix}${child.pid}-`));
  expect(await reapSourceSpools(base)).toEqual({ removed: 1, active: 0, preserved: 3, failed: 0 });
  expect(await readdir(base)).not.toContain(empty.slice(base.length + 1));
  expect(await readFile(join(directory, "diagnostic.txt"), "utf8")).toBe("retain");
  expect(await readFile(join(hard, "upload.zip"), "utf8")).toBe("legacy");
  expect(await readFile(join(junction, "upload.zip"), "utf8")).toBe("legacy");
}, 20000);

it("allows simultaneous sweepers to finish without touching other namespaces", async () => {
  const { base, child } = await fixture();
  await kill(child);
  const foreign = join(base, "codelab-source-v2-another-workspace-999-ABC123");
  await mkdir(foreign);
  await writeFile(join(foreign, "upload.zip"), "foreign");
  const results = await Promise.all([reapSourceSpools(base), reapSourceSpools(base)]);
  // Windows can report success to both removers while directory deletion is
  // pending. Per-sweep receipts are observations, not a global unique counter.
  expect(results.some(result => result.removed === 1)).toBe(true);
  expect(await readdir(base)).toEqual(["codelab-source-v2-another-workspace-999-ABC123"]);
  expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
  expect(await readFile(join(foreign, "upload.zip"), "utf8")).toBe("foreign");
}, 20000);
