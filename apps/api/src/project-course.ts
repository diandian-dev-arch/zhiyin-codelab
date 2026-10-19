import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sourceContentQuery, sourceContent } from './source-content.js';
import { canonicalJson, sha256 } from '../../../packages/contracts/src/v2/index.js';
import type { DB } from './db.js';

type Actor = { id: string; role: string };
type Row = Record<string, any>;
const uuid = z.string().uuid();
const iso = (value: string | Date | null | undefined) => value == null ? null : new Date(value).toISOString();
export const projectRubricSchema = z.array(z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional(),
}).strict()).max(20).refine(items => new Set(items.map(item => item.id)).size === items.length, '评价标准编号不能重复');
export class ProjectCourseError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
const fail = (code: string, message: string, status = 400): never => { throw new ProjectCourseError(code, message, status); };
const actor = (req: FastifyRequest) => {
  const user = (req as FastifyRequest & { user?: Actor }).user;
  if (!user || !['teacher', 'student'].includes(user.role)) return fail('AUTHENTICATION_REQUIRED', '请先登录', 401);
  return user;
};
const id = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);
export function projectTaskSummary(task: Row) {
  return { taskId: task.id, classId: task.class_id, teacherId: task.teacher_id,
    title: task.title, description: task.description, kind: task.kind,
    dueAt: iso(task.due_at), rubric: task.rubric, createdAt: iso(task.created_at) };
}
export async function projectTaskAccess(db: DB, taskId: string, user: Actor) {
  if ((await db.query('SELECT task_id FROM course_tasks WHERE task_id=$1', [uuid.parse(taskId)])).rows.length)
    return fail('COURSEWORK_ROUTE_REQUIRED', '此任务使用任务化提交，请从作业入口打开', 409);
  const task = (await db.query(`SELECT t.*,c.teacher_id,c.name AS class_name FROM tasks t JOIN classes c ON c.id=t.class_id
    WHERE t.id=$1 AND t.kind='project' AND
    (($3='teacher' AND c.teacher_id=$2) OR ($3='student' AND EXISTS(
      SELECT 1 FROM memberships m WHERE m.class_id=c.id AND m.user_id=$2)))`, [uuid.parse(taskId), user.id, user.role])).rows[0];
  if (!task) return fail('NOT_FOUND', '项目任务不存在或无权访问', 404);
  return task;
}
/** Class membership permits the specifically submitted source version, never the author's project history. */
export async function projectSubmissionAccess(db: DB, submissionId: string, user: Actor) {
  const submission = (await db.query('SELECT * FROM project_submissions WHERE id=$1', [uuid.parse(submissionId)])).rows[0];
  if (!submission) return fail('NOT_FOUND', '项目提交不存在或无权访问', 404);
  const task = await projectTaskAccess(db, submission.task_id, user);
  if (!submission.share_with_class && submission.user_id !== user.id && task.teacher_id !== user.id)
    return fail('NOT_FOUND', '项目提交不存在或无权访问', 404);
  return { submission, task };
}
function evaluationSummary(row: Row, canSeeFeedback: boolean) {
  if (!row.evaluation_outcome) return null;
  return {
    ...(canSeeFeedback ? { feedback: row.feedback, outcome: row.evaluation_outcome, revision: row.evaluation_revision } : {}),
    featured: row.featured, featureReason: row.feature_reason, updatedAt: iso(row.evaluation_updated_at),
  };
}
function submissionSummary(row: Row, user: Actor, task: Row) {
  return { id: row.id, taskId: row.task_id, userId: row.user_id, studentName: row.student_name,
    projectId: row.project_id, projectName: row.project_name, version: row.version, note: row.note,
    revisionNote: row.revision_note, createdAt: iso(row.created_at),
    late: Boolean(task.due_at && new Date(row.created_at).getTime() > new Date(task.due_at).getTime()),
    analysisId: row.analysis_id, analysisStatus: row.analysis_status ?? null,
    pendingAnalysis: row.pending_analysis_id ? { id: row.pending_analysis_id, status: row.pending_status, code: row.pending_code ?? null,
      canCancel: ['queued','running'].includes(row.pending_status) && (row.pending_billing_user_id ?? row.user_id) === user.id } : null,
    reviewCount: Number(row.review_count ?? 0), recommendations: Number(row.recommendations ?? 0),
    showcaseConsent: row.showcase_consent,
    evaluation: evaluationSummary(row, user.id === row.user_id || user.id === task.teacher_id) };
}
const submissionSelect = `SELECT s.*,u.name AS student_name,p.name AS project_name,a.status AS analysis_status,
  pending.status AS pending_status,pending.code AS pending_code,pending.billing_user_id AS pending_billing_user_id,
  e.feedback,e.outcome AS evaluation_outcome,e.featured,e.feature_reason,e.revision AS evaluation_revision,e.updated_at AS evaluation_updated_at,
  (SELECT count(*)::int FROM project_peer_reviews r WHERE r.submission_id=s.id) AS review_count,
  (SELECT count(*)::int FROM project_peer_reviews r WHERE r.submission_id=s.id AND r.recommend) AS recommendations
  FROM project_submissions s JOIN users u ON u.id=s.user_id JOIN source_projects p ON p.id=s.project_id
  LEFT JOIN source_analyses a ON a.id=s.analysis_id
  LEFT JOIN source_analyses pending ON pending.id=s.pending_analysis_id
  LEFT JOIN project_evaluations e ON e.submission_id=s.id`;

