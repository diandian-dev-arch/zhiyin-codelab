import yauzl from "yauzl";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { sourceImportLimits as limits } from "@codelab/contracts/source";

export function redactSource(text: string) {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      (key) => key.replace(/[^\r\n]+/g, "[PRIVATE KEY REMOVED]"),
    )
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{15,}|AKIA[A-Z0-9]{16})\b/g,
      "[SECRET REMOVED]",
    )
    .replace(
      /((?:api[_-]?key|password|secret|access[_-]?token|authorization)\s*["']?\s*[:=]\s*)["'][^"'\r\n]+["']/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /(https?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/)[^\s/@]+:[^\s/@]+@/g,
      "$1[REDACTED]@",
    );
}

// No extraction, execution or dependency installation. This is independent of course ZIP validation.
export async function importSourceZip(
  input: Buffer | { path: string; sha256: string },
  policy: { redact?: boolean } = {},
) {
  const bytes = Buffer.isBuffer(input)
    ? input.length
    : (await stat(input.path)).size;
  if (bytes > limits.zipBytes) throw new Error("ZIP 最大为 100 MB");
  const files: Record<string, string> = Object.create(null),
    omitted: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  let count = 0,
    expanded = 0,
    retained = 0;
  await new Promise<void>((resolve, reject) => {
    const onOpen = (error: Error | null, zip: yauzl.ZipFile | undefined) => {
      if (error || !zip) return reject(new Error("ZIP 无法读取，请重新压缩"));
      let stopped = false;
      const fail = (e: unknown) => {
        if (!stopped) {
          stopped = true;
          zip.close();
          reject(e);
        }
      };
      zip.on("error", () => fail(new Error("ZIP 内容损坏")));
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName,
          segments = name.split("/");
        if (++count > limits.entries || name.length > 400)
          return fail(new Error("ZIP 文件数量或路径长度超限"));
        if (
          name.includes("\\") ||
          name.startsWith("/") ||
          /[\x00-\x1f:]/.test(name) ||
          segments.some((s) => s === ".." || s === ".")
        )
          return fail(new Error("ZIP 包含不安全路径"));
        if (
          entry.generalPurposeBitFlag & 1 ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
        )
          return fail(new Error("不支持加密文件或符号链接"));
        if (seen.has(name.toLowerCase()))
          return fail(new Error("ZIP 存在重复文件路径"));
        seen.add(name.toLowerCase());
        expanded += entry.uncompressedSize;
        if (expanded > limits.expandedBytes)
          return fail(
            new Error("ZIP 展开后不能超过 500 MB（包括被跳过的文件）"),
          );
        if (name.endsWith("/")) return zip.readEntry();
        const skip = segments.some((s) =>
          /^(node_modules|\.git|dist|build|coverage|vendor|__pycache__|\.venv|venv|__MACOSX)$/i.test(
            s,
          ),
        )
          ? "依赖或构建产物"
          : segments.some((s) =>
                /^\.env(?:\.|$)|^\.npmrc$|^\.pypirc$|credential|secret|^id_rsa/i.test(
                  s,
                ),
              ) || /\.(pem|key|p12|pfx)$/i.test(name)
            ? "敏感配置"
            : !/\.(vue|svelte|astro|[cm]?[jt]sx?|py|pyi|ipynb|java|go|rs|c|cc|cpp|cxx|h|hpp|cs|fs|fsx|php|rb|swift|kt|kts|dart|lua|r|rmd|jl|hs|lhs|ex|exs|erl|hrl|clj|cljs|cljc|edn|scala|sc|groovy|gradle|m|mm|sql|graphql|gql|proto|prisma|html|htm|css|scss|sass|less|styl|json|jsonc|ya?ml|toml|xml|md|mdx|rst|txt|sh|bash|zsh|fish|ps1|psm1|bat|cmd|properties|ini|cfg|conf|tf)$/i.test(
                  name,
                ) &&
                !/(^|\/)(Dockerfile(?:\.[\w.-]+)?|Makefile|CMakeLists\.txt|Gemfile|Rakefile|Procfile|Justfile|requirements\.txt|go\.mod|go\.sum|\.gitignore|\.editorconfig)$/i.test(name)
              ? "非源码文件"
              : /(?:lock\.json|lock\.yaml|\.lock)$/i.test(name)
                ? "依赖锁文件"
                : entry.uncompressedSize > limits.fileBytes
                  ? "单文件超过 512 KB"
                  : retained + entry.uncompressedSize > limits.retainedBytes
                    ? "源码总量超过 16 MB"
                    : "";
        if (skip) {
          omitted.push({ path: name, reason: skip });
          return zip.readEntry();
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return fail(new Error("ZIP 文件无法读取"));
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("error", () => fail(new Error("ZIP 文件损坏")));
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limits.fileBytes) {
              stream.destroy();
              fail(new Error("文件实际大小超限"));
            } else chunks.push(chunk);
          });
          stream.on("end", () => {
            if (stopped) return;
            try {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              );
              if (text.includes("\0")) throw new Error();
              files[name] = policy.redact === false ? text : redactSource(text);
              retained += size;
            } catch {
              omitted.push({ path: name, reason: "不是 UTF-8 文本" });
            }
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    };
    const options = {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    };
    if (Buffer.isBuffer(input)) yauzl.fromBuffer(input, options, onOpen);
    else yauzl.open(input.path, options, onOpen);
  });
  if (!Object.keys(files).length)
    throw new Error("ZIP 中没有可分析的源码，请上传含源码的 UTF-8 项目");
  return {
    files,
    omitted,
    sha256: Buffer.isBuffer(input)
      ? createHash("sha256").update(input).digest("hex")
      : input.sha256,
  };
}
