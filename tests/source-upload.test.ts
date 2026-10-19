import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import { zipSync, strToU8 } from "fflate";
import { receiveSourceZip } from "../apps/api/src/source-upload";
import { importSourceZip } from "../apps/api/src/source-zip";
import { sourceImportLimits as limits } from "../packages/contracts/src/source";

let temporaryRoot: string;
beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "codelab-upload-test-"));
});
afterEach(async () => {
  expect(await readdir(temporaryRoot)).toEqual([]);
  await rmdir(temporaryRoot);
});

it("streams an ordinary ZIP above the old 10MB limit, preserves its hash and skips binary assets", async () => {
  const archive = Buffer.from(
    zipSync(
      {
        "museum/main.ts": strToU8("export const museum = true;"),
        "museum/exhibit.glb": new Uint8Array(11 * 1024 * 1024),
      },
      { level: 0 },
    ),
  );
  expect(archive.length).toBeGreaterThan(10 * 1024 * 1024);
  async function* chunks() {
    for (let offset = 0; offset < archive.length; offset += 64 * 1024)
      yield archive.subarray(offset, offset + 64 * 1024);
  }
  const result = await receiveSourceZip(Readable.from(chunks()), {
    temporaryRoot,
  });
  expect(result.sha256).toBe(
    createHash("sha256").update(archive).digest("hex"),
  );
  expect(result.files).toEqual({
    "museum/main.ts": "export const museum = true;",
  });
  expect(result.omitted).toEqual([
    { path: "museum/exhibit.glb", reason: "非源码文件" },
  ]);
});

it("enforces the exact 100MB transfer boundary without buffering the full body", async () => {
  async function* chunks(extra: boolean) {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 100; i++) yield chunk;
    if (extra) yield Buffer.from([0]);
  }
  // Exactly at the limit reaches ZIP validation; one byte above fails at transport.
  await expect(
    receiveSourceZip(Readable.from(chunks(false)), { temporaryRoot }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    receiveSourceZip(Readable.from(chunks(true)), { temporaryRoot }),
  ).rejects.toMatchObject({ statusCode: 413 });
});

it("cleans partial spool files after timeout, disconnect, truncated body and malformed ZIP", async () => {
  const waiting = new PassThrough();
  waiting.write("partial ZIP");
  await expect(
    receiveSourceZip(waiting, { temporaryRoot, timeoutMs: 25 }),
  ).rejects.toMatchObject({ statusCode: 408 });
  const disconnected = Readable.from(
    (async function* () {
      yield Buffer.from("partial");
      throw new Error("disconnected");
    })(),
  );
  await expect(
    receiveSourceZip(disconnected, { temporaryRoot }),
  ).rejects.toThrow("disconnected");
  const truncated = Object.assign(Readable.from([Buffer.from("partial")]), {
    truncated: true,
  });
  await expect(
    receiveSourceZip(truncated, { temporaryRoot }),
  ).rejects.toMatchObject({ statusCode: 413 });
  await expect(
    receiveSourceZip(Readable.from([Buffer.from("bad")]), { temporaryRoot }),
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("imports over 4MB of source and discloses per-file and aggregate source omissions", async () => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < 33; i++)
    files[`src/module-${i}.ts`] = new Uint8Array(limits.fileBytes).fill(97);
  files["src/large.ts"] = new Uint8Array(limits.fileBytes + 1).fill(97);
  const result = await importSourceZip(Buffer.from(zipSync(files)));
  expect(Object.keys(result.files)).toHaveLength(32);
  expect(result.omitted).toEqual([
    { path: "src/module-32.ts", reason: "源码总量超过 16 MB" },
    { path: "src/large.ts", reason: "单文件超过 512 KB" },
  ]);
});

it("still rejects unsafe paths and expansion bombs in disk-backed ZIP imports", async () => {
  for (const filename of ["../evil.ts", "/evil.ts"]) {
    const archive = Buffer.from(zipSync({ [filename]: strToU8("evil") }));
    await expect(
      receiveSourceZip(Readable.from([archive]), { temporaryRoot }),
    ).rejects.toMatchObject({ statusCode: 400 });
  }
  const archive = Buffer.from(zipSync({ "huge.png": strToU8("x") }));
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt32LE(limits.expandedBytes + 1, central + 24);
  await expect(
    receiveSourceZip(Readable.from([archive]), { temporaryRoot }),
  ).rejects.toThrow("500 MB");
});