export async function projectCourseOverviews(db: DB, taskIds: string[], user: Actor) {
  if (!taskIds.length) return new Map<string, any>();
  const rows = (await db.query(`SELECT DISTINCT ON(s.task_id,s.user_id) s.id,s.task_id,s.user_id,s.project_id,s.created_at,s.version,
    u.name AS student_name,e.outcome,e.updated_at AS evaluated_at
    FROM project_submissions s JOIN users u ON u.id=s.user_id
    LEFT JOIN project_evaluations e ON e.submission_id=s.id
    WHERE s.task_id=ANY($1::uuid[]) AND ($3='teacher' OR s.user_id=$2)
    ORDER BY s.task_id,s.user_id,s.version DESC`, [taskIds, user.id, user.role])).rows;
  const result = new Map<string, any>(taskIds.map(taskId => [taskId, user.role === 'teacher'
    ? { submittedStudents: 0, pendingReviewCount: 0, pendingReviews: [] }
    : { latestSubmission: null, latestPublication: null }]));
  for (const row of rows) {
    const overview = result.get(row.task_id);
    const item = { submissionId: row.id, projectId: row.project_id, submittedAt: iso(row.created_at), version: row.version,
      runId: null, status: row.outcome ?? 'saved', publicationId: null };
    if (user.role === 'teacher') {
      overview.submittedStudents++;
      if (!row.outcome || row.outcome === 'pending') {
        overview.pendingReviewCount++;
        if (overview.pendingReviews.length < 5) overview.pendingReviews.push({ ...item, studentName: row.student_name });
      }
    } else {
      overview.latestSubmission = item;
      if (row.evaluated_at) overview.latestEvaluation = { submissionId: row.id, outcome: row.outcome, updatedAt: iso(row.evaluated_at) };
    }
  }
  return result;
}

