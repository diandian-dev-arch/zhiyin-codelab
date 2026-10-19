import { z } from "zod";
import {
  LIMITS_V1,
  canonicalJson,
  decodeBase64,
  fail,
  lexicalCompare,
  refineWith,
  requireUnique,
  sha256,
  sha256Schema,
  validateRelativePath,
} from "./primitives";

export const SOURCE_MANIFEST_ALGORITHM = "source-manifest-v1" as const;
export const sourceFileEntrySchema = z
  .object({
    path: z.string().min(1),
    byteSize: z.number().int().min(0).max(LIMITS_V1.sourceFileMaxBytes),
    sha256: sha256Schema,
  })
  .strict();

function validateSourcePaths(paths: readonly string[]): void {
  const folded = new Set<string>();
  for (const path of paths) {
    validateRelativePath(path);
    if (!/^(src|public)\/.+/.test(path))
      fail(
        "SOURCE_SCOPE_INVALID",
        "Only editable src/ and public/ files belong in a source manifest",
      );
    const lower = path.toLowerCase();
    if (folded.has(lower)) fail("PATH_COLLISION", path);
    folded.add(lower);
  }
  for (const path of folded) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (folded.has(parts.slice(0, i).join("/"))) fail("PATH_COLLISION", path);
  }
}

export const sourceManifestSchema = z
  .object({
    algorithmVersion: z.literal(SOURCE_MANIFEST_ALGORITHM),
    files: z.array(sourceFileEntrySchema).min(1).max(LIMITS_V1.sourceMaxFiles),
    sourceManifestSha256: sha256Schema,
  })
  .strict()
  .superRefine((manifest, ctx) =>
    refineWith(ctx, () => {
      requireUnique(
        manifest.files.map((file) => file.path),
        "source files",
      );
      validateSourcePaths(manifest.files.map((file) => file.path));
      if (
        manifest.files.reduce((sum, file) => sum + file.byteSize, 0) >
        LIMITS_V1.sourceMaxBytes
      )
        fail("PAYLOAD_TOO_LARGE", "source manifest total bytes");
    }),
  );
export type SourceManifest = z.infer<typeof sourceManifestSchema>;

export function validateSourceFiles(files: Record<string, string>): {
  decodedFiles: Record<string, Uint8Array>;
  totalBytes: number;
} {
  if (!files || typeof files !== "object" || Array.isArray(files))
    fail("INVALID_FILES", "Expected a plain path-to-base64 object");
  const prototype = Object.getPrototypeOf(files);
  if (prototype !== Object.prototype && prototype !== null)
    fail("INVALID_FILES", "Expected a plain object");
  const paths = Object.keys(files);
  if (!paths.length || paths.length > LIMITS_V1.sourceMaxFiles)
    fail("FILE_COUNT_INVALID", "Expected 1–2000 editable files");
  validateSourcePaths(paths);
  const decodedFiles: Record<string, Uint8Array> = Object.create(null);
  let totalBytes = 0;
  for (const path of paths) {
    if (typeof files[path] !== "string") fail("INVALID_BASE64", path);
    const bytes = decodeBase64(files[path], LIMITS_V1.sourceFileMaxBytes);
    totalBytes += bytes.byteLength;
    if (totalBytes > LIMITS_V1.sourceMaxBytes)
      fail("PAYLOAD_TOO_LARGE", "decoded source total");
    decodedFiles[path] = bytes;
  }
  return { decodedFiles, totalBytes };
}

export async function hashSourceManifest(
  manifest: Pick<SourceManifest, "algorithmVersion" | "files">,
): Promise<string> {
  return sha256(
    canonicalJson({
      algorithmVersion: manifest.algorithmVersion,
      files: [...manifest.files].sort((a, b) => lexicalCompare(a.path, b.path)),
    }),
  );
}

/** This hashes editable source bytes only. It does not verify the original ZIP. */
export async function createSourceManifest(
  files: Record<string, string>,
): Promise<SourceManifest> {
  const { decodedFiles } = validateSourceFiles(files);
  const entries: SourceManifest["files"] = [];
  for (const path of Object.keys(decodedFiles).sort(lexicalCompare)) {
    const bytes = decodedFiles[path];
    entries.push({
      path,
      byteSize: bytes.byteLength,
      sha256: await sha256(bytes),
    });
  }
  const value = { algorithmVersion: SOURCE_MANIFEST_ALGORITHM, files: entries };
  return { ...value, sourceManifestSha256: await hashSourceManifest(value) };
}

export async function validateSourceManifest(
  manifest: unknown,
  files?: Record<string, string>,
): Promise<SourceManifest> {
  const parsed = sourceManifestSchema.parse(manifest);
  if ((await hashSourceManifest(parsed)) !== parsed.sourceManifestSha256)
    fail("SOURCE_HASH_MISMATCH", "Source manifest content hash");
  if (
    files &&
    (await createSourceManifest(files)).sourceManifestSha256 !==
      parsed.sourceManifestSha256
  )
    fail("SOURCE_HASH_MISMATCH", "Transmitted source bytes");
  return parsed;
}
