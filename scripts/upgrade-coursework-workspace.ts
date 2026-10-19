// Additive upgrade of the selected, stopped local workspace after a verified backup.
// No process is stopped, no database is replaced, and no external model is called.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { migrate, type DB } from "../apps/api/src/db.js";
import { MIGRATION_LOCK_ID } from "../apps/api/src/migrations.js";
import { connectDesktopDatabase } from "./desktop-database.js";
import { workspaceDatabaseTarget } from "./workspace-database-target.js";

const backupId = process.argv[2];
assert.match(
  backupId ?? "",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "VERIFIED_BACKUP_ID_REQUIRED",
);
const root = process.cwd(),
  directory = path.join(root, ".data/backups", backupId);
const resultPath = path.join(
  root,
  "docs/verification/2026-10-18/coursework/workspace-upgrade.json",
);
const receipt: any = {
  startedAt: new Date().toISOString(),
  backupId,
  externalModelCalls: 0,
  passed: false,
};
async function offline() {
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@(Get-NetTCPConnection -State Listen -LocalPort 3102,3103,5174 -ErrorAction SilentlyContinue).Count",
    ],
    { windowsHide: true, timeout: 10000 },
  );
  assert.equal(Number(stdout.trim()), 0, "STOP_WORKSPACE_BEFORE_UPGRADE");
}
async function inventory(db: DB) {
  const result: Record<string, unknown> = {};
  const tables = (
    await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
    const rows = (
      await db.query(
        `SELECT row_to_json(t)::text AS value FROM public."${tablename}" t ORDER BY row_to_json(t)::text COLLATE "C"`,
      )
    ).rows;
    result[tablename] = {
      rows: rows.length,
      sha256: createHash("sha256")
        .update(
          rows
            .map((r) => r.value)
            .join("\n")
            .trim(),
        )
        .digest("hex"),
    };
  }
  return result;
}
let db: DB | undefined;
try {
  const backup = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  const evidence = JSON.parse(
    await readFile(
      path.join(
        root,
        "docs/verification/2026-10-18",
        `backup-${backupId}`,
        "result.json",
      ),
      "utf8",
    ),
  );
  assert.equal(evidence.passed, true, "BACKUP_RESTORE_NOT_VERIFIED");
  assert.equal(evidence.sourceUnchanged, true);
  assert.equal(backup.id, backupId);
  assert.equal(
    createHash("sha256")
      .update(await readFile(path.join(directory, "database.dump")))
      .digest("hex"),
    evidence.dumpSha256,
    "BACKUP_CHANGED",
  );
  await offline();
  receipt.databaseTarget = await workspaceDatabaseTarget(root);
  db = await connectDesktopDatabase();
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    const version = (
      await tx.query("SELECT max(version)::int AS n FROM schema_migrations")
    ).rows[0].n;
    assert.equal(version, 20, "WORKSPACE_SCHEMA_CHANGED");
    receipt.fromVersion = version;
    const active = (
      await tx.query(`SELECT
      (SELECT count(*) FROM source_analyses WHERE status IN ('queued','running')) +
      (SELECT count(*) FROM execution_attempts WHERE owner_phase<>'closed') +
      (SELECT count(*) FROM analysis_attempts WHERE status IN ('queued','running') OR owner_phase<>'closed') +
      (SELECT count(*) FROM runs WHERE status IN ('queued','preparing','building','checking','analyzing')) AS n`)
    ).rows[0].n;
    assert.equal(Number(active), 0, "WORKSPACE_ACTIVE_WORK");
    const before = await inventory(tx);
    assert.deepEqual(before, backup.tables, "WORKSPACE_CHANGED_SINCE_BACKUP");
    receipt.migration = await migrate(tx);
    assert.equal(
      (await tx.query("SELECT max(version)::int AS n FROM schema_migrations"))
        .rows[0].n,
      22,
    );
    const after = await inventory(tx);
    for (const table of Object.keys(before))
      if (table !== "schema_migrations")
        assert.deepEqual(
          after[table],
          before[table],
          `EXISTING_DATA_CHANGED:${table}`,
        );
    receipt.existingTablesPreserved = Object.keys(before).filter(
      (t) => t !== "schema_migrations",
    ).length;
    receipt.toVersion = 22;
    receipt.tables = after;
    await offline();
  });
  receipt.passed = true;
} catch (error) {
  receipt.error =
    error instanceof assert.AssertionError
      ? error.message
      : "WORKSPACE_UPGRADE_FAILED";
  process.exitCode = 1;
} finally {
  await db?.close();
  receipt.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      fromVersion: receipt.fromVersion,
      toVersion: receipt.toVersion,
      existingTablesPreserved: receipt.existingTablesPreserved,
      record: path.relative(root, resultPath),
      error: receipt.error,
    }),
  );
}
