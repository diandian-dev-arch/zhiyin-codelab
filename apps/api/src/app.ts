import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  taskSchema,
  feedbackSchema,
  verdict,
  compareResults,
  type CheckResult,
} from "@codelab/contracts";
import type { DB } from "./db.js";
import { digest, token, verifyPassword, hashPassword } from "./auth.js";
import { templateZip, templateVersion } from "./template.js";
import { validateZip } from "./zip.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./template.js";
import type {
  TaskPackManifest,
  Evidence,
  RuleSnapshot,
  MeasurementFingerprint,
} from "@codelab/contracts/v2";
import { registerV2Routes } from "./routes-v2.js";
import { registerSourceProjects } from './source-projects.js';
import { createUserModelService, registerUserModelRoutes, type UserModelService } from './user-model-settings.js';
import { enforceTeacherTrialRequest } from './teacher-trial-policy.js';
export interface Config {
  teacherTrial?: boolean;
  sessionCookieName?: string;
  coursework?: {enabled?:boolean;background?:boolean};
  userModels?: UserModelService;
  sourceProvider?: import('./model-provider-v2.js').SummaryProviderV2;
  storageAdmission?: import('../../runner/src/storage-admission.js').StorageAdmission;
  initialAnalysisMode?: import('./analysis-mode-v2.js').InitialAnalysisModeV2;
  analysisConfiguration?: import("./model-provider-v2.js").SummaryProviderV2["configuration"];
  origin: string;
  additionalOrigins?: readonly string[];
  secure: boolean;
  executionApproved: boolean;
  model: string;
  image: string;
  packs?: readonly TaskPackManifest[];
  businessVersion?: 1 | 2;
  evidenceReader?: (evidence: Evidence) => Promise<Uint8Array>;
  approvedFingerprint?: (rule: RuleSnapshot) => Promise<MeasurementFingerprint>;
}
const uuid = z.string().uuid();
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
const json = (v: any) => JSON.stringify(v);
export function problem(status: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode: status });
}
export async function createApp(db: DB, config: Config) {
  const sessionCookieName = config.sessionCookieName ?? (config.teacherTrial ? 'codelab_teacher_trial_sid' : 'sid');
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(sessionCookieName) || (config.teacherTrial && sessionCookieName === 'sid'))
    throw new Error('SESSION_COOKIE_NAME_INVALID');
  if (config.teacherTrial && (config.executionApproved || config.userModels || config.sourceProvider || config.packs?.length || config.evidenceReader || config.approvedFingerprint))
    throw new Error('TEACHER_TRIAL_CAPABILITIES_MUST_BE_DISABLED');
  const app = Fastify({ logger: false, bodyLimit: 11 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  // The global authentication hook runs before this route-level limiter.
  // Verified accounts have separate read/write buckets across sessions and IPs.
  // Public requests remain IP-scoped; login keeps its stricter route limit.
  await app.register(rateLimit, {
    max: (request) => request.method === "GET" ? 240 : 100,
    keyGenerator: (request) => {
      const accountId = (request as any).user?.id;
      if (accountId)
        return `account:${accountId}:${request.method === "GET" ? "read" : "write"}`;
      return `${request.ip}:${request.method === "GET" ? "read" : "write"}`;
    },
    timeWindow: "1 minute",
  });
  app.setErrorHandler((e, req, reply) => {
    const status =
      e instanceof z.ZodError ? 400 : ((e as any).statusCode ?? 500);
    if (
      req.url.startsWith("/api/v2/") ||
      (e as any).code === "CLIENT_UPGRADE_REQUIRED"
    ) {
      const codes: Record<number, string> = {
        400: "INVALID_REQUEST",
        401: "UNAUTHENTICATED",
        403: "FORBIDDEN",
        404: "NOT_FOUND",
        409: "CONFLICT",
        429: "RATE_LIMITED",
        503: "SERVICE_UNAVAILABLE",
      };
      reply.code(status).send({
        error: {
          code:
            status >= 500 && status !== 503
              ? "INTERNAL_ERROR"
              : ((e as any).code ?? codes[status] ?? "INVALID_REQUEST"),
          message:
            status >= 500 && status !== 503
              ? "服务暂时不可用，请稍后重试"
              : e instanceof z.ZodError
                ? "请求字段无效"
                : e instanceof Error
                  ? e.message
                  : "请求无效",
          requestId: req.id,
        },
      });
      if (status >= 500) app.log.error(e);
      return;
    }
    reply.code(status).send({
      error:
        status === 500
          ? "服务暂时不可用，请稍后重试"
          : e instanceof Error
            ? e.message
            : "请求无效",
    });
    if (status >= 500) app.log.error(e);
  });
  app.decorateRequest("user", null);
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store");
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.headers.origin !== config.origin &&
      !(typeof req.headers.origin === 'string' && config.additionalOrigins?.includes(req.headers.origin))
    )
      problem(403, "请求来源不受信任");
    if (req.url === "/api/v1/health" || req.url === "/api/v1/session/login")
      return;
    const sid = req.cookies[sessionCookieName];
    if (!sid) problem(401, "请先登录");
    const session = (
      await db.query(
        "SELECT s.*,u.email,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now()",
        [digest(sid)],
      )
    ).rows[0];
    if (!session) problem(401, "登录已过期");
    (req as any).user = {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role,
    };
    (req as any).session = session;
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-csrf-token"] !== session.csrf
    )
      problem(403, "安全令牌已失效，请刷新页面");
    if (
      config.businessVersion === 2 &&
      !config.teacherTrial &&
      !["GET", "HEAD"].includes(req.method) &&
      /^\/api\/v1\/(tasks|submissions|runs)(\/|\?|$)/.test(req.url)
    )
      throw Object.assign(
        new Error("业务接口已升级，请刷新工作台；历史报告仍可读取"),
        { statusCode: 409, code: "CLIENT_UPGRADE_REQUIRED" },
      );
  });
  if (config.teacherTrial) app.addHook('preValidation', async req => {
    enforceTeacherTrialRequest({ method: req.method, url: req.url, body: req.body });
  });
  const user = (req: any) => req.user;
  const teacher = (req: any) => {
    if (user(req).role !== "teacher") problem(403, "仅教师可操作");
    return user(req);
  };
  async function taskAccess(req: any, id: string) {
    uuid.parse(id);
    if((await db.query('SELECT task_id FROM course_tasks WHERE task_id=$1',[id])).rows.length) problem(409,'此任务请从课程作业入口打开');
    const t = (
      await db.query(
        "SELECT t.*,c.teacher_id FROM tasks t JOIN classes c ON c.id=t.class_id WHERE t.id=$1",
        [id],
      )
    ).rows[0];
    if (!t) problem(404, "任务不存在");
    const u = user(req);
    if (
      u.role === "teacher"
        ? t.teacher_id !== u.id
        : !(
            await db.query(
              "SELECT 1 FROM memberships WHERE class_id=$1 AND user_id=$2",
              [t.class_id, u.id],
            )
          ).rows.length
    )
      problem(404, "任务不存在");
    return t;
  }
  async function runAccess(req: any, id: string) {
    uuid.parse(id);
    const r = (
      await db.query(
        "SELECT r.*,s.user_id,s.task_id,s.rule_id,s.sha256,s.created_at AS submitted_at,ru.criteria,ru.template_version,ru.version AS rule_version FROM runs r JOIN submissions s ON s.id=r.submission_id JOIN rules ru ON ru.id=s.rule_id WHERE r.id=$1 AND r.contract_version=1",
        [id],
      )
    ).rows[0];
    if (!r) problem(404, "运行不存在");
    await taskAccess(req, r.task_id);
    if (user(req).role === "student" && r.user_id !== user(req).id)
      problem(404, "运行不存在");
    return r;
  }
  app.get("/api/v1/health", () => ({
    ok: true,
    executionApproved: config.executionApproved,
    businessVersion: config.businessVersion ?? 1,
    ...(config.teacherTrial ? { workspace: 'teacher-trial', modelsEnabled: false, codeExecutionEnabled: false } : {}),
  }));
  app.post(
    "/api/v1/session/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          email: z.string().email().max(200),
          password: z.string().max(200),
        })
        .parse(req.body);
      const u = (
        await db.query("SELECT * FROM users WHERE email=$1", [
          body.email.toLowerCase(),
        ])
      ).rows[0];
      if (!u || !verifyPassword(body.password, u.password_hash))
        problem(401, "账号或密码错误");
      const sid = token(),
        csrf = token();
      await db.query(
        "INSERT INTO sessions VALUES($1,$2,$3,now()+interval '8 hours')",
        [digest(sid), u.id, csrf],
      );
      reply.setCookie(sessionCookieName, sid, {
        httpOnly: true,
        secure: config.secure,
        sameSite: "strict",
        path: "/",
        maxAge: 28800,
      });
      return {
        user: { id: u.id, email: u.email, name: u.name, role: u.role },
        csrf,
      };
    },
  );
  app.get("/api/v1/session", async (req) => ({
    user: user(req),
    csrf: (req as any).session.csrf,
    executionApproved: config.executionApproved,
    businessVersion: config.businessVersion ?? 1,
    ...(config.teacherTrial ? { workspace: 'teacher-trial' } : {}),
  }));
  app.post("/api/v1/session/logout", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE id=$1", [
      (req as any).session.id,
    ]);
    reply.clearCookie(sessionCookieName, { path: "/" });
    return { ok: true };
  });
  app.get("/api/v1/classes", async (req) => ({
    items: (
      await db.query(
        user(req).role === "teacher"
          ? "SELECT * FROM classes WHERE teacher_id=$1"
          : "SELECT c.* FROM classes c JOIN memberships m ON m.class_id=c.id WHERE m.user_id=$1",
        [user(req).id],
      )
    ).rows,
  }));
  app.post("/api/v1/classes", async (req) => {
    const u = teacher(req);
    const { name } = z
      .object({ name: z.string().min(1).max(120) })
      .parse(req.body);
    const key = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional().parse(req.headers['idempotency-key']);
    return db.transaction(async tx => {
      // Serialize a teacher's creations so concurrent retries resolve identically.
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
      if (key) {
        const prior = (await tx.query('SELECT class_id,request_name FROM class_creation_requests WHERE teacher_id=$1 AND request_key=$2', [u.id,key])).rows[0];
        if (prior) {
          if (prior.request_name !== name) problem(409, '此创建请求对应的班级名称已变化，请重新发起');
          return {id:prior.class_id};
        }
      }
      const id = randomUUID();
      await tx.query('INSERT INTO classes(id,name,teacher_id) VALUES($1,$2,$3)', [id,name,u.id]);
      if (key) await tx.query('INSERT INTO class_creation_requests VALUES($1,$2,$3,$4)', [u.id,key,id,name]);
      return {id};
    });
  });
  app.get('/api/v1/classes/:id/students', async req => {
    const owner = teacher(req), id = uuid.parse((req.params as any).id);
    if (!(await db.query('SELECT 1 FROM classes WHERE id=$1 AND teacher_id=$2',[id,owner.id])).rows.length)
      problem(404,'班级不存在');
    const query = z.object({after:z.string().uuid().optional(),email:z.string().email().max(200).optional()}).parse(req.query);
    const rows = (await db.query(`SELECT u.id,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.class_id=$1 AND u.role='student' AND ($2::uuid IS NULL OR u.id>$2::uuid)
      AND ($3::text IS NULL OR u.email=$3) ORDER BY u.id LIMIT 101`,[id,query.after??null,query.email?.toLowerCase()??null])).rows;
    const items = rows.slice(0,100);
    return {items,nextCursor:rows.length>100?items.at(-1).id:null};
  });
  app.post("/api/v1/classes/:id/students", async (req) => {
    teacher(req);
    const id = uuid.parse((req.params as any).id);
    if (
      !(
        await db.query("SELECT 1 FROM classes WHERE id=$1 AND teacher_id=$2", [
          id,
          user(req).id,
        ])
      ).rows.length
    )
      problem(404, "班级不存在");
    const b = z
      .object({
        email: z.string().email().max(200),
        name: z.string().min(1).max(80),
        password: z.string().min(12).max(200),
      })
      .parse(req.body);
    const student = randomUUID();
    await db.transaction(async (tx) => {
      if (
        (
          await tx.query("SELECT 1 FROM users WHERE email=$1", [
            b.email.toLowerCase(),
          ])
        ).rows.length
      )
        problem(409, "账号已存在");
      await tx.query("INSERT INTO users VALUES($1,$2,$3,$4,$5)", [
        student,
        b.email.toLowerCase(),
        b.name,
        "student",
        hashPassword(b.password),
      ]);
      await tx.query("INSERT INTO memberships VALUES($1,$2)", [id, student]);
    });
    return { id: student };
  });
  app.get("/api/v1/tasks", async (req) => {
    const u = user(req);
    return {
      items: (
        await db.query(
          `SELECT t.*,c.name AS class_name,(SELECT max(version) FROM rules WHERE task_id=t.id AND contract_version=1) AS rule_version FROM tasks t JOIN classes c ON c.id=t.class_id WHERE (${u.role === "teacher" ? "c.teacher_id=$1" : "EXISTS(SELECT 1 FROM memberships m WHERE m.class_id=c.id AND m.user_id=$1)"}) AND NOT EXISTS(SELECT 1 FROM course_tasks ct WHERE ct.task_id=t.id) ORDER BY t.created_at DESC`,
          [u.id],
        )
      ).rows,
    };
  });
  app.post("/api/v1/tasks", async (req) => {
    teacher(req);
    const b = taskSchema.parse(req.body);
    if (
      !(
        await db.query("SELECT 1 FROM classes WHERE id=$1 AND teacher_id=$2", [
          b.classId,
          user(req).id,
        ])
      ).rows.length
    )
      problem(404, "班级不存在");
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO tasks(id,class_id,title,description) VALUES($1,$2,$3,$4)",
        [id, b.classId, b.title, b.description],
      );
      await tx.query(
        "INSERT INTO rules(id,task_id,version,template_version,criteria) VALUES($1,$2,1,$3,$4)",
        [randomUUID(), id, templateVersion, json(b.criteria)],
      );
    });
    return { id };
  });
  app.get("/api/v1/tasks/:id", async (req) => {
    const task = await taskAccess(req, (req.params as any).id);
    return {
      ...task,
      rules: (
        await db.query(
          "SELECT * FROM rules WHERE task_id=$1 AND contract_version=1 ORDER BY version DESC",
          [task.id],
        )
      ).rows,
    };
  });
  app.post("/api/v1/tasks/:id/rules", async (req) => {
    teacher(req);
    const t = await taskAccess(req, (req.params as any).id);
    const b = taskSchema.parse({
      ...(req.body as object),
      title: t.title,
      description: t.description,
      classId: t.class_id,
    });
    return db.transaction(async (tx) => {
      await tx.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [t.id]);
      const v =
        Number(
          (
            await tx.query(
              "SELECT max(version) AS v FROM rules WHERE task_id=$1",
              [t.id],
            )
          ).rows[0].v,
        ) + 1;
      const id = randomUUID();
      await tx.query(
        "INSERT INTO rules(id,task_id,version,template_version,criteria) VALUES($1,$2,$3,$4,$5)",
        [id, t.id, v, templateVersion, json(b.criteria)],
      );
      return { id, version: v };
    });
  });
  app.get("/api/v1/tasks/:id/template", async (req, reply) => {
    await taskAccess(req, (req.params as any).id);
    reply
      .type("application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="${templateVersion}.zip"`,
      );
    return templateZip();
  });
  app.post("/api/v1/tasks/:id/submissions", async (req, reply) => {
    const t = await taskAccess(req, (req.params as any).id);
    if (user(req).role !== "student") problem(403, "请使用学生账号提交");
    const key = requestId.parse(req.headers["idempotency-key"]);
    const data = await req.file();
    if (!data) problem(400, "请选择 ZIP 文件");
    let validated;
    try {
      const buf = await data.toBuffer();
      if (data.file.truncated) problem(413, "ZIP 超过 10 MB");
      validated = await validateZip(buf);
    } catch (e) {
      problem(400, e instanceof Error ? e.message : "无效 ZIP");
    }
    return db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        user(req).id,
      ]);
      const duplicate = (
        await tx.query(
          "SELECT id,sha256,task_id FROM submissions WHERE user_id=$1 AND request_id=$2 AND contract_version=1",
          [user(req).id, key],
        )
      ).rows[0];
      if (duplicate) {
        if (duplicate.task_id !== t.id || duplicate.sha256 !== validated.sha256)
          problem(409, "请求编号冲突");
        return { id: duplicate.id, reused: true };
      }
      const rule = (
        await tx.query(
          "SELECT id FROM rules WHERE task_id=$1 AND contract_version=1 ORDER BY version DESC LIMIT 1",
          [t.id],
        )
      ).rows[0];
      const id = randomUUID();
      await tx.query(
        "INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          t.id,
          user(req).id,
          rule.id,
          validated.sha256,
          json(validated.files),
          key,
        ],
      );
      reply.code(201);
      return { id, status: "received" };
    });
  });
  app.get("/api/v1/tasks/:id/submissions", async (req) => {
    const t = await taskAccess(req, (req.params as any).id);
    return {
      items: (
        await db.query(
          `SELECT s.id,s.sha256,s.user_id,s.created_at,u.name,r.id AS run_id,r.status,r.outcome,r.model_status,ru.version AS rule_version FROM submissions s JOIN users u ON u.id=s.user_id JOIN rules ru ON ru.id=s.rule_id LEFT JOIN LATERAL(SELECT * FROM runs WHERE submission_id=s.id AND contract_version=1 ORDER BY created_at DESC,id DESC LIMIT 1) r ON true WHERE s.task_id=$1 AND s.contract_version=1 ${user(req).role === "student" ? "AND s.user_id=$2" : ""} ORDER BY s.created_at DESC LIMIT 200`,
          user(req).role === "student" ? [t.id, user(req).id] : [t.id],
        )
      ).rows,
    };
  });
  app.post("/api/v1/submissions/:id/runs", async (req) => {
    const id = uuid.parse((req.params as any).id),
      key = requestId.parse(req.headers["idempotency-key"]);
    const s = (
      await db.query(
        "SELECT * FROM submissions WHERE id=$1 AND contract_version=1",
        [id],
      )
    ).rows[0];
    if (!s) problem(404, "提交不存在");
    await taskAccess(req, s.task_id);
    if (user(req).role === "student" && s.user_id !== user(req).id)
      problem(404, "提交不存在");
    return db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(41722)");
      const prior = (
        await tx.query(
          "SELECT id,status FROM runs WHERE submission_id=$1 AND request_id=$2",
          [id, key],
        )
      ).rows[0];
      if (prior) return prior;
      if (!config.executionApproved)
        problem(
          503,
          "执行环境尚未通过隔离验收。提交已保存，可在验收完成后发起检查。",
        );
      const active = (
        await tx.query(
          "SELECT id,status FROM runs WHERE submission_id=$1 AND status IN ('queued','building','analyzing')",
          [id],
        )
      ).rows[0];
      if (active) return active;
      const count = Number(
        (await tx.query("SELECT count(*) AS n FROM runs WHERE status='queued'"))
          .rows[0].n,
      );
      if (count >= 30) problem(429, "等待队列已满，请稍后重试");
      const run = randomUUID();
      await tx.query(
        "INSERT INTO runs(id,submission_id,status,execution_config,request_id) VALUES($1,$2,'queued',$3,$4)",
        [
          run,
          id,
          json({
            image: config.image,
            model: config.model,
            template: templateVersion,
          }),
          key,
        ],
      );
      await tx.query(
        "INSERT INTO events(run_id,kind,payload) VALUES($1,$2,$3)",
        [run, "queued", "{}"],
      );
      return { id: run, status: "queued" };
    });
  });
  app.post("/api/v1/runs/:id/cancel", async (req) => {
    const r = await runAccess(req, (req.params as any).id);
    const updated = (
      await db.query(
        "UPDATE runs SET status='cancelled',finished_at=now() WHERE id=$1 AND status='queued' RETURNING id",
        [r.id],
      )
    ).rows;
    if (!updated.length) problem(409, "只能取消尚未开始的任务");
    return { ok: true };
  });
  app.get("/api/v1/runs/:id", async (req) => {
    const r = await runAccess(req, (req.params as any).id);
    if (user(req).role === "student") {
      const published = (
        await db.query("SELECT snapshot FROM reports WHERE run_id=$1", [r.id])
      ).rows[0];
      return {
        id: r.id,
        task_id: r.task_id,
        user_id: r.user_id,
        submission_id: r.submission_id,
        status: r.status,
        outcome: r.outcome,
        report: published?.snapshot ?? null,
      };
    }
    delete r.lease_token;
    return r;
  });
  app.get("/api/v1/runs/:id/evidence/:evidenceId", async (req, reply) => {
    const r = await runAccess(req, (req.params as any).id);
    let evidence = r.evidence;
    if (user(req).role === "student") {
      const report = (
        await db.query("SELECT snapshot FROM reports WHERE run_id=$1", [r.id])
      ).rows[0];
      if (!report) problem(404, "证据尚未发布");
      evidence = report.snapshot.evidence;
    }
    const e = evidence.find(
      (e: any) => e.id === (req.params as any).evidenceId,
    );
    if (!e) problem(404, "证据不存在");
    if (e.kind === "screenshot" && e.file) {
      const base = path.resolve(
        process.env.DATA_DIR ?? path.join(root, ".data"),
        "evidence",
      );
      const target = path.resolve(base, e.file);
      if (!target.startsWith(base + path.sep)) problem(404, "证据不存在");
      reply.type("image/png");
      return readFile(target);
    }
    return { id: e.id, kind: e.kind, title: e.title, text: e.text ?? "" };
  });
  const reviewSchema = z.object({
    revision: z.number().int().min(0),
    criterionId: z.string(),
    feedback: feedbackSchema,
    manualStatus: verdict.optional(),
  });
  app.put("/api/v1/runs/:id/review", async (req) => {
    teacher(req);
    const r = await runAccess(req, (req.params as any).id);
    const b = reviewSchema.parse(req.body);
    return db.transaction(async (tx) => {
      const current = (
        await tx.query("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [r.id])
      ).rows[0];
      if (current.status !== "review" || current.revision !== b.revision)
        problem(409, "草稿已变化或已发布，请刷新");
      const criterion = r.criteria.find((c: any) => c.id === b.criterionId);
      if (!criterion || b.feedback.criterionId !== b.criterionId)
        problem(400, "条目不存在");
      const ids = new Set(current.evidence.map((e: any) => e.id));
      if (b.feedback.evidenceIds.some((id) => !ids.has(id)))
        problem(400, "引用不属于当前运行");
      const results: CheckResult[] = current.results;
      if (b.manualStatus) {
        if (criterion.mode !== "manual")
          problem(400, "自动检查结果不可由反馈编辑覆盖");
        results.find((x) => x.criterionId === b.criterionId)!.status =
          b.manualStatus;
      }
      const feedback = current.feedback
        .filter((x: any) => x.criterionId !== b.criterionId)
        .concat(b.feedback);
      const reviewed = [...new Set([...current.reviewed, b.criterionId])];
      await tx.query(
        "UPDATE runs SET feedback=$2,results=$3,reviewed=$4,revision=revision+1 WHERE id=$1",
        [r.id, json(feedback), json(results), json(reviewed)],
      );
      await tx.query(
        "INSERT INTO revisions(id,run_id,user_id,revision,payload) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), r.id, user(req).id, b.revision + 1, json(b)],
      );
      return { revision: b.revision + 1 };
    });
  });
  app.post("/api/v1/runs/:id/publish", async (req) => {
    teacher(req);
    const r = await runAccess(req, (req.params as any).id);
    const b = z.object({ revision: z.number().int() }).parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        r.user_id,
      ]);
      const c = (
        await tx.query("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [r.id])
      ).rows[0];
      if (c.status === "published") {
        const p = (
          await tx.query("SELECT id FROM reports WHERE run_id=$1", [r.id])
        ).rows[0];
        return p;
      }
      if (c.status !== "review" || c.revision !== b.revision)
        problem(409, "草稿版本已变化，请刷新后复核");
      if (r.criteria.some((x: any) => !c.reviewed.includes(x.id)))
        problem(409, "请逐条确认后再发布");
      const latest = (
        await tx.query(
          "SELECT id FROM submissions WHERE task_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
          [r.task_id, r.user_id],
        )
      ).rows[0];
      if (latest.id !== r.submission_id)
        problem(409, "学生已有新提交，请处理新版本");
      const newer = (
        await tx.query(
          "SELECT id FROM runs WHERE submission_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [r.submission_id],
        )
      ).rows[0];
      if (newer.id !== r.id)
        problem(409, "同一提交已有更新运行，请处理最新运行");
      const snapshot = {
        runId: r.id,
        submissionId: r.submission_id,
        sha256: r.sha256,
        ruleId: r.rule_id,
        ruleVersion: r.rule_version,
        templateVersion: r.template_version,
        criteria: r.criteria,
        results: c.results,
        feedback: c.feedback,
        evidence: c.evidence.map(({ png, ...e }: any) => e),
        modelStatus: c.model_status,
        publishedAt: new Date().toISOString(),
      };
      const id = randomUUID();
      await tx.query(
        "INSERT INTO reports(id,run_id,snapshot,published_by) VALUES($1,$2,$3,$4)",
        [id, r.id, json(snapshot), user(req).id],
      );
      await tx.query("UPDATE runs SET status='published' WHERE id=$1", [r.id]);
      await tx.query(
        "INSERT INTO events(run_id,kind,payload) VALUES($1,$2,$3)",
        [r.id, "published", "{}"],
      );
      return { id };
    });
  });
  app.get("/api/v1/compare", async (req) => {
    const q = z.object({ before: uuid, after: uuid }).parse(req.query);
    const a = await runAccess(req, q.before),
      b = await runAccess(req, q.after);
    if (a.user_id !== b.user_id || a.task_id !== b.task_id)
      problem(400, "只能比较同一学生同一任务");
    if (
      user(req).role === "student" &&
      (a.status !== "published" || b.status !== "published")
    )
      problem(404, "报告未发布");
    if (a.rule_id !== b.rule_id || a.template_version !== b.template_version)
      return {
        compatible: false,
        reason: "规则或模板版本不同，不能直接比较",
        items: [],
      };
    return { compatible: true, items: compareResults(a.results, b.results) };
  });
  app.get("/api/v1/tasks/:id/summary", async (req) => {
    teacher(req);
    const t = await taskAccess(req, (req.params as any).id);
    const rows = (
      await db.query(
        "SELECT r.status,r.outcome,r.results FROM runs r JOIN submissions s ON s.id=r.submission_id WHERE s.task_id=$1 AND r.contract_version=1",
        [t.id],
      )
    ).rows;
    const statuses: Record<string, number> = {},
      failures: Record<string, number> = {};
    for (const r of rows) {
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      for (const result of r.results)
        if (result.status === "failed")
          failures[result.criterionId] =
            (failures[result.criterionId] ?? 0) + 1;
    }
    return {
      scope: "所有运行（包含重跑）",
      statuses,
      failures,
      infraErrors: rows.filter((r) => r.outcome === "infra_error").length,
      buildErrors: rows.filter((r) => r.outcome === "build_error").length,
    };
  });
  app.get("/api/v1/tasks/:id/export", async (req, reply) => {
    teacher(req);
    const t = await taskAccess(req, (req.params as any).id);
    const rows = (
      await db.query(
        "SELECT u.name,s.id,r.status,r.outcome,r.created_at FROM runs r JOIN submissions s ON s.id=r.submission_id JOIN users u ON u.id=s.user_id WHERE s.task_id=$1 AND r.contract_version=1 ORDER BY r.created_at",
        [t.id],
      )
    ).rows;
    const escape = (s: any) =>
      '"' +
      String(s ?? "")
        .replace(/^[=+@-]/, "'$&")
        .replaceAll('"', '""') +
      '"';
    reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="codelab.csv"');
    return (
      "\ufeff姓名,提交编号,状态,执行分类,时间\r\n" +
      rows
        .map((r) =>
          [r.name, r.id, r.status, r.outcome, r.created_at]
            .map(escape)
            .join(","),
        )
        .join("\r\n")
    );
  });
  app.get("/api/v1/runs/:id/events", async (req, reply) => {
    const r = await runAccess(req, (req.params as any).id);
    const cursor = Number(req.headers["last-event-id"] ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      problem(400, "事件游标无效");
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let last = cursor,
      closed = false;
    const until = Date.now() + 25000;
    reply.raw.on("close", () => {
      closed = true;
    });
    while (!closed && Date.now() < until) {
      const events = (
        await db.query(
          "SELECT id,kind FROM events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT 100",
          [r.id, last],
        )
      ).rows;
      for (const e of events) {
        last = Number(e.id);
        reply.raw.write(
          `id: ${last}\nevent: progress\ndata: ${json({ kind: e.kind })}\n\n`,
        );
      }
      reply.raw.write(": heartbeat\n\n");
      await new Promise((res) => setTimeout(res, 1000));
    }
    reply.raw.end();
  });
  await registerV2Routes(app, db, {
    coursework:config.teacherTrial ? { ...config.coursework, background: false } : config.coursework,
    courseVault: config.userModels,
    personalModels: config.userModels?.resolve,
    storageAdmission: config.storageAdmission,
    initialAnalysisMode: config.initialAnalysisMode,
    analysisConfiguration: config.analysisConfiguration,
    packs: config.packs,
    executionApproved: config.executionApproved,
    businessVersion: config.businessVersion ?? 1,
    evidenceReader: config.evidenceReader,
    approvedFingerprint: config.approvedFingerprint,
  });
  registerUserModelRoutes(app, config.userModels ?? createUserModelService(db, undefined));
  if (config.teacherTrial) {
    // The first trial has no project-analysis worker or shared upload-spool reaper.
    app.get('/api/v2/projects', async () => ({ projects: [], available: false }));
  } else {
    await registerSourceProjects(app, db, config.userModels ? config.userModels.resolve : config.sourceProvider, config.storageAdmission);
  }
  return app;
}
