import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sourceImportLimits as limits } from "@codelab/contracts/source";
import { importSourceZip } from "./source-zip.js";
import { createSourceSpool } from "./source-spool.js";

/** Unique private spool; removed on success, rejection, timeout and disconnected upload. */
export async function receiveSourceZip(
  stream: Readable & { truncated?: boolean },
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    temporaryRoot?: string;
  } = {},
) {
  const directory = await createSourceSpool(options.temporaryRoot);
  const file = join(directory, "upload.zip");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    await pipeline(
      stream,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? limits.zipBytes)) {
            callback(
              Object.assign(new Error("ZIP 最大为 100 MB"), {
                statusCode: 413,
              }),
            );
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
      {
        signal: AbortSignal.timeout(
          options.timeoutMs ?? limits.uploadTimeoutMs,
        ),
      },
    );
    if (stream.truncated)
      throw Object.assign(new Error("ZIP 最大为 100 MB"), { statusCode: 413 });
    try {
      return await importSourceZip({ path: file, sha256: hash.digest("hex") });
    } catch (error) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : "ZIP 无效"),
        { statusCode: 400 },
      );
    }
  } catch (error) {
    if ((error as Error).name === "AbortError")
      throw Object.assign(new Error("上传超过 2 分钟，请检查连接后重试"), {
        statusCode: 408,
      });
    throw error;
  } finally {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(directory);
  }
}
