// Offline development-workspace backup and isolated PostgreSQL restore drill.
// Never restores over the live database; private dumps stay under ignored .data.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkRestoredHttp } from "./restore-http-check.js";
import { postgres } from "../apps/api/src/db.js";
import {
  backupModelVault,
  checkRestoredModelVault,
} from "./backup-model-vault.js";
import { connectDesktopDatabase } from "./desktop-database.js";
import {
  workspaceDatabaseTarget,
  assertDatabaseTarget,
} from "./workspace-database-target.js";

const exec = promisify(execFile);
const root = process.cwd();
const id = randomUUID();
const databaseTarget = await workspaceDatabaseTarget(root);
const source = databaseTarget.name;
const target = `codelab-restore-${id}`;
const network = `codelab-restore-network-${id}`;
const restorePassword = randomUUID();
const backup = path.join(root, ".data", "backups", id);
// Deliberately outside the database/evidence archive; retain separately when moving off host.
const vaultBackup = path.join(root, ".data", "model-key-backups", id);
const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const record = path.join(root, "docs/verification", date, `backup-${id}`);
const sourceEvidence = path.join(root, ".data/business-v2/evidence-v2");
async function docker(args: string[], env = process.env) {
  try {
    return (
      await exec("docker", args, {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 32 * 1024 * 1024,
        env,
      })
    ).stdout;
  } catch {
    throw new Error("BACKUP_DOCKER_COMMAND_FAILED");
  }
}
async function sql(container: string, query: string) {
  return (
    await docker([
      "exec",
      container,
      "psql",
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "codelab",
      "-c",
      query,
    ])
  ).trim();
}
async function assertOffline() {
  let responding = false;
  try {
    await fetch("http://127.0.0.1:3102/api/health", {
      signal: AbortSignal.timeout(1500),
    });
    responding = true;
  } catch {
    /* offline */
  }
  if (responding) throw new Error("STOP_WORKSPACE_BEFORE_BACKUP");
}
async function tableInventory(container: string) {
  const tables = (
    await sql(
      container,
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  )
    .split("\n")
    .filter(Boolean);
  const inventory: Record<string, { rows: number; sha256: string }> = {};
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table))
      throw new Error("UNEXPECTED_TABLE_NAME");
    // Hash every stored field, including private checkpoints, without logging rows.
    const content = await sql(
      container,
      `SELECT row_to_json(t)::text FROM public."${table}" t ORDER BY row_to_json(t)::text COLLATE "C"`,
    );
    inventory[table] = {
      rows: Number(
        await sql(container, `SELECT count(*) FROM public."${table}"`),
      ),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }
  return inventory;
}
async function fileInventory(directory: string, prefix = "") {
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const entry of await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("EVIDENCE_SYMLINK_REJECTED");
    if (entry.isDirectory())
      Object.assign(files, await fileInventory(directory, relative));
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(directory, relative));
      files[relative.replaceAll("\\", "/")] = {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } else throw new Error("UNEXPECTED_EVIDENCE_ENTRY");
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}
function same(a: unknown, b: unknown, error: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(error);
}

await assertOffline();
const sourceInfo = JSON.parse(await docker(["inspect", source]))[0];
assertDatabaseTarget(databaseTarget, sourceInfo);
if (
  sourceInfo.Config.Labels?.["codelab.workspace"] !== "v2" ||
  !sourceInfo.State.Running
)
  throw new Error("WORKSPACE_DATABASE_IDENTITY_MISMATCH");
if (
  Number(
    await sql(
      source,
      "SELECT (SELECT count(*) FROM execution_attempts WHERE owner_phase <> 'closed') + (SELECT count(*) FROM analysis_attempts WHERE mode='reanalysis' AND owner_phase IS NOT NULL AND owner_phase <> 'closed') + (SELECT count(*) FROM source_analyses WHERE status IN ('queued','running'))",
    ),
  ) !== 0
)
  throw new Error("WORKSPACE_RESOURCES_NOT_CLEAN");
