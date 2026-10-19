import { z } from "zod";

/** These limits also need enforcement while reading HTTP/ZIP streams. */
export const LIMITS_V1 = Object.freeze({
  version: "limits-v1" as const,
  originalZipMaxBytes: 10 * 1024 * 1024,
  sourceMaxBytes: 50 * 1024 * 1024,
  sourceFileMaxBytes: 2 * 1024 * 1024,
  sourceMaxFiles: 2000,
  pathMaxBytes: 240,
  pngMaxBytes: 1024 * 1024,
  textEvidenceMaxBytes: 64 * 1024,
  manifestMaxEvidence: 200,
  runnerRequestMaxBytes: 75 * 1024 * 1024,
  runnerMetadataMaxBytes: 1024 * 1024,
  runnerResponseMaxBytes: 16 * 1024 * 1024,
});

export const uuidSchema = z.string().uuid();
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const utcDateTimeSchema = z.string().datetime();
export const businessIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_:-]{0,79}$/);
export const versionSchema = z.string().min(1).max(80);
export const reasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
export const verdictSchema = z.enum(["passed", "failed", "manual", "not_run"]);
export type Verdict = z.infer<typeof verdictSchema>;

export function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail("DUPLICATE_ID", label);
}

export function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

export function refineWith(context: z.RefinementCtx, check: () => void): void {
  try {
    check();
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** json-v1: object keys use UTF-16 code-unit order; array order is preserved. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object" || seen.has(item))
      fail(
        "INVALID_CANONICAL_JSON",
        "Only finite, acyclic JSON values are allowed",
      );
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length)
        fail(
          "INVALID_CANONICAL_JSON",
          "Sparse arrays and array properties are not allowed",
        );
      result = `[${item.map(encode).join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        fail("INVALID_CANONICAL_JSON", "Expected a plain object");
      if (Object.getOwnPropertySymbols(item).length)
        fail("INVALID_CANONICAL_JSON", "Symbol keys are not allowed");
      const object = item as Record<string, unknown>;
      result = `{${Object.keys(object)
        .sort(lexicalCompare)
        .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`)
        .join(",")}}`;
    }
    seen.delete(item);
    return result;
  }
  return encode(value);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertJsonByteLimit(
  value: unknown,
  maxBytes: number,
  label: string,
): void {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || utf8ByteLength(json) > maxBytes)
    fail("PAYLOAD_TOO_LARGE", label);
}

/** Uses the browser/Node Web Crypto API; the public entry point has no Node imports. */
export async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (!globalThis.crypto?.subtle)
    fail("CRYPTO_UNAVAILABLE", "Web Crypto SHA-256 is required");
  // Copy to a normal ArrayBuffer to also support views over shared buffers.
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return globalThis.btoa(binary);
}

export function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length > Math.ceil(maxBytes / 3) * 4)
    fail("PAYLOAD_TOO_LARGE", "base64 encoded bytes");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    fail("INVALID_BASE64", "Expected canonical padded base64");
  const binary = globalThis.atob(value);
  if (binary.length > maxBytes) fail("PAYLOAD_TOO_LARGE", "decoded bytes");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (encodeBase64(bytes) !== value)
    fail("INVALID_BASE64", "Nonzero padding bits");
  return bytes;
}

export function validateRelativePath(path: string): string {
  if (
    !path ||
    utf8ByteLength(path) > LIMITS_V1.pathMaxBytes ||
    path !== path.normalize("NFC")
  )
    fail("INVALID_PATH", path);
  if (/[\\\u0000-\u001f\u007f:<>"|?*]/.test(path)) fail("INVALID_PATH", path);
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    fail("INVALID_PATH", path);
  return path;
}

export const executionContextSchema = z
  .object({
    runId: uuidSchema,
    executionAttemptId: uuidSchema,
    submissionId: uuidSchema,
    originalZipSha256: sha256Schema,
    sourceManifestSha256: sha256Schema,
    ruleId: uuidSchema,
    ruleHash: sha256Schema,
    packManifestHash: sha256Schema,
    templateHash: sha256Schema,
  })
  .strict();
export type ExecutionContext = z.infer<typeof executionContextSchema>;

export function assertContextMatches(
  expected: ExecutionContext,
  actual: ExecutionContext,
): void {
  if (
    canonicalJson(executionContextSchema.parse(expected)) !==
    canonicalJson(executionContextSchema.parse(actual))
  )
    fail(
      "CONTEXT_MISMATCH",
      "Execution identities differ from the trusted request",
    );
}
