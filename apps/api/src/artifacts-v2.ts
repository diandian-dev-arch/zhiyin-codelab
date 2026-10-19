import { mkdir, open, lstat, realpath, link, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  artifactManifestSchema,
  evidenceSchema,
  hashArtifactManifest,
  validateArtifactPayloads,
  decodeBase64,
  sha256,
  sha256Schema,
  LIMITS_V1,
  type ArtifactManifest,
  type ArtifactPayload,
  type Evidence,
} from "@codelab/contracts/v2";

/** Dedicated service-owned directory. Student containers never mount this durable store. */
export class ArtifactStore {
  readonly root: string;
  constructor(options: { root: string }) {
    this.root = path.resolve(options.root);
  }
  private async syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async location(key: string, create: boolean): Promise<string> {
    if (
      !/^runs\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|txt|json)$/.test(
        key,
      )
    )
      throw new Error("INVALID_ARTIFACT_KEY");
    if (create) {
      const firstCreated = await mkdir(this.root, {
        recursive: true,
        mode: 0o700,
      });
      if (firstCreated) {
        const stop = path.dirname(firstCreated);
        for (let directory = this.root; ; directory = path.dirname(directory)) {
          await this.syncDirectory(directory);
          if (directory === stop || path.dirname(directory) === directory)
            break;
        }
      }
    }
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("UNSAFE_ARTIFACT_ROOT");
    const canonicalRoot = await realpath(this.root);
    const parts = key.split("/");
    let directory = this.root;
    for (const segment of parts.slice(0, -1)) {
      directory = path.join(directory, segment);
      if (create)
        await mkdir(directory, { mode: 0o700 }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("UNSAFE_ARTIFACT_DIRECTORY");
      if (
        (await realpath(directory)) !==
        path.join(
          canonicalRoot,
          ...path.relative(this.root, directory).split(path.sep),
        )
      )
        throw new Error("UNSAFE_ARTIFACT_DIRECTORY");
      if (create) await this.syncDirectory(path.dirname(directory));
    }
    return path.join(directory, parts.at(-1)!);
  }
  private async read(
    key: string,
    digest: string,
    size: number,
  ): Promise<Uint8Array> {
    sha256Schema.parse(digest);
    if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS_V1.pngMaxBytes)
      throw new Error("ARTIFACT_SIZE_INVALID");
    const file = await this.location(key, false);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size)
      throw new Error("ARTIFACT_STORAGE_MISMATCH");
    const handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.size !== size)
        throw new Error("ARTIFACT_STORAGE_MISMATCH");
      const bytes = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const result = await handle.read(bytes, offset, size - offset, offset);
        if (!result.bytesRead) throw new Error("ARTIFACT_STORAGE_MISMATCH");
        offset += result.bytesRead;
      }
      if (
        (await handle.stat()).size !== size ||
        (await sha256(bytes)) !== digest
      )
        throw new Error("ARTIFACT_STORAGE_MISMATCH");
      return bytes;
    } finally {
      await handle.close();
    }
  }
  async verifyEvidence(
    storageKey: string,
    digest: string,
    byteSize: number,
  ): Promise<void> {
    await this.read(storageKey, digest, byteSize);
  }
  async readEvidence(value: Evidence): Promise<Uint8Array> {
    const evidence = evidenceSchema.parse(value);
    this.assertCanonicalKey(evidence);
    return this.read(evidence.storageKey, evidence.sha256, evidence.byteSize);
  }
  /** Internal file operation for a future durable cleanup worker, NOT deletion authorization.
   * Caller must have committed an exact cleanup intent, excluded all retained references,
   * and exclude writers to this run. Never call directly from an age/unreferenced-file scan.
   * Directories remain in place; a missing hierarchy is an error, not successful cleanup.
   */
  async removeVerifiedEvidence(value: Evidence): Promise<'removed' | 'already_missing'> {
    const evidence=evidenceSchema.parse(value);
    this.assertCanonicalKey(evidence);
    const file=await this.location(evidence.storageKey,false);
    let before;
    try { before=await lstat(file); }
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      // A prior unlink may have succeeded before a crash or failed directory sync.
      // Retry the sync even on an absent file before allowing a durable receipt.
      await this.syncDirectory(path.dirname(file));
      return 'already_missing';
    }
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)
      throw new Error('UNSAFE_ARTIFACT_REMOVAL');
    await this.read(evidence.storageKey,evidence.sha256,evidence.byteSize);
    const resolved=await this.location(evidence.storageKey,false);
    const after=await lstat(resolved);
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||
      before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||
      !after.isFile()||after.isSymbolicLink()||after.nlink!==1)
      throw new Error('ARTIFACT_CHANGED_DURING_REMOVAL');
    // No recursive deletion, no directory removal, no replacement of a corrupt object.
    await unlink(resolved);
    await this.syncDirectory(path.dirname(resolved));
    return 'removed';
  }
  private assertCanonicalKey(evidence: Evidence) {
    const extension =
      evidence.mediaType === "image/png"
        ? "png"
        : evidence.mediaType === "application/json"
          ? "json"
          : "txt";
    if (
      evidence.storageKey !==
      `runs/${evidence.runId}/${evidence.manifestId}/${evidence.evidenceId}.${extension}`
    )
      throw new Error("ARTIFACT_KEY_IDENTITY_MISMATCH");
  }
  async storeManifest(
    value: ArtifactManifest,
    payloads: ArtifactPayload[],
  ): Promise<void> {
    const manifest = artifactManifestSchema.parse(value);
    if ((await hashArtifactManifest(manifest)) !== manifest.contentHash)
      throw new Error("MANIFEST_HASH_MISMATCH");
    await validateArtifactPayloads(manifest, payloads);
    // Validate every identity before creating any files.
    for (const evidence of manifest.evidence) this.assertCanonicalKey(evidence);
    for (const evidence of manifest.evidence) {
      const bytes = decodeBase64(
        payloads.find((payload) => payload.evidenceId === evidence.evidenceId)!
          .data,
        LIMITS_V1.pngMaxBytes,
      );
      const target = await this.location(evidence.storageKey, true);
      const temporary = path.join(
        path.dirname(target),
        `.pending-${randomUUID()}`,
      );
      const handle = await open(temporary, "wx", 0o600);
      let failed = false;
      try {
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Hard-link publication is atomic and never overwrites a previous object.
        await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && !failed) throw error;
        });
      }
      await this.verifyEvidence(
        evidence.storageKey,
        evidence.sha256,
        evidence.byteSize,
      );
      await this.syncDirectory(path.dirname(target));
    }
  }
}