// Old schema backups must remain usable before coursework is migrated.
if (
  await sql(source, "SELECT COALESCE(to_regclass('course_imports')::text,'')")
) {
  const active = await sql(
    source,
    "SELECT (SELECT count(*) FROM course_imports WHERE status IN ('created','fetching','validating')) + (SELECT count(*) FROM course_analyses WHERE status IN ('queued','running'))",
  );
  if (Number(active) !== 0)
    throw new Error("WORKSPACE_COURSEWORK_RESOURCES_NOT_CLEAN");
}
await mkdir(backup, { recursive: true });
await mkdir(record, { recursive: true });
let owned = false;
let networkOwned = false;
const result: Record<string, unknown> = {
  id,
  startedAt: new Date().toISOString(),
  scope: "offline-local-backup-isolated-restore",
  sourceUnchanged: false,
  passed: false,
};
try {
  const before = await tableInventory(source);
  const evidenceBefore = await fileInventory(sourceEvidence);
  const sourceDb = await connectDesktopDatabase();
  let vault: Awaited<ReturnType<typeof backupModelVault>>;
  try {
    vault = await backupModelVault(
      sourceDb,
      path.join(root, ".data"),
      vaultBackup,
    );
  } finally {
    await sourceDb.close();
  }
  // Container /tmp path is unique; dump is copied as binary without a shell pipe.
  const remoteDump = `/tmp/codelab-backup-${id}.dump`;
  try {
    await docker([
      "exec",
      source,
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "codelab",
      "-Fc",
      "-f",
      remoteDump,
    ]);
    await docker([
      "cp",
      `${source}:${remoteDump}`,
      path.join(backup, "database.dump"),
    ]);
  } finally {
    await docker(["exec", source, "rm", "-f", remoteDump]);
  }
  await cp(sourceEvidence, path.join(backup, "evidence-v2"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  same(
    evidenceBefore,
    await fileInventory(path.join(backup, "evidence-v2")),
    "BACKUP_EVIDENCE_MISMATCH",
  );
  await docker([
    "network",
    "create",
    "--label",
    `codelab.restore=${id}`,
    network,
  ]);
  networkOwned = true;
  await docker(
    [
      "create",
      "--name",
      target,
      "--label",
      `codelab.restore=${id}`,
      "--network",
      network,
      "--publish",
      "127.0.0.1::5432",
      "--memory",
      "384m",
      "--cpus",
      "1",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB=codelab",
      sourceInfo.Image,
    ],
    { ...process.env, POSTGRES_PASSWORD: restorePassword },
  );
  owned = true;
  await docker(["start", target]);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      // The image first starts a temporary Unix-only server; wait for final TCP readiness.
      await docker([
        "exec",
        target,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "codelab",
      ]);
      await sql(target, "SELECT 1");
      ready = true;
      break;
    } catch {
      await delay(500);
    }
  }
  if (!ready) throw new Error("RESTORE_DATABASE_NOT_READY");
  await docker([
    "cp",
    path.join(backup, "database.dump"),
    `${target}:/tmp/restore.dump`,
  ]);
  await docker([
    "exec",
    target,
    "pg_restore",
    "--exit-on-error",
    "-U",
    "postgres",
    "-d",
    "codelab",
    "/tmp/restore.dump",
  ]);
  const restored = await tableInventory(target);
  same(before, restored, "RESTORED_DATABASE_MISMATCH");
  // A second copy proves the backup is the source of recovered artifacts.
  await cp(
    path.join(backup, "evidence-v2"),
    path.join(backup, "restored-evidence-v2"),
    { recursive: true, errorOnExist: true, force: false },
  );
  same(
    evidenceBefore,
    await fileInventory(path.join(backup, "restored-evidence-v2")),
    "RESTORED_EVIDENCE_MISMATCH",
  );
  const restoredInfo = JSON.parse(await docker(["inspect", target]))[0];
  const binding = restoredInfo.NetworkSettings.Ports["5432/tcp"]?.[0];
  if (binding?.HostIp !== "127.0.0.1")
    throw new Error("RESTORE_DATABASE_NOT_LOOPBACK");
  const restoredDb = postgres(
    `postgres://postgres:${restorePassword}@127.0.0.1:${binding.HostPort}/codelab`,
  );
  try {
    result.modelCredentials = await checkRestoredModelVault(
      restoredDb,
      vaultBackup,
      vault,
    );
  } finally {
    await restoredDb.close();
  }
  const credentials = JSON.parse(
    await readFile(
      path.join(root, ".data/business-v2/development-credentials.json"),
      "utf8",
    ),
  );
  result.http = await checkRestoredHttp({
    databaseUrl: `postgres://postgres:${restorePassword}@127.0.0.1:${binding.HostPort}/codelab`,
    evidenceRoot: path.join(backup, "restored-evidence-v2"),
    password: credentials.loginPassword,
  });
  await assertOffline();
  same(before, await tableInventory(source), "SOURCE_CHANGED_DURING_BACKUP");
  same(
    evidenceBefore,
    await fileInventory(sourceEvidence),
    "SOURCE_EVIDENCE_CHANGED_DURING_BACKUP",
  );
  Object.assign(result, {
    sourceUnchanged: true,
    tables: restored,
    evidenceFiles: Object.keys(evidenceBefore).length,
    evidenceBytes: Object.values(evidenceBefore).reduce(
      (n, f) => n + f.bytes,
      0,
    ),
    dumpSha256: createHash("sha256")
      .update(await readFile(path.join(backup, "database.dump")))
      .digest("hex"),
    passed: true,
  });
  await writeFile(
    path.join(backup, "manifest.json"),
    JSON.stringify(
      {
        id,
        tables: before,
        evidence: evidenceBefore,
        modelVault: {
          ...vault,
          separateLocation: path.relative(root, vaultBackup),
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  result.error = error instanceof Error ? error.message : "BACKUP_FAILED";
  process.exitCode = 1;
} finally {
  try {
    if (owned) {
      const actual = JSON.parse(await docker(["inspect", target]))[0];
      if (actual.Config.Labels?.["codelab.restore"] !== id)
        throw new Error("RESTORE_CLEANUP_OWNERSHIP_MISMATCH");
      await docker(["rm", "-f", "-v", actual.Id]);
    }
    if (networkOwned) {
      const actual = JSON.parse(
        await docker(["network", "inspect", network]),
      )[0];
      if (actual.Labels?.["codelab.restore"] !== id)
        throw new Error("RESTORE_NETWORK_OWNERSHIP_MISMATCH");
      await docker(["network", "rm", actual.Id]);
    }
    result.cleanup = "clean";
  } catch {
    result.cleanup = "failed";
    result.passed = false;
    process.exitCode = 1;
  }
  result.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(record, "result.json"),
    JSON.stringify(result, null, 2),
  );
}
console.log(
  `备份恢复${result.passed ? "通过" : "失败"}；记录 ${path.relative(root, record)}。私有备份保留在 .data/backups/${id}；未覆盖原数据库。`,
);
