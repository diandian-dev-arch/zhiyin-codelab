import { zipSync } from 'fflate';
import { canonicalJson, sha256, uuidSchema } from '@codelab/contracts/v2';
import type { DB } from './db.js';
import { getReviewV2, ReportV2Error, type EvidenceReader } from './reports-v2.js';
import { providerConfigurationV2, sealedAnalysisInputHashV2 } from './analysis-input-v2.js';

const terminal = new Set(['succeeded', 'degraded', 'interrupted', 'cancelled']);
const maxBytes = 64 * 1024 * 1024;
type Artifact = { path: string; sha256: string };
function fail(code: string, message: string): never { throw new ReportV2Error(code, message); }

/** Private teacher export. A material bundle is deliberately not a completed evaluation trial. */
export async function exportAnalysisPairV2(db: DB, input: {
  runId: string; actorId: string; analysisId: string;
}, reader?: EvidenceReader) {
  uuidSchema.parse(input.runId); uuidSchema.parse(input.actorId); uuidSchema.parse(input.analysisId);
  const snapshot = await db.transaction(async tx => {
    await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const review = await getReviewV2(tx, input); // Auth before reading private model I/O.
    const select = `SELECT id,run_id,base_manifest_id,mode,status,configuration,budget,usage,candidate,
      selected_at_start_revision_id,created_at,finished_at FROM analysis_attempts`;
    const second = (await tx.query(`${select} WHERE id=$1 AND run_id=$2`, [input.analysisId, input.runId])).rows[0];
    const pairedId = uuidSchema.safeParse(second?.configuration?.pairedWithAnalysisId);
    if (!pairedId.success) fail('ANALYSIS_PAIR_REQUIRED', '请选择已登记对照关系的分析记录');
    const first = (await tx.query(`${select} WHERE id=$1 AND run_id=$2`, [pairedId.data, input.runId])).rows[0];
    const attempts = [first, second];
    const baseInputHash = await sealedAnalysisInputHashV2(review);
    if (attempts.some(a => !a || a.mode !== 'reanalysis' || !terminal.has(a.status)
      || a.base_manifest_id !== review.baseManifest.manifestId || a.configuration.baseInputHash !== baseInputHash)
      || new Set(attempts.map(a => a.configuration.strategy)).size !== 2
      || attempts.some(a => !['summary', 'agent'].includes(a.configuration.strategy))
      || canonicalJson(providerConfigurationV2(first.configuration)) !== canonicalJson(providerConfigurationV2(second.configuration)))
      fail('ANALYSIS_PAIR_INCOMPATIBLE', '对照分析尚未结束，或封存材料、模型配置不一致');
    const operations = (await tx.query(`SELECT o.analysis_attempt_id,o.operation_id,o.kind,o.request_hash,o.state,
      o.reserved_budget,o.actual_usage,o.response_hash,o.error,o.started_at,o.finished_at,
      p.input,p.response FROM analysis_operations o LEFT JOIN analysis_private_io p
      USING(analysis_attempt_id,operation_id) WHERE o.analysis_attempt_id IN ($1,$2)
      ORDER BY o.analysis_attempt_id,o.started_at,o.operation_id`, [first.id, second.id])).rows;
    if (operations.length > 100) fail('EXPORT_TOO_LARGE', '操作记录超过导出上限');
    const environment = (await tx.query(`SELECT actual_fingerprint FROM execution_attempts
      WHERE id=$1 AND run_id=$2`, [review.baseManifest.context.executionAttemptId, input.runId])).rows[0]?.actual_fingerprint;
    // Latest publication is context only: never attribute it to either model candidate.
    const publication = review.latestPublication ? (await tx.query(`SELECT id,revision_id,publication_no,
      purpose,snapshot,published_at FROM publications WHERE id=$1 AND run_id=$2`,
      [review.latestPublication.publicationId, input.runId])).rows[0] : null;
    return { review, attempts, operations, environment, publication, baseInputHash };
  });
  const files: Record<string, Uint8Array> = {};
  const inventory: (Artifact & { byteSize: number })[] = [];
  let size = 0;
  async function add(path: string, bytes: Uint8Array): Promise<Artifact> {
    size += bytes.byteLength;
    if (size > maxBytes || inventory.length >= 1000) fail('EXPORT_TOO_LARGE', '材料超过 64 MiB 或文件数量上限');
    const artifact = { path, sha256: await sha256(bytes) };
    files[path] = bytes;
    inventory.push({ ...artifact, byteSize: bytes.byteLength });
    return artifact;
  }
  // pg returns timestamptz as Date; serialize it to ISO before canonical encoding.
  const json = (path: string, value: unknown) => add(path, Buffer.from(canonicalJson(JSON.parse(JSON.stringify(value))) + '\n'));
  const { review, attempts, operations } = snapshot;
  const common = {
    rule: await json('common/rule.json', review.rule),
    environment: await json('common/environment.json', snapshot.environment ?? null),
    baseEvidence: await json('common/base-manifest.json', review.baseManifest),
    baseResults: await json('common/base-results.json', review.baseResults),
    modelConfiguration: await json('common/model-configuration.json', providerConfigurationV2(attempts[0].configuration)),
  };
  const manifests = [review.baseManifest, ...review.supplementalManifests.filter(m => attempts.some(a => a.id === m.analysisAttemptId))];
  if (!reader && manifests.some(m => m.evidence.length)) fail('EVIDENCE_UNAVAILABLE', '证据存储未接通，无法导出完整材料');
  for (const manifest of manifests) {
    if (manifest.source === 'supplemental') await json(`supplemental/${manifest.manifestId}.json`, manifest);
    for (const e of manifest.evidence) {
      if (e.byteSize > maxBytes - size) fail('EXPORT_TOO_LARGE', '材料超过 64 MiB 上限');
      let bytes: Uint8Array;
      try { bytes = await reader!(e); } catch { fail('EVIDENCE_UNAVAILABLE', '证据文件不可读取，请检查存储'); }
      if (bytes.byteLength !== e.byteSize || await sha256(bytes) !== e.sha256)
        fail('EVIDENCE_HASH_MISMATCH', '证据文件与封存哈希不符，已停止导出');
      const ext = e.mediaType === 'image/png' ? 'png' : e.mediaType === 'application/json' ? 'json' : 'txt';
      await add(`evidence/${e.manifestId}/${e.evidenceId}.${ext}`, bytes);
    }
  }
  const arms = [];
  for (const a of attempts) {
    const prefix = `analyses/${a.id}`;
    // Explicit allowlist excludes ownership credentials and arbitrary configuration fields.
    const config = a.configuration;
    await json(`${prefix}/analysis.json`, {
      analysisAttemptId: a.id, strategy: config.strategy, status: a.status,
      baseInputHash: config.baseInputHash, pairedWithAnalysisId: config.pairedWithAnalysisId ?? null,
      promptVersion: config.promptVersion ?? null, promptHash: config.promptHash ?? null,
      selectedAtStartRevisionId: a.selected_at_start_revision_id,
      createdAt: a.created_at, finishedAt: a.finished_at, budget: a.budget, usage: a.usage,
    });
    const candidate = a.candidate == null ? null : await json(`${prefix}/candidate.json`, a.candidate);
    const modelOperations = [];
    for (const op of operations.filter(o => o.analysis_attempt_id === a.id)) {
      if (op.input == null) fail('ANALYSIS_IO_MISSING', '调用输入记录缺失，无法核验');
      const expectedRequestHash = await sha256(canonicalJson(op.kind === 'model_summary'
        ? { configuration: config, request: op.input }
        : { kind: op.kind, request: op.input, budget: op.reserved_budget }));
      if (expectedRequestHash !== op.request_hash) fail('ANALYSIS_REQUEST_HASH_MISMATCH', '调用输入与登记哈希不符');
      if ((op.response == null) !== (op.response_hash == null)
        || (op.response != null && await sha256(op.response) !== op.response_hash))
        fail('ANALYSIS_RESPONSE_HASH_MISMATCH', '调用响应与登记哈希不符');
      const request = await json(`${prefix}/operations/${op.operation_id}/request.json`, op.input);
      const response = op.response == null ? null : await add(`${prefix}/operations/${op.operation_id}/response.txt`, Buffer.from(op.response));
      await json(`${prefix}/operations/${op.operation_id}/record.json`, {
        operationId: op.operation_id, kind: op.kind, state: op.state,
        requestHash: op.request_hash, responseHash: op.response_hash,
        startedAt: op.started_at, finishedAt: op.finished_at,
        reservedBudget: op.reserved_budget, actualUsage: op.actual_usage, error: op.error,
        request, response,
      });
      if (op.kind.startsWith('model_')) modelOperations.push({ operationId: op.operation_id, state: op.state, request, response });
    }
    arms.push({ group: config.strategy === 'summary' ? 'S' : 'A', analysisAttemptId: a.id,
      analysisStatus: a.status, candidate, modelOperations,
      // A reserved request is not proof it was sent; failed/unknown calls remain explicit.
      confirmedCompletedCalls: modelOperations.filter(o => o.state === 'completed').length,
      teacherRevision: null, publication: null, phaseMs: null, rating: null,
      inputTokens: null, outputTokens: null, cost: null, currency: null });
  }
  const teacherSnapshot = await json('context/teacher-revision.json', review.revision);
  const publicationSnapshot = snapshot.publication ? await json('context/latest-publication.json', snapshot.publication) : null;
  await json('evaluation-materials.json', {
    version: 'analysis-pair-materials-v1', runId: input.runId, baseInputHash: snapshot.baseInputHash,
    originalZipSha256: review.baseManifest.context.originalZipSha256, common, arms,
    contextOnly: { teacherSnapshot, publicationSnapshot, attributionToEitherArm: null },
    ledgerReady: false, qualityEvaluationCompleted: false,
    missing: ['preRegisteredPlan', 'sampleRegistry', 'reviewerCode', 'priorExposure', 'blinding',
      'humanPhaseTimings', 'perArmTeacherRevisionAndPublication', 'independentRating', 'pricingAndCurrency'],
    limitations: ['Same sealed source does not mean identical model-visible inputs.',
      'Material hashes refer to exact exported file bytes; stored request hashes use their original envelope.',
      'Reserved and uncertain operations are not confirmed model responses.',
      'Context publication is not evidence of candidate adoption or an independent teacher trial.'],
  });
  await add('README.txt', Buffer.from('教师私有评测材料，包含学生证据、源码片段和模型原始输入输出，请勿直接公开。\n'
    + 'manifest.json 登记每个材料文件的字节长度及 SHA-256；不含 manifest 自身。\n'
    + 'evaluation-materials.json 是材料映射，不是已完成的评测账本；人工字段须依真实记录填写。\n'
    + 'context 中的教师版本及发布记录仅为导出时快照，不归属于任一 S/A 试验。\n'));
  files['manifest.json'] = Buffer.from(canonicalJson({ version: 'analysis-pair-export-v1',
    exportedAt: new Date().toISOString(), runId: input.runId, files: inventory }) + '\n');
  return { bytes: zipSync(files, { level: 0 }), filename: `codelab-pair-${input.analysisId}.zip` };
}
