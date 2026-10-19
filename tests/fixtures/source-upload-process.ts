import { PassThrough } from "node:stream";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { receiveSourceZip } from "../../apps/api/src/source-upload.js";
import { sourceSpoolPrefix } from "../../apps/api/src/source-spool.js";

const temporaryRoot = process.argv[2];
if (!temporaryRoot || !process.send) throw new Error("TEST_IPC_AND_ROOT_REQUIRED");
// A PassThrough has no socket handle. Hold this fixture open like the real
// listening HTTP server until the parent explicitly terminates the process.
process.on("message", () => {});
const stream = new PassThrough();
stream.write(Buffer.alloc(65536, 65));
void receiveSourceZip(stream, { temporaryRoot }).catch(() => process.exit(2));
for (let i = 0; i < 500; i++) {
  const directory = (await readdir(temporaryRoot)).find(name => name.startsWith(`${sourceSpoolPrefix}${process.pid}-`));
  if (directory && (await stat(join(temporaryRoot, directory, "upload.zip")).catch(() => null))?.size === 65536) {
    process.send({ state: "uploading", directory, pid: process.pid });
    break;
  }
  if (i === 499) throw new Error("UPLOAD_DID_NOT_START");
  await delay(10);
}