export async function registerProjectCourse(api: FastifyInstance, db: DB) {
  api.get('/project-tasks/:id', async req => {
    const user = actor(req), task = await projectTaskAccess(db, id(req), user);
    const rows = (await db.query(`${submissionSelect} WHERE s.task_id=$1 ORDER BY s.created_at DESC,s.id`, [task.id])).rows;
    const submissions = rows.map(row => submissionSummary(row, user, task));
    const latest = new Map<string, number>();
    for (const row of rows) latest.set(row.user_id, Math.max(latest.get(row.user_id) ?? 0, row.version));
    const myProjects = (await db.query(`SELECT p.id,p.name,(SELECT status FROM source_analyses a WHERE a.project_id=p.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS status
      FROM source_projects p WHERE p.owner_id=$1 ORDER BY p.created_at DESC,p.id LIMIT 100`, [user.id])).rows;
    return { task: projectTaskSummary(task), submissions,
      showcase: submissions.filter(item => item.evaluation?.featured && item.showcaseConsent && latest.get(item.userId) === item.version), myProjects };
  });

  api.post('/project-tasks/:id/submissions', async (req, reply) => {
    const user = actor(req);
    if (user.role !== 'student') return fail('FORBIDDEN', '请使用学生本人账号提交', 403);
    const taskId = id(req);
    const body = z.object({ projectId: uuid, shareWithClass: z.literal(true),
      note: z.string().trim().max(2000).default(''), revisionNote: z.string().trim().max(2000).default(''),
      showcaseConsent: z.boolean().default(false) }).strict().parse(req.body);
    const requestKey = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/).parse(req.headers['idempotency-key']);
    const requestHash = await sha256(canonicalJson(body));
    const result = await db.transaction(async tx => {
      const task = await projectTaskAccess(tx, taskId, user);
      // A task row lock serializes version allocation and idempotency across API processes.
      await tx.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
      const prior = (await tx.query('SELECT * FROM project_submissions WHERE task_id=$1 AND user_id=$2 AND request_key=$3', [taskId, user.id, requestKey])).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) return fail('IDEMPOTENCY_CONFLICT', '该提交请求已用于不同材料', 409);
        return { id: prior.id, task, replayed: true };
      }
      const project = (await tx.query('SELECT id,sha256 FROM source_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE', [body.projectId, user.id])).rows[0];
      if (!project) return fail('NOT_FOUND', '只能提交自己已保存的项目', 404);
      const existing = (await tx.query('SELECT id FROM project_submissions WHERE task_id=$1 AND user_id=$2 AND project_id=$3', [taskId, user.id, project.id])).rows[0];
      if (existing) return { id: existing.id, task, replayed: true };
      const next = Number((await tx.query('SELECT COALESCE(max(version),0)+1 AS version FROM project_submissions WHERE task_id=$1 AND user_id=$2', [taskId, user.id])).rows[0].version);
      const analysis = (await tx.query("SELECT id FROM source_analyses WHERE project_id=$1 AND status='succeeded' AND report IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1", [project.id])).rows[0];
      const submissionId = randomUUID();
      await tx.query(`INSERT INTO project_submissions(id,task_id,user_id,project_id,project_sha256,version,note,revision_note,
        share_with_class,showcase_consent,analysis_id,request_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12)`,
        [submissionId, taskId, user.id, project.id, project.sha256, next, body.note, body.revisionNote,
          body.showcaseConsent, analysis?.id ?? null, requestKey, requestHash]);
      return { id: submissionId, task, replayed: false };
    });
    const row = (await db.query(`${submissionSelect} WHERE s.id=$1`, [result.id])).rows[0];
    reply.code(result.replayed ? 200 : 201);
    return { submission: submissionSummary(row, user, result.task), replayed: result.replayed };
  });

  api.get('/project-submissions/:id', async req => {
    const user = actor(req), { submission, task } = await projectSubmissionAccess(db, id(req), user);
    const row = (await db.query(`${submissionSelect} WHERE s.id=$1`, [submission.id])).rows[0];
    const analysis = submission.analysis_id ? (await db.query('SELECT id,status,report FROM source_analyses WHERE id=$1 AND project_id=$2', [submission.analysis_id, submission.project_id])).rows[0] : null;
    const canManageAnalysis = user.id === submission.user_id || user.id === task.teacher_id;
    const pendingReport = canManageAnalysis && row.pending_status === 'succeeded'
      ? (await db.query('SELECT report FROM source_analyses WHERE id=$1 AND project_id=$2', [row.pending_analysis_id, submission.project_id])).rows[0]?.report?.report ?? null
      : null;
    const reviews = (await db.query(`SELECT r.id,r.reviewer_id,u.name,r.analysis_id,r.strength,r.improvement,r.recommend,r.updated_at
      FROM project_peer_reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.submission_id=$1 ORDER BY r.updated_at,r.id`, [submission.id])).rows;
    const peerReviews = reviews.map(review => ({ id: review.id, reviewerId: review.reviewer_id, reviewerName: review.name,
      analysisId: review.analysis_id, strength: review.strength, improvement: review.improvement, recommend: review.recommend, updatedAt: iso(review.updated_at) }));
    // The full source-analysis row contains private model configuration and invocation metadata.
    // Course readers receive only the approved report content bound to this exact submission.
    return { task: projectTaskSummary(task), submission: submissionSummary(row, user, task),
      analysis: analysis ? { id: analysis.id, status: analysis.status, report: analysis.report?.report ?? null } : null,
      pendingAnalysis: row.pending_analysis_id ? { id: row.pending_analysis_id, status: row.pending_status, code: row.pending_code ?? null,
        canCancel: canManageAnalysis && ['queued','running'].includes(row.pending_status) && (row.pending_billing_user_id ?? row.user_id) === user.id,
        ...(canManageAnalysis ? { report: pendingReport } : {}) } : null,
      peerReviews, myReview: peerReviews.find(review => review.reviewerId === user.id) ?? null };
  });

  api.get('/project-submissions/:id/source', async req => {
    const user = actor(req);
    const { submission, task } = await projectSubmissionAccess(db, id(req), user);
    const query = sourceContentQuery.parse(req.query);
    const { path, analysisId } = query;
    if (analysisId) {
      const canPreview = user.id === submission.user_id || user.id === task.teacher_id;
      if (analysisId !== submission.analysis_id && !(canPreview && analysisId === submission.pending_analysis_id)) return fail('NOT_FOUND', '报告不属于此提交', 404);
      const analysis = (await db.query('SELECT id FROM source_analyses WHERE id=$1 AND project_id=$2', [analysisId, submission.project_id])).rows[0];
      if (!analysis) return fail('NOT_FOUND', '报告不属于此源码版本', 404);
    }
    const project = (await db.query('SELECT files,sha256 FROM source_projects WHERE id=$1', [submission.project_id])).rows[0];
    if (!project || project.sha256 !== submission.project_sha256) return fail('SOURCE_VERSION_MISMATCH', '提交源码版本不一致', 409);
    if (!Object.hasOwn(project.files, path)) return fail('NOT_FOUND', '源码不存在', 404);
    return { path, ...sourceContent(project.files[path], query), submissionId: submission.id, version: submission.version, ...(analysisId ? { analysisId } : {}) };
  });

  api.put('/project-submissions/:id/analysis', async req => {
    const user = actor(req), body = z.object({ analysisId: uuid }).strict().parse(req.body);
    return db.transaction(async tx => {
      const { submission, task } = await projectSubmissionAccess(tx, id(req), user);
      if (user.id !== submission.user_id && user.id !== task.teacher_id) return fail('FORBIDDEN', '仅作者或所属教师可更新共享导读', 403);
      const analysis = (await tx.query("SELECT id FROM source_analyses WHERE id=$1 AND project_id=$2 AND status='succeeded' AND report IS NOT NULL", [body.analysisId, submission.project_id])).rows[0];
      if (!analysis) return fail('ANALYSIS_NOT_READY', '请选择该源码版本已经完成的分析报告', 409);
      await tx.query('UPDATE project_submissions SET analysis_id=$2,pending_analysis_id=CASE WHEN pending_analysis_id=$2 THEN NULL ELSE pending_analysis_id END WHERE id=$1', [submission.id, analysis.id]);
      return { submissionId: submission.id, analysisId: analysis.id };
    });
  });

  api.put('/project-submissions/:id/peer-review', async req => {
    const user = actor(req), body = z.object({ strength: z.string().trim().min(2).max(2000),
      improvement: z.string().trim().min(2).max(2000), recommend: z.boolean().default(false) }).strict().parse(req.body);
    return db.transaction(async tx => {
      const { submission } = await projectSubmissionAccess(tx, id(req), user);
      if (user.role !== 'student') return fail('FORBIDDEN', '同伴评阅由同班学生完成', 403);
      if (submission.user_id === user.id) return fail('SELF_REVIEW_FORBIDDEN', '不能评价或推荐自己的提交', 403);
      await tx.query(`INSERT INTO project_peer_reviews(id,submission_id,reviewer_id,analysis_id,strength,improvement,recommend)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(submission_id,reviewer_id) DO UPDATE
        SET analysis_id=EXCLUDED.analysis_id,strength=EXCLUDED.strength,improvement=EXCLUDED.improvement,
          recommend=EXCLUDED.recommend,updated_at=clock_timestamp()`,
        [randomUUID(), submission.id, user.id, submission.analysis_id, body.strength, body.improvement, body.recommend]);
      return { saved: true, submissionId: submission.id };
    });
  });

  api.put('/project-submissions/:id/evaluation', async req => {
    const user = actor(req), body = z.object({ feedback: z.string().trim().min(1).max(5000),
      outcome: z.enum(['achieved', 'needs_revision', 'pending']), featured: z.boolean().default(false),
      featureReason: z.string().trim().max(2000).default('') }).strict().parse(req.body);
    return db.transaction(async tx => {
      const { submission, task } = await projectSubmissionAccess(tx, id(req), user);
      if (user.role !== 'teacher' || task.teacher_id !== user.id) return fail('FORBIDDEN', '仅所属教师可发布正式评价', 403);
      await tx.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [task.id]);
      if (body.featured) {
        if (!submission.showcase_consent) return fail('SHOWCASE_CONSENT_REQUIRED', '作者尚未同意将此版本展示为班内案例', 409);
        if (body.outcome !== 'achieved' || !body.featureReason) return fail('FEATURE_REASON_REQUIRED', '请选择达成并填写具体入选理由', 400);
        if ((await tx.query('SELECT 1 FROM project_submissions WHERE task_id=$1 AND user_id=$2 AND version>$3', [task.id, submission.user_id, submission.version])).rows.length)
          return fail('NEWER_SUBMISSION_EXISTS', '学生已有新提交，请核对最终版本后选优', 409);
      }
      const previous = (await tx.query('SELECT * FROM project_evaluations WHERE submission_id=$1', [submission.id])).rows[0];
      if (previous && previous.analysis_id === submission.analysis_id && previous.feedback === body.feedback &&
        previous.outcome === body.outcome && previous.featured === body.featured && previous.feature_reason === body.featureReason)
        return { saved: true, submissionId: submission.id, revision: previous.revision };
      const evaluation = (await tx.query(`INSERT INTO project_evaluations(submission_id,teacher_id,analysis_id,feedback,outcome,featured,feature_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(submission_id) DO UPDATE SET teacher_id=EXCLUDED.teacher_id,
        analysis_id=EXCLUDED.analysis_id,feedback=EXCLUDED.feedback,outcome=EXCLUDED.outcome,featured=EXCLUDED.featured,
        feature_reason=EXCLUDED.feature_reason,revision=project_evaluations.revision+1,updated_at=clock_timestamp() RETURNING *`,
        [submission.id, user.id, submission.analysis_id, body.feedback, body.outcome, body.featured, body.featureReason])).rows[0];
      await tx.query('INSERT INTO project_evaluation_revisions(id,submission_id,revision,snapshot) VALUES($1,$2,$3,$4)',
        [randomUUID(), submission.id, evaluation.revision, JSON.stringify(evaluation)]);
      return { saved: true, submissionId: submission.id, revision: evaluation.revision };
    });
  });
}
