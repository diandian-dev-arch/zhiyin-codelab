import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { isolatedTestDB } from "./isolated-db";
import { migrate } from "../apps/api/src/db";
import {
  createUserModelService,
  loadModelVaultKey,
} from "../apps/api/src/user-model-settings";
import {
  backupModelVault,
  checkRestoredModelVault,
} from "../scripts/backup-model-vault";

it("backs up and restores actual encrypted profiles separately, rejects wrong/missing keys, and never calls a model", async () => {
  const db = await isolatedTestDB(),
    directory = await mkdtemp(path.join(tmpdir(), "codelab-vault-backup-"));
  try {
    await migrate(db);
    const user = randomUUID(),
      key = randomBytes(32);
    await db.query("INSERT INTO users VALUES($1,$2,'U','student','hash')", [
      user,
      `${user}@test.local`,
    ]);
    await createUserModelService(db, key).save(user, {
      vendor: "deepseek",
      model: "deepseek-flash",
      apiKey: "fixture-credential-not-live",
    });
    const before = (await db.query("SELECT * FROM user_model_settings")).rows;
    const destination = path.join(directory, "separate");
    const saved = await backupModelVault(db, directory, destination, {
      MODEL_CREDENTIAL_KEY: key.toString("hex"),
    });
    expect(saved.profiles).toBe(1);
    expect(JSON.stringify(saved)).not.toContain(key.toString("hex"));
    expect(
      (await readFile(path.join(destination, "model-credentials.key"))).equals(
        key,
      ),
    ).toBe(true);
    expect(await checkRestoredModelVault(db, destination, saved)).toEqual({
      profiles: 1,
      decrypted: 1,
      externalModelCalls: 0,
    });
    await expect(
      backupModelVault(db, directory, destination, {
        MODEL_CREDENTIAL_KEY: key.toString("hex"),
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await writeFile(
      path.join(destination, "model-credentials.key"),
      randomBytes(32),
    );
    await expect(
      checkRestoredModelVault(db, destination, saved),
    ).rejects.toThrow("RESTORED_VAULT_FINGERPRINT_MISMATCH");
    await unlink(path.join(destination, "model-credentials.key"));
    await expect(
      checkRestoredModelVault(db, destination, saved),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await db.query("SELECT * FROM user_model_settings")).rows).toEqual(
      before,
    );
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("does not create a vault when no personal credentials exist", async () => {
  const db = await isolatedTestDB(),
    directory = await mkdtemp(path.join(tmpdir(), "codelab-empty-vault-"));
  try {
    await migrate(db);
    const record = await backupModelVault(
      db,
      directory,
      path.join(directory, "separate"),
      {},
    );
    expect(record).toEqual({ profiles: 0, saved: false });
    expect(await checkRestoredModelVault(db, directory, record)).toEqual({
      profiles: 0,
      decrypted: 0,
      externalModelCalls: 0,
    });
    await expect(
      readFile(path.join(directory, "model-credentials.key")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("preserves the shared vault when only encrypted repository credentials exist", async () => {
  const db = await isolatedTestDB(),
    directory = await mkdtemp(path.join(tmpdir(), "codelab-repository-vault-"));
  try {
    await migrate(db);
    const user = randomUUID(),
      key = randomBytes(32),
      service = createUserModelService(db, key);
    await db.query("INSERT INTO users VALUES($1,$2,'U','student','hash')", [
      user,
      `${user}@test.local`,
    ]);
    await db.query(
      "INSERT INTO course_repository_connections(id,owner_id,provider,label,credential) VALUES($1,$2,'gitee','fixture',$3)",
      [
        randomUUID(),
        user,
        service.sealRepository(user, "fixture-repository-token"),
      ],
    );
    await expect(loadModelVaultKey(db, directory, {})).rejects.toThrow(
      "MODEL_VAULT_KEY_MISSING",
    );
    const saved = await backupModelVault(
      db,
      directory,
      path.join(directory, "separate"),
      { MODEL_CREDENTIAL_KEY: key.toString("hex") },
    );
    expect(saved).toMatchObject({
      profiles: 0,
      repositoryConnections: 1,
      saved: true,
    });
    expect(
      await checkRestoredModelVault(
        db,
        path.join(directory, "separate"),
        saved,
      ),
    ).toEqual({
      profiles: 0,
      decrypted: 0,
      repositoryConnections: 1,
      repositoryDecrypted: 1,
      externalModelCalls: 0,
    });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
