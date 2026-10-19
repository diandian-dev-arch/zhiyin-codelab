import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@codelab/contracts/v2';
import type { DB } from './db.js';

const uuid = z.string().uuid();
const reason = z.string().trim().min(3).max(300);
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex');
const retentionLock = 41724; // Same lock as source upload, enqueue, claim, and account settings.
const targetSchema = z.object({ projectId: uuid, ownerId: uuid }).strict();
const holdSchema = targetSchema.extend({ action: z.enum(['hold','release']), requestId: uuid, reason,
  holdId: uuid.optional() }).strict().refine(v => (v.action === 'release') === !!v.holdId);
const deleteSchema = targetSchema.extend({ requestId: uuid, reason,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  authorizationReference: z.string().trim().min(3).max(300),
  externalReferencesReviewed: z.literal(true),
  confirm: z.literal('DELETE_SOURCE_PROJECT_AND_ALL_ANALYSES'),
}).strict();

async function lock(tx: DB) {
  await tx.exec("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s'");
  await tx.query('SELECT pg_advisory_xact_lock($1)', [retentionLock]);
}

async function snapshot(tx: DB, target: z.infer<typeof targetSchema>) {
  const project = (await tx.query('SELECT to_jsonb(p) AS data FROM source_projects p WHERE id=$1 AND owner_id=$2 FOR UPDATE OF p',
    [target.projectId, target.ownerId])).rows[0]?.data;
  if (!project) throw new Error('RETENTION_SOURCE_NOT_FOUND');
  // Bound memory before loading historical model output. Never return it in the plan.
  const size = (await tx.query(`SELECT
    (SELECT COALESCE(sum(octet_length(row_to_json(a)::text)),0) FROM source_analyses a WHERE project_id=$1) +
    (SELECT octet_length(row_to_json(p)::text) FROM source_projects p WHERE id=$1) +
    (SELECT COALESCE(sum(octet_length(row_to_json(c)::text)),0) FROM source_model_calls c JOIN source_analyses a ON a.id=c.analysis_id WHERE a.project_id=$1) AS bytes`, [target.projectId])).rows[0];
  if (Number(size.bytes) > 64 * 1024 * 1024) throw new Error('RETENTION_SOURCE_SIZE_LIMIT');
  const analyses = (await tx.query('SELECT to_jsonb(a) AS data FROM source_analyses a WHERE project_id=$1 ORDER BY id LIMIT 10001 FOR UPDATE OF a', [target.projectId])).rows.map(r=>r.data);
  if (analyses.length > 10000) throw new Error('RETENTION_SOURCE_ROW_LIMIT');
  const calls = (await tx.query(`SELECT to_jsonb(c) AS data FROM source_model_calls c JOIN source_analyses a ON a.id=c.analysis_id
    WHERE a.project_id=$1 ORDER BY c.id LIMIT 160001 FOR UPDATE OF c`, [target.projectId])).rows.map(r=>r.data);
  if (calls.length > 160000) throw new Error('RETENTION_SOURCE_ROW_LIMIT');
  const events = (await tx.query('SELECT to_jsonb(e) AS data FROM source_retention_events e WHERE project_id=$1 ORDER BY id LIMIT 10001', [target.projectId])).rows.map(r=>r.data);
  if (events.length > 10000) throw new Error('RETENTION_SOURCE_ROW_LIMIT');
  const activeHolds = events.filter(e => e.action === 'hold' && !events.some(r => r.action === 'release' && r.hold_id === e.id));
  const blockers: string[] = [];
  if (analyses.some(a => ['queued','running'].includes(a.status))) blockers.push('ACTIVE_ANALYSIS');
  if (calls.some(c => c.state === 'started')) blockers.push('UNSETTLED_MODEL_CALL');
  if (activeHolds.length) blockers.push('ACTIVE_RETENTION_HOLD');
  if ((await tx.query('SELECT 1 FROM project_submissions WHERE project_id=$1 LIMIT 1', [target.projectId])).rows.length)
    blockers.push('COURSE_SUBMISSION_REFERENCE');
  if (!project.files || Array.isArray(project.files) || typeof project.files !== 'object') blockers.push('INVALID_SOURCE_FILES');
  return { version: 1 as const, projectId: target.projectId, ownerId: target.ownerId,
    fingerprint: digest({ project, analyses, calls, events }),
    counts: { files: project.files && typeof project.files === 'object' ? Object.keys(project.files).length : 0,
      analyses: analyses.length, modelCalls: calls.length, activeHolds: activeHolds.length },
    blockers, deletionAuthorized: false as const,
    scope: 'source project, all analysis history and model receipts in the current database',
    excluded: ['course submissions and published reports', 'personal model credentials', 'backups and external copies'],
  };
}

