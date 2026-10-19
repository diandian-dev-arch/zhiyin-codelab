import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  businessIdSchema,
  canonicalJson,
  createRuleSnapshot,
  createSourceManifest,
  sha256,
  sha256Schema,
  uuidSchema,
  versionSchema,
  validateRuleSnapshot,
  type RuleSnapshot,
  type MeasurementFingerprint,
  type TaskPackManifest,
} from "../../../packages/contracts/src/v2/index.js";
import type { DB } from "./db.js";
import { taskOverviews } from './task-overview-v2.js';
import { CourseModelError } from './course-model-v2.js';
import { ProjectCourseError, projectCourseOverviews, projectRubricSchema, registerProjectCourse } from './project-course.js';
import { registerCoursework } from './coursework.js';
import { CourseworkError } from './coursework-common.js';
import { admitReservedStorageV2 } from './storage-reservations-v2.js';
import type { StorageAdmission } from '../../runner/src/storage-admission.js';
import { StorageAdmissionError } from '../../runner/src/storage-admission.js';
import { enqueueReanalysisV2, cancelReanalysisV2 } from "./reanalysis-v2.js";
import { exportAnalysisPairV2 } from './analysis-export-v2.js';
import { createPackCatalog } from "./catalog-v2.js";
import {
  cancelQueuedV2,
  enqueueRunV2,
  LifecycleError,
  lockStudentTask,
  lockQueue,
} from "./lifecycle-v2.js";
import { templateVersion, templateZip, templateFiles, hashTemplateFiles } from "./template.js";
import { validateZip } from "./zip.js";
import {
  adoptReviewV2,
  confirmReviewV2,
  createCorrectionV2,
  editReviewV2,
  getPublicationV2,
  getPublicationComparisonV2,
  getPublicationComparisonOptionsV2,
  getReviewV2,
  getRunComparisonV2,
  getExplicitRunComparisonV2,
  publishReportV2,
  readPublicationEvidenceV2,
  readReviewEvidenceV2,
  ReportV2Error,
  type EvidenceReader,
} from "./reports-v2.js";

export interface V2RouteOptions {
  coursework?: {enabled?:boolean;background?:boolean};
  courseVault?: import('./coursework-sources.js').CourseVault;
  personalModels?: import('./user-model-settings.js').SourceProviderResolver;
  initialAnalysisMode?: import('./analysis-mode-v2.js').InitialAnalysisModeV2;
  storageAdmission?: StorageAdmission;
  analysisConfiguration?: import("./model-provider-v2.js").SummaryProviderV2["configuration"];
  packs?: readonly TaskPackManifest[];
  executionApproved: boolean;
  businessVersion: 1 | 2;
  evidenceReader?: EvidenceReader;
  approvedFingerprint?: (rule: RuleSnapshot) => Promise<MeasurementFingerprint>;
}
type Actor = { id: string; role: "teacher" | "student" };
type Row = Record<string, any>;
const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
const noPayload = z.object({}).strict();
const ruleRequest = z
  .object({
    packId: businessIdSchema,
    packVersion: versionSchema,
    packManifestHash: sha256Schema,
    enabledCriterionIds: z.array(businessIdSchema).min(1).max(15),
    parameterValues: z.record(
      z.union([z.boolean(), z.number().finite(), z.string()]),
    ),
    confirmed: z.literal(true),
  })
  .strict();
const runRequest = z.object({ retryOfRunId: uuidSchema.optional(), personalAnalysisMode: z.enum(['off','summary','agent']).optional() }).strict();
const taskRequest = z
  .object({
    classId: uuidSchema,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(5000),
    kind: z.enum(['template','project']).optional(),
    dueAt: z.string().datetime({offset:true}).nullable().optional(),
    rubric: projectRubricSchema.optional(),
  })
  .strict();

