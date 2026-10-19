import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import type { DB } from "../apps/api/src/db.js";
import {
  createUserModelService,
  loadModelVaultKey,
} from "../apps/api/src/user-model-settings.js";

const fingerprint = (key: Buffer) =>
  createHash("sha256").update(key).digest("hex");
async function repositoryCredentials(db: DB) {
  if (
    !(
      await db.query(
        "SELECT to_regclass('course_repository_connections') AS relation",
      )
    ).rows[0].relation
  )
    return [];
  return (
    await db.query(
      "SELECT owner_id,credential FROM course_repository_connections WHERE credential<>'' ORDER BY id",
    )
  ).rows;
}
/** Store the vault separately from the database archive. Resolving a provider does not call it. */
export async function backupModelVault(
  db: DB,
  sourceDirectory: string,
  separateDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const users = (
    await db.query("SELECT user_id FROM user_model_settings ORDER BY user_id")
  ).rows;
  const repositories = await repositoryCredentials(db);
  if (!users.length && !repositories.length)
    return { profiles: 0, saved: false as const };
  const key = await loadModelVaultKey(db, sourceDirectory, env);
  const service = createUserModelService(db, key);
  for (const row of users)
    assert(
      await service.resolve(row.user_id),
      "SOURCE_MODEL_PROFILE_UNREADABLE",
    );
  for (const row of repositories)
    assert(
      service.openRepository(row.owner_id, row.credential),
      "SOURCE_REPOSITORY_CREDENTIAL_UNREADABLE",
    );
  await mkdir(separateDirectory, { recursive: true });
  const destination = path.join(separateDirectory, "model-credentials.key");
  await writeFile(destination, key, { flag: "wx", mode: 0o600 });
  assert(
    (await readFile(destination)).equals(key),
    "BACKUP_VAULT_WRITE_MISMATCH",
  );
  return {
    profiles: users.length,
    saved: true as const,
    keySha256: fingerprint(key),
    ...(repositories.length
      ? { repositoryConnections: repositories.length }
      : {}),
  };
}

/** Offline decryption/configuration check only. Never start a worker or call a provider. */
export async function checkRestoredModelVault(
  db: DB,
  separateDirectory: string,
  expected: Awaited<ReturnType<typeof backupModelVault>>,
) {
  const rows = (
    await db.query(
      "SELECT user_id,revision,settings FROM user_model_settings ORDER BY user_id",
    )
  ).rows;
  assert.equal(
    rows.length,
    expected.profiles,
    "RESTORED_MODEL_PROFILE_COUNT_MISMATCH",
  );
  const repositories = await repositoryCredentials(db);
  const repositoryConnections =
    "repositoryConnections" in expected ? expected.repositoryConnections : 0;
  assert.equal(
    repositories.length,
    repositoryConnections,
    "RESTORED_REPOSITORY_CONNECTION_COUNT_MISMATCH",
  );
  if (!expected.saved)
    return { profiles: 0, decrypted: 0, externalModelCalls: 0 };
  const filename = path.join(separateDirectory, "model-credentials.key");
  const stat = await lstat(filename);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.size === 32,
    "RESTORED_VAULT_FILE_INVALID",
  );
  const key = await readFile(filename);
  assert.equal(
    fingerprint(key),
    expected.keySha256,
    "RESTORED_VAULT_FINGERPRINT_MISMATCH",
  );
  const service = createUserModelService(db, key);
  for (const row of repositories)
    assert(
      service.openRepository(row.owner_id, row.credential),
      "RESTORED_REPOSITORY_CREDENTIAL_UNREADABLE",
    );
  for (const row of rows) {
    const provider = await service.resolve(row.user_id);
    assert(provider, "RESTORED_MODEL_PROFILE_UNREADABLE");
    assert.equal(
      provider.configuration.model,
      row.settings.model,
      "RESTORED_MODEL_NAME_MISMATCH",
    );
    assert.equal(
      provider.configuration.credentialRevision,
      row.revision,
      "RESTORED_MODEL_REVISION_MISMATCH",
    );
  }
  return {
    profiles: rows.length,
    decrypted: rows.length,
    externalModelCalls: 0,
    ...(repositories.length
      ? {
          repositoryConnections: repositories.length,
          repositoryDecrypted: repositories.length,
        }
      : {}),
  };
}
