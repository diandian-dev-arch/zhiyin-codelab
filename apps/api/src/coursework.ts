import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DB } from "./db.js";
import type { SourceProviderResolver } from "./user-model-settings.js";
import {
  courseworkAssignment,
  courseworkImport,
  courseworkSubmit,
  courseworkTask,
} from "../../../packages/contracts/src/coursework.js";
import {
  courseActor as actor,
  courseFail as fail,
  courseHash,
  type CourseActor,
  type CourseRow,
} from "./coursework-common.js";
import {
  courseGitConnection,
  courseContributionEvidence,
  courseImportTick,
  courseUploadedFiles,
  persistCourseSnapshot,
  type CourseVault,
} from "./coursework-sources.js";
import {
  courseAnalysisTick,
  enqueueCourseAnalysis,
  courseRecipient,
} from "./coursework-agent.js";
import { sourceDelta } from "./source-delta.js";
const uuid = z.string().uuid(),
  json = JSON.stringify;
const param = (req: FastifyRequest) => uuid.parse((req.params as any).id);
const key = (req: FastifyRequest) =>
  z
    .string()
    .regex(/^[a-zA-Z0-9_-]{8,100}$/)
    .parse(req.headers["idempotency-key"]);
export async function courseAssignmentAccess(
  db: DB,
  id: string,
  user: CourseActor,
  teacher = false,
) {
  const row = (
    await db.query(
      `SELECT a.*,c.teacher_id,c.name AS class_name FROM course_assignments a JOIN classes c ON c.id=a.class_id WHERE a.id=$1
    AND (($3='teacher' AND c.teacher_id=$2) OR ($3='student' AND a.status='published' AND EXISTS(SELECT 1 FROM memberships m WHERE m.class_id=a.class_id AND m.user_id=$2)))`,
      [id, user.id, user.role],
    )
  ).rows[0];
  if (!row || (teacher && user.role !== "teacher"))
    fail("NOT_FOUND", "作业不存在或无权访问", 404);
  return row;
}
export async function courseTaskAccess(
  db: DB,
  id: string,
  user: CourseActor,
  teacher = false,
) {
  const task = (
    await db.query(
      `SELECT t.*,r.config,r.sequence AS revision_sequence FROM course_tasks t JOIN course_task_revisions r ON r.id=t.current_revision_id WHERE t.task_id=$1`,
      [id],
    )
  ).rows[0];
  if (!task) fail("NOT_FOUND", "子任务不存在", 404);
  const assignment = await courseAssignmentAccess(
    db,
    task.assignment_id,
    user,
    teacher,
  );
  return { ...task, assignment };
}
async function audit(
  db: DB,
  user: CourseActor,
  kind: string,
  id: string,
  metadata: any = {},
) {
  await db.query(
    "INSERT INTO course_audit(actor_id,kind,object_id,metadata) VALUES($1,$2,$3,$4)",
    [user.id, kind, id, json(metadata)],
  );
}
async function subjects(db: DB, assignment: any, user: CourseActor) {
  if (assignment.subject_mode === "individual" && user.role === "student") {
    await db.query(
      "INSERT INTO course_subjects(id,assignment_id,user_id,name) SELECT $1,$2,id,name FROM users WHERE id=$3 ON CONFLICT(assignment_id,user_id) DO NOTHING",
      [randomUUID(), assignment.id, user.id],
    );
  }
  return (
    await db.query(
      `SELECT s.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',u.id,'name',u.name,'role',m.role,'status',m.status)) FROM course_team_members m JOIN users u ON u.id=m.user_id WHERE m.subject_id=s.id),'[]') AS members
    FROM course_subjects s WHERE s.assignment_id=$1 AND ($3='teacher' OR s.user_id=$2 OR EXISTS(SELECT 1 FROM course_team_members m WHERE m.subject_id=s.id AND m.user_id=$2 AND m.status IN ('active','invited'))) ORDER BY s.name,s.id`,
      [assignment.id, user.id, user.role],
    )
  ).rows;
}
export async function courseSubjectAccess(
  db: DB,
  assignment: any,
  id: string,
  user: CourseActor,
  write = false,
) {
  const subject = (
    await db.query(
      "SELECT * FROM course_subjects WHERE id=$1 AND assignment_id=$2",
      [id, assignment.id],
    )
  ).rows[0];
  if (!subject) fail("SUBJECT_NOT_FOUND", "提交主体不存在", 404);
  if (user.role === "teacher") {
    if (write) fail("FORBIDDEN", "教师不能代替学生提交", 403);
    return subject;
  }
  if (subject.user_id === user.id) return subject;
  const member = (
    await db.query(
      "SELECT * FROM course_team_members WHERE subject_id=$1 AND user_id=$2 AND status='active'",
      [id, user.id],
    )
  ).rows[0];
  if (!member || (write && member.role !== "submitter"))
    fail(
      "SUBJECT_FORBIDDEN",
      write ? "只有已确认加入的指定提交人可以提交" : "请先确认团队邀请",
      403,
    );
  return subject;
}
export async function courseSubmissionAccess(
  db: DB,
  id: string,
  user: CourseActor,
) {
  const submission = (
    await db.query(
      "SELECT s.*,p.name AS subject_name,u.name AS submitted_name FROM course_submissions s JOIN course_subjects p ON p.id=s.subject_id JOIN users u ON u.id=s.submitted_by WHERE s.id=$1",
      [id],
    )
  ).rows[0];
  if (!submission) fail("NOT_FOUND", "提交不存在", 404);
  const task = await courseTaskAccess(db, submission.task_id, user);
  await courseSubjectAccess(db, task.assignment, submission.subject_id, user);
  return { submission, task };
}
async function snapshotOwn(
  db: DB,
  id: string,
  user: CourseActor,
  taskId?: string,
) {
  const snapshot = (
    await db.query(
      `SELECT s.*,i.task_id FROM course_snapshots s JOIN course_imports i ON i.snapshot_id=s.id WHERE s.id=$1 AND s.owner_id=$2 AND i.status='ready'`,
      [id, user.id],
    )
  ).rows[0];
  if (!snapshot || (taskId && snapshot.task_id !== taskId))
    fail("SOURCE_NOT_READY", "请先为当前子任务准备可读取的快照", 409);
  await courseTaskAccess(db, snapshot.task_id, user);
  return snapshot;
}
async function revisionGraph(
  db: DB,
  assignmentId: string,
  taskId: string,
  config: any,
) {
  const all = (
    await db.query(
      "SELECT t.task_id,r.config FROM course_tasks t JOIN course_task_revisions r ON r.id=t.current_revision_id WHERE t.assignment_id=$1",
      [assignmentId],
    )
  ).rows;
  const next = new Map(all.map((r) => [r.task_id, r.config.predecessorTaskId]));
  next.set(taskId, config.predecessorTaskId);
  let current = config.predecessorTaskId;
  const seen = new Set([taskId]);
  while (current) {
    if (seen.has(current) || !next.has(current))
      fail("DEPENDENCY_INVALID", "前置任务必须属于同一作业且不能成环");
    seen.add(current);
    current = next.get(current);
  }
}
export function courseWindow(
  accepted: Date,
  dueAt: string | null,
  grant?: { opens_at: any; closes_at: any; revoked_at?: any },
) {
  if (!dueAt || accepted.getTime() < new Date(dueAt).getTime()) return "normal";
  if (
    grant &&
    !grant.revoked_at &&
    accepted.getTime() >= new Date(grant.opens_at).getTime() &&
    accepted.getTime() < new Date(grant.closes_at).getTime()
  )
    return "late";
  return "closed";
}
async function taskProgress(
  db: DB,
  assignmentIds: string[],
  user: CourseActor,
) {
  if (!assignmentIds.length) return [];
  // Count current learners, and only each subject's latest accepted submission.
  // Students get their own active subjects; inviting someone does not expose team work.
  return (
    await db.query(
      `WITH expected AS (
        SELECT a.id, CASE
          WHEN a.subject_mode='individual' AND $3='teacher' THEN
            (SELECT count(*) FROM memberships m WHERE m.class_id=a.class_id)
          WHEN a.subject_mode='individual' THEN 1
          ELSE (SELECT count(*) FROM course_subjects p WHERE p.assignment_id=a.id AND
            ($3='teacher' OR EXISTS(SELECT 1 FROM course_team_members m WHERE m.subject_id=p.id AND m.user_id=$2 AND m.status='active')))
        END::int AS n FROM course_assignments a WHERE a.id=ANY($1::uuid[])
      ), latest AS (
        SELECT DISTINCT ON (s.task_id,s.subject_id) s.id,s.task_id
        FROM course_submissions s JOIN course_subjects p ON p.id=s.subject_id
          JOIN course_assignments a ON a.id=p.assignment_id
        WHERE a.id=ANY($1::uuid[]) AND (
          ($3='teacher' AND (a.subject_mode='team' OR EXISTS(SELECT 1 FROM memberships m WHERE m.class_id=a.class_id AND m.user_id=p.user_id)))
          OR ($3='student' AND (p.user_id=$2 OR EXISTS(SELECT 1 FROM course_team_members m WHERE m.subject_id=p.id AND m.user_id=$2 AND m.status='active')))
        ) ORDER BY s.task_id,s.subject_id,s.sequence DESC
      ) SELECT t.task_id,t.assignment_id,r.config->>'dueAt' AS due_at,e.n AS expected,
        count(l.id)::int AS submitted,
        count(l.id) FILTER (WHERE EXISTS(SELECT 1 FROM course_evaluations v WHERE v.submission_id=l.id AND v.status='published'))::int AS reviewed
      FROM course_tasks t JOIN course_task_revisions r ON r.id=t.current_revision_id
        JOIN expected e ON e.id=t.assignment_id LEFT JOIN latest l ON l.task_id=t.task_id
      GROUP BY t.task_id,t.assignment_id,r.config,e.n`,
      [assignmentIds, user.id, user.role],
    )
  ).rows;
}
export async function registerCoursework(
  api: FastifyInstance,
  db: DB,
  options: {
    resolve?: SourceProviderResolver;
    vault?: CourseVault;
    enabled?: boolean;
    background?: boolean;
  } = {},
) {
  const enabled =
    options.enabled ?? process.env.CODELAB_COURSEWORK_ENABLED !== "false";
  api.get("/coursework/status", async () => ({ enabled }));
  await api.register(async (routes) => {
    routes.addHook("preHandler", async () => {
      if (!enabled) fail("COURSEWORK_DISABLED", "任务化升级入口暂未开放", 404);
    });
    routes.get("/assignments", async (req) => {
      const user = actor(req);
      const items = (
        await db.query(
          `SELECT a.*,c.name AS class_name,(SELECT count(*)::int FROM course_tasks t WHERE t.assignment_id=a.id) AS task_count
        FROM course_assignments a JOIN classes c ON c.id=a.class_id WHERE ($2='teacher' AND c.teacher_id=$1) OR ($2='student' AND a.status='published' AND EXISTS(SELECT 1 FROM memberships m WHERE m.class_id=a.class_id AND m.user_id=$1)) ORDER BY a.created_at DESC`,
          [user.id, user.role],
        )
      ).rows;
      const progress = await taskProgress(
        db,
        items.map((a) => a.id),
        user,
      );
      for (const item of items) {
        const tasks = progress.filter((t) => t.assignment_id === item.id);
        item.progress = tasks.reduce(
          (sum, t) => ({
            expected: sum.expected + t.expected,
            submitted: sum.submitted + t.submitted,
            reviewed: sum.reviewed + t.reviewed,
          }),
          { expected: 0, submitted: 0, reviewed: 0 },
        );
        const pending = tasks
          .filter((t) => t.submitted < t.expected && t.due_at)
          .map((t) => t.due_at as string)
          .sort();
        item.pendingDueAt = pending[0] ?? null;
      }
      // Legacy tasks stay on their original routes and IDs; no fabricated historical hashes or consents.
      const legacy = (
        await db.query(
          `SELECT t.id,t.title,t.class_id,c.name AS class_name FROM tasks t JOIN classes c ON c.id=t.class_id WHERE t.kind='project' AND NOT EXISTS(SELECT 1 FROM course_tasks ct WHERE ct.task_id=t.id)
        AND (($2='teacher' AND c.teacher_id=$1) OR ($2='student' AND EXISTS(SELECT 1 FROM memberships m WHERE m.class_id=t.class_id AND m.user_id=$1))) ORDER BY t.created_at DESC`,
          [user.id, user.role],
        )
      ).rows;
      return {
        items,
        legacy: legacy.map((t) => ({
          ...t,
          legacy: true,
          task_count: 1,
          snapshotStatus: "historical-incomplete",
        })),
      };
    });
    routes.post("/assignments", async (req, reply) => {
      const user = actor(req);
      if (user.role !== "teacher") fail("FORBIDDEN", "仅教师可以创建作业", 403);
      const body = courseworkAssignment.parse(req.body),
        id = randomUUID();
      await db.transaction(async (tx) => {
        if (
          !(
            await tx.query(
              "SELECT 1 FROM classes WHERE id=$1 AND teacher_id=$2",
              [body.classId, user.id],
            )
          ).rows.length
        )
          fail("NOT_FOUND", "班级不存在", 404);
        await tx.query(
          "INSERT INTO course_assignments(id,class_id,title,subject_mode,status) VALUES($1,$2,$3,$4,$5)",
          [id, body.classId, body.title, body.subjectMode, body.status],
        );
        for (const [position, config] of body.tasks.entries()) {
          if (config.predecessorTaskId)
            fail("DEPENDENCY_INVALID", "请在任务创建后选择前置任务");
          await addTask(tx, id, body.classId, config, position);
        }
        await audit(tx, user, "assignment-created", id);
      });
      return reply.code(201).send({ id });
    });
    async function addTask(
      tx: DB,
      assignmentId: string,
      classId: string,
      config: any,
      position: number,
    ) {
      const taskId = randomUUID(),
        revisionId = randomUUID();
      await tx.query(
        "INSERT INTO tasks(id,class_id,title,description,kind,due_at,rubric) VALUES($1,$2,$3,$4,'project',$5,$6)",
        [
          taskId,
          classId,
          config.title,
          config.description,
          config.dueAt,
          json(config.requirements),
        ],
      );
      await tx.query(
        "INSERT INTO course_tasks(task_id,assignment_id,position) VALUES($1,$2,$3)",
        [taskId, assignmentId, position],
      );
      await revisionGraph(tx, assignmentId, taskId, config);
      await tx.query(
        "INSERT INTO course_task_revisions(id,task_id,sequence,config) VALUES($1,$2,1,$3)",
        [revisionId, taskId, json(config)],
      );
      await tx.query(
        "UPDATE course_tasks SET current_revision_id=$2 WHERE task_id=$1",
        [taskId, revisionId],
      );
      return taskId;
    }
    routes.get("/assignments/:id", async (req) => {
      const user = actor(req),
        assignment = await courseAssignmentAccess(db, param(req), user);
      const taskRows = (
        await db.query(
          "SELECT t.*,r.config,r.sequence AS revision_sequence FROM course_tasks t JOIN course_task_revisions r ON r.id=t.current_revision_id WHERE assignment_id=$1 ORDER BY position",
          [assignment.id],
        )
      ).rows;
      const visibleSubjects = await subjects(db, assignment, user);
      const progress = await taskProgress(db, [assignment.id], user);
      for (const task of taskRows) {
        const counts = progress.find((p) => p.task_id === task.task_id);
        task.progress = {
          expected: counts?.expected ?? 0,
          submitted: counts?.submitted ?? 0,
          reviewed: counts?.reviewed ?? 0,
        };
      }
      return {
        assignment,
        tasks: taskRows,
        subjects: visibleSubjects,
      };
    });
    routes.post("/assignments/:id/publish", async (req) => {
      const user = actor(req),
        assignment = await courseAssignmentAccess(db, param(req), user, true);
      await db.query(
        "UPDATE course_assignments SET status='published' WHERE id=$1",
        [assignment.id],
      );
      return { published: true };
    });
    routes.post("/assignments/:id/tasks", async (req, reply) => {
      const user = actor(req),
        config = courseworkTask.parse(req.body),
        id = param(req);
      const taskId = await db.transaction(async (tx) => {
        const a = await courseAssignmentAccess(tx, id, user, true);
        await tx.query(
          "SELECT id FROM course_assignments WHERE id=$1 FOR UPDATE",
          [id],
        );
        const pos = Number(
          (
            await tx.query(
              "SELECT COALESCE(max(position),-1)+1 AS n FROM course_tasks WHERE assignment_id=$1",
              [id],
            )
          ).rows[0].n,
        );
        return addTask(tx, id, a.class_id, config, pos);
      });
      return reply.code(201).send({ taskId });
    });
    routes.post("/course-tasks/:id/revisions", async (req, reply) => {
      const user = actor(req),
        config = courseworkTask.parse(req.body),
        id = param(req);
      const revisionId = await db.transaction(async (tx) => {
        await tx.query(
          "SELECT task_id FROM course_tasks WHERE task_id=$1 FOR UPDATE",
          [id],
        );
        const t = await courseTaskAccess(tx, id, user, true);
        await revisionGraph(tx, t.assignment_id, id, config);
        const rid = randomUUID();
        await tx.query(
          "INSERT INTO course_task_revisions(id,task_id,sequence,config) VALUES($1,$2,$3,$4)",
          [rid, id, t.revision_sequence + 1, json(config)],
        );
        await tx.query(
          "UPDATE course_tasks SET current_revision_id=$2 WHERE task_id=$1",
          [id, rid],
        );
        await audit(tx, user, "task-revised", id, { revisionId: rid });
        return rid;
      });
      return reply.code(201).send({ revisionId });
    });
    routes.post("/assignments/:id/teams", async (req, reply) => {
      const user = actor(req),
        a = await courseAssignmentAccess(db, param(req), user, true);
      if (a.subject_mode !== "team")
        fail("SUBJECT_MODE_INVALID", "此作业使用个人提交");
      const body = z
        .object({
          name: z.string().trim().min(1).max(120),
          members: z
            .array(
              z
                .object({ userId: uuid, role: z.enum(["member", "submitter"]) })
                .strict(),
            )
            .min(1)
            .max(30),
        })
        .strict()
        .parse(req.body);
      if (
        new Set(body.members.map((m) => m.userId)).size !==
          body.members.length ||
        !body.members.some((m) => m.role === "submitter")
      )
        fail("TEAM_INVALID", "成员不能重复且需要指定提交人");
      const id = randomUUID();
      await db.transaction(async (tx) => {
        for (const m of body.members)
          if (
            !(
              await tx.query(
                "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.class_id=$1 AND m.user_id=$2 AND u.role='student'",
                [a.class_id, m.userId],
              )
            ).rows.length
          )
            fail("TEAM_INVALID", "成员必须是本班学生");
        await tx.query(
          "INSERT INTO course_subjects(id,assignment_id,name) VALUES($1,$2,$3)",
          [id, a.id, body.name],
        );
        for (const m of body.members)
          await tx.query(
            "INSERT INTO course_team_members(subject_id,user_id,role,status) VALUES($1,$2,$3,'invited')",
            [id, m.userId, m.role],
          );
        await audit(tx, user, "team-invited", id);
      });
      return reply.code(201).send({ id });
    });
    routes.post("/course-teams/:id/accept", async (req) => {
      const user = actor(req),
        id = param(req),
        team = (
          await db.query(
            "SELECT assignment_id FROM course_subjects WHERE id=$1",
            [id],
          )
        ).rows[0];
      if (!team) fail("NOT_FOUND", "团队不存在", 404);
      await courseAssignmentAccess(db, team.assignment_id, user);
      if (
        !(
          await db.query(
            "UPDATE course_team_members SET status='active' WHERE subject_id=$1 AND user_id=$2 AND status='invited' RETURNING user_id",
            [id, user.id],
          )
        ).rows.length
      )
        fail("NOT_FOUND", "没有待确认邀请", 404);
      return { accepted: true };
    });
    routes.post("/course-teams/:id/members/:userId", async (req) => {
      const user = actor(req),
        id = param(req),
        memberId = uuid.parse((req.params as any).userId),
        body = z
          .object({
            role: z.enum(["member", "submitter"]),
            status: z.enum(["invited", "left"]),
          })
          .strict()
          .parse(req.body);
      await db.transaction(async (tx) => {
        const subject = (
          await tx.query(
            "SELECT * FROM course_subjects WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!subject || subject.user_id) fail("NOT_FOUND", "团队不存在", 404);
        const a = await courseAssignmentAccess(
          tx,
          subject.assignment_id,
          user,
          true,
        );
        if (
          !(
            await tx.query(
              "SELECT 1 FROM memberships WHERE class_id=$1 AND user_id=$2",
              [a.class_id, memberId],
            )
          ).rows.length
        )
          fail("TEAM_INVALID", "成员必须属于本班");
        await tx.query(
          "INSERT INTO course_team_members(subject_id,user_id,role,status) VALUES($1,$2,$3,$4) ON CONFLICT(subject_id,user_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status",
          [id, memberId, body.role, body.status],
        );
        await audit(tx, user, "team-membership-changed", id, {
          memberId,
          ...body,
        });
      });
      return { saved: true };
    });
    routes.get("/course-tasks/:id", async (req) => {
      const user = actor(req),
        task = await courseTaskAccess(db, param(req), user);
      const own = await subjects(db, task.assignment, user);
      const rows = (
        await db.query(
          `SELECT s.*,p.name AS subject_name,u.name AS submitted_name FROM course_submissions s JOIN course_subjects p ON p.id=s.subject_id JOIN users u ON u.id=s.submitted_by WHERE s.task_id=$1
        AND ($3='teacher' OR p.user_id=$2 OR EXISTS(SELECT 1 FROM course_team_members m WHERE m.subject_id=p.id AND m.user_id=$2 AND m.status='active')) ORDER BY s.sequence DESC,s.accepted_at DESC`,
          [task.task_id, user.id, user.role],
        )
      ).rows;
      const evaluations = (
        await db.query(
          "SELECT * FROM course_evaluations WHERE submission_id=ANY($1::uuid[]) AND ($2='teacher' OR status='published') ORDER BY revision DESC",
          [rows.map((r) => r.id), user.role],
        )
      ).rows;
      const latest = new Set<string>();
      for (const row of rows) {
        row.latest = !latest.has(row.subject_id);
        latest.add(row.subject_id);
        row.evaluations = evaluations.filter((e) => e.submission_id === row.id);
      }
      const prerequisite = task.config.predecessorTaskId
        ? (
            await db.query(
              `SELECT s.id,s.subject_id,s.sequence,s.accepted_at FROM course_submissions s JOIN course_subjects p ON p.id=s.subject_id WHERE s.task_id=$1 AND ($3='teacher' OR p.user_id=$2 OR EXISTS(SELECT 1 FROM course_team_members m WHERE m.subject_id=p.id AND m.user_id=$2 AND m.status='active')) ORDER BY sequence DESC`,
              [task.config.predecessorTaskId, user.id, user.role],
            )
          ).rows
        : [];
      const teacherRecipient = await courseRecipient(
        options.resolve,
        task.assignment.teacher_id,
      );
      const grants = (
        await db.query(
          `SELECT g.* FROM course_late_grants g WHERE task_id=$1 AND ($3='teacher' OR subject_id=ANY($2::uuid[])) ORDER BY closes_at DESC`,
          [
            task.task_id,
            own
              .filter(
                (s) =>
                  s.user_id === user.id ||
                  s.members.some(
                    (m: any) => m.userId === user.id && m.status === "active",
                  ),
              )
              .map((s) => s.id),
            user.role,
          ],
        )
      ).rows;
      return {
        task,
        subjects: own,
        submissions: rows,
        prerequisite,
        baselineOptions: task.config.predecessorTaskId ? prerequisite : rows,
        grants,
        teacherRecipient,
        serverTime: new Date().toISOString(),
      };
    });
    routes.post("/repository-connections", async (req, reply) => {
      const user = actor(req),
        body = z
          .object({
            provider: z.enum(["github", "gitee"]),
            label: z.string().trim().min(1).max(100),
            token: z.string().trim().min(8).max(2048),
            confirmed: z.literal(true),
          })
          .strict()
          .parse(req.body);
      if (!options.vault)
        fail("REPOSITORY_VAULT_UNAVAILABLE", "仓库凭据安全存储未配置", 503);
      const id = randomUUID(),
        credential = options.vault.sealRepository(user.id, body.token);
      await db.query(
        "INSERT INTO course_repository_connections(id,owner_id,provider,label,credential) VALUES($1,$2,$3,$4,$5)",
        [id, user.id, body.provider, body.label, credential],
      );
      await audit(db, user, "repository-connected", id, {
        provider: body.provider,
      });
      return reply
        .code(201)
        .send({ id, provider: body.provider, label: body.label });
    });
    routes.get("/repository-connections", async (req) => ({
      items: (
        await db.query(
          "SELECT id,provider,label,revoked_at,created_at FROM course_repository_connections WHERE owner_id=$1 ORDER BY created_at DESC",
          [actor(req).id],
        )
      ).rows,
    }));
    routes.get("/repository-identities", async (req) => ({
      items: (
        await db.query(
          "SELECT i.provider,i.provider_user_id,i.login,i.verified_at,i.connection_id,c.revoked_at FROM course_git_identities i JOIN course_repository_connections c ON c.id=i.connection_id WHERE i.user_id=$1",
          [actor(req).id],
        )
      ).rows,
    }));
    routes.post("/repository-connections/:id/verify", async (req) => {
      const user = actor(req),
        id = param(req);
      const row = (
        await db.query(
          "SELECT provider FROM course_repository_connections WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL",
          [id, user.id],
        )
      ).rows[0];
      if (!row) fail("NOT_FOUND", "读取授权不存在", 404);
      const git = await courseGitConnection(
        db,
        user.id,
        { provider: row.provider, connectionId: id },
        options.vault,
      );
      const identity = await git.identity();
      await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(41730)");
        if (
          (
            await tx.query(
              "SELECT 1 FROM course_git_identities WHERE provider=$1 AND provider_user_id=$2 AND user_id<>$3",
              [row.provider, identity.id, user.id],
            )
          ).rows.length
        )
          fail("GIT_IDENTITY_IN_USE", "此托管平台账号已关联其他成员", 409);
        if (
          !(
            await tx.query(
              "SELECT 1 FROM course_repository_connections WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL FOR UPDATE",
              [id, user.id],
            )
          ).rows.length
        )
          fail("REPOSITORY_AUTH_REQUIRED", "读取授权已撤销", 409);
        await tx.query(
          "INSERT INTO course_git_identities(user_id,provider,provider_user_id,login,connection_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,provider) DO UPDATE SET provider_user_id=EXCLUDED.provider_user_id,login=EXCLUDED.login,connection_id=EXCLUDED.connection_id,verified_at=clock_timestamp()",
          [user.id, row.provider, identity.id, identity.login, id],
        );
        await audit(tx, user, "git-identity-verified", id, {
          provider: row.provider,
        });
      });
      return { provider: row.provider, ...identity };
    });
    routes.post("/repository-connections/:id/revoke", async (req) => {
      const user = actor(req),
        id = param(req);
      await db.query(
        "UPDATE course_repository_connections SET revoked_at=clock_timestamp(),credential=$3 WHERE id=$1 AND owner_id=$2",
        [id, user.id, ""],
      );
      await audit(db, user, "repository-revoked", id);
      return { revoked: true };
    });
    routes.post("/imports", async (req, reply) => {
      const user = actor(req),
        body = courseworkImport.parse(req.body),
        task = await courseTaskAccess(db, body.taskId, user);
      if (user.role !== "student")
        fail("FORBIDDEN", "请使用学生账号准备成果", 403);
      if (!task.config.allowedSources.includes(body.type))
        fail("SOURCE_TYPE_DISABLED", "教师不允许此来源");
      const git = ["github", "gitee"].includes(body.type);
      if (
        git &&
        (!body.repository ||
          body.repository.provider !== body.type ||
          body.files ||
          body.zipBase64)
      )
        fail("SOURCE_INVALID", "请填写对应平台的仓库");
      if (
        !git &&
        (body.repository ||
          (body.type === "zip"
            ? !body.zipBase64 || !!body.files
            : !body.files || !!body.zipBase64))
      )
        fail("SOURCE_INVALID", "来源与材料不匹配");
      if (body.type === "snippet" && body.files?.length !== 1)
        fail("SOURCE_INVALID", "片段应为一个文件");
      const id = randomUUID(),
        source = git
          ? {
              ...body.repository,
              scope: task.config.scope.length
                ? [
                    ...new Set([
                      ...task.config.scope,
                      ...task.config.requiredPaths,
                    ]),
                  ]
                : [],
            }
          : { type: body.type },
        job = { id, owner_id: user.id };
      if (git) await courseGitConnection(db, user.id, source, options.vault);
      await db.query(
        "INSERT INTO course_imports(id,task_id,owner_id,source_type,status,source) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          task.task_id,
          user.id,
          body.type,
          git ? "created" : "validating",
          json(source),
        ],
      );
      if (!git)
        try {
          const content = await courseUploadedFiles(body);
          await persistCourseSnapshot(
            db,
            job,
            content.files,
            content.omitted,
            source,
          );
        } catch (error) {
          await db.query(
            "UPDATE course_imports SET status='failed',failure_code='SOURCE_INVALID',finished_at=clock_timestamp() WHERE id=$1",
            [id],
          );
          fail(
            "SOURCE_INVALID",
            error instanceof Error ? error.message : "材料无法读取",
          );
        }
      return reply.code(git ? 202 : 201).send({
        id,
        ...(
          await db.query(
            "SELECT status,snapshot_id,resolved_commit,failure_code FROM course_imports WHERE id=$1",
            [id],
          )
        ).rows[0],
      });
    });
    routes.get("/imports/:id", async (req) => {
      const row = (
        await db.query(
          "SELECT id,task_id,source_type,status,resolved_commit,snapshot_id,failure_code,created_at FROM course_imports WHERE id=$1 AND owner_id=$2",
          [param(req), actor(req).id],
        )
      ).rows[0];
      if (!row) fail("NOT_FOUND", "导入不存在", 404);
      await courseTaskAccess(db, row.task_id, actor(req));
      return row;
    });
    routes.get("/course-tasks/:id/imports", async (req) => {
      const user = actor(req);
      await courseTaskAccess(db, param(req), user);
      return {
        items: (
          await db.query(
            "SELECT id,status,snapshot_id,resolved_commit,failure_code,source_type,created_at FROM course_imports WHERE task_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 30",
            [param(req), user.id],
          )
        ).rows,
      };
    });
    routes.post("/imports/:id/retry", async (req) => {
      const user = actor(req),
        row = (
          await db.query(
            "SELECT * FROM course_imports WHERE id=$1 AND owner_id=$2",
            [param(req), user.id],
          )
        ).rows[0];
      if (!row) fail("NOT_FOUND", "导入不存在", 404);
      await courseTaskAccess(db, row.task_id, user);
      if (!["gitee", "github"].includes(row.source_type))
        fail("SOURCE_REUPLOAD_REQUIRED", "请重新选择并上传材料", 409);
      await db.query(
        "UPDATE course_imports SET status='created',failure_code=NULL,started_at=NULL WHERE id=$1 AND status='failed'",
        [row.id],
      );
      return { id: row.id };
    });
    routes.post("/imports/:id/cancel", async (req) => {
      await db.query(
        "UPDATE course_imports SET status='cancelled',finished_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND status IN ('created','fetching','validating')",
        [param(req), actor(req).id],
      );
      return { cancelled: true };
    });
    routes.get("/snapshots/:id", async (req) => {
      const s = await snapshotOwn(db, param(req), actor(req));
      return {
        id: s.id,
        manifest: s.manifest,
        hash: s.content_hash,
        source: s.source,
        omitted: s.omitted,
      };
    });
    routes.get("/snapshots/:id/source", async (req) => {
      const s = await snapshotOwn(db, param(req), actor(req));
      const { path } = z.object({ path: z.string() }).strict().parse(req.query);
      if (!Object.hasOwn(s.files, path)) fail("NOT_FOUND", "文件不存在", 404);
      return { path, content: s.files[path] };
    });
    routes.post("/course-tasks/:id/submissions", async (req, reply) => {
      const user = actor(req),
        taskId = param(req),
        body = courseworkSubmit.parse(req.body),
        requestKey = key(req),
        requestHash = await courseHash(body);
      if (user.role !== "student")
        fail("FORBIDDEN", "请使用学生本人账号提交", 403);
      const result = await db.transaction(async (tx) => {
        await tx.query(
          "SELECT task_id FROM course_tasks WHERE task_id=$1 FOR UPDATE",
          [taskId],
        );
        const task = await courseTaskAccess(tx, taskId, user);
        const prior = (
          await tx.query(
            "SELECT * FROM course_submissions WHERE task_id=$1 AND submitted_by=$2 AND request_key=$3",
            [taskId, user.id, requestKey],
          )
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== requestHash)
            fail("IDEMPOTENCY_CONFLICT", "此请求号已用于不同材料", 409);
          await courseSubjectAccess(
            tx,
            task.assignment,
            prior.subject_id,
            user,
          );
          return { submission: prior, replayed: true };
        }
        const available = await subjects(tx, task.assignment, user);
        const subjectId =
          body.subjectId ??
          (task.assignment.subject_mode === "individual"
            ? available.find((s) => s.user_id === user.id)?.id
            : null);
        if (!subjectId) fail("SUBJECT_REQUIRED", "请选择已确认加入的团队");
        await tx.query(
          "SELECT id FROM course_subjects WHERE id=$1 FOR UPDATE",
          [subjectId],
        );
        const subject = await courseSubjectAccess(
          tx,
          task.assignment,
          subjectId,
          user,
          true,
        );
        if (body.taskRevisionId !== task.current_revision_id)
          fail(
            "TASK_REVISION_CHANGED",
            "任务要求已更新，请阅读后重新确认",
            409,
          );
        const snapshot = await snapshotOwn(tx, body.snapshotId, user, taskId);
        for (const p of task.config.requiredPaths)
          if (!Object.hasOwn(snapshot.files, p))
            fail("REQUIRED_SOURCE_MISSING", `缺少教师要求的文件：${p}`);
        if (task.config.predecessorTaskId) {
          const base =
            body.baseSubmissionId &&
            (
              await tx.query(
                "SELECT id FROM course_submissions WHERE id=$1 AND task_id=$2 AND subject_id=$3",
                [
                  body.baseSubmissionId,
                  task.config.predecessorTaskId,
                  subjectId,
                ],
              )
            ).rows[0];
          if (!base)
            fail(
              "PREREQUISITE_MISSING",
              "请先成功提交前置任务并选择固定基线",
              409,
            );
        } else if (
          body.baseSubmissionId &&
          !(
            await tx.query(
              "SELECT id FROM course_submissions WHERE id=$1 AND task_id=$2 AND subject_id=$3",
              [body.baseSubmissionId, taskId, subjectId],
            )
          ).rows.length
        )
          fail(
            "BASE_SUBMISSION_INVALID",
            "独立任务只能选择本任务同主体的历史版本作为比较起点",
          );
        const accepted = (
          await tx.query("SELECT clock_timestamp() AS accepted")
        ).rows[0].accepted;
        const grant = (
          await tx.query(
            "SELECT * FROM course_late_grants WHERE task_id=$1 AND subject_id=$2 AND revoked_at IS NULL AND opens_at<=$3 AND closes_at>$3 ORDER BY closes_at DESC LIMIT 1 FOR UPDATE",
            [taskId, subjectId, accepted],
          )
        ).rows[0];
        const window = courseWindow(
          new Date(accepted),
          task.config.dueAt,
          grant,
        );
        if (window === "closed")
          fail(
            "SUBMISSION_CLOSED",
            "已过截止时间，请联系教师为当前主体开放补交",
            409,
          );
        const seq = Number(
          (
            await tx.query(
              "SELECT COALESCE(max(sequence),0)+1 AS n FROM course_submissions WHERE task_id=$1 AND subject_id=$2",
              [taskId, subjectId],
            )
          ).rows[0].n,
        );
        const members: any[] = subject.user_id
          ? [{ userId: user.id, name: subject.name, role: "submitter" }]
          : (
              await tx.query(
                "SELECT m.user_id AS \"userId\",u.name,m.role FROM course_team_members m JOIN users u ON u.id=m.user_id WHERE m.subject_id=$1 AND m.status='active' ORDER BY m.user_id",
                [subjectId],
              )
            ).rows;
        for (const member of members)
          member.gitIdentities = (
            await tx.query(
              "SELECT i.provider,i.provider_user_id,i.login,i.verified_at FROM course_git_identities i JOIN course_repository_connections c ON c.id=i.connection_id WHERE i.user_id=$1 AND c.revoked_at IS NULL",
              [member.userId],
            )
          ).rows;
        const id = randomUUID();
        await tx.query(
          "INSERT INTO course_submissions(id,task_id,subject_id,sequence,snapshot_id,task_revision_id,base_submission_id,accepted_at,late_grant_id,submitted_by,member_snapshot,note,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            id,
            taskId,
            subjectId,
            seq,
            snapshot.id,
            task.current_revision_id,
            body.baseSubmissionId,
            accepted,
            window === "late" ? grant.id : null,
            user.id,
            json(members),
            body.note,
            requestKey,
            requestHash,
          ],
        );
        await audit(tx, user, "submission-accepted", id, {
          taskId,
          subjectId,
          snapshotId: snapshot.id,
          sequence: seq,
        });
        return {
          submission: (
            await tx.query("SELECT * FROM course_submissions WHERE id=$1", [id])
          ).rows[0],
          replayed: false,
        };
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    });
    routes.get("/course-submissions/:id", async (req) => {
      const user = actor(req),
        { submission, task } = await courseSubmissionAccess(
          db,
          param(req),
          user,
        );
      const snapshot = (
        await db.query(
          "SELECT id,manifest,content_hash,source,omitted FROM course_snapshots WHERE id=$1",
          [submission.snapshot_id],
        )
      ).rows[0];
      const evaluations = (
        await db.query(
          "SELECT * FROM course_evaluations WHERE submission_id=$1 AND ($2='teacher' OR status='published') ORDER BY revision DESC",
          [submission.id, user.role],
        )
      ).rows;
      const analyses = (
        await db.query(
          `SELECT id,status,report,usage,failure_code,model_config,billing_user_id,created_at FROM course_analyses a WHERE submission_id=$1 AND ($2='teacher' OR EXISTS(SELECT 1 FROM course_evaluations e WHERE e.submission_id=$1 AND e.status='published' AND e.analysis_id=a.id)) ORDER BY created_at DESC`,
          [submission.id, user.role],
        )
      ).rows;
      const statements = (
        await db.query(
          "SELECT user_id,statement,updated_at FROM course_contribution_statements WHERE submission_id=$1",
          [submission.id],
        )
      ).rows;
      const consents = (
        await db.query(
          "SELECT id,recipient_hash,recipient,actor_id,revoked_at FROM course_model_consents WHERE snapshot_id=$1 AND purpose='formal'",
          [submission.snapshot_id],
        )
      ).rows;
      return {
        submission,
        task: {
          ...task,
          config: (
            await db.query(
              "SELECT config FROM course_task_revisions WHERE id=$1",
              [submission.task_revision_id],
            )
          ).rows[0].config,
        },
        snapshot,
        evaluations,
        analyses,
        statements,
        consents,
      };
    });
    routes.get("/course-submissions/:id/download", async (req, reply) => {
      const { submission } = await courseSubmissionAccess(
        db,
        param(req),
        actor(req),
      );
      const snapshot = (
        await db.query("SELECT files FROM course_snapshots WHERE id=$1", [
          submission.snapshot_id,
        ])
      ).rows[0];
      const files: Record<string, Uint8Array> = Object.create(null);
      for (const [path, content] of Object.entries(snapshot.files))
        files[path] = strToU8(content as string);
      return reply
        .header("Cache-Control", "private, no-store")
        .header(
          "Content-Disposition",
          `attachment; filename="codelab-${submission.id}-v${submission.sequence}.zip"`,
        )
        .type("application/zip")
        .send(Buffer.from(zipSync(files, { level: 0 })));
    });
    routes.get("/course-submissions/:id/source", async (req) => {
      const { submission } = await courseSubmissionAccess(
        db,
        param(req),
        actor(req),
      );
      const s = (
        await db.query("SELECT files FROM course_snapshots WHERE id=$1", [
          submission.snapshot_id,
        ])
      ).rows[0];
      const { path } = z.object({ path: z.string() }).strict().parse(req.query);
      if (!Object.hasOwn(s.files, path)) fail("NOT_FOUND", "文件不存在", 404);
      return { path, content: s.files[path] };
    });
    routes.get("/course-submissions/:id/diff", async (req) => {
      const user = actor(req),
        { submission } = await courseSubmissionAccess(db, param(req), user),
        { base } = z.object({ base: uuid }).strict().parse(req.query);
      const other = await courseSubmissionAccess(db, base, user);
      if (other.submission.subject_id !== submission.subject_id)
        fail("DIFF_SUBJECT_MISMATCH", "请选择相同主体的版本");
      const snapshots = (
        await db.query(
          "SELECT id,files FROM course_snapshots WHERE id=ANY($1::uuid[])",
          [[submission.snapshot_id, other.submission.snapshot_id]],
        )
      ).rows;
      const before = snapshots.find(
          (s) => s.id === other.submission.snapshot_id,
        ).files,
        after = snapshots.find((s) => s.id === submission.snapshot_id).files;
      return {
        base,
        head: submission.id,
        ...sourceDelta(before, after),
        files: Object.keys({ ...before, ...after })
          .sort()
          .filter((p) => before[p] !== after[p])
          .map((path) => ({
            path,
            before: before[path] ?? null,
            after: after[path] ?? null,
          })),
      };
    });
    routes.post("/course-tasks/:id/late-grants", async (req, reply) => {
      const user = actor(req),
        body = z
          .object({
            subjectId: uuid,
            opensAt: z.string().datetime(),
            closesAt: z.string().datetime(),
            reason: z.string().trim().min(1).max(2000),
          })
          .strict()
          .parse(req.body);
      if (new Date(body.closesAt) <= new Date(body.opensAt))
        fail("GRANT_WINDOW_INVALID", "补交截止应晚于开始");
      const id = randomUUID();
      await db.transaction(async (tx) => {
        await tx.query(
          "SELECT task_id FROM course_tasks WHERE task_id=$1 FOR UPDATE",
          [param(req)],
        );
        const t = await courseTaskAccess(tx, param(req), user, true);
        await courseSubjectAccess(tx, t.assignment, body.subjectId, user);
        await tx.query(
          "INSERT INTO course_late_grants(id,task_id,subject_id,opens_at,closes_at,granted_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            t.task_id,
            body.subjectId,
            body.opensAt,
            body.closesAt,
            user.id,
            body.reason,
          ],
        );
        await audit(tx, user, "late-grant-created", id);
      });
      return reply.code(201).send({ id });
    });
    routes.post("/late-grants/:id/revoke", async (req) => {
      const user = actor(req),
        id = param(req);
      await db.transaction(async (tx) => {
        const grant = (
          await tx.query("SELECT * FROM course_late_grants WHERE id=$1", [id])
        ).rows[0];
        if (!grant) fail("NOT_FOUND", "补交授权不存在", 404);
        await tx.query(
          "SELECT task_id FROM course_tasks WHERE task_id=$1 FOR UPDATE",
          [grant.task_id],
        );
        await courseTaskAccess(tx, grant.task_id, user, true);
        await tx.query(
          "UPDATE course_late_grants SET revoked_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        await audit(tx, user, "late-grant-revoked", id);
      });
      return { revoked: true };
    });
    routes.post("/course-submissions/:id/evaluations", async (req, reply) => {
      const user = actor(req),
        body = z
          .object({
            feedback: z.string().trim().min(1).max(5000),
            outcome: z.enum(["achieved", "needs_revision", "pending"]),
            analysisId: uuid.nullable().default(null),
          })
          .strict()
          .parse(req.body);
      const id = await db.transaction(async (tx) => {
        const { submission, task } = await courseSubmissionAccess(
          tx,
          param(req),
          user,
        );
        if (user.id !== task.assignment.teacher_id)
          fail("FORBIDDEN", "仅授课教师可评价", 403);
        await tx.query(
          "SELECT id FROM course_submissions WHERE id=$1 FOR UPDATE",
          [submission.id],
        );
        if (
          body.analysisId &&
          !(
            await tx.query(
              "SELECT id FROM course_analyses WHERE id=$1 AND submission_id=$2 AND status='succeeded'",
              [body.analysisId, submission.id],
            )
          ).rows.length
        )
          fail("ANALYSIS_MISMATCH", "只能采用本次提交的成功正式分析");
        const n = Number(
            (
              await tx.query(
                "SELECT COALESCE(max(revision),0)+1 AS n FROM course_evaluations WHERE submission_id=$1",
                [submission.id],
              )
            ).rows[0].n,
          ),
          id = randomUUID();
        await tx.query(
          "INSERT INTO course_evaluations(id,submission_id,teacher_id,revision,status,feedback,outcome,analysis_id) VALUES($1,$2,$3,$4,'draft',$5,$6,$7)",
          [
            id,
            submission.id,
            user.id,
            n,
            body.feedback,
            body.outcome,
            body.analysisId,
          ],
        );
        return id;
      });
      return reply.code(201).send({ id });
    });
    routes.post("/course-evaluations/:id/publish", async (req) => {
      const user = actor(req),
        id = param(req);
      await db.transaction(async (tx) => {
        const e = (
          await tx.query(
            "SELECT * FROM course_evaluations WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!e) fail("NOT_FOUND", "评价不存在", 404);
        const { task } = await courseSubmissionAccess(
          tx,
          e.submission_id,
          user,
        );
        if (user.id !== task.assignment.teacher_id)
          fail("FORBIDDEN", "仅授课教师可以发布", 403);
        if (e.status === "draft")
          await tx.query(
            "UPDATE course_evaluations SET status='published',published_at=clock_timestamp() WHERE id=$1",
            [id],
          );
        await audit(tx, user, "evaluation-published", id);
      });
      return { published: true };
    });
    routes.get("/course-model-recipient", async (req) => ({
      recipient: await courseRecipient(options.resolve, actor(req).id),
    }));
    routes.post("/course-submissions/:id/model-consent", async (req, reply) => {
      const user = actor(req),
        { submission, task } = await courseSubmissionAccess(
          db,
          param(req),
          user,
        );
      if (submission.submitted_by !== user.id || user.role !== "student")
        fail("FORBIDDEN", "仅原提交人可授权代码外发", 403);
      const body = z
          .object({
            recipientHash: z.string().length(64),
            confirmed: z.literal(true),
          })
          .strict()
          .parse(req.body),
        recipient = await courseRecipient(
          options.resolve,
          task.assignment.teacher_id,
        );
      if (!recipient || body.recipientHash !== recipient.hash)
        fail(
          "MODEL_RECIPIENT_CHANGED",
          "教师模型接收方已变化，请重新确认",
          409,
        );
      const id = randomUUID();
      await db.query(
        "INSERT INTO course_model_consents(id,snapshot_id,actor_id,recipient_hash,purpose,recipient) VALUES($1,$2,$3,$4,'formal',$5)",
        [id, submission.snapshot_id, user.id, recipient.hash, json(recipient)],
      );
      return reply.code(201).send({ id });
    });
    routes.post("/course-model-consents/:id/revoke", async (req) => {
      await db.query(
        "UPDATE course_model_consents SET revoked_at=clock_timestamp() WHERE id=$1 AND actor_id=$2",
        [param(req), actor(req).id],
      );
      return { revoked: true };
    });
    routes.post("/course-submissions/:id/analyses", async (req, reply) => {
      const user = actor(req),
        { submission, task } = await courseSubmissionAccess(
          db,
          param(req),
          user,
        );
      if (user.id !== task.assignment.teacher_id)
        fail("FORBIDDEN", "仅授课教师发起正式评阅", 403);
      const body = z
        .object({
          recipientHash: z.string().length(64),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const id = await enqueueCourseAnalysis(db, options.resolve, {
        user,
        submission,
        task,
        body,
      });
      return reply.code(202).send({ id });
    });
    routes.post("/course-tasks/:id/self-checks", async (req, reply) => {
      const user = actor(req);
      if (user.role !== "student") fail("FORBIDDEN", "自查仅属于学生本人", 403);
      const task = await courseTaskAccess(db, param(req), user),
        body = z
          .object({
            snapshotId: uuid,
            recipientHash: z.string().length(64),
            confirmed: z.literal(true),
          })
          .strict()
          .parse(req.body);
      const snapshot = await snapshotOwn(
          db,
          body.snapshotId,
          user,
          task.task_id,
        ),
        id = randomUUID();
      const analysisId = await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO course_self_checks(id,owner_id,task_id,snapshot_id,task_revision_id) VALUES($1,$2,$3,$4,$5)",
          [id, user.id, task.task_id, snapshot.id, task.current_revision_id],
        );
        return enqueueCourseAnalysis(tx, options.resolve, {
          user,
          selfCheck: {
            id,
            snapshot_id: snapshot.id,
            task_revision_id: task.current_revision_id,
          },
          task,
          body,
        });
      });
      return reply.code(202).send({ id, analysisId });
    });
    async function ownCheck(id: string, user: CourseActor) {
      const row = (
        await db.query(
          "SELECT * FROM course_self_checks WHERE id=$1 AND owner_id=$2",
          [id, user.id],
        )
      ).rows[0];
      if (!row || user.role !== "student") fail("NOT_FOUND", "自查不存在", 404);
      await courseTaskAccess(db, row.task_id, user);
      return row;
    }
    routes.get("/self-checks/:id", async (req) => {
      const user = actor(req),
        check = await ownCheck(param(req), user);
      return {
        check,
        messages: (
          await db.query(
            "SELECT id,level,question,status,report,usage,failure_code,model_config,billing_user_id,created_at FROM course_analyses WHERE self_check_id=$1 ORDER BY created_at",
            [check.id],
          )
        ).rows,
      };
    });
    routes.get("/course-tasks/:id/self-checks", async (req) => {
      const user = actor(req);
      await courseTaskAccess(db, param(req), user);
      return {
        items: (
          await db.query(
            "SELECT id,snapshot_id,created_at FROM course_self_checks WHERE task_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 30",
            [param(req), user.id],
          )
        ).rows,
      };
    });
    routes.post("/self-checks/:id/messages", async (req, reply) => {
      const user = actor(req),
        check = await ownCheck(param(req), user),
        task = await courseTaskAccess(db, check.task_id, user);
      const body = z
        .object({
          level: z.number().int().min(2).max(3),
          question: z.string().max(2000).default(""),
          recipientHash: z.string().length(64),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const completed = Number(
        (
          await db.query(
            "SELECT COALESCE(max(level),0) AS n FROM course_analyses WHERE self_check_id=$1 AND status='succeeded'",
            [check.id],
          )
        ).rows[0].n,
      );
      if (body.level > completed + 1)
        fail(
          "HELP_ORDER_REQUIRED",
          "请先阅读当前层级提示，再请求更多帮助",
          409,
        );
      if (body.level === 3 && !task.config.allowCode)
        fail(
          "HELP_CODE_DISABLED",
          "教师已关闭辅助代码，可继续请求思路和验证提示",
          409,
        );
      const id = await enqueueCourseAnalysis(db, options.resolve, {
        user,
        selfCheck: check,
        task,
        body,
      });
      return reply.code(202).send({ id });
    });
    routes.post("/course-analyses/:id/cancel", async (req) => {
      await db.query(
        "UPDATE course_analyses SET status='cancelled',finished_at=clock_timestamp() WHERE id=$1 AND billing_user_id=$2 AND status IN ('queued','running')",
        [param(req), actor(req).id],
      );
      return { cancelled: true };
    });
    routes.post(
      "/course-submissions/:id/contribution-statements",
      async (req) => {
        const user = actor(req),
          { submission } = await courseSubmissionAccess(db, param(req), user),
          body = z
            .object({ statement: z.string().trim().min(1).max(3000) })
            .strict()
            .parse(req.body);
        if (
          user.role !== "student" ||
          !submission.member_snapshot.some((m: any) => m.userId === user.id)
        )
          fail("FORBIDDEN", "只能说明本人参与的提交", 403);
        await db.query(
          "INSERT INTO course_contribution_statements(submission_id,user_id,statement) VALUES($1,$2,$3) ON CONFLICT(submission_id,user_id) DO UPDATE SET statement=EXCLUDED.statement,updated_at=clock_timestamp()",
          [submission.id, user.id, body.statement],
        );
        return { saved: true };
      },
    );
    routes.get("/course-submissions/:id/contributions", async (req) => {
      const user = actor(req),
        { submission } = await courseSubmissionAccess(db, param(req), user),
        current = (
          await db.query(
            "SELECT source,owner_id FROM course_snapshots WHERE id=$1",
            [submission.snapshot_id],
          )
        ).rows[0];
      if (!submission.base_submission_id || !current.source.commit)
        return {
          members: submission.member_snapshot,
          status: "insufficient",
          limitation:
            "缺少固定 Git 基线区间；上传人不等于作者，不计算贡献比例。",
        };
      const base = (
        await db.query(
          "SELECT p.source FROM course_submissions s JOIN course_snapshots p ON p.id=s.snapshot_id WHERE s.id=$1",
          [submission.base_submission_id],
        )
      ).rows[0]?.source;
      if (
        !base?.commit ||
        ["provider", "owner", "name"].some((k) => base[k] !== current.source[k])
      )
        return {
          status: "insufficient",
          limitation: "前置基线不是同仓库固定提交，无法确认历史区间。",
        };
      try {
        const git = await courseGitConnection(
          db,
          current.owner_id,
          current.source,
          options.vault,
        );
        return {
          members: submission.member_snapshot,
          base: base.commit,
          head: current.source.commit,
          evidence: await courseContributionEvidence(
            git,
            current.source,
            base.commit,
            submission.member_snapshot,
          ),
        };
      } catch {
        return {
          status: "insufficient",
          limitation: "授权、网络或历史不足；不能据此判定零贡献。",
        };
      }
    });
  });
  if (enabled && options.background !== false) {
    const controller = new AbortController();
    let work: Promise<void> | undefined;
    api.addHook("onReady", async () => {
      work = (async () => {
        while (!controller.signal.aborted) {
          try {
            await courseImportTick(db, controller.signal, options.vault);
            await courseAnalysisTick(db, options.resolve, controller.signal);
          } catch {
            api.log.error("COURSEWORK_WORKER_UNAVAILABLE");
          }
          try {
            await delay(1000, undefined, { signal: controller.signal });
          } catch {
            break;
          }
        }
      })();
    });
    api.addHook("onClose", async () => {
      controller.abort();
      await work;
    });
  }
}