class ApiV2Error extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
function fail(code: string, message: string, statusCode = 400): never {
  throw new ApiV2Error(code, message, statusCode);
}
function actor(req: FastifyRequest): Actor {
  const value = (req as FastifyRequest & { user?: Actor }).user;
  if (!value || !["teacher", "student"].includes(value.role)) {
    fail("AUTHENTICATION_REQUIRED", "请先登录", 401);
  }
  return value;
}
function idParam(req: FastifyRequest) {
  return uuidSchema.parse((req.params as { id?: unknown }).id);
}
function requestKey(req: FastifyRequest) {
  const parsed = keySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success)
    fail(
      "INVALID_IDEMPOTENCY_KEY",
      "请提供 8—100 位字母、数字、下划线或连字符的幂等键",
    );
  return parsed.data;
}
function iso(value: string | Date | null | undefined) {
  return value == null ? null : new Date(value).toISOString();
}
async function revisionReply<T extends { replayed: boolean }>(
  reply: FastifyReply,
  resultPromise: Promise<T>,
) {
  const result = await resultPromise;
  reply.code(result.replayed ? 200 : 201);
  return result;
}
function runSummary(row: Row) {
  return {
    contractVersion: 2,
    runId: row.id,
    submissionId: row.submission_id,
    ruleId: row.rule_id,
    status: row.status,
    createdAt: iso(row.created_at),
    finishedAt: iso(row.finished_at),
    pipelineStartedAt: iso(row.pipeline_started_at),
    pipelineDeadlineAt: iso(row.pipeline_deadline_at),
  };
}
function errorHandler(error: Error, req: FastifyRequest, reply: FastifyReply) {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "服务暂时不可用，请稍后重试";
  let details: unknown;
  if (
    error instanceof CourseworkError ||
    error instanceof CourseModelError ||
    error instanceof ProjectCourseError ||
    error instanceof StorageAdmissionError ||
    error instanceof ApiV2Error ||
    error instanceof LifecycleError ||
    error instanceof ReportV2Error
  ) {
    ({ statusCode: status, code, message } = error);
  } else if (error instanceof z.ZodError) {
    status = 400;
    code = "INVALID_REQUEST";
    message = "请求内容不符合接口约定";
    details = error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    }));
  } else if (/^[A-Z][A-Z0-9_]{2,79}: /.test(error.message)) {
    status = 400;
    [code] = error.message.split(": ", 1);
    message = error.message.slice(code.length + 2);
  } else {
    const httpStatus = (error as Error & { statusCode?: number }).statusCode;
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      status = httpStatus;
      code =
        status === 401
          ? "AUTHENTICATION_REQUIRED"
          : status === 403
            ? "FORBIDDEN"
            : status === 413
              ? "PAYLOAD_TOO_LARGE"
              : "INVALID_REQUEST";
      message = error.message;
    }
  }
  if (status >= 500) req.log.error(error);
  reply.code(status).send({
    error: {
      code,
      message,
      requestId: req.id,
      ...(details ? { details } : {}),
    },
  });
}

