import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reapSourceSpools,
  sourceSpoolPrefix,
} from "../apps/api/src/source-spool.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});
const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(unlink).mockReset().mockImplementation(actual.unlink);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const deadPid = 2147483647;
  expect(() => process.kill(deadPid, 0)).toThrow(
    expect.objectContaining({ code: "ESRCH" }),
  );
  const root = await mkdtemp(join(tmpdir(), "codelab-spool-errors-"));
  roots.push(root);
  const directory = join(root, `${sourceSpoolPrefix}${deadPid}-ABC123`);
  await mkdir(directory);
  const file = join(directory, "upload.zip");
  await writeFile(file, "private partial upload");
  return { root, directory, file };
}
it("accepts EPERM only after confirming a competing sweeper removed the directory", async () => {
  const { root, directory, file } = await fixture();
  vi.mocked(unlink).mockImplementationOnce(async (path) => {
    expect(path).toBe(file);
    await actual.unlink(path);
    await rmdir(directory);
    throw Object.assign(new Error("simulated delete-pending race"), {
      code: "EPERM",
    });
  });
  expect(await reapSourceSpools(root)).toEqual({
    removed: 0,
    active: 0,
    preserved: 0,
    failed: 0,
  });
});
it("retains persistent permission failures and does not retry deletion", async () => {
  const { root, file } = await fixture();
  vi.mocked(unlink).mockRejectedValueOnce(
    Object.assign(new Error("denied"), { code: "EPERM" }),
  );
  expect(await reapSourceSpools(root)).toEqual({
    removed: 0,
    active: 0,
    preserved: 0,
    failed: 1,
  });
  expect(unlink).toHaveBeenCalledTimes(1);
  expect(await readFile(file, "utf8")).toBe("private partial upload");
});
it("does not suppress unrelated disk failures even if another sweeper removes the directory", async () => {
  const { root, directory } = await fixture();
  vi.mocked(unlink).mockImplementationOnce(async (path) => {
    await actual.unlink(path);
    await rmdir(directory);
    throw Object.assign(new Error("disk error"), { code: "EIO" });
  });
  expect(await reapSourceSpools(root)).toEqual({
    removed: 0,
    active: 0,
    preserved: 0,
    failed: 1,
  });
});
