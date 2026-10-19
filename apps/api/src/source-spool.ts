import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  opendir,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./template.js";

// Versioned, host + checkout scoped names. Legacy/unowned temporary files are
// deliberately not adopted. PID namespaces must not share this temp directory.
export const sourceSpoolPrefix = `codelab-source-v2-${createHash("sha256")
  .update(`${hostname()}\0${resolve(root)}`)
  .digest("hex")
  .slice(0, 24)}-`;

export function createSourceSpool(temporaryRoot = tmpdir()) {
  return mkdtemp(join(temporaryRoot, `${sourceSpoolPrefix}${process.pid}-`));
}

function ownerIsDead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM and unknown OS errors are not proof of death. PID reuse retains
    // files conservatively; age alone never permits deleting a live upload.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function alreadyReaped(directory: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return true;
  if (code !== "EPERM" && code !== "EBUSY") return false;
  // Windows can report EPERM on unlink while another sweeper's deletion is
  // pending. Do not retry deletion or swallow permissions errors: only an
  // observed missing directory confirms another sweeper finished the work.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await delay(25);
    try {
      await lstat(directory);
    } catch (checkError) {
      return (checkError as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return false;
}

export async function reapSourceSpools(temporaryRoot = tmpdir()) {
  const result = { removed: 0, active: 0, preserved: 0, failed: 0 };
  const base = await realpath(temporaryRoot);
  const entries = await opendir(base);
  for await (const entry of entries) {
    if (!entry.name.startsWith(sourceSpoolPrefix)) continue;
    const identity = /^(\d+)-[a-zA-Z0-9]{6}$/.exec(
      entry.name.slice(sourceSpoolPrefix.length),
    );
    const pid = Number(identity?.[1]);
    if (
      !identity ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      pid > 2147483647
    ) {
      result.preserved++;
      continue;
    }
    if (!ownerIsDead(pid)) {
      result.active++;
      continue;
    }
    const directory = join(base, entry.name);
    try {
      const before = await lstat(directory);
      if (
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        (await realpath(directory)) !== directory
      ) {
        result.preserved++;
        continue;
      }
      const children = await readdir(directory);
      if (children.some((name) => name !== "upload.zip")) {
        result.preserved++;
        continue;
      }
      const file = join(directory, "upload.zip");
      if (children.length) {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
          result.preserved++;
          continue;
        }
      }
      const current = await lstat(directory);
      if (
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        !ownerIsDead(pid)
      ) {
        result.preserved++;
        continue;
      }
      // Never recursive: unexpected files or concurrent changes prevent rmdir.
      if (children.length) await unlink(file);
      await rmdir(directory);
      result.removed++;
    } catch (error) {
      if (!(await alreadyReaped(directory, error))) result.failed++;
    }
  }
  return result;
}