/** Uses createApp's existing session/origin/CSRF hooks; never accepts client packs. */
export async function registerV2Routes(
  app: FastifyInstance,
  db: DB,
  options: V2RouteOptions,
): Promise<void> {
  const catalog = await createPackCatalog(options.packs);

  async function taskAccess(req: FastifyRequest, taskId: string, tx = db) {
    if ((await tx.query('SELECT task_id FROM course_tasks WHERE task_id=$1',[taskId])).rows.length)
      fail('COURSEWORK_ROUTE_REQUIRED','请从课程作业入口读取此任务',409);
    const user = actor(req);
    const task = (
      await tx.query(
        `SELECT t.id,t.class_id,t.title,t.description,t.created_at,t.kind,t.due_at,t.rubric,c.teacher_id
      FROM tasks t JOIN classes c ON c.id=t.class_id WHERE t.id=$1`,
        [taskId],
      )
    ).rows[0];
    if (!task) fail("NOT_FOUND", "任务不存在", 404);
    const allowed =
      user.role === "teacher"
        ? task.teacher_id === user.id
        : (
            await tx.query(
              "SELECT 1 FROM memberships WHERE class_id=$1 AND user_id=$2",
              [task.class_id, user.id],
            )
          ).rows.length > 0;
    if (!allowed) fail("NOT_FOUND", "任务不存在", 404);
    return task;
  }
  async function runAccess(req: FastifyRequest, runId: string) {
    const run = (
      await db.query(
        `SELECT r.id,r.submission_id,r.rule_id,r.status,r.created_at,r.finished_at,
      r.pipeline_started_at,r.pipeline_deadline_at,s.task_id,s.user_id
      FROM runs r JOIN submissions s ON s.id=r.submission_id
      WHERE r.id=$1 AND r.contract_version=2`,
        [runId],
      )
    ).rows[0];
    if (!run) fail("NOT_FOUND", "运行不存在", 404);
    try {
      await taskAccess(req, run.task_id);
    } catch (error) {
      if (error instanceof ApiV2Error && error.statusCode === 404)
        fail("NOT_FOUND", "运行不存在", 404);
      throw error;
    }
    if (actor(req).role === "student" && actor(req).id !== run.user_id)
      fail("NOT_FOUND", "运行不存在", 404);
    return run;
  }
  function submissionSummary(row: Row) {
    return {
      contractVersion: 2,
      submissionId: row.id,
      ruleId: row.rule_id,
      accepted: true,
      enqueueState: "not_requested",
      originalZipSha256: row.sha256,
      sourceManifestSha256: row.source_manifest_sha256,
    };
  }
  async function personalAnalysisAvailable(actorId: string) {
    if (!options.personalModels) return Boolean(options.analysisConfiguration);
    try { return Boolean(await options.personalModels(actorId)); }
    catch (error) {
      // An unreadable personal key must not hide sealed evidence or the teacher's report.
      if (['MODEL_KEY_UNAVAILABLE','MODEL_VAULT_UNAVAILABLE'].includes((error as {code?:string}).code ?? '')) return false;
      throw error;
    }
  }

  await app.register(
    async (api) => {
      api.setErrorHandler(errorHandler);
      api.addHook("preHandler", async (req) => {
        actor(req);
        if (
          !["GET", "HEAD"].includes(req.method) &&
          options.businessVersion !== 2
        ) {
          fail(
            "BUSINESS_VERSION_DISABLED",
            "当前业务写入仍使用 v1；完成切换后才能写入 v2",
            409,
          );
        }
      });

      api.get("/runs/:id/review", async (req) => ({
        ...(await getReviewV2(db, {
          runId: idParam(req),
          actorId: actor(req).id,
        })),
        analysisAvailable: await personalAnalysisAvailable(actor(req).id),
        personalModelBilling: Boolean(options.personalModels),
      }));
      api.post("/runs/:id/analyses", async (req, reply) => {
        const result = await enqueueReanalysisV2(db, {
          storageAdmission: options.storageAdmission,
          runId: idParam(req),
          actorId: actor(req).id,
          idempotencyKey: requestKey(req),
          body: req.body,
          configuration: options.analysisConfiguration,
          personalModels: options.personalModels,
        });
        reply.code(result.replayed ? 200 : 201);
        return { contractVersion: 2, ...result };
      });
      api.get('/runs/:id/analyses/:analysisId/export', async (req, reply) => {
        const params = z.object({ id: uuidSchema, analysisId: uuidSchema }).parse(req.params);
        const result = await exportAnalysisPairV2(db, {
          runId: params.id, analysisId: params.analysisId, actorId: actor(req).id,
        }, options.evidenceReader);
        return reply.type('application/zip')
          .header('Content-Disposition', `attachment; filename="${result.filename}"`)
          .header('Cache-Control', 'private, no-store')
          .header('X-Content-Type-Options', 'nosniff').send(Buffer.from(result.bytes));
      });
      api.post("/analyses/:id/cancel", async (req) => {
        requestKey(req);
        noPayload.parse(req.body ?? {});
        const analysisAttemptId = idParam(req), actorId = actor(req).id;
        // Resolve only a teacher-owned attempt; the cancellation transaction
        // rechecks ownership and binds the attempt to this exact run.
        const row = (await db.query(
          `SELECT a.run_id FROM analysis_attempts a
          JOIN runs r ON r.id=a.run_id JOIN submissions s ON s.id=r.submission_id
          JOIN tasks t ON t.id=s.task_id JOIN classes c ON c.id=t.class_id
          JOIN users u ON u.id=$2 AND u.role='teacher'
          WHERE a.id=$1 AND a.mode='reanalysis' AND r.contract_version=2 AND c.teacher_id=u.id`,
          [analysisAttemptId, actorId],
        )).rows[0];
        if (!row) fail("NOT_FOUND", "分析不存在", 404);
        return {
          contractVersion: 2,
          analysis: await cancelReanalysisV2(db, { runId: row.run_id, actorId, analysisAttemptId }),
        };
      });
      api.post("/runs/:id/analyses/:analysisId/cancel", async (req) => {
        requestKey(req);
        z.object({})
          .strict()
          .parse(req.body ?? {});
        const params = z
          .object({ id: uuidSchema, analysisId: uuidSchema })
          .parse(req.params);
        return {
          contractVersion: 2,
          analysis: await cancelReanalysisV2(db, {
            runId: params.id,
            actorId: actor(req).id,
            analysisAttemptId: params.analysisId,
          }),
        };
      });
      api.put("/runs/:id/review", (req, reply) =>
        revisionReply(
          reply,
          editReviewV2(
            db,
            {
              runId: idParam(req),
              actorId: actor(req).id,
              idempotencyKey: requestKey(req),
            },
            req.body,
          ),
        ),
      );
      api.post("/runs/:id/review/confirm", (req, reply) =>
        revisionReply(
          reply,
          confirmReviewV2(
            db,
            {
              runId: idParam(req),
              actorId: actor(req).id,
              idempotencyKey: requestKey(req),
            },
            req.body,
          ),
        ),
      );
      api.post("/runs/:id/review/adopt", (req, reply) =>
        revisionReply(
          reply,
          adoptReviewV2(
            db,
            {
              runId: idParam(req),
              actorId: actor(req).id,
              idempotencyKey: requestKey(req),
            },
            req.body,
          ),
        ),
      );
      api.post("/runs/:id/publications", async (req, reply) => {
        const result = await publishReportV2(
          db,
          {
            runId: idParam(req),
            actorId: actor(req).id,
            idempotencyKey: requestKey(req),
          },
          req.body,
          options.evidenceReader,
        );
        reply.code(result.replayed ? 200 : 201);
        return result;
      });
      api.post("/publications/:id/corrections", (req, reply) =>
        revisionReply(
          reply,
          createCorrectionV2(
            db,
            {
              publicationId: idParam(req),
              actorId: actor(req).id,
              idempotencyKey: requestKey(req),
            },
            req.body,
          ),
        ),
      );
      api.get("/publications/:id", (req) =>
        getPublicationV2(db, {
          publicationId: idParam(req),
          actorId: actor(req).id,
        }),
      );
      api.get('/publications/:id/comparison', (req) => {
        const query = z.object({before: uuidSchema}).strict().parse(req.query);
        return getPublicationComparisonV2(db, {publicationId: idParam(req),
          beforePublicationId: query.before, actorId: actor(req).id});
      });
      api.get('/publications/:id/comparison-options', (req) => {
        const query = z.object({after: uuidSchema.optional()}).strict().parse(req.query);
        return getPublicationComparisonOptionsV2(db, {publicationId:idParam(req), actorId:actor(req).id, after:query.after});
      });
      api.get("/publications/:id/evidence/:evidenceId", async (req, reply) => {
        const result = await readPublicationEvidenceV2(
          db,
          {
            publicationId: idParam(req),
            actorId: actor(req).id,
            evidenceId: uuidSchema.parse(
              (req.params as { evidenceId: unknown }).evidenceId,
            ),
          },
          options.evidenceReader,
        );
        return reply
          .type(result.evidence.mediaType)
          .header("X-Content-Type-Options", "nosniff")
          .header("Cache-Control", "private, no-store")
          .send(Buffer.from(result.bytes));
      });
      api.get("/runs/:id/evidence/:evidenceId", async (req, reply) => {
        const result = await readReviewEvidenceV2(
          db,
          {
            runId: idParam(req),
            actorId: actor(req).id,
            evidenceId: uuidSchema.parse(
              (req.params as { evidenceId: unknown }).evidenceId,
            ),
          },
          options.evidenceReader,
        );
        return reply
          .type(result.evidence.mediaType)
          .header("X-Content-Type-Options", "nosniff")
          .header("Cache-Control", "private, no-store")
          .send(Buffer.from(result.bytes));
      });

      api.post("/tasks", async (req, reply) => {
        const user = actor(req);
        if (user.role !== "teacher")
          fail("FORBIDDEN", "仅教师可以创建任务", 403);
        const body = taskRequest.parse(req.body);
        const key = `${user.id}:create_task:${requestKey(req)}`;
        const requestHash = await sha256(canonicalJson(body));
        return db.transaction(async (tx) => {
          const classroom = (
            await tx.query(
              "SELECT teacher_id FROM classes WHERE id=$1 FOR UPDATE",
              [body.classId],
            )
          ).rows[0];
          if (classroom?.teacher_id !== user.id)
            fail("NOT_FOUND", "班级不存在", 404);
          const prior = (
            await tx.query(
              "SELECT * FROM tasks WHERE class_id=$1 AND idempotency_key=$2",
              [body.classId, key],
            )
          ).rows[0];
          let task = prior;
          if (prior && prior.request_hash !== requestHash)
            fail("IDEMPOTENCY_CONFLICT", "该幂等键已用于不同任务内容", 409);
          if (!prior) {
            task = (
              await tx.query(
                `INSERT INTO tasks(id,class_id,title,description,created_at,idempotency_key,request_hash,kind,due_at,rubric)
              VALUES($1,$2,$3,$4,clock_timestamp(),$5,$6,$7,$8,$9) RETURNING *`,
                [
                  randomUUID(),
                  body.classId,
                  body.title,
                  body.description,
                  key,
                  requestHash,
                  body.kind ?? 'template',
                  body.dueAt ?? null,
                  JSON.stringify(body.rubric ?? []),
                ],
              )
            ).rows[0];
            reply.code(201);
          }
          return {
            contractVersion: 2,
            taskId: task.id,
            classId: task.class_id,
            title: task.title,
            description: task.description,
            kind: task.kind,
            dueAt: iso(task.due_at),
            rubric: task.rubric,
            createdAt: iso(task.created_at),
          };
        });
      });

      api.get("/tasks", async (req) => {
        const user = actor(req);
        const {after}=z.object({after:z.string().uuid().optional()}).strict().parse(req.query);
        const visible=`(${user.role === 'teacher' ? 'c.teacher_id=$1' : 'EXISTS(SELECT 1 FROM memberships m WHERE m.class_id=c.id AND m.user_id=$1)'}) AND NOT EXISTS(SELECT 1 FROM course_tasks ct WHERE ct.task_id=t.id)`;
        if(after && !(await db.query(`SELECT 1 FROM tasks t JOIN classes c ON c.id=t.class_id WHERE ${visible} AND t.id=$2`,[user.id,after])).rows.length)
          fail('INVALID_CURSOR','任务位置已失效，请刷新列表',400);
        const total=Number((await db.query(`SELECT count(*) AS n FROM tasks t JOIN classes c ON c.id=t.class_id WHERE ${visible}`,[user.id])).rows[0].n);
        const rows = (
          await db.query(
            `SELECT t.id,t.class_id,t.title,t.description,t.created_at,t.kind,t.due_at,t.rubric,
        current_rule.version AS rule_version,current_rule.rule_snapshot
        FROM tasks t JOIN classes c ON c.id=t.class_id
        LEFT JOIN LATERAL (SELECT version,rule_snapshot FROM rules
          WHERE task_id=t.id AND contract_version=2 ORDER BY version DESC LIMIT 1) current_rule ON true
        WHERE ${visible} AND ($2::uuid IS NULL OR t.created_at < (SELECT created_at FROM tasks WHERE id=$2)
          OR (t.created_at = (SELECT created_at FROM tasks WHERE id=$2) AND t.id > $2))
        ORDER BY t.created_at DESC,t.id LIMIT 201`,
            [user.id,after??null],
          )
        ).rows;
        const page=rows.slice(0,200);
        const overviews = await taskOverviews(db, page.map(row => row.id), user);
        const projectOverviews = await projectCourseOverviews(db, page.filter(row => row.kind === 'project').map(row => row.id), user);
        return {
          contractVersion: 2,
          total,
          nextCursor:rows.length>200?page[199].id:null,
          items: page.map((row) => ({
            taskId: row.id,
            classId: row.class_id,
            title: row.title,
            description: row.description,
            kind: row.kind,
            dueAt: iso(row.due_at),
            rubric: row.rubric,
            createdAt: iso(row.created_at),
            ruleVersion: row.rule_version,
            ruleScope: row.rule_snapshot ? {
              criteria: (row.rule_snapshot as RuleSnapshot).packManifest.criteria
                .filter(c => row.rule_snapshot.enabledCriterionIds.includes(c.criterionId))
                .map(c => ({criterionId:c.criterionId,title:c.title,mode:c.mode})),
              caseCount: row.rule_snapshot.requiredCaseIds.length,
            } : null,
            overview: projectOverviews.get(row.id) ?? overviews.get(row.id),
          })),
        };
      });

      api.get("/tasks/:id", async (req) => {
        const task = await taskAccess(req, idParam(req));
        const rules = (
          await db.query(
            "SELECT rule_snapshot FROM rules WHERE task_id=$1 AND contract_version=2 ORDER BY version DESC LIMIT 100",
            [task.id],
          )
        ).rows.map((row) => row.rule_snapshot);
        return {
          contractVersion: 2,
          taskId: task.id,
          classId: task.class_id,
          title: task.title,
          description: task.description,
          kind: task.kind,
          dueAt: iso(task.due_at),
          rubric: task.rubric,
          currentRule: rules[0] ?? null,
          rules,
          template: {
            version: rules[0]?.packManifest?.templateVersion ?? templateVersion,
            available: task.kind !== 'project' && (!rules[0] || (rules[0].packManifest.templateVersion === templateVersion && rules[0].packManifest.templateHash === hashTemplateFiles(await templateFiles()))),
            downloadUrl: `/api/v2/tasks/${task.id}/template${rules[0] ? '?ruleId='+rules[0].ruleId : ''}`,
          },
          executionAvailable: task.kind !== 'project' && options.executionApproved,
          personalModelBilling: Boolean(options.personalModels),
          writeEnabled: options.businessVersion === 2,
          ...(actor(req).role === "teacher"
            ? { availablePacks: catalog.list() }
            : {}),
        };
      });

      await registerProjectCourse(api, db);
      await registerCoursework(api, db, {resolve:options.personalModels,vault:options.courseVault,...options.coursework});

      api.get("/tasks/:id/template", async (req, reply) => {
        const task=await taskAccess(req, idParam(req));
        if (task.kind === 'project') fail('PROJECT_TASK_NO_TEMPLATE', '开放项目任务无需统一模板', 409);
        const {ruleId}=z.object({ruleId:z.string().uuid().optional()}).strict().parse(req.query);
        const rule=(await db.query(`SELECT template_version,rule_snapshot FROM rules WHERE task_id=$1 AND contract_version=2
          ${ruleId?'AND id=$2':''} ORDER BY version DESC LIMIT 1`,ruleId?[task.id,ruleId]:[task.id])).rows[0];
        if(ruleId&&!rule)fail('RULE_NOT_FOUND','该任务没有此规则版本',404);
        if(rule&&rule.template_version!==templateVersion)
          fail('TEMPLATE_UNAVAILABLE','该规则所需模板尚未部署，请联系教师确认模板版本',409);
        const files=await templateFiles();
        if(rule && rule.rule_snapshot.packManifest.templateHash!==hashTemplateFiles(files))
          fail('TEMPLATE_INTEGRITY_MISMATCH','模板内容与规则要求不一致，请联系教师检查部署',409);
        reply
          .type("application/zip")
          .header(
            "Content-Disposition",
            `attachment; filename="${templateVersion}.zip"`,
          );
        return templateZip(files);
      });

      api.get('/tasks/:id/rules', async req => {
        const task = await taskAccess(req, idParam(req));
        const {beforeVersion} = z.object({beforeVersion:z.coerce.number().int().positive().optional()}).strict().parse(req.query);
        const rows=(await db.query(`SELECT rule_snapshot,version FROM rules WHERE task_id=$1 AND contract_version=2
          AND ($2::int IS NULL OR version<$2) ORDER BY version DESC LIMIT 101`,[task.id,beforeVersion ?? null])).rows;
        return {items:rows.slice(0,100).map(row=>row.rule_snapshot),nextBeforeVersion:rows.length>100?rows[99].version:null};
      });
      api.post("/tasks/:id/rules", async (req, reply) => {
        const taskId = idParam(req);
        const task = await taskAccess(req, taskId);
        if (task.kind === 'project') fail('PROJECT_TASK_ROUTE_REQUIRED', '开放项目任务使用文字评价标准，无需发布模板规则', 409);
        const user = actor(req);
        if (user.role !== "teacher")
          fail("FORBIDDEN", "仅所属教师可以发布规则", 403);
        const body = ruleRequest.parse(req.body);
        const key = `${user.id}:publish_rule:${requestKey(req)}`;
        const requestHash = await sha256(
          canonicalJson({
            actorId: user.id,
            taskId,
            ...body,
            enabledCriterionIds: [...body.enabledCriterionIds].sort(),
          }),
        );
        return db.transaction(async (tx) => {
          await tx.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [
            taskId,
          ]);
          await taskAccess(req, taskId, tx);
          const prior = (
            await tx.query(
              "SELECT rule_snapshot,request_hash FROM rules WHERE task_id=$1 AND contract_version=2 AND idempotency_key=$2",
              [taskId, key],
            )
          ).rows[0];
          if (prior) {
            if (prior.request_hash !== requestHash)
              fail(
                "IDEMPOTENCY_CONFLICT",
                "该幂等键已用于不同的规则发布内容",
                409,
              );
            return { contractVersion: 2, rule: prior.rule_snapshot };
          }
          const pack = catalog.get(body.packId, body.packVersion);
          if (!pack)
            fail("PACK_NOT_AVAILABLE", "启动端尚未登记该任务包版本", 409);
          if (pack.contentHash !== body.packManifestHash)
            fail(
              "PACK_VERSION_CONFLICT",
              "所选任务包内容已变化，请重新读取",
              409,
            );
          if (pack.templateVersion !== templateVersion)
            fail("TEMPLATE_UNAVAILABLE", "该任务包要求的模板尚未部署", 409);
          const version =
            Number(
              (
                await tx.query(
                  "SELECT COALESCE(max(version),0) AS version FROM rules WHERE task_id=$1",
                  [taskId],
                )
              ).rows[0].version,
            ) + 1;
          const snapshot = await createRuleSnapshot({
            ruleId: randomUUID(),
            taskId,
            version,
            packManifest: pack,
            enabledCriterionIds: body.enabledCriterionIds,
            parameterValues: body.parameterValues,
            confirmedBy: user.id,
            confirmedAt: new Date().toISOString(),
          });
          await tx.query(
            `INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,'[]',2,$5,$6,$7)`,
            [
              snapshot.ruleId,
              taskId,
              version,
              pack.templateVersion,
              JSON.stringify(snapshot),
              key,
              requestHash,
            ],
          );
          reply.code(201);
          return { contractVersion: 2, rule: snapshot };
        });
      });

      api.post("/tasks/:id/submissions", async (req, reply) => {
        const taskId = idParam(req);
        const task = await taskAccess(req, taskId);
        if (task.kind === 'project') fail('PROJECT_TASK_ROUTE_REQUIRED', '请从开放项目任务页面提交已保存的项目', 409);
        const user = actor(req);
        if (user.role !== "student")
          fail("FORBIDDEN", "请使用学生本人账号提交", 403);
        const ruleId = uuidSchema.parse(req.headers["x-rule-id"]);
        const key = `${user.id}:submit_v2:${taskId}:${requestKey(req)}`;
        const rule = (
          await db.query(
            "SELECT id,template_version,rule_snapshot FROM rules WHERE id=$1 AND task_id=$2 AND contract_version=2",
            [ruleId, taskId],
          )
        ).rows[0];
        if (!rule) fail("RULE_NOT_FOUND", "所选任务规则不存在", 404);
        if(rule.template_version!==templateVersion)
          fail('TEMPLATE_UNAVAILABLE','该规则所需模板尚未部署，请联系教师确认模板版本',409);
        if(rule.rule_snapshot.packManifest.templateHash!==hashTemplateFiles(await templateFiles()))
          fail('TEMPLATE_INTEGRITY_MISMATCH','模板内容与规则要求不一致，请联系教师检查部署',409);
        const data = await req.file();
        if (!data || data.fieldname !== "file")
          fail("ZIP_REQUIRED", "请使用 file 字段上传一份 ZIP");
        let validated: Awaited<ReturnType<typeof validateZip>>;
        try {
          const bytes = await data.toBuffer();
          if (data.file.truncated)
            fail("PAYLOAD_TOO_LARGE", "ZIP 超过 10 MiB", 413);
          validated = await validateZip(bytes);
        } catch (error) {
          if (
            error instanceof ApiV2Error ||
            (error as { statusCode?: number }).statusCode === 413
          )
            throw error;
          fail(
            "ZIP_INVALID",
            error instanceof Error ? error.message : "ZIP 无效",
          );
        }
        const sourceManifest = await createSourceManifest(
          Object.fromEntries(
            Object.entries(validated.files).filter(
              ([name]) => name.startsWith("src/") || name.startsWith("public/"),
            ),
          ),
        );
        return db.transaction(async (tx) => {
          await lockStudentTask(tx, taskId, user.id);
          await taskAccess(req, taskId, tx);
          const prior = (
            await tx.query(
              "SELECT id,rule_id,task_id,sha256,source_manifest_sha256,contract_version FROM submissions WHERE user_id=$1 AND request_id=$2",
              [user.id, key],
            )
          ).rows[0];
          if (prior) {
            if (
              prior.contract_version !== 2 ||
              prior.task_id !== taskId ||
              prior.rule_id !== ruleId ||
              prior.sha256 !== validated.sha256 ||
              prior.source_manifest_sha256 !==
                sourceManifest.sourceManifestSha256
            ) {
              fail(
                "IDEMPOTENCY_CONFLICT",
                "该幂等键已用于不同的提交内容或规则",
                409,
              );
            }
            return submissionSummary(prior);
          }
          // Same lock as queue admission: serialize upload writes across API processes.
          await lockQueue(tx);
          await admitReservedStorageV2(tx, options.storageAdmission, true);
          const created = (
            await tx.query(
              `INSERT INTO submissions
          (id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256,source_manifest_version,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,2,$8,$9,$10,clock_timestamp())
          RETURNING id,rule_id,sha256,source_manifest_sha256`,
              [
                randomUUID(),
                taskId,
                user.id,
                ruleId,
                validated.sha256,
                JSON.stringify(validated.files),
                key,
                JSON.stringify(sourceManifest),
                sourceManifest.sourceManifestSha256,
                sourceManifest.algorithmVersion,
              ],
            )
          ).rows[0];
          reply.code(201);
          return submissionSummary(created);
        });
      });

      api.get("/tasks/:id/submissions", async (req) => {
        const task = await taskAccess(req, idParam(req));
        const user = actor(req);
        const { after } = z.object({ after: z.string().uuid().optional() }).strict().parse(req.query);
        const scope = [task.id, user.role === 'student' ? user.id : null];
        const scopeSql = 's.task_id=$1 AND s.contract_version=2 AND ($2::uuid IS NULL OR s.user_id=$2)';
        if (after && !(await db.query(`SELECT 1 FROM submissions s WHERE ${scopeSql} AND s.id=$3`, [...scope, after])).rows.length)
          fail('INVALID_CURSOR', '历史位置已失效，请刷新提交列表', 400);
        const total = Number((await db.query(`SELECT count(*) AS n FROM submissions s WHERE ${scopeSql}`, scope)).rows[0].n);
        const rows = (
          await db.query(
            `SELECT s.id,s.user_id,s.rule_id,s.sha256,s.source_manifest_sha256,s.created_at,
        r.id AS run_id,r.status AS run_status FROM submissions s
        LEFT JOIN LATERAL(SELECT id,status FROM runs WHERE submission_id=s.id AND contract_version=2 ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
        WHERE ${scopeSql} AND ($3::uuid IS NULL OR
          s.created_at < (SELECT created_at FROM submissions WHERE id=$3) OR
          (s.created_at = (SELECT created_at FROM submissions WHERE id=$3) AND s.id > $3))
        ORDER BY s.created_at DESC,s.id LIMIT 201`,
            [...scope, after ?? null],
          )
        ).rows;
        return {
          contractVersion: 2,
          total,
          nextCursor: rows.length > 200 ? rows[199].id : null,
          items: rows.slice(0, 200).map((row) => ({
            submissionId: row.id,
            studentId: row.user_id,
            ruleId: row.rule_id,
            originalZipSha256: row.sha256,
            sourceManifestSha256: row.source_manifest_sha256,
            createdAt: iso(row.created_at),
            latestRun: row.run_id
              ? { runId: row.run_id, status: row.run_status }
              : null,
          })),
        };
      });

      api.post("/submissions/:id/runs", async (req, reply) => {
        const submissionId = idParam(req);
        const body = runRequest.parse(req.body ?? {});
        const actorId = actor(req).id;
        const idempotencyKey = requestKey(req);
        let approvedFingerprint: MeasurementFingerprint | undefined;
        if (options.approvedFingerprint && options.executionApproved) {
          // A resolver may read trusted runtime state. Never invoke it for an
          // unauthorized submission or with a rule selected by the request.
          const submission = (
            await db.query(
              `SELECT s.contract_version,s.task_id,s.rule_id,ru.rule_snapshot
              FROM submissions s JOIN tasks t ON t.id=s.task_id
              JOIN classes c ON c.id=t.class_id JOIN rules ru ON ru.id=s.rule_id
              WHERE s.id=$1 AND (c.teacher_id=$2 OR (s.user_id=$2 AND EXISTS(
                SELECT 1 FROM memberships m WHERE m.class_id=c.id AND m.user_id=$2)))`,
              [submissionId, actorId],
            )
          ).rows[0];
          if (!submission) fail("NOT_FOUND", "提交不存在", 404);
          if (submission.contract_version !== 2)
            fail("CLIENT_UPGRADE_REQUIRED", "历史提交仅供旧协议读取");
          const replay = (
            await db.query(
              "SELECT id FROM runs WHERE submission_id=$1 AND idempotency_key=$2",
              [submissionId, `${actorId}:create_run:${idempotencyKey}`],
            )
          ).rows[0];
          // Existing runs retain their stored approval even after the runtime
          // catalog changes. Lifecycle still verifies replay request identity.
          if (!replay) {
            const rule = await validateRuleSnapshot(submission.rule_snapshot);
            if (
              rule.ruleId !== submission.rule_id ||
              rule.taskId !== submission.task_id
            )
              fail("RULE_SNAPSHOT_MISMATCH", "提交的规则快照身份不一致");
            approvedFingerprint = await options.approvedFingerprint(rule);
          }
        }
        const result = await enqueueRunV2(db, {
          initialAnalysisMode: options.initialAnalysisMode,
          personalModels: options.personalModels,
          personalAnalysisMode: body.personalAnalysisMode,
          storageAdmission: options.storageAdmission,
          submissionId,
          actorId,
          idempotencyKey,
          executionApproved: options.executionApproved,
          ...(approvedFingerprint ? { approvedFingerprint } : {}),
          ...(body.retryOfRunId ? { retryOfRunId: body.retryOfRunId } : {}),
        });
        reply.code(result.replayed ? 200 : 202);
        return runSummary(result.run);
      });

      api.post("/runs/:id/cancel", async (req) => {
        const runId = idParam(req);
        noPayload.parse(req.body ?? {});
        requestKey(req);
        return runSummary(await cancelQueuedV2(db, runId, actor(req).id));
      });

      api.get("/compare", (req) => {
        const query = z.object({ before: uuidSchema, after: uuidSchema }).strict().parse(req.query);
        return getExplicitRunComparisonV2(db, {
          beforeRunId: query.before, afterRunId: query.after, actorId: actor(req).id,
        });
      });
      api.get("/runs/:id/comparison", (req) =>
        getRunComparisonV2(db, { runId: idParam(req), actorId: actor(req).id }),
      );

      api.get("/runs/:id", async (req) => {
        const run = await runAccess(req, idParam(req));
        const owner = (
          await db.query(
            "SELECT owner_phase,base_sealed_at FROM execution_attempts WHERE run_id=$1 ORDER BY attempt_no DESC LIMIT 1",
            [run.id],
          )
        ).rows[0];
        const analysis = (
          await db.query(
            "SELECT id,mode,status,created_at,finished_at FROM analysis_attempts WHERE run_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
            [run.id],
          )
        ).rows[0];
        const publication = (
          await db.query(
            "SELECT id,publication_no,purpose,published_at FROM publications WHERE run_id=$1 ORDER BY publication_no DESC LIMIT 1",
            [run.id],
          )
        ).rows[0];
        return {
          ...runSummary(run),
          taskId: run.task_id,
          baseSealed: !!owner?.base_sealed_at,
          resourceState: owner?.owner_phase ?? null,
          analysis: analysis
            ? {
                analysisAttemptId: analysis.id,
                mode: analysis.mode,
                status: analysis.status,
                createdAt: iso(analysis.created_at),
                finishedAt: iso(analysis.finished_at),
              }
            : null,
          report: {
            state: publication ? "published" : "unpublished",
            latestPublication: publication
              ? {
                  publicationId: publication.id,
                  publicationNo: publication.publication_no,
                  purpose: publication.purpose,
                  publishedAt: iso(publication.published_at),
                }
              : null,
          },
        };
      });
    },
    { prefix: "/api/v2" },
  );
}
