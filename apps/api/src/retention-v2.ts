import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { artifactManifestSchema, canonicalJson, evidenceSchema, hashArtifactManifest,
  hashPublicationSnapshot, publicationSnapshotSchema, type Evidence } from '@codelab/contracts/v2';
import type { DB } from './db.js';
import { ArtifactStore } from './artifacts-v2.js';

type Source = { id: string; runId: string; kind: string; value: unknown };
type Issue = { code: string; source: string };
const rowLimit = 10_000;

/** Operator-only inventory. Deliberately grants no deletion authority, including for unreferenced files. */
export async function auditRetentionV2(db: DB, store: ArtifactStore) {
  const issues: Issue[] = [];
  const issue = (code: string, source: string) => { issues.push({ code, source }); };
  const snapshot = await db.transaction(async tx => {
    await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await tx.exec("SET LOCAL statement_timeout = '30s'");
    const rows = async (query: string) => {
      const result = (await tx.query(`${query} LIMIT ${rowLimit + 1}`)).rows;
      if (result.length > rowLimit) throw new Error('RETENTION_ROW_LIMIT');
      return result;
    };
    const runs = await rows(`SELECT r.id,r.submission_id,r.status,r.accepted_execution_attempt_id,s.task_id,s.user_id
      FROM runs r JOIN submissions s ON s.id=r.submission_id WHERE r.contract_version=2 ORDER BY r.id`);
    const executions = await rows('SELECT id,run_id,owner_phase,base_sealed_at,base_manifest FROM execution_attempts ORDER BY id');
    const analyses = await rows(`SELECT id,run_id,status,owner_phase,base_manifest_id,selected_at_start_revision_id,
      configuration->>'pairedWithAnalysisId' AS paired_id,candidate FROM analysis_attempts ORDER BY id`);
    const operations = await rows(`SELECT analysis_attempt_id,operation_id,state,supplemental_manifest
      FROM analysis_operations ORDER BY analysis_attempt_id,operation_id`);
    const revisions = await rows(`SELECT id,run_id,base_manifest_id,selected_supplemental_manifest_ids,feedback,
      teacher_judgments FROM report_revisions ORDER BY id`);
    const publications = await rows('SELECT id,run_id,revision_id,snapshot FROM publications ORDER BY id');
    const holds = await rows(`SELECT h.id,h.run_id,h.reason,h.created_at,r.id AS release_id,r.reason AS release_reason,r.created_at AS released_at
      FROM retention_holds h LEFT JOIN retention_hold_releases r ON r.hold_id=h.id ORDER BY h.id`);
    // Quarantined input is retained even when it cannot be trusted as evidence.
    const quarantine = await rows("SELECT id,run_id FROM events WHERE kind='v2_invalid_partial_quarantined' ORDER BY id");
    const counts = (await tx.query(`SELECT
      (SELECT count(*) FROM analysis_private_io) AS private_io,
      (SELECT count(*) FROM analysis_checkpoints) AS checkpoints,
      (SELECT count(*) FROM analysis_checkpoint_writes) AS checkpoint_writes,
      (SELECT count(*) FROM submissions WHERE contract_version=2) AS submissions`)).rows[0];
    // Aggregate in SQL: never copy uploaded source, model output or credentials into the audit.
    const sourceInventory = (await tx.query(`SELECT
      (SELECT count(*)::int FROM source_projects) AS projects,
      (SELECT count(*)::int FROM source_projects p CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(p.files)='object' THEN p.files ELSE '{}'::jsonb END) k) AS files,
      (SELECT count(*)::int FROM source_projects WHERE jsonb_typeof(files) IS DISTINCT FROM 'object') AS invalid_file_lists,
      (SELECT count(*)::int FROM source_analyses) AS analyses,
      (SELECT count(*)::int FROM source_analyses WHERE status IN ('queued','running')) AS active_analyses,
      (SELECT count(*)::int FROM source_model_calls) AS model_calls,
      (SELECT count(*)::int FROM source_model_calls WHERE state='started') AS unsettled_model_calls
    `)).rows[0];
    const sourceRetentionInstalled = !!(await tx.query("SELECT to_regclass('source_retention_events') AS relation")).rows[0].relation;
    const sourceRetention = sourceRetentionInstalled ? { installed: true, ...(await tx.query(`SELECT
      count(*) FILTER (WHERE action='hold')::int AS holds,
      count(*) FILTER (WHERE action='release')::int AS releases,
      count(*) FILTER (WHERE action='delete')::int AS deleted_projects,
      count(*) FILTER (WHERE action='hold' AND NOT EXISTS
        (SELECT 1 FROM source_retention_events r WHERE r.hold_id=e.id AND r.action='release'))::int AS active_holds
      FROM source_retention_events e`)).rows[0] } : { installed: false };
    return { runs, executions, analyses, operations, revisions, publications, holds, quarantine, counts, sourceInventory, sourceRetention };
  });
  const evidence = new Map<string, { evidence: Evidence; reasons: Set<string> }>();
  if (snapshot.sourceInventory.invalid_file_lists > 0)
    issue('INVALID_SOURCE_FILE_LIST', 'source-projects');
  const byRef = new Map<string, string>();
  const manifests = new Map<string, { runId: string; hash: string; keys: string[] }>();
  const sources: Source[] = [];
  const runIds = new Set(snapshot.runs.map(r => r.id));
  function registerEvidence(value: unknown, source: string) {
    const parsed = evidenceSchema.safeParse(value);
    if (!parsed.success) { issue('INVALID_EVIDENCE', source); return; }
    const e = parsed.data;
    const existing = evidence.get(e.storageKey);
    if (existing && canonicalJson(existing.evidence) !== canonicalJson(e)) {
      issue('CONFLICTING_EVIDENCE', source); return;
    }
    const ref = `${e.manifestId}:${e.evidenceId}`;
    if (byRef.has(ref) && byRef.get(ref) !== e.storageKey) issue('CONFLICTING_REFERENCE', source);
    byRef.set(ref, e.storageKey);
    if (existing) existing.reasons.add(source);
    else evidence.set(e.storageKey, { evidence: e, reasons: new Set([source]) });
  }
  async function registerManifest(value: unknown, source: string, runId: string) {
    const parsed = artifactManifestSchema.safeParse(value);
    if (!parsed.success) { issue('INVALID_MANIFEST', source); return; }
    const m = parsed.data;
    if (m.context.runId !== runId || !runIds.has(runId)) issue('MANIFEST_OWNER_MISMATCH', source);
    if (await hashArtifactManifest(m) !== m.contentHash) issue('MANIFEST_HASH_MISMATCH', source);
    const previous = manifests.get(m.manifestId);
    if (previous && previous.hash !== m.contentHash) issue('CONFLICTING_MANIFEST', source);
    manifests.set(m.manifestId, { runId, hash: m.contentHash, keys: m.evidence.map(e => e.storageKey) });
    for (const e of m.evidence) registerEvidence(e, source);
  }
  for (const row of snapshot.executions) {
    if (row.base_manifest) await registerManifest(row.base_manifest, `execution:${row.id}`, row.run_id);
    else if (row.base_sealed_at) issue('SEALED_MANIFEST_MISSING', `execution:${row.id}`);
  }
  for (const row of snapshot.operations) {
    const owner = snapshot.analyses.find(a => a.id === row.analysis_attempt_id);
    if (!owner) { issue('OPERATION_OWNER_MISSING', row.operation_id); continue; }
    if (row.supplemental_manifest) {
      const source = `operation:${row.analysis_attempt_id}:${row.operation_id}`;
      await registerManifest(row.supplemental_manifest, source, owner.run_id);
      if (row.supplemental_manifest.analysisAttemptId !== owner.id || row.supplemental_manifest.operationId !== row.operation_id)
        issue('SUPPLEMENTAL_OWNER_MISMATCH', source);
    }
  }
  for (const row of snapshot.publications) {
    const source = `publication:${row.id}`;
    const parsed = publicationSnapshotSchema.safeParse(row.snapshot);
    if (!parsed.success) { issue('INVALID_PUBLICATION', source); continue; }
    if (await hashPublicationSnapshot(parsed.data) !== parsed.data.contentHash) issue('PUBLICATION_HASH_MISMATCH', source);
    if (parsed.data.baseContext.runId !== row.run_id || parsed.data.revision.revisionId !== row.revision_id)
      issue('PUBLICATION_OWNER_MISMATCH', source);
    for (const e of parsed.data.publicEvidence) registerEvidence(e, source);
    sources.push({ id: row.id, kind: 'publication', runId: row.run_id, value: parsed.data.revision });
  }
  for (const row of snapshot.revisions) sources.push({ id: row.id, kind: 'revision', runId: row.run_id,
    value: { baseManifestId: row.base_manifest_id, selectedSupplementalManifestIds: row.selected_supplemental_manifest_ids,
      feedback: row.feedback, teacherJudgments: row.teacher_judgments } });
  for (const row of snapshot.analyses) {
    sources.push({ id: row.id, kind: 'analysis', runId: row.run_id,
      value: { baseManifestId: row.base_manifest_id, candidate: row.candidate } });
    if (row.paired_id && !snapshot.analyses.some(a => a.id === row.paired_id && a.run_id === row.run_id))
      issue('PAIRED_ANALYSIS_MISSING', `analysis:${row.id}`);
    if (row.selected_at_start_revision_id && !snapshot.revisions.some(r => r.id === row.selected_at_start_revision_id && r.run_id === row.run_id))
      issue('START_REVISION_MISSING', `analysis:${row.id}`);
  }
  function holdManifest(id: string, source: Source) {
    const manifest = manifests.get(id);
    if (!manifest) { issue('REFERENCED_MANIFEST_MISSING', `${source.kind}:${source.id}`); return; }
    if (manifest.runId !== source.runId) issue('MANIFEST_REFERENCE_OWNER_MISMATCH', `${source.kind}:${source.id}`);
    for (const key of manifest.keys) evidence.get(key)?.reasons.add(`${source.kind}:${source.id}`);
  }
  function walk(value: any, source: Source, depth = 0) {
    if (depth > 32) { issue('REFERENCE_DEPTH_LIMIT', `${source.kind}:${source.id}`); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.baseManifestId === 'string') holdManifest(value.baseManifestId, source);
    if (Array.isArray(value.selectedSupplementalManifestIds))
      for (const id of value.selectedSupplementalManifestIds) holdManifest(id, source);
    if (typeof value.manifestId === 'string' && typeof value.evidenceId === 'string' && !value.storageKey) {
      const key = byRef.get(`${value.manifestId}:${value.evidenceId}`);
      if (!key) issue('EVIDENCE_REFERENCE_MISSING', `${source.kind}:${source.id}`);
      else evidence.get(key)!.reasons.add(`${source.kind}:${source.id}`);
    }
    for (const child of Object.values(value)) walk(child, source, depth + 1);
  }
  for (const source of sources) walk(source.value, source);
  for (const hold of snapshot.holds) {
    if (!runIds.has(hold.run_id)) issue('RETENTION_HOLD_RUN_MISSING', `hold:${hold.id}`);
    if (!hold.release_id) for (const record of evidence.values()) {
      if (record.evidence.runId === hold.run_id) record.reasons.add(`retention_hold:${hold.id}`);
    }
  }
  // Invalid quarantined material cannot be classified as safe to delete or revalidated as facts.
  for (const row of snapshot.quarantine) issue('QUARANTINED_MATERIAL_REQUIRES_REVIEW', `event:${row.id}`);
  for (const run of snapshot.runs) {
    if (run.accepted_execution_attempt_id && !snapshot.executions.some(e => e.id === run.accepted_execution_attempt_id && e.run_id === run.id && e.base_sealed_at))
      issue('ACCEPTED_EXECUTION_MISSING', `run:${run.id}`);
  }
  const files: { path: string; byteSize: number; state: string; reasons: string[] }[] = [];
  let entries = 0, bytesChecked = 0;
  const seen = new Set<string>();
  async function scan(relative = '', depth = 0) {
    if (depth > 6) { issue('FILESYSTEM_DEPTH_LIMIT', relative); return; }
    const directory = path.join(store.root, relative);
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) { issue('UNSAFE_EVIDENCE_DIRECTORY', relative); return; }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 20_000) throw new Error('RETENTION_FILE_LIMIT');
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      const item = await lstat(path.join(store.root, key));
      if (item.isSymbolicLink() || item.nlink > 1 && item.isFile()) { issue('UNSAFE_EVIDENCE_ENTRY', key); continue; }
      if (item.isDirectory()) { await scan(key, depth + 1); continue; }
      if (!item.isFile()) { issue('UNSAFE_EVIDENCE_ENTRY', key); continue; }
      seen.add(key);
      const retained = evidence.get(key);
      if (retained) {
        bytesChecked += retained.evidence.byteSize;
        if (bytesChecked > 512 * 1024 * 1024) throw new Error('RETENTION_BYTE_LIMIT');
        let state = 'referenced_verified';
        try { await store.readEvidence(retained.evidence); }
        catch { state = 'referenced_unreadable_or_corrupt'; issue('EVIDENCE_UNREADABLE_OR_CORRUPT', key); }
        files.push({ path: key, byteSize: item.size, state, reasons: [...retained.reasons].sort() });
      } else files.push({ path: key, byteSize: item.size, state: 'unreferenced_retained', reasons: ['retain_all_policy', 'external_or_inflight_references_not_excluded'] });
    }
  }
  try { await scan(); }
  catch (error) { issue(error instanceof Error && /^RETENTION_[A-Z_]+$/.test(error.message) ? error.message : 'FILESYSTEM_SCAN_INCOMPLETE', 'evidence-store'); }
  for (const [key, record] of evidence) if (!seen.has(key)) {
    issue('REFERENCED_FILE_NOT_VERIFIED', key);
    files.push({ path: key, byteSize: record.evidence.byteSize, state: 'referenced_not_verified', reasons: [...record.reasons].sort() });
  }
  const active = snapshot.runs.filter(r => ['queued', 'running'].includes(r.status)).length
    + snapshot.executions.filter(e => e.owner_phase !== 'closed').length
    + snapshot.analyses.filter(a => ['queued', 'running'].includes(a.status) || a.owner_phase && a.owner_phase !== 'closed').length
    + snapshot.sourceInventory.active_analyses;
  return {
    version: 'retention-audit-v1', checkedAt: new Date().toISOString(), policy: 'retain_all', deletionAuthorized: false,
    complete: issues.length === 0, activeRecords: active,
    sourceInventory: snapshot.sourceInventory,
    sourceRetention: snapshot.sourceRetention,
    counts: { runs: snapshot.runs.length, manifests: manifests.size, revisions: snapshot.revisions.length,
      publications: snapshot.publications.length, analyses: snapshot.analyses.length, ...snapshot.counts,
      activeHolds: snapshot.holds.filter(h => !h.release_id).length, releasedHolds: snapshot.holds.filter(h => h.release_id).length,
      referencedFiles: evidence.size, unreferencedFiles: files.filter(f => f.state === 'unreferenced_retained').length },
    preservation: { allRunHistory: true, comparisonSelection: 'retain all earlier submissions; comparison is dynamically selected',
      modelIoAndCheckpoints: 'retained privately; opaque contents not validated by this audit', externalEvaluationReferences: 'not exhaustively discoverable; no deletion eligible' },
    holds: snapshot.holds, issues, files: files.sort((a, b) => a.path.localeCompare(b.path)),
    limitations: ['Database snapshot and filesystem walk are not one atomic snapshot.',
      'Source project inventory counts retained database records only; it does not validate report citations or source content. Unsettled model calls are historical receipts, not proof of a live request.',
      'Unreferenced files may belong to in-flight work, quarantined input or external evaluation records.',
      'This is an integrity and retention inventory, not a deletion plan, backup, or full report-semantic validation.'],
  };
}
