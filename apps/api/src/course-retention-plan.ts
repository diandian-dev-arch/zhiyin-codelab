import { z } from "zod";
import type { DB } from "./db.js";

const targetSchema = z
  .object({ taskId: z.string().uuid(), studentId: z.string().uuid() })
  .strict();

/** Read-only impact inventory, not a deletion permit. Comparison dynamically selects old submissions. */
export async function planCourseRetention(db: DB, raw: unknown) {
  const target = targetSchema.parse(raw);
  return db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await tx.exec("SET LOCAL statement_timeout = '30s'");
    return readCourseRetentionPlan(tx, target);
  });
}

/** Internal: caller owns the transaction/snapshot or maintenance table locks. */
export async function readCourseRetentionPlan(tx: DB, raw: unknown) {
  const target = targetSchema.parse(raw);
  if (
    (
      await tx.query("SELECT 1 FROM course_tasks WHERE task_id=$1", [
        target.taskId,
      ])
    ).rows.length
  )
    throw new Error("RETENTION_COURSEWORK_POLICY_REQUIRED");
  if (
    !(
      await tx.query(
        `SELECT t.id FROM tasks t CROSS JOIN users u
      WHERE t.id=$1 AND u.id=$2 AND u.role='student'`,
        [target.taskId, target.studentId],
      )
    ).rows.length
  )
    throw new Error("RETENTION_COURSE_TARGET_NOT_FOUND");
  // Keep scope bounded without loading uploaded source, candidate reports or private model IO.
  const submissions = (
    await tx.query(
      `SELECT id,contract_version FROM submissions
      WHERE task_id=$1 AND user_id=$2 ORDER BY id LIMIT 10001`,
      [target.taskId, target.studentId],
    )
  ).rows;
  if (submissions.length > 10000) throw new Error("RETENTION_COURSE_ROW_LIMIT");
  if (!submissions.length)
    throw new Error("RETENTION_COURSE_HISTORY_NOT_FOUND");
  const runs = (
    await tx.query(
      `SELECT id,contract_version,status FROM runs
      WHERE submission_id=ANY($1::uuid[]) ORDER BY id LIMIT 10001`,
      [submissions.map((s) => s.id)],
    )
  ).rows;
  if (runs.length > 10000) throw new Error("RETENTION_COURSE_ROW_LIMIT");
  const ids = runs.map((r) => r.id);
  const counts = (
    await tx.query(
      `WITH a AS MATERIALIZED
      (SELECT id FROM analysis_attempts WHERE run_id=ANY($1::uuid[])) SELECT
      (SELECT count(*)::int FROM execution_attempts WHERE run_id=ANY($1::uuid[])) AS executions,
      (SELECT count(*)::int FROM analysis_attempts WHERE run_id=ANY($1::uuid[])) AS analyses,
      (SELECT count(*)::int FROM analysis_operations WHERE analysis_attempt_id IN (SELECT id FROM a)) AS operations,
      (SELECT count(*)::int FROM analysis_private_io WHERE analysis_attempt_id IN (SELECT id FROM a)) AS private_io,
      (SELECT count(*)::int FROM analysis_checkpoints WHERE analysis_attempt_id IN (SELECT id FROM a)) AS checkpoints,
      (SELECT count(*)::int FROM analysis_checkpoint_writes WHERE analysis_attempt_id IN (SELECT id FROM a)) AS checkpoint_writes,
      (SELECT count(*)::int FROM report_revisions WHERE run_id=ANY($1::uuid[])) AS teacher_revisions,
      (SELECT count(*)::int FROM publications WHERE run_id=ANY($1::uuid[])) AS publications,
      (SELECT count(*)::int FROM reports WHERE run_id=ANY($1::uuid[])) AS legacy_reports,
      (SELECT count(*)::int FROM revisions WHERE run_id=ANY($1::uuid[])) AS legacy_revisions,
      (SELECT count(*)::int FROM events WHERE run_id=ANY($1::uuid[])) AS events,
      (SELECT count(*)::int FROM retention_holds WHERE run_id=ANY($1::uuid[])) AS holds,
      (SELECT count(*)::int FROM retention_hold_releases WHERE hold_id IN
        (SELECT id FROM retention_holds WHERE run_id=ANY($1::uuid[]))) AS hold_releases,
      (SELECT count(*)::int FROM retention_holds h WHERE run_id=ANY($1::uuid[]) AND NOT EXISTS
        (SELECT 1 FROM retention_hold_releases r WHERE r.hold_id=h.id)) AS active_holds,
      (SELECT count(*)::int FROM execution_attempts WHERE run_id=ANY($1::uuid[]) AND owner_phase<>'closed') AS open_executions,
      (SELECT count(*)::int FROM analysis_attempts WHERE run_id=ANY($1::uuid[]) AND
        (status IN ('queued','running') OR owner_phase IS NOT NULL AND owner_phase<>'closed')) AS active_analyses,
      (SELECT count(*)::int FROM analysis_operations WHERE analysis_attempt_id IN (SELECT id FROM a)
        AND state IN ('reserved','sent')) AS unsettled_operations,
      (SELECT count(*)::int FROM events WHERE run_id=ANY($1::uuid[]) AND kind='v2_invalid_partial_quarantined') AS quarantined_events,
      (SELECT count(*)::int FROM runs WHERE NOT(id=ANY($1::uuid[])) AND retry_of_run_id=ANY($1::uuid[])) AS incoming_retry_references,
      (SELECT count(*)::int FROM runs WHERE id=ANY($1::uuid[]) AND retry_of_run_id IS NOT NULL
        AND NOT(retry_of_run_id=ANY($1::uuid[]))) AS outgoing_retry_references,
      (SELECT count(*)::int FROM analysis_attempts other WHERE NOT(other.run_id=ANY($1::uuid[]))
        AND other.configuration->>'pairedWithAnalysisId' IN (SELECT id::text FROM a)) AS incoming_pair_references,
      (SELECT count(*)::int FROM analysis_attempts own WHERE own.id IN (SELECT id FROM a)
        AND own.configuration->>'pairedWithAnalysisId' IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM a WHERE a.id::text=own.configuration->>'pairedWithAnalysisId')) AS outside_or_missing_pair_references
    `,
      [ids],
    )
  ).rows[0];
  const blockers = [
    "COURSE_RETENTION_POLICY_REQUIRED",
    "EXTERNAL_REFERENCES_REVIEW_REQUIRED",
    "COURSE_DELETE_EXECUTOR_NOT_IMPLEMENTED",
  ];
  if (
    submissions.some((s) => s.contract_version !== 2) ||
    runs.some((r) => r.contract_version !== 2) ||
    counts.legacy_reports ||
    counts.legacy_revisions
  )
    blockers.push("LEGACY_HISTORY_REQUIRES_SEPARATE_REVIEW");
  if (
    runs.some((r) =>
      ["queued", "preparing", "building", "checking", "analyzing"].includes(
        r.status,
      ),
    ) ||
    counts.open_executions ||
    counts.active_analyses
  )
    blockers.push("ACTIVE_WORK_OR_CLEANUP");
  if (counts.unsettled_operations)
    blockers.push("UNSETTLED_ANALYSIS_OPERATION");
  if (counts.active_holds) blockers.push("ACTIVE_RETENTION_HOLD");
  if (counts.quarantined_events)
    blockers.push("QUARANTINED_MATERIAL_REQUIRES_REVIEW");
  if (
    counts.incoming_retry_references ||
    counts.outgoing_retry_references ||
    counts.incoming_pair_references ||
    counts.outside_or_missing_pair_references
  )
    blockers.push("CROSS_SCOPE_OR_MISSING_REFERENCE");
  return {
    version: 1,
    target,
    scope: "all_submissions_and_runs_for_student_task",
    checkedAt: new Date().toISOString(),
    deletionAuthorized: false,
    deletionExecutorAvailable: false,
    counts: { submissions: submissions.length, runs: runs.length, ...counts },
    blockers,
    excluded: [
      "other students and tasks",
      "shared task and rule definitions",
      "accounts and personal model credentials",
      "ordinary ZIP projects",
      "backups and external copies",
    ],
    limitations: [
      "Read-only database snapshot; it does not reserve the scope against future submissions or teacher edits.",
      "No evidence files are read, hashed, moved or deleted. Run retention:check separately for current evidence integrity.",
      "Counts do not validate arbitrary JSON references, report semantics, external evaluation links or authorization.",
      "Immutable records, cyclic foreign keys and durable filesystem cleanup require an explicit deletion protocol; no constraints are bypassed.",
    ],
  };
}
