import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { zipSync, unzipSync } from "fflate";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const limit = 64 * 1024 ** 2;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function archiveVerifiedBackup(
  root: string,
  id: string,
  recordPath: string,
) {
  if (!uuid.test(id)) throw new Error("BACKUP_ID_INVALID");
  const directory = path.join(root, ".data/backups", id);
  // Operator-owned offline backups only; not a race-proof hostile filesystem boundary.
  for (const dir of [
    path.join(root, ".data"),
    path.join(root, ".data/backups"),
    directory,
  ]) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("BACKUP_DIRECTORY_UNSAFE");
  }
  const recordInfo = await lstat(recordPath);
  if (
    !recordInfo.isFile() ||
    recordInfo.isSymbolicLink() ||
    recordInfo.size > 1024 ** 2
  )
    throw new Error("BACKUP_RECORD_UNSAFE");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  if (
    record.id !== id ||
    record.passed !== true ||
    record.sourceUnchanged !== true ||
    record.cleanup !== "clean" ||
    !/^[0-9a-f]{64}$/.test(record.dumpSha256)
  )
    throw new Error("BACKUP_NOT_VERIFIED");
  const files: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  async function add(relative: string) {
    const filename = path.join(directory, relative),
      info = await lstat(filename);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > limit - total
    )
      throw new Error("BACKUP_FILE_UNSAFE_OR_TOO_LARGE");
    const bytes = await readFile(filename);
    total += bytes.length;
    if (total > limit || Object.keys(files).length >= 10000)
      throw new Error("BACKUP_ARCHIVE_LIMIT");
    files[relative] = bytes;
    return bytes;
  }
  const manifest = JSON.parse(
    Buffer.from(await add("manifest.json")).toString("utf8"),
  );
  if (
    manifest.id !== id ||
    !manifest.evidence ||
    typeof manifest.evidence !== "object" ||
    Array.isArray(manifest.evidence)
  )
    throw new Error("BACKUP_MANIFEST_INVALID");
  const profileRows = manifest.tables?.user_model_settings?.rows;
  const repositoryRows =
    manifest.tables?.course_repository_connections?.rows ?? 0;
  const vault = manifest.modelVault;
  let modelVault: {
    status: "not_recorded" | "not_required" | "separate_key_verified";
    keyIncluded: false;
    profiles?: number;
    separateLocation?: string;
    keySha256?: string;
  } = { status: "not_recorded", keyIncluded: false };
  if (vault !== undefined || profileRows !== undefined) {
    if (
      !vault ||
      !Number.isSafeInteger(vault.profiles) ||
      vault.profiles < 0 ||
      profileRows !== vault.profiles ||
      record.modelCredentials?.profiles !== vault.profiles
    )
      throw new Error("BACKUP_VAULT_METADATA_INVALID");
    if (
      !Number.isSafeInteger(repositoryRows) ||
      repositoryRows < 0 ||
      (vault.repositoryConnections ?? 0) > repositoryRows ||
      (vault.repositoryConnections ?? 0) < 0
    )
      throw new Error("BACKUP_VAULT_METADATA_INVALID");
    if (vault.profiles === 0 && !(vault.repositoryConnections ?? 0)) {
      if (vault.saved !== false)
        throw new Error("BACKUP_VAULT_METADATA_INVALID");
      modelVault = { status: "not_required", keyIncluded: false, profiles: 0 };
    } else {
      if (
        vault.saved !== true ||
        !/^[a-f0-9]{64}$/.test(vault.keySha256) ||
        record.modelCredentials?.decrypted !== vault.profiles ||
        (record.modelCredentials?.repositoryDecrypted ?? 0) !==
          (vault.repositoryConnections ?? 0)
      )
        throw new Error("BACKUP_VAULT_METADATA_INVALID");
      // Derive the path from the validated backup UUID, never follow a manifest path.
      const separateLocation = `.data/model-key-backups/${id}`;
      for (const dir of [
        path.join(root, ".data/model-key-backups"),
        path.join(root, separateLocation),
      ]) {
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("BACKUP_VAULT_DIRECTORY_UNSAFE");
      }
      const keyPath = path.join(
        root,
        separateLocation,
        "model-credentials.key",
      );
      const keyInfo = await lstat(keyPath);
      if (
        !keyInfo.isFile() ||
        keyInfo.isSymbolicLink() ||
        keyInfo.nlink !== 1 ||
        keyInfo.size !== 32
      )
        throw new Error("BACKUP_VAULT_FILE_UNSAFE");
      if (digest(await readFile(keyPath)) !== vault.keySha256)
        throw new Error("BACKUP_VAULT_CHANGED");
      modelVault = {
        status: "separate_key_verified",
        keyIncluded: false,
        profiles: vault.profiles,
        separateLocation,
        keySha256: vault.keySha256,
      };
    }
  }
  if (digest(await add("database.dump")) !== record.dumpSha256)
    throw new Error("BACKUP_DUMP_CHANGED");
  const actual = new Set<string>();
  let visited = 0;
  async function walk(relative: string) {
    if (relative.split("/").length > 32 || ++visited > 10000)
      throw new Error("BACKUP_ARCHIVE_LIMIT");
    const info = await lstat(path.join(directory, relative));
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("BACKUP_DIRECTORY_UNSAFE");
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      if (++visited > 10000) throw new Error("BACKUP_ARCHIVE_LIMIT");
      if (!/^[a-zA-Z0-9_.-]+$/.test(entry.name))
        throw new Error("BACKUP_PATH_INVALID");
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else {
        const key = child.slice("evidence-v2/".length),
          expected = manifest.evidence[key];
        if (
          !expected ||
          !Number.isSafeInteger(expected.bytes) ||
          !/^[0-9a-f]{64}$/.test(expected.sha256)
        )
          throw new Error("BACKUP_UNLISTED_EVIDENCE");
        const bytes = await add(child);
        if (
          bytes.length !== expected.bytes ||
          digest(bytes) !== expected.sha256
        )
          throw new Error("BACKUP_EVIDENCE_CHANGED");
        actual.add(key);
      }
    }
  }
  await walk("evidence-v2");
  if (
    actual.size !== Object.keys(manifest.evidence).length ||
    actual.size !== record.evidenceFiles
  )
    throw new Error("BACKUP_EVIDENCE_MISSING");
  if (
    [...actual].reduce(
      (sum, key) => sum + files[`evidence-v2/${key}`].length,
      0,
    ) !== record.evidenceBytes
  )
    throw new Error("BACKUP_EVIDENCE_TOTAL_MISMATCH");
  files["restore-verification.json"] = Buffer.from(
    JSON.stringify(record, null, 2),
  );
  const inventory = Object.entries(files).map(([name, bytes]) => ({
    path: name,
    bytes: bytes.length,
    sha256: digest(bytes),
  }));
  files["ARCHIVE_MANIFEST.json"] = Buffer.from(
    JSON.stringify(
      {
        version: 2,
        backupId: id,
        modelVault,
        recoveryNotice:
          "Encrypted model credentials require their separate original vault key. Never place the key in this archive. Missing keys cannot be recreated by generating a new key.",
        files: inventory,
      },
      null,
      2,
    ),
  );
  const archive = zipSync(files, { level: 6 });
  const restored = unzipSync(archive);
  if (Object.keys(restored).length !== Object.keys(files).length)
    throw new Error("ARCHIVE_ROUNDTRIP_FAILED");
  for (const [name, bytes] of Object.entries(files)) {
    if (!restored[name] || digest(restored[name]) !== digest(bytes))
      throw new Error("ARCHIVE_ROUNDTRIP_FAILED");
  }
  return {
    archive,
    sha256: digest(archive),
    evidenceFiles: actual.size,
    sourceBytes: total,
    entries: Object.keys(files).length,
    modelVault,
  };
}
