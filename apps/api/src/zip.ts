import yauzl from "yauzl";
import { createHash } from "node:crypto";
import { templateFiles } from "./template.js";
const editable =
  /^(src\/[a-zA-Z0-9_./-]+\.(vue|js|ts|css|json)|public\/[a-zA-Z0-9_./-]+\.(png|jpg|jpeg|webp|ico|woff2|txt))$/;
export async function validateZip(buffer: Buffer) {
  if (buffer.length > 10 * 1024 * 1024) throw new Error("ZIP 超过 10 MB");
  const trusted = await templateFiles();
  const files: Record<string, string> = {};
  const seen = new Set<string>();
  let total = 0,
    count = 0;
  await new Promise<void>((resolve, reject) =>
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, decodeStrings: true },
      (error, zip) => {
        if (error || !zip) {
          reject(error ?? new Error("ZIP 无效"));
          return;
        }
        let stopped = false;
        const fail = (e: unknown) => {
          if (stopped) return;
          stopped = true;
          zip.close();
          reject(e);
        };
        zip.on("error", fail);
        zip.on("end", () => resolve());
        zip.on("entry", (entry: yauzl.Entry) => {
          try {
            const name = entry.fileName;
            const segments = name.split("/");
            if (++count > 2000) throw new Error("最多 2000 个文件");
            if (
              name.includes("\\") ||
              name.startsWith("/") ||
              segments.some(
                (s) => s === ".." || s === "." || s.includes(":"),
              ) ||
              name.includes("\0")
            )
              throw new Error("禁止路径穿越");
            if (entry.generalPurposeBitFlag & 1)
              throw new Error("不支持加密 ZIP");
            if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
              throw new Error("禁止符号链接");
            if (
              segments.some(
                (s) =>
                  s === "node_modules" || s === ".git" || s.startsWith(".env"),
              ) ||
              /\.(zip|tar|gz|7z|rar|pem|key|p12)$/i.test(name)
            )
              throw new Error("包含不允许的文件");
            if (
              segments
                .slice(0, name.endsWith("/") ? -1 : undefined)
                .some(
                  (s) =>
                    !s ||
                    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
                )
            )
              throw new Error("不兼容的文件路径");
            if (seen.has(name.toLowerCase()))
              throw new Error("重复或大小写冲突的文件名");
            seen.add(name.toLowerCase());
            if (name.endsWith("/")) {
              zip.readEntry();
              return;
            }
            if (Object.hasOwn(files, name)) throw new Error("重复文件名");
            if (!Object.hasOwn(trusted, name) && !editable.test(name))
              throw new Error(`不允许的路径：${name}`);
            total += entry.uncompressedSize;
            if (
              total > 50 * 1024 * 1024 ||
              entry.uncompressedSize > 2 * 1024 * 1024
            )
              throw new Error("解压内容超限（单文件 2 MB，总计 50 MB）");
            zip.openReadStream(entry, (err, stream) => {
              if (err || !stream) {
                fail(err);
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              stream.on("error", fail);
              stream.on("data", (c) => {
                size += c.length;
                if (size > entry.uncompressedSize || size > 2 * 1024 * 1024) {
                  stream.destroy();
                  fail(new Error("文件实际大小超限"));
                } else chunks.push(c);
              });
              stream.on("end", () => {
                if (stopped) return;
                const content = Buffer.concat(chunks);
                if (!editable.test(name) && !content.equals(trusted[name])) {
                  fail(new Error(`模板配置不可修改：${name}`));
                  return;
                }
                files[name] = content.toString("base64");
                zip.readEntry();
              });
            });
          } catch (e) {
            fail(e);
          }
        });
        zip.readEntry();
      },
    ),
  );
  for (const name of Object.keys(trusted))
    if (!editable.test(name) && !Object.hasOwn(files, name))
      throw new Error(`缺少模板文件：${name}`);
  if (!files["src/main.js"] || !files["src/App.vue"])
    throw new Error("缺少 Vue 入口");
  return { files, sha256: createHash("sha256").update(buffer).digest("hex") };
}
