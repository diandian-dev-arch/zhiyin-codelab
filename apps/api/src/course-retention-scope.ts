import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@codelab/contracts/v2";
import type { DB } from "./db.js";
import { readCourseRetentionPlan } from "./course-retention-plan.js";

const targetSchema = z
  .object({ taskId: z.string().uuid(), studentId: z.string().uuid() })
  .strict();
const submissions =
  "SELECT id FROM submissions WHERE task_id=$1 AND user_id=$2";
const runs = `SELECT id FROM runs WHERE submission_id IN (${submissions})`;
const analyses = `SELECT id FROM analysis_attempts WHERE run_id IN (${runs})`;
// Fixed identifiers only. Every current course-owned dependency is represented, including v1 rows.
const tables = [
  ["submissions", "task_id=$1 AND user_id=$2"],
  ["runs", `submission_id IN (${submissions})`],
  ["execution_attempts", `run_id IN (${runs})`],
  ["analysis_attempts", `run_id IN (${runs})`],
  ["analysis_operations", `analysis_attempt_id IN (${analyses})`],
  ["analysis_private_io", `analysis_attempt_id IN (${analyses})`],
  ["analysis_checkpoints", `analysis_attempt_id IN (${analyses})`],
  ["analysis_checkpoint_writes", `analysis_attempt_id IN (${analyses})`],
  ["report_revisions", `run_id IN (${runs})`],
  ["publications", `run_id IN (${runs})`],
  ["reports", `run_id IN (${runs})`],
  ["revisions", `run_id IN (${runs})`],
  ["events", `run_id IN (${runs})`],
  ["retention_holds", `run_id IN (${runs})`],
  [
    "retention_hold_releases",
    `hold_id IN (SELECT id FROM retention_holds WHERE run_id IN (${runs}))`,
  ],
] as const;
const noWork = async (tx: DB) => {
  const row = (
    await tx.query(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM runs WHERE status IN ('queued','preparing','building','checking','analyzing')) OR
    EXISTS(SELECT 1 FROM execution_attempts WHERE owner_phase<>'closed') OR
    EXISTS(SELECT 1 FROM analysis_attempts WHERE status IN ('queued','running') OR owner_phase IS NOT NULL AND owner_phase<>'closed') OR
    EXISTS(SELECT 1 FROM analysis_operations WHERE state IN ('reserved','sent')) OR
    EXISTS(SELECT 1 FROM course_imports WHERE status IN ('created','fetching','validating')) OR
    EXISTS(SELECT 1 FROM course_analyses WHERE status IN ('queued','running'))`)
  ).rows[0];
  if (row) throw new Error("RETENTION_COURSE_WORKSPACE_BUSY");
};

export type FrozenCourseHistory = {
  target: z.infer<typeof targetSchema>;
  fingerprint: string;
  tables: Record<string, { rows: number; bytes: number }>;
  impact: Awaited<ReturnType<typeof readCourseRetentionPlan>>;
  deletionAuthorized: false;
};

/** Internal maintenance primitive. No authorization, trigger bypass or filesystem action.
 * Requires a top-level database connection, not an existing transaction.
 * Callback must do bounded database work only. Locks affect all course writes until it returns.
 * A future executor must independently validate authorization and every impact blocker.
 */
export async function withFrozenCourseHistory<T>(
  db: DB,
  raw: unknown,
  operation: (tx: DB, snapshot: FrozenCourseHistory) => Promise<T>,
  expectedFingerprint?: string,
): Promise<T> {
  const target = targetSchema.parse(raw);
  if (
    expectedFingerprint !== undefined &&
    !/^[a-f0-9]{64}$/.test(expectedFingerprint)
  )
    throw new Error("RETENTION_COURSE_FINGERPRINT_INVALID");
  return db.transaction(async (tx) => {
    // The post-lock check must see commits made while waiting, not an older repeatable-read snapshot.
    await tx.exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await tx.exec(
      "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'",
    );
    await noWork(tx);
    // Blocks writes even from code paths that do not use an advisory lock; ordinary SELECT stays available.
    await tx.exec(
      `LOCK TABLE tasks,users,${tables.map(([table]) => table).join(",")} IN SHARE ROW EXCLUSIVE MODE`,
    );
    await noWork(tx); // A claim/submission may have committed while table locks were being acquired.
    // Inspect all schemas: a new table outside this inventory must not silently acquire
    // cascading deletion eligibility. Include empty referencing tables as schema changes.
    const foreignKeys = (
      await tx.query(
        `SELECT sn.nspname AS source_schema,s.relname AS source_table,
      tn.nspname AS target_schema,t.relname AS target_table,c.conname AS name,
      pg_get_constraintdef(c.oid) AS definition,
      sn.nspname=current_schema() AS source_local
      FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid
      JOIN pg_namespace sn ON sn.oid=s.relnamespace JOIN pg_class t ON t.oid=c.confrelid
      JOIN pg_namespace tn ON tn.oid=t.relnamespace
      WHERE c.contype='f' AND tn.nspname=current_schema() AND t.relname=ANY($1::text[])
      ORDER BY sn.nspname COLLATE "C",s.relname COLLATE "C",c.conname COLLATE "C" LIMIT 1001`,
        [tables.map(([name]) => name)],
      )
    ).rows;
    if (foreignKeys.length > 1000)
      throw new Error("RETENTION_COURSE_SCHEMA_LIMIT");
    if (
      foreignKeys.some(
        (f) =>
          !f.source_local || !tables.some(([name]) => name === f.source_table),
      )
    )
      throw new Error("RETENTION_COURSE_UNSUPPORTED_REFERENCE_TABLE");
    const migrations = (
      await tx.query(
        "SELECT version,name,checksum FROM schema_migrations ORDER BY version LIMIT 1001",
      )
    ).rows;
    if (migrations.length > 1000)
      throw new Error("RETENTION_COURSE_SCHEMA_LIMIT");
    const impact = await readCourseRetentionPlan(tx, target);
    const digest = createHash("sha256");
    // Schema names differ in disposable test schemas; all accepted edges are local.
    // Keep restore-stable identity without PostgreSQL OIDs or catalog timestamps.
    digest.update(
      canonicalJson({
        version: 2,
        target,
        migrations,
        foreignKeys: foreignKeys.map((f) => ({
          source: f.source_table,
          target: f.target_table,
          name: f.name,
          definition: f.definition,
        })),
      }),
    );
    const inventory: FrozenCourseHistory["tables"] = {};
    let totalBytes = 0;
    for (const [table, where] of tables) {
      const size = (
        await tx.query(
          `SELECT count(*)::int AS rows,COALESCE(sum(octet_length(to_jsonb(t)::text)),0)::text AS bytes
        FROM ${table} t WHERE ${where}`,
          [target.taskId, target.studentId],
        )
      ).rows[0];
      const bytes = Number(size.bytes);
      if (size.rows > 10000 || !Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error("RETENTION_COURSE_ROW_LIMIT");
      totalBytes += bytes;
      if (totalBytes > 64 * 1024 * 1024)
        throw new Error("RETENTION_COURSE_SIZE_LIMIT");
      inventory[table] = { rows: size.rows, bytes };
      digest.update(canonicalJson({ table, rows: size.rows }));
      const rows = (
        await tx.query(
          `SELECT to_jsonb(t) AS data FROM ${table} t WHERE ${where}
        ORDER BY to_jsonb(t)::text COLLATE "C"`,
          [target.taskId, target.studentId],
        )
      ).rows;
      for (const row of rows) digest.update(canonicalJson(row.data) + "\n");
    }
    // Blocker counts include incoming cross-scope references, not just rows scheduled for later cleanup.
    digest.update(
      canonicalJson({ counts: impact.counts, blockers: impact.blockers }),
    );
    const fingerprint = digest.digest("hex");
    if (expectedFingerprint && expectedFingerprint !== fingerprint)
      throw new Error("RETENTION_COURSE_PLAN_STALE");
    return operation(tx, {
      target,
      fingerprint,
      tables: inventory,
      impact,
      deletionAuthorized: false,
    });
  });
}
