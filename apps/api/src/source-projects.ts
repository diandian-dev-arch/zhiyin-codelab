import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sourceContentQuery, sourceContent } from './source-content.js';
import type { DB } from "./db.js";
import type { SummaryProviderV2 } from "./model-provider-v2.js";
import { ModelRequestError } from "./model-provider-v2.js";
import type { SourceProviderResolver } from "./user-model-settings.js";
import { importSourceZip } from "./source-zip.js";
import { receiveSourceZip } from "./source-upload.js";
import { reapSourceSpools } from "./source-spool.js";
import {
  sourceImportLimits,
  sourceAnalysisProfiles,
  sourceReportQuality,
} from "@codelab/contracts/source";
import { sourceOptionsSchema } from "./source-options.js";
import { buildSourceCatalog } from "./source-catalog.js";
import { createStorageAdmission } from "../../runner/src/storage-admission.js";
import { tmpdir } from "node:os";
import { analyzeSource, sourceValidationDiagnostic } from "./source-agent.js";
import { sourceDelta } from './source-delta.js';
import { projectSubmissionAccess } from './project-course.js';
import { officialSourcePrice, quoteSource, sameAnalysisScope, summarizeSourceCost, priceTokens } from './source-cost.js';
import {
  registerSourceCall,
  finishSourceCall,
  summarizeSourceUsage,
} from "./source-usage.js";
import {
  assertSourceExecutionSnapshot,
  sourceExecutionSnapshot,
} from "./source-execution.js";
const uuid = z.string().uuid();
const actor = (req: FastifyRequest) =>
  (req as FastifyRequest & { user: { id: string } }).user.id;
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
export async function sourceWorkerTick(
  db: DB,
  providerSource: SummaryProviderV2 | SourceProviderResolver,
  shutdown: AbortSignal,
) {
  // A timed out owner cannot publish. Uncertain paid requests are never automatically replayed.
  await db.query(
    "UPDATE source_analyses SET status='failed',code='INTERRUPTED',finished_at=now() WHERE status='running' AND deadline<now()",
  );
  const job = await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(41724)");
    if (
      (
        await tx.query(
          "SELECT id FROM source_analyses WHERE status='running' LIMIT 1",
        )
      ).rows.length
    )
      return;
    const row = (
      await tx.query(
        "SELECT id,analysis_options FROM source_analyses WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
    ).rows[0];
    if (!row) return;
    return (
      await tx.query(
        "UPDATE source_analyses SET status='running',usage_recording_version=1,started_at=now(),deadline=now()+($2::int*interval '1 second') WHERE id=$1 RETURNING *",
        [
          row.id,
          sourceAnalysisProfiles[
            sourceOptionsSchema.parse(row.analysis_options ?? {}).mode
          ].leaseSeconds,
        ],
      )
    ).rows[0];
  });
  if (!job) return false;
  const local = new AbortController();
  const signal = AbortSignal.any([
    shutdown,
    local.signal,
    AbortSignal.timeout(
      sourceAnalysisProfiles[
        sourceOptionsSchema.parse(job.analysis_options ?? {}).mode
      ].timeoutMs,
    ),
  ]);
  const timer = setInterval(() => {
    void db
      .query("SELECT status FROM source_analyses WHERE id=$1", [job.id])
      .then((r) => {
        if (r.rows[0]?.status !== "running") local.abort();
      })
      .catch(() => local.abort());
  }, 1000);
  try {
    const project = (
      await db.query("SELECT files,owner_id FROM source_projects WHERE id=$1", [job.project_id])
    ).rows[0];
    // The person explicitly requesting analysis pays. A teacher may analyze an
    // authorized submission without ever using the student's credentials.
    const resolveProvider = () => typeof providerSource === 'function' ? providerSource(job.billing_user_id ?? project.owner_id) : Promise.resolve(providerSource);
    const provider = await resolveProvider();
    if (!provider) throw new Error('MODEL_NOT_CONFIGURED');
    // Personal billing requires explicit queue-time configuration. Legacy jobs
    // must not acquire the account's current key merely because one now exists.
    // Fixed-provider fixtures retain their legacy compatibility path.
    if (typeof providerSource === 'function' || (job.execution_snapshot !== null && job.execution_snapshot !== undefined))
      assertSourceExecutionSnapshot(job.execution_snapshot, provider);
    const options = sourceOptionsSchema.parse(job.analysis_options ?? {});
    const baseline = options.incrementalFrom ? (await db.query('SELECT files FROM source_projects WHERE id=$1 AND owner_id=$2', [options.incrementalFrom, project.owner_id])).rows[0] : undefined;
    if (options.incrementalFrom && !baseline) throw new Error('SOURCE_BASELINE_UNAVAILABLE');
    const result = await analyzeSource({
      files: project.files,
      options,
      changes: baseline ? sourceDelta(baseline.files, project.files) : undefined,
      provider,
      signal,
      callLedger: {
        begin: (number, budget) =>
          registerSourceCall(db, job.id, number, budget),
        finish: (id, receipt) => finishSourceCall(db, id, receipt),
      },
      emit: async (event) => {
        signal.throwIfAborted();
        const updated = await db.query(
          "UPDATE source_analyses SET events=events || $2::jsonb WHERE id=$1 AND status='running' AND deadline>now() RETURNING id",
          [job.id, JSON.stringify([event])],
        );
        if (!updated.rows.length) throw new Error("OWNER_EXPIRED");
      },
      beforeModelCall: async () => {
        const live = await resolveProvider();
        if (!live) throw new Error('MODEL_NOT_CONFIGURED');
        if (!(await db.query("SELECT id FROM source_analyses WHERE id=$1 AND status='running' AND deadline>now()", [job.id])).rows.length) throw new Error('OWNER_EXPIRED');
        if (
          typeof providerSource === 'function' ||
          (job.execution_snapshot !== null && job.execution_snapshot !== undefined)
        )
          assertSourceExecutionSnapshot(job.execution_snapshot, live);
      },
    });
    signal.throwIfAborted();
    await db.query(
      "UPDATE source_analyses SET status='succeeded',report=$2,finished_at=now() WHERE id=$1 AND status='running' AND deadline>now()",
      [job.id, JSON.stringify({...result, costReuseVersion: 1})],
    );
  } catch (error) {
    const issues = sourceValidationDiagnostic(error);
    if (issues) await db.query(
      "UPDATE source_analyses SET events=events || $2::jsonb WHERE id=$1 AND status='running'",
      [job.id, JSON.stringify([{ at: new Date().toISOString(), kind: 'validation_failed',
        label: '报告修正后仍不符合格式要求，已保留具体字段诊断；本次不会发布未通过校验的报告。', issues }])],
    );
    await db.query(
      "UPDATE source_analyses SET status='failed',code=$2,finished_at=now() WHERE id=$1 AND status='running'",
      [
        job.id,
        shutdown.aborted
          ? "INTERRUPTED"
          : signal.aborted
            ? "TIME_LIMIT"
            : error instanceof ModelRequestError
              ? error.code
              : error instanceof z.ZodError
                ? "REPORT_SCHEMA_INVALID"
                : error instanceof Error &&
                    [
                      "MODEL_OUTPUT_LIMIT",
                      "MODEL_EMPTY_OUTPUT",
                      "INVALID_SOURCE_CITATION",
                      "INVALID_SOURCE_SELECTION",
                      "MODEL_JSON_INVALID",
                      "MISSING_FINDING_VERIFICATION",
                      "MISSING_VERIFIED_FINDING",
                      "MODEL_CONTEXT_BUDGET",
                      "INVALID_SOURCE_MODULE",
                      "SOURCE_PLAN_INVALID",
                      "SOURCE_CONFIGURATION_CHANGED",
                      "MODEL_NOT_CONFIGURED",
                      "SOURCE_COST_BUDGET",
                      "SOURCE_BASELINE_UNAVAILABLE",
                    ].includes(error.message)
                  ? error.message
                  : "ANALYSIS_FAILED",
      ],
    );
  } finally {
    clearInterval(timer);
  }
  return true;
}
export async function registerSourceProjects(
  app: FastifyInstance,
  db: DB,
  providerSource?: SummaryProviderV2 | SourceProviderResolver,
  storageAdmission?: (bytes?: number) => Promise<void>,
) {
  const resolveProvider = async (owner: string, connection = db) => typeof providerSource === 'function' ? providerSource(owner, connection) : providerSource;
  // Availability must not decrypt credentials: history remains readable even after vault damage.
  const available = async (owner: string) => typeof providerSource === 'function'
    ? !!(await db.query('SELECT 1 FROM user_model_settings WHERE user_id=$1', [owner])).rows.length
    : !!providerSource;
  const requireProvider = async (owner: string, connection = db) => {
    const provider = await resolveProvider(owner, connection);
    if (!provider) throw Object.assign(new Error('请先在模型设置中配置你自己的 API Key'), { statusCode: 409, code: 'MODEL_NOT_CONFIGURED' });
    return provider;
  };
  const controller = new AbortController();
  let importsInFlight = 0;
  const temporaryStorageAdmission = createStorageAdmission(tmpdir());
  let reaping: Promise<void> | undefined;
  let reapTimer: ReturnType<typeof setInterval> | undefined;
  const reap = () => {
    if (reaping) return reaping;
    reaping = reapSourceSpools()
      .then((result) => {
        if (result.removed || result.preserved || result.failed)
          app.log.info(
            { sourceSpoolRecovery: result },
            "Source upload recovery",
          );
      })
      .catch(() => {
        app.log.error("SOURCE_SPOOL_RECOVERY_UNAVAILABLE");
      })
      .finally(() => {
        reaping = undefined;
      });
    return reaping;
  };
  app.addHook("onReady", async () => {
    await reap();
    reapTimer = setInterval(() => {
      void reap();
    }, 60_000);
    reapTimer.unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(reapTimer);
    await reaping;
  });
  let worker: Promise<void> | undefined;
  if (providerSource) {
    app.addHook("onReady", async () => {
      worker = (async () => {
        while (!controller.signal.aborted) {
          try {
            await sourceWorkerTick(db, providerSource, controller.signal);
          } catch {
            console.error("SOURCE_WORKER_DATABASE_UNAVAILABLE");
          }
          try {
            await delay(1000, undefined, { signal: controller.signal });
          } catch {
            break;
          }
        }
      })();
    });
    app.addHook("onClose", async () => {
      controller.abort();
      await worker;
    });
  }
  const own = async (id: unknown, owner: string) => {
    const row = (
      await db.query(
        "SELECT id,name,sha256,omitted,created_at FROM source_projects WHERE id=$1 AND owner_id=$2",
        [uuid.parse(id), owner],
      )
    ).rows[0];
    if (!row) fail(404, "项目不存在");
    return row;
  };
  // Uploads, personal reanalysis and course reanalysis share the same decision:
  // identical active work is retained; only a compatible successful report is reusable.
  async function enqueueAnalysis(tx: DB, projectId: string, ownerId: string, payerId: string,
    options: z.infer<typeof sourceOptionsSchema>, provider: SummaryProviderV2, allowReuse: boolean) {
    const active = (await tx.query("SELECT id,analysis_options,execution_snapshot,billing_user_id FROM source_analyses WHERE project_id=$1 AND status IN ('queued','running')", [projectId])).rows[0];
    if (active) {
      if ((active.billing_user_id ?? ownerId) !== payerId)
        fail(409, '另一位用户已在分析这份源码，请等待完成；本次没有创建新的付费请求');
      const activeOptions = sourceOptionsSchema.parse(active.analysis_options ?? {});
      let sameModel = true;
      try { assertSourceExecutionSnapshot(active.execution_snapshot, provider); }
      catch { sameModel = false; }
      if (!sameAnalysisScope(activeOptions, options) || JSON.stringify(activeOptions.cost ?? null) !== JSON.stringify(options.cost ?? null) || !sameModel)
        fail(409, '当前分析尚未结束，请等待完成或先停止，再更换分析模式、范围、模型或预算');
      return {analysisId: active.id as string, analysisDisposition: 'active' as const, reused: false, active: true};
    }
    if (allowReuse) {
      const previous = (await tx.query("SELECT id,analysis_options,execution_snapshot,report,billing_user_id FROM source_analyses WHERE project_id=$1 AND status='succeeded' AND report IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 20", [projectId])).rows;
      for (const old of previous) {
        if ((old.billing_user_id ?? ownerId) !== payerId || old.report?.costReuseVersion !== 1 || !sameAnalysisScope(sourceOptionsSchema.parse(old.analysis_options ?? {}), options)) continue;
        try { assertSourceExecutionSnapshot(old.execution_snapshot, provider); }
        catch { continue; }
        return {analysisId: old.id as string, analysisDisposition: 'reused' as const, reused: true, active: false};
      }
    }
    const recent = (await tx.query("SELECT count(*)::int AS n FROM source_analyses WHERE project_id=$1 AND created_at>now()-interval '1 hour'", [projectId])).rows[0].n;
    if (recent >= 5) fail(429, '每个项目每小时最多发起 5 次分析');
    const analysisId = randomUUID();
    await tx.query("INSERT INTO source_analyses(id,project_id,status,analysis_options,execution_snapshot,usage_recording_version,billing_user_id) VALUES($1,$2,'queued',$3,$4,1,$5)",
      [analysisId,projectId,JSON.stringify(options),JSON.stringify(sourceExecutionSnapshot(provider)),payerId]);
    return {analysisId, analysisDisposition: 'queued' as const, reused: false, active: false};
  }
  async function cancelAnalysis(tx: DB, projectId: string, ownerId: string, payerId: string, analysisId: string) {
    const analysis = (await tx.query('SELECT billing_user_id FROM source_analyses WHERE id=$1 AND project_id=$2', [analysisId,projectId])).rows[0];
    if (!analysis) fail(404, '分析记录不存在');
    if ((analysis.billing_user_id ?? ownerId) !== payerId) fail(403, '只有本次分析的付费发起人可以停止分析');
    await tx.query("UPDATE source_analyses SET status='cancelled',finished_at=now() WHERE id=$1 AND project_id=$2 AND status IN ('queued','running')", [analysisId,projectId]);
    return {ok:true};
  }
  app.get("/api/v2/projects", async (req) => ({
    available: await available(actor(req)),
    projects: (
      await db.query(
        `SELECT p.id,p.name,p.created_at,latest.status,latest.quality,(SELECT max(finished_at) FROM source_analyses a WHERE a.project_id=p.id AND a.status='succeeded' AND a.report IS NOT NULL) AS last_analyzed_at
         FROM source_projects p LEFT JOIN LATERAL (
           SELECT a.status,jsonb_build_object('reportQuality',a.report->'report'->'reportQuality','reportLimitReasons',a.report->'report'->'reportLimitReasons','analysisWarnings',a.report->'report'->'analysisWarnings') AS quality
           FROM source_analyses a WHERE a.project_id=p.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1
         ) latest ON true WHERE p.owner_id=$1 ORDER BY p.created_at DESC LIMIT 100`,
        [actor(req)],
      )
    ).rows.map(({ quality, ...project }) => ({ ...project, report_quality: sourceReportQuality(quality ?? {}) })),
  }));
  app.post(
    "/api/v2/projects",
    { bodyLimit: sourceImportLimits.zipBytes + 1024 * 1024 },
    async (req, reply) => {
      const analyze = z.enum(['true', 'false']).default('true').parse((req.query as any).analyze) === 'true';
      if (analyze) await requireProvider(actor(req));
      const options = sourceOptionsSchema.parse({
        ...(analyze ? {
          mode: (req.query as { mode?: string }).mode,
          ...((req.query as any).cost ? {cost: JSON.parse((req.query as any).cost)} : {}),
          ...((req.query as any).incrementalFrom ? {incrementalFrom:(req.query as any).incrementalFrom} : {}),
        } : {}),
      });
      if (importsInFlight >= sourceImportLimits.concurrentImports)
        fail(429, "正在导入其他项目，请稍后重试");
      importsInFlight++;
      // Also bound clients that never finish the first boundary or final multipart trailer.
      const uploadDeadline = setTimeout(
        () => req.raw.destroy(),
        sourceImportLimits.uploadTimeoutMs,
      );
      uploadDeadline.unref();
      try {
        await temporaryStorageAdmission(
          sourceImportLimits.zipBytes * sourceImportLimits.concurrentImports,
        );
        await storageAdmission?.(
          sourceImportLimits.retainedBytes *
            8 *
            sourceImportLimits.concurrentImports,
        );
        let imported: Awaited<ReturnType<typeof importSourceZip>> | undefined;
        let filename = "";
        // Consume the entire envelope before persisting: extra parts cannot queue a paid analysis.
        for await (const part of req.parts({
          limits: {
            fileSize: sourceImportLimits.zipBytes,
            files: 1,
            fields: 0,
            parts: 1,
          },
        })) {
          if (
            part.type !== "file" ||
            part.fieldname !== "file" ||
            !part.filename.toLowerCase().endsWith(".zip")
          )
            return fail(400, "请使用 file 字段上传一份 ZIP 项目压缩包");
          filename = part.filename;
          imported = await receiveSourceZip(part.file);
        }
        if (!imported) fail(400, "请选择项目 ZIP");
        const result = await db.transaction(async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(41724)");
          const provider = analyze ? await requireProvider(actor(req), tx) : undefined;
          if (!options.cost && provider) options.cost = officialSourcePrice(provider) ?? undefined;
          else if (options.cost) options.cost.label = '用户确认单价 · 人民币 / 百万 token';
          // ZIP timestamps and compression settings do not change the source.
          // Deduplicate within this account; never share private files across owners.
          const contentHash = createHash('sha256').update(JSON.stringify(
            Object.keys(imported!.files).sort().map(path => [path, imported!.files[path]]),
          )).digest('hex');
          const existing = (
            await tx.query(
              "SELECT id FROM source_projects WHERE owner_id=$1 AND (sha256=$2 OR content_hash=$3 OR (content_hash IS NULL AND files=$4::jsonb)) ORDER BY created_at LIMIT 1",
              [actor(req), imported!.sha256, contentHash, JSON.stringify(imported!.files)],
            )
          ).rows[0];
          if (options.incrementalFrom) {
            const baseline = (await tx.query('SELECT files FROM source_projects WHERE id=$1 AND owner_id=$2', [options.incrementalFrom,actor(req)])).rows[0];
            if (!baseline) fail(404,'对比版本不存在或无权访问');
            const delta = sourceDelta(baseline.files, imported!.files);
            if (!delta.added.length && !delta.modified.length && !delta.removed.length)
              fail(409,'保留源码与所选版本完全相同，无需付费分析；请打开原项目查看报告。');
          }
          if (existing) {
            const result = analyze ? await enqueueAnalysis(tx, existing.id, actor(req), actor(req), options, provider!, true) : null;
            return {id:existing.id,analysisId:result?.analysisId ?? null,reused:true,
              analysisReused:result?.reused ?? false,analysisDisposition:result?.analysisDisposition ?? 'not_requested'};
          }
          const count = (
            await tx.query(
              "SELECT count(*)::int AS n FROM source_projects WHERE owner_id=$1",
              [actor(req)],
            )
          ).rows[0].n;
          if (count >= 50) fail(409, "已达到 50 个项目的保存上限");
          const id = randomUUID();
          await tx.query(
            "INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              id,
              actor(req),
              filename.replace(/[^\p{L}\p{N}_. -]/gu, "_").slice(0, 120),
              imported!.sha256,
              JSON.stringify(imported!.files),
              JSON.stringify(imported!.omitted),
              contentHash,
            ],
          );
          const result = analyze ? await enqueueAnalysis(tx,id,actor(req),actor(req),options,provider!,true) : null;
          return {id,analysisId:result?.analysisId ?? null,reused:false,
            analysisReused:result?.reused ?? false,analysisDisposition:result?.analysisDisposition ?? 'not_requested'};
        });
        reply.code(201);
        const messages = {not_requested:'源码已保存，本次未发起分析',active:'已打开正在进行的同范围分析，本次未创建新请求',
          reused:'已复用范围和模型配置一致的成功报告，本次没有新模型调用',queued:'源码已保存，已按本次确认的范围和模型创建分析'};
        return { ...result, projectId: result.id, saved: true, message: messages[result.analysisDisposition as keyof typeof messages] };
      } finally {
        clearTimeout(uploadDeadline);
        importsInFlight--;
      }
    },
  );
  app.get("/api/v2/projects/:id", async (req) => {
    const p = await own((req.params as any).id, actor(req));
    const files = (
      await db.query("SELECT files FROM source_projects WHERE id=$1", [p.id])
    ).rows[0].files;
    const analyses = (
      await db.query(
        "SELECT * FROM source_analyses WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20",
        [p.id],
      )
    ).rows;
    const calls = (
      await db.query(
        "SELECT analysis_id,state,usage,budget FROM source_model_calls WHERE analysis_id=ANY($1::uuid[]) ORDER BY analysis_id,call_no",
        [analyses.filter(a => (a.billing_user_id ?? actor(req)) === actor(req)).map((a) => a.id)],
      )
    ).rows;
    return {
      ...p,
      available: await available(actor(req)),
      modules: buildSourceCatalog(files).modules,
      files: Object.keys(files).map((path) => ({
        path,
        lines: files[path].split("\n").length,
      })),
      analyses: analyses.map((a) => {
        const selfFunded = (a.billing_user_id ?? actor(req)) === actor(req);
        if (selfFunded) return {...a, canCancel:['queued','running'].includes(a.status),
          costSummary:summarizeSourceCost(a.analysis_options?.cost,calls.filter(c => c.analysis_id === a.id)),
          modelUsage:summarizeSourceUsage(a.usage_recording_version,a.status,calls.filter(c => c.analysis_id === a.id))};
        // Teachers can analyze submitted student projects. The source owner may
        // read that guide, but private model settings and billing stay with its payer.
        return {id:a.id,project_id:a.project_id,status:a.status,code:a.code,created_at:a.created_at,
          started_at:a.started_at,finished_at:a.finished_at,canCancel:false,shared:true,
          events:(a.events ?? []).map((event: any) => ({at:event.at,kind:event.kind,label:event.label,path:event.path,
            count:event.count,round:event.round,totalRounds:event.totalRounds,issues:event.issues})),
          analysis_options:a.analysis_options ? {version:1,mode:a.analysis_options.mode,modules:a.analysis_options.modules} : null,
          report:a.report ? {report:a.report.report,read:a.report.read,readRanges:a.report.readRanges,coverage:a.report.coverage,
            sourceMap:a.report.sourceMap,changes:a.report.changes,analysisScope:a.report.analysisScope,verification:a.report.verification} : null};
      }),
    };
  });
  app.get("/api/v2/projects/:id/source", async (req) => {
    const p = await own((req.params as any).id, actor(req));
    const query = sourceContentQuery.parse(req.query);
    const { analysisId, path } = query;
    if (analysisId) {
      const analysis = (await db.query('SELECT id FROM source_analyses WHERE id=$1 AND project_id=$2', [analysisId, p.id])).rows[0];
      if (!analysis) fail(404, '报告不属于此源码版本');
    }
    const files = (
      await db.query("SELECT files FROM source_projects WHERE id=$1", [p.id])
    ).rows[0].files;
    if (!Object.hasOwn(files, path)) fail(404, "源码不存在");
    return { path, ...sourceContent(files[path], query), projectId: p.id, ...(analysisId ? { analysisId } : {}) };
  });
  app.post("/api/v2/projects/:id/analyze", async (req) => {
    const p = await own((req.params as any).id, actor(req));
    const options = sourceOptionsSchema.parse(req.body ?? {});
    if (options.incrementalFrom) {
      if (options.incrementalFrom === p.id) fail(400,'请选择不同的历史版本进行变更分析');
      await own(options.incrementalFrom, actor(req));
    }
    if (options.modules.length) {
      const files = (
        await db.query("SELECT files FROM source_projects WHERE id=$1", [p.id])
      ).rows[0].files;
      const catalog = buildSourceCatalog(files);
      if (options.modules.some((id) => !catalog.groups.has(id)))
        fail(400, "所选目录不属于此项目，请刷新后重选");
    }
    return db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(41724)");
      if (!(await tx.query('SELECT id FROM source_projects WHERE id=$1 AND owner_id=$2', [p.id,actor(req)])).rows.length)
        fail(404, "项目不存在");
      const provider = await requireProvider(actor(req), tx);
      if (!options.cost) options.cost = officialSourcePrice(provider!) ?? undefined;
      else options.cost.label = '用户确认单价 · 人民币 / 百万 token';
      const result = await enqueueAnalysis(tx,p.id,actor(req),actor(req),options,provider!,options.reuse ?? false);
      return {id:result.analysisId,reused:result.reused,active:result.active,analysisDisposition:result.analysisDisposition};
    });
  });
  app.post('/api/v2/project-submissions/:id/analyze', async (req) => {
    const user = (req as FastifyRequest & {user: {id: string; role: string}}).user;
    const submissionId = uuid.parse((req.params as any).id);
    const input = z.object({consent: z.literal(true), options: sourceOptionsSchema.optional()}).strict().parse(req.body);
    const options = sourceOptionsSchema.parse({...input.options, reuse: input.options?.reuse ?? true});
    if (options.incrementalFrom) fail(400, '班级导读先分析本次提交；版本对比请在本人的项目分析中发起');
    return db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(41724)');
      const {submission, task} = await projectSubmissionAccess(tx, submissionId, user);
      if (user.id !== submission.user_id && user.id !== task.teacher_id)
        fail(403, '仅提交者或本班教师可以发起分析');
      const projectId = submission.project_id;
      if (options.modules.length) {
        const files = (await tx.query('SELECT files FROM source_projects WHERE id=$1', [projectId])).rows[0]?.files;
        if (!files || options.modules.some(id => !buildSourceCatalog(files).groups.has(id)))
          fail(400, '所选目录不属于本次提交');
      }
      const provider = await requireProvider(user.id, tx);
      if (!options.cost) options.cost = officialSourcePrice(provider!) ?? undefined;
      else options.cost.label = '用户确认单价 · 人民币 / 百万 token';
      const result = await enqueueAnalysis(tx,projectId,submission.user_id,user.id,options,provider!,options.reuse ?? true);
      await tx.query('UPDATE project_submissions SET pending_analysis_id=$2 WHERE id=$1', [submissionId, result.analysisId]);
      return {...result,payerId:user.id};
    });
  });
  app.post('/api/v2/project-submissions/:id/cancel', async req => {
    const user = (req as FastifyRequest & {user:{id:string;role:string}}).user;
    const submissionId = uuid.parse((req.params as any).id);
    const {analysisId} = z.object({analysisId:uuid}).strict().parse(req.body);
    return db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(41724)');
      const {submission,task} = await projectSubmissionAccess(tx,submissionId,user);
      if (user.id !== submission.user_id && user.id !== task.teacher_id) fail(403,'仅提交者或所属教师可管理分析');
      return cancelAnalysis(tx,submission.project_id,submission.user_id,user.id,analysisId);
    });
  });
  app.post('/api/v2/source-cost-preview', async (req) => {
    const provider = await requireProvider(actor(req));
    const options = sourceOptionsSchema.parse(req.body ?? {});
    const quote = quoteSource(provider!, options);
    const rows = (await db.query("SELECT a.report,a.execution_snapshot FROM source_analyses a JOIN source_projects p ON p.id=a.project_id WHERE COALESCE(a.billing_user_id,p.owner_id)=$1 AND a.status='succeeded' AND a.analysis_options->>'mode'=$2 ORDER BY a.created_at DESC LIMIT 20",[actor(req),options.mode])).rows;
    const amounts = rows.flatMap(row => {
      const c = row.report?.context, model = row.execution_snapshot?.model;
      return quote.price && c?.callsWithUsage > 0 && c.callsWithoutUsage === 0 && Number.isSafeInteger(c.knownInputTokens) && Number.isSafeInteger(c.knownOutputTokens) && model?.model===provider!.configuration.model && model?.endpoint===provider!.configuration.endpoint
        ? [priceTokens(quote.price,c.knownInputTokens,c.knownOutputTokens)] : [];
    });
    return {...quote, historicalRange:amounts.length ? {min:Math.min(...amounts),max:Math.max(...amounts),samples:amounts.length} : null};
  });
  app.post("/api/v2/projects/:id/cancel", async (req) => {
    const p = await own((req.params as any).id, actor(req));
    const id = uuid.parse((req.body as any)?.analysisId);
    return db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(41724)');
      return cancelAnalysis(tx,p.id,actor(req),actor(req),id);
    });
  });
}