/** Local operator preview only. A fingerprint is not authorization or a backup. */
export async function planSourceDeletion(db: DB, raw: unknown) {
  const target = targetSchema.parse(raw);
  return db.transaction(async tx => {
    await lock(tx);
    return snapshot(tx, target);
  });
}

async function replay(tx: DB, requestId: string, requestHash: string) {
  const previous = (await tx.query('SELECT id,request_hash,receipt FROM source_retention_events WHERE request_id=$1', [requestId])).rows[0];
  if (!previous) return;
  if (previous.request_hash !== requestHash) throw new Error('RETENTION_REQUEST_CONFLICT');
  return { eventId: previous.id as string, ...previous.receipt, replayed: true };
}

export async function changeSourceRetentionHold(db: DB, raw: unknown) {
  const input = holdSchema.parse(raw), requestHash = digest(input);
  return db.transaction(async tx => {
    await lock(tx);
    const previous = await replay(tx, input.requestId, requestHash);
    if (previous) return previous;
    if (!(await tx.query('SELECT id FROM source_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE', [input.projectId,input.ownerId])).rows.length)
      throw new Error('RETENTION_SOURCE_NOT_FOUND');
    if (input.action === 'release') {
      const hold = (await tx.query("SELECT id FROM source_retention_events WHERE id=$1 AND project_id=$2 AND action='hold'", [input.holdId, input.projectId])).rows[0];
      if (!hold) throw new Error('RETENTION_HOLD_NOT_FOUND');
      if ((await tx.query("SELECT id FROM source_retention_events WHERE hold_id=$1", [input.holdId])).rows.length)
        throw new Error('RETENTION_HOLD_ALREADY_RELEASED');
    }
    const eventId = randomUUID(), receipt = { action: input.action, projectId: input.projectId, deletionAuthorized: false };
    await tx.query(`INSERT INTO source_retention_events(id,project_id,request_id,action,hold_id,reason,request_hash,receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [eventId,input.projectId,input.requestId,input.action,input.holdId ?? null,input.reason,requestHash,JSON.stringify(receipt)]);
    return { eventId, ...receipt, replayed: false };
  });
}

/** Explicit operator authorization assertion; never call automatically from an age/disk threshold. */
export async function executeSourceDeletion(db: DB, raw: unknown) {
  const input = deleteSchema.parse(raw), requestHash = digest(input);
  return db.transaction(async tx => {
    await lock(tx);
    const previous = await replay(tx, input.requestId, requestHash);
    if (previous) return previous;
    const plan = await snapshot(tx, { projectId: input.projectId, ownerId: input.ownerId });
    if (plan.blockers.length) throw new Error(`RETENTION_SOURCE_BLOCKED_${plan.blockers[0]}`);
    if (plan.fingerprint !== input.fingerprint) throw new Error('RETENTION_SOURCE_PLAN_STALE');
    const eventId = randomUUID();
    const receipt = { action: 'delete', projectId: input.projectId, counts: plan.counts,
      fingerprint: plan.fingerprint, authorizationReference: input.authorizationReference,
      externalReferencesReviewed: true, excluded: plan.excluded };
    // No trigger bypass. Ledger and deletion commit together, or all roll back.
    await tx.query(`INSERT INTO source_retention_events(id,project_id,request_id,action,reason,request_hash,receipt)
      VALUES($1,$2,$3,'delete',$4,$5,$6)`, [eventId,input.projectId,input.requestId,input.reason,requestHash,JSON.stringify(receipt)]);
    await tx.query('DELETE FROM source_model_calls WHERE analysis_id IN (SELECT id FROM source_analyses WHERE project_id=$1)', [input.projectId]);
    await tx.query('DELETE FROM source_analyses WHERE project_id=$1', [input.projectId]);
    await tx.query('DELETE FROM source_projects WHERE id=$1 AND owner_id=$2', [input.projectId,input.ownerId]);
    return { eventId, ...receipt, replayed: false };
  });
}
