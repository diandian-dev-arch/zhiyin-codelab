// Column mapping; SQL migration is authoritative for constraints and triggers.
// Do not use drizzle push against production.
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  bigserial,
  primaryKey,
} from "drizzle-orm/pg-core";
const created = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const users = pgTable("users", {
  id: uuid().primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull(),
  role: text().notNull(),
  passwordHash: text("password_hash").notNull(),
});
export const classes = pgTable("classes", {
  id: uuid().primaryKey(),
  name: text().notNull(),
  teacherId: uuid("teacher_id")
    .notNull()
    .references(() => users.id),
});
export const memberships = pgTable("memberships", {
  classId: uuid("class_id")
    .notNull()
    .references(() => classes.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
});
export const sessions = pgTable("sessions", {
  id: text().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  csrf: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const tasks = pgTable("tasks", {
  id: uuid().primaryKey(),
  classId: uuid("class_id")
    .notNull()
    .references(() => classes.id),
  title: text().notNull(),
  description: text().notNull(),
  idempotencyKey: text("idempotency_key"),
  requestHash: text("request_hash"),
  createdAt: created(),
});
export const rules = pgTable("rules", {
  id: uuid().primaryKey(),
  taskId: uuid("task_id")
    .references(() => tasks.id)
    .notNull(),
  version: integer().notNull(),
  templateVersion: text("template_version").notNull(),
  criteria: jsonb().notNull(),
  contractVersion: integer("contract_version").notNull().default(1),
  ruleSnapshot: jsonb("rule_snapshot"),
  idempotencyKey: text("idempotency_key"),
  requestHash: text("request_hash"),
  createdAt: created(),
});
export const submissions = pgTable("submissions", {
  id: uuid().primaryKey(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  ruleId: uuid("rule_id")
    .notNull()
    .references(() => rules.id),
  sha256: text().notNull(),
  files: jsonb().notNull(),
  contractVersion: integer("contract_version").notNull().default(1),
  sourceManifest: jsonb("source_manifest"),
  sourceManifestSha256: text("source_manifest_sha256"),
  sourceManifestVersion: text("source_manifest_version"),
  requestId: text("request_id").notNull(),
  createdAt: created(),
});
export const runs = pgTable("runs", {
  id: uuid().primaryKey(),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => submissions.id),
  status: text().notNull(),
  contractVersion: integer("contract_version").notNull().default(1),
  ruleId: uuid("rule_id").references(() => rules.id),
  idempotencyKey: text("idempotency_key"),
  requestHash: text("request_hash"),
  acceptedExecutionAttemptId: uuid("accepted_execution_attempt_id"),
  pipelineStartedAt: timestamp("pipeline_started_at", { withTimezone: true }),
  pipelineDeadlineAt: timestamp("pipeline_deadline_at", { withTimezone: true }),
  retryOfRunId: uuid("retry_of_run_id"),
  outcome: text(),
  results: jsonb().notNull().default([]),
  evidence: jsonb().notNull().default([]),
  feedback: jsonb().notNull().default([]),
  reviewed: jsonb().notNull().default([]),
  revision: integer().notNull().default(0),
  modelStatus: text("model_status").notNull().default("pending"),
  executionConfig: jsonb("execution_config").notNull(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  attempts: integer().notNull().default(0),
  requestId: text("request_id").notNull(),
  createdAt: created(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export const reports = pgTable("reports", {
  id: uuid().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .unique()
    .references(() => runs.id),
  snapshot: jsonb().notNull(),
  publishedBy: uuid("published_by")
    .notNull()
    .references(() => users.id),
  createdAt: created(),
});
export const revisions = pgTable("revisions", {
  id: uuid().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  revision: integer().notNull(),
  payload: jsonb().notNull(),
  createdAt: created(),
});
export const events = pgTable("events", {
  id: bigserial({ mode: "number" }).primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  kind: text().notNull(),
  payload: jsonb().notNull(),
  createdAt: created(),
});

export const schemaMigrations = pgTable("schema_migrations", {
  version: integer().primaryKey(),
  name: text().notNull().unique(),
  checksum: text().notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

const ownerColumns = () => ({
  ownerPhase: text("owner_phase"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  cleanupState: text("cleanup_state").notNull().default("pending"),
  cleanupReceipt: jsonb("cleanup_receipt"),
  controlOperations: jsonb("control_operations").notNull().default({}),
});

export const executionAttempts = pgTable("execution_attempts", {
  id: uuid().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  attemptNo: integer("attempt_no").notNull(),
  ...ownerColumns(),
  ownerPhase: text("owner_phase").notNull(),
  pipelineStartedAt: timestamp("pipeline_started_at", {
    withTimezone: true,
  }).notNull(),
  pipelineDeadlineAt: timestamp("pipeline_deadline_at", {
    withTimezone: true,
  }).notNull(),
  workDeadlineAt: timestamp("work_deadline_at", {
    withTimezone: true,
  }).notNull(),
  baseSealedAt: timestamp("base_sealed_at", { withTimezone: true }),
  baseResults: jsonb("base_results").notNull().default([]),
  baseManifest: jsonb("base_manifest"),
  actualFingerprint: jsonb("actual_fingerprint"),
  createdAt: created(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const analysisAttempts = pgTable("analysis_attempts", {
  id: uuid().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  baseManifestId: uuid("base_manifest_id"),
  mode: text().notNull(),
  ownerExecutionAttemptId: uuid("owner_execution_attempt_id").references(
    () => executionAttempts.id,
  ),
  status: text().notNull(),
  configuration: jsonb().notNull().default({}),
  budget: jsonb().notNull().default({}),
  deadlines: jsonb().notNull().default({}),
  usage: jsonb().notNull().default({}),
  candidate: jsonb(),
  selectedAtStartRevisionId: uuid("selected_at_start_revision_id"),
  ...ownerColumns(),
  workDeadlineAt: timestamp("work_deadline_at", { withTimezone: true }),
  hardDeadlineAt: timestamp("hard_deadline_at", { withTimezone: true }),
  createdAt: created(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const analysisOperations = pgTable(
  "analysis_operations",
  {
    analysisAttemptId: uuid("analysis_attempt_id")
      .notNull()
      .references(() => analysisAttempts.id),
    operationId: uuid("operation_id").notNull(),
    kind: text().notNull(),
    requestHash: text("request_hash").notNull(),
    state: text().notNull(),
    reservedBudget: jsonb("reserved_budget").notNull(),
    actualUsage: jsonb("actual_usage"),
    providerRequestId: text("provider_request_id"),
    responseHash: text("response_hash"),
    supplementalManifest: jsonb("supplemental_manifest"),
    error: jsonb(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.analysisAttemptId, table.operationId] }),
  ],
);

export const reportRevisions = pgTable("report_revisions", {
  id: uuid().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  revisionNo: integer("revision_no").notNull(),
  parentRevisionId: uuid("parent_revision_id"),
  baseManifestId: uuid("base_manifest_id").notNull(),
  selectedSupplementalManifestIds: jsonb("selected_supplemental_manifest_ids")
    .notNull()
    .default([]),
  feedback: jsonb().notNull().default([]),
  teacherJudgments: jsonb("teacher_judgments").notNull().default([]),
  confirmations: jsonb().notNull().default([]),
  source: text().notNull(),
  originPublicationId: uuid("origin_publication_id"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: created(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
});

export const publications = pgTable("publications", {
  id: uuid().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  publicationNo: integer("publication_no").notNull(),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => reportRevisions.id),
  supersedesPublicationId: uuid("supersedes_publication_id"),
  purpose: text().notNull(),
  correctionReason: text("correction_reason"),
  snapshot: jsonb().notNull(),
  publicEvidenceIds: jsonb("public_evidence_ids").notNull().default([]),
  publishedBy: uuid("published_by")
    .notNull()
    .references(() => users.id),
  publishedAt: timestamp("published_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
});
