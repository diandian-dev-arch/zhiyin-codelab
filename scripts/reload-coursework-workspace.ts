// Reload only the freshly inspected, idle local workbench; preserve every business row.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { connectDesktopDatabase } from "./desktop-database.js";
const supervisorId = Number(process.argv[2]),
  childId = Number(process.argv[3]);
assert(
  Number.isSafeInteger(supervisorId) &&
    supervisorId > 0 &&
    Number.isSafeInteger(childId) &&
    childId > 0,
  "INSPECTED_PROCESS_IDS_REQUIRED",
);
const exec = promisify(execFile),
  root = process.cwd();
const record = path.resolve(
  process.argv[4] ??
    "docs/verification/2026-10-18/coursework/workspace-reload.json",
);
assert(
  record.startsWith(path.resolve("docs/verification") + path.sep),
  "RECORD_OUTSIDE_VERIFICATION",
);
const receipt: any = {
  startedAt: new Date().toISOString(),
  passed: false,
  supervisorId,
  childId,
  externalModelCalls: 0,
};
async function ps(command: string) {
  const { stdout } = await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 15000 },
  );
  return stdout.trim() ? JSON.parse(stdout) : null;
}
const proc = (pid: number) =>
  ps(
    `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`,
  );
const ports = async () =>
  (await ps(
    "ConvertTo-Json -InputObject @(Get-NetTCPConnection -State Listen -LocalPort 3102,3103,5174 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess) -Compress",
  )) ?? [];
const db = await connectDesktopDatabase();
async function idle() {
  const row = (
    await db.query(`SELECT
    (SELECT count(*) FROM source_analyses WHERE status IN ('queued','running')) AS source,
    (SELECT count(*) FROM execution_attempts WHERE owner_phase<>'closed') AS executions,
    (SELECT count(*) FROM analysis_attempts WHERE status IN ('queued','running') OR owner_phase<>'closed') AS analyses,
    (SELECT count(*) FROM runs WHERE status IN ('queued','preparing','building','checking','analyzing')) AS runs,
    (SELECT count(*) FROM course_imports WHERE status IN ('created','fetching','validating')) AS imports,
    (SELECT count(*) FROM course_analyses WHERE status IN ('queued','running')) AS coursework`)
  ).rows[0];
  assert(
    Object.values(row).every((n) => Number(n) === 0),
    "WORKSPACE_HAS_ACTIVE_WORK",
  );
  return row;
}
async function inventory() {
  const result: Record<string, unknown> = {};
  const tables = (
    await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'sessions' ORDER BY tablename",
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
        .update(rows.map((r) => r.value).join("\n"))
        .digest("hex"),
    };
  }
  return result;
}
let stopped = false;
try {
  const listeners = await ports();
  assert.equal(
    listeners.find((p: any) => p.LocalPort === 3103)?.OwningProcess,
    supervisorId,
    "SUPERVISOR_CHANGED",
  );
  for (const port of [3102, 5174])
    assert.equal(
      listeners.find((p: any) => p.LocalPort === port)?.OwningProcess,
      childId,
      "WORKSPACE_CHANGED",
    );
  assert.match(
    (await proc(supervisorId))?.CommandLine,
    /scripts[\\/]supervised-workspace\.ts/,
  );
  const child = await proc(childId);
  assert.equal(child?.ParentProcessId, supervisorId);
  assert.match(child?.CommandLine, /scripts[\\/]workspace-v2\.ts/);
  assert.equal(
    (await db.query("SELECT max(version)::int AS n FROM schema_migrations"))
      .rows[0].n,
    22,
  );
  receipt.idleBefore = await idle();
  receipt.before = await inventory();
  await idle();
  // Losing its owned IPC parent triggers workspace-v2's existing graceful shutdown.
  process.kill(supervisorId, "SIGKILL");
  stopped = true;
  const until = Date.now() + 25000;
  while (Date.now() < until && (await proc(childId))) await delay(250);
  assert.equal(await proc(childId), null, "WORKSPACE_DID_NOT_STOP");
  assert.equal((await ports()).length, 0, "WORKSPACE_PORTS_NOT_RELEASED");
} catch (error) {
  receipt.error =
    error instanceof assert.AssertionError
      ? error.message
      : "WORKSPACE_RELOAD_FAILED";
  process.exitCode = 1;
} finally {
  if (stopped) {
    try {
      assert.equal((await ports()).length, 0, "WORKSPACE_PORTS_OCCUPIED");
      const { stdout } = await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-File",
          "scripts/start-workspace-background.ps1",
          "-SchemaVersion",
          "22",
        ],
        { cwd: root, windowsHide: true, timeout: 120000 },
      );
      receipt.launch = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
      assert.equal(receipt.launch.status, "ready");
      const response = await fetch("http://127.0.0.1:5174/api/v1/health", {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).businessVersion, 2);
      receipt.after = await inventory();
      assert.deepEqual(receipt.after, receipt.before, "BUSINESS_DATA_CHANGED");
      receipt.idleAfter = await idle();
      receipt.passed = !receipt.error;
    } catch {
      receipt.error = "WORKSPACE_RESTART_OR_DATA_CHECK_FAILED";
      process.exitCode = 1;
    }
  }
  await db.close();
  receipt.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      stopped,
      status: receipt.launch?.status,
      error: receipt.error,
      record: path.relative(root, record),
    }),
  );
}
