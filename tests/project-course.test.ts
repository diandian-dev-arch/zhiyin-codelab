import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createApp} from '../apps/api/src/app';
import {digest} from '../apps/api/src/auth';
import {migrate} from '../apps/api/src/db';
import {isolatedTestDB, type IsolatedTestDatabase} from './isolated-db';

const origin = 'http://localhost:5173';
type Session = {id: string; headers: Record<string, string>};

describe('open project coursework and shared project reading', () => {
  let db: IsolatedTestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let teacher: Session, student: Session, peer: Session, outsider: Session, otherTeacher: Session;
  let classId: string;

  async function session(name: string, role: 'teacher' | 'student'): Promise<Session> {
    const id = randomUUID(), sid = randomUUID(), csrf = randomUUID();
    await db.query('INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [id, `${id}@project-course.invalid`, name, role, 'fixture-session-only']);
    await db.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [digest(sid), id, csrf]);
    return {id, headers:{origin, cookie:`sid=${sid}`, 'x-csrf-token':csrf}};
  }
  beforeAll(async () => {
    db = await isolatedTestDB();
    await migrate(db);
    teacher = await session('课程教师', 'teacher');
    student = await session('提交学生', 'student');
    peer = await session('同班同学', 'student');
    outsider = await session('其他班学生', 'student');
    otherTeacher = await session('其他教师', 'teacher');
    classId = randomUUID();
    await db.query("INSERT INTO classes(id,name,teacher_id) VALUES($1,'项目实践班',$2)", [classId, teacher.id]);
    await db.query('INSERT INTO memberships(class_id,user_id) VALUES($1,$2),($1,$3)', [classId, student.id, peer.id]);
    app = await createApp(db, {origin, secure:false, executionApproved:false, businessVersion:2, model:'fixture', image:'fixture', packs:[]});
  });
  afterAll(async () => {await app?.close(); await db?.close();});

  const get = (url: string, who: Session = student) => app.inject({url, headers:who.headers});
  const put = (url: string, who: Session, payload: Record<string, unknown>) => app.inject({method:'PUT',url,headers:who.headers,payload});
  async function createTask(extra: Record<string, unknown> = {}) {
    const response = await app.inject({method:'POST',url:'/api/v2/tasks', headers:{...teacher.headers,'idempotency-key':randomUUID()},
      payload:{classId,title:'开放项目实训',description:'实现一个项目并解释设计思路',kind:'project',...extra}});
    expect(response.statusCode, response.body).toBe(201);
    return response.json().taskId as string;
  }
  async function project(owner: Session = student, content = 'export const answer = 42;') {
    const id = randomUUID(), files = {'src/main.ts':content, 'README.md':'课程项目说明'};
    await db.query('INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,$3,$4,$5,$6)',
      [id,owner.id,'学生自选项目',digest(id),JSON.stringify(files),'[]']);
    return {id,files};
  }
  async function analysis(projectId: string, label: string, status = 'succeeded') {
    const id = randomUUID();
    const report = {overview:{summary:label},stack:[],modules:[],flows:[],findings:[],readingPath:[],limitations:[]};
    await db.query('INSERT INTO source_analyses(id,project_id,status,report) VALUES($1,$2,$3,$4)',
      [id,projectId,status,JSON.stringify({report,privateConfig:'DO_NOT_SHARE_CONFIGURATION',context:{privateUsage:'DO_NOT_SHARE_USAGE'}})]);
    return {id,report};
  }
  const submit = (taskId: string, projectId: string, extra: Record<string, unknown> = {}, who: Session = student, key = randomUUID()) =>
    app.inject({method:'POST',url:`/api/v2/project-tasks/${taskId}/submissions`,headers:{...who.headers,'idempotency-key':key},
      payload:{projectId,shareWithClass:true,...extra}});
  async function fixture(options: {consent?: boolean; withAnalysis?: boolean} = {}) {
    const taskId = await createTask(), source = await project();
    const initial = options.withAnalysis ? await analysis(source.id, '最初采用的导读') : null;
    const response = await submit(taskId,source.id,{showcaseConsent:options.consent ?? false});
    expect(response.statusCode, response.body).toBe(201);
    return {taskId,source,initial,submission:response.json().submission};
  }

  it('reads bounded source for the adopted report and refuses pending or foreign reports for peers', async () => {
    const f = await fixture({ withAnalysis: true });
    const pending = await analysis(f.source.id, '待采用报告');
    await db.query('UPDATE project_submissions SET pending_analysis_id=$2 WHERE id=$1', [f.submission.id, pending.id]);
    const sourceUrl = `/api/v2/project-submissions/${f.submission.id}/source?path=src/main.ts&start=1&end=1`;
    const allowed = await get(`${sourceUrl}&analysisId=${f.initial!.id}`, peer);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json()).toMatchObject({ startLine: 1, totalLines: 1, content: f.source.files['src/main.ts'], analysisId: f.initial!.id });
    expect((await get(`${sourceUrl}&analysisId=${pending.id}`, peer)).statusCode).toBe(404);
    expect((await get(`${sourceUrl}&analysisId=${pending.id}`, student)).statusCode).toBe(200);
    expect((await get(`${sourceUrl}&analysisId=${pending.id}`, teacher)).statusCode).toBe(200);
    expect((await get(`${sourceUrl}&analysisId=${randomUUID()}`, teacher)).statusCode).toBe(404);
    expect((await get(`${sourceUrl}&analysisId=${f.initial!.id}`, outsider)).statusCode).toBe(404);
    await expect(db.query('UPDATE source_projects SET sha256=$2 WHERE id=$1', [f.source.id, digest('mismatch')])).rejects.toThrow('SUBMITTED_SOURCE_IMMUTABLE');
  });

  it('creates owned project tasks with rubric and due date while preserving the template default', async () => {
    const rubric = [{id:'design',title:'模块职责清晰',description:'说明各模块如何协作'}];
    const taskId = await createTask({rubric,dueAt:'2026-09-01T00:00:00.000Z'});
    const detail = await get(`/api/v2/tasks/${taskId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({kind:'project',rubric,dueAt:'2026-09-01T00:00:00.000Z',executionAvailable:false,template:{available:false}});
    expect((await get(`/api/v2/project-tasks/${taskId}`)).json().task).toMatchObject({taskId,teacherId:teacher.id,rubric});
    const listed = (await get('/api/v2/tasks')).json().items.find((task: any) => task.taskId === taskId);
    expect(listed).toMatchObject({kind:'project',rubric,overview:{latestSubmission:null}});
    expect((await get(`/api/v2/tasks/${taskId}/template`)).statusCode).toBe(409);
    for (const suffix of ['rules','submissions']) {
      const rejected = await app.inject({method:'POST',url:`/api/v2/tasks/${taskId}/${suffix}`,headers:teacher.headers,payload:{}});
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().error.code).toBe('PROJECT_TASK_ROUTE_REQUIRED');
    }
    for (const who of [student,otherTeacher]) {
      const response = await app.inject({method:'POST',url:'/api/v2/tasks',headers:{...who.headers,'idempotency-key':randomUUID()},
        payload:{classId,title:'不应创建',description:'权限验证',kind:'project'}});
      expect(response.statusCode).toBe(who === student ? 403 : 404);
    }
    const legacy = await app.inject({method:'POST',url:'/api/v2/tasks',headers:{...teacher.headers,'idempotency-key':randomUUID()},
      payload:{classId,title:'模板兼容',description:'未传kind的客户端保持旧语义'}});
    expect(legacy.statusCode,legacy.body).toBe(201);
    expect(legacy.json().kind).toBe('template');
  });

  it('submits without any model configuration, requires sharing consent, and handles retry without new versions', async () => {
    const taskId = await createTask({dueAt:'2020-01-01T00:00:00.000Z'}), source = await project(), key = randomUUID();
    expect((await submit(taskId,source.id,{shareWithClass:false})).statusCode).toBe(400);
    expect((await submit(taskId,source.id,{},peer)).statusCode).toBe(404);
    const created = await submit(taskId,source.id,{note:'第一次提交'},student,key);
    expect(created.statusCode,created.body).toBe(201);
    expect(created.json()).toMatchObject({replayed:false,submission:{version:1,late:true,analysisId:null,analysisStatus:null}});
    const retried = await submit(taskId,source.id,{note:'第一次提交'},student,key);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().submission.id).toBe(created.json().submission.id);
    expect((await submit(taskId,source.id,{note:'不同请求'},student,key)).statusCode).toBe(409);
    const sameProject = await submit(taskId,source.id);
    expect(sameProject.json().submission.id).toBe(created.json().submission.id);
    expect((await db.query('SELECT id FROM project_submissions WHERE task_id=$1',[taskId])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM source_analyses WHERE project_id=$1',[source.id])).rows).toHaveLength(0);
    const overview = (await get('/api/v2/tasks',teacher)).json().items.find((task: any) => task.taskId === taskId).overview;
    expect(overview).toMatchObject({submittedStudents:1,pendingReviewCount:1});
    expect(overview.pendingReviews[0]).toMatchObject({submissionId:created.json().submission.id,projectId:source.id});
  });

  it('shares only the submitted source and report with current classmates and the owning teacher', async () => {
    const {taskId,source,initial,submission} = await fixture({withAnalysis:true});
    for (const who of [student,peer,teacher]) {
      const detail = await get(`/api/v2/project-submissions/${submission.id}`,who);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().analysis).toEqual({id:initial!.id,status:'succeeded',report:initial!.report});
      expect(detail.body).not.toContain('DO_NOT_SHARE');
      expect((await get(`/api/v2/project-submissions/${submission.id}/source?path=src%2Fmain.ts`,who)).json()).toMatchObject({content:source.files['src/main.ts'],version:1});
    }
    expect((await get(`/api/v2/projects/${source.id}`,peer)).statusCode).toBe(404);
    expect((await get(`/api/v2/project-submissions/${submission.id}/source?path=missing.ts`,peer)).statusCode).toBe(404);
    for (const who of [outsider,otherTeacher]) {
      for (const url of [`/api/v2/project-tasks/${taskId}`,`/api/v2/project-submissions/${submission.id}`,`/api/v2/project-submissions/${submission.id}/source?path=src%2Fmain.ts`])
        expect((await get(url,who)).statusCode).toBe(404);
      expect((await put(`/api/v2/project-submissions/${submission.id}/peer-review`,who,{strength:'模块清晰',improvement:'补充测试'})).statusCode).toBe(404);
    }
    await db.query('DELETE FROM memberships WHERE class_id=$1 AND user_id=$2',[classId,peer.id]);
    try { expect((await get(`/api/v2/project-submissions/${submission.id}`,peer)).statusCode).toBe(404); }
    finally { await db.query('INSERT INTO memberships(class_id,user_id) VALUES($1,$2)',[classId,peer.id]); }
  });

  it('requires meaningful peer feedback, forbids self-review, and keeps one review per classmate', async () => {
    const {submission,initial} = await fixture({withAnalysis:true});
    const url = `/api/v2/project-submissions/${submission.id}/peer-review`;
    const review = {strength:'模块职责清楚',improvement:'补充失败路径测试',recommend:true};
    expect((await put(url,student,review)).statusCode).toBe(403);
    expect((await put(url,teacher,review)).statusCode).toBe(403);
    expect((await put(url,peer,{...review,improvement:''})).statusCode).toBe(400);
    expect((await put(url,peer,review)).statusCode).toBe(200);
    expect((await put(url,peer,{...review,improvement:'也补充网络失败时的恢复说明'})).statusCode).toBe(200);
    const detail = (await get(`/api/v2/project-submissions/${submission.id}`,peer)).json();
    expect(detail.peerReviews).toHaveLength(1);
    expect(detail.myReview).toMatchObject({reviewerId:peer.id,analysisId:initial!.id,recommend:true,improvement:'也补充网络失败时的恢复说明'});
    expect(detail.submission).toMatchObject({reviewCount:1,recommendations:1});
  });

  it('keeps official feedback private, requires an authorized showcase, and makes identical evaluation retries idempotent', async () => {
    const {taskId,submission} = await fixture({consent:true});
    const url = `/api/v2/project-submissions/${submission.id}/evaluation`;
    const evaluation = {feedback:'私有教师反馈：补充异常处理说明',outcome:'achieved',featured:true,featureReason:'模块边界清楚，适合作为分层设计案例'};
    expect((await put(url,student,evaluation)).statusCode).toBe(403);
    expect((await put(url,otherTeacher,evaluation)).statusCode).toBe(404);
    expect((await put(url,teacher,{...evaluation,featureReason:''})).statusCode).toBe(400);
    const saved = await put(url,teacher,evaluation);
    expect(saved.statusCode,saved.body).toBe(200);
    expect(saved.json().revision).toBe(1);
    expect((await put(url,teacher,evaluation)).json().revision).toBe(1);
    expect((await db.query('SELECT id FROM project_evaluation_revisions WHERE submission_id=$1',[submission.id])).rows).toHaveLength(1);
    expect((await get(`/api/v2/project-submissions/${submission.id}`)).json().submission.evaluation).toMatchObject(evaluation);
    const peerDetail = await get(`/api/v2/project-submissions/${submission.id}`,peer);
    expect(peerDetail.body).not.toContain(evaluation.feedback);
    expect(peerDetail.json().submission.evaluation).toEqual(expect.objectContaining({featured:true,featureReason:evaluation.featureReason}));
    expect(peerDetail.json().submission.evaluation).not.toHaveProperty('outcome');
    const task = (await get(`/api/v2/project-tasks/${taskId}`,peer)).json();
    expect(task.showcase.map((item: any) => item.id)).toEqual([submission.id]);
    expect(JSON.stringify(task)).not.toContain(evaluation.feedback);
    const noConsent = await fixture();
    const rejected = await put(`/api/v2/project-submissions/${noConsent.submission.id}/evaluation`,teacher,evaluation);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe('SHOWCASE_CONSENT_REQUIRED');
  });

  it('preserves submitted versions and prior review history when a student revises the source', async () => {
    const {taskId,source,submission} = await fixture({consent:true});
    const evaluation = {feedback:'第一版结构清晰',outcome:'achieved',featured:true,featureReason:'版本一展示理由'};
    expect((await put(`/api/v2/project-submissions/${submission.id}/evaluation`,teacher,evaluation)).statusCode).toBe(200);
    await expect(db.query('UPDATE source_projects SET files=$2 WHERE id=$1',[source.id,JSON.stringify({'src/main.ts':'changed'})])).rejects.toThrow('SUBMITTED_SOURCE_IMMUTABLE');
    await expect(db.query("UPDATE project_submissions SET note='changed' WHERE id=$1",[submission.id])).rejects.toThrow('PROJECT_SUBMISSION_IMMUTABLE');
    const revised = await project(student,'export const answer = 43;');
    const second = await submit(taskId,revised.id,{revisionNote:'补充异常处理',showcaseConsent:true});
    expect(second.statusCode,second.body).toBe(201);
    expect(second.json().submission).toMatchObject({version:2,revisionNote:'补充异常处理',evaluation:null});
    const task = (await get(`/api/v2/project-tasks/${taskId}`)).json();
    expect(task.submissions.map((item: any) => item.version)).toEqual([2,1]);
    expect(task.showcase).toEqual([]);
    expect(task.submissions.find((item: any) => item.id === submission.id).evaluation.feedback).toBe(evaluation.feedback);
    const staleFeature = await put(`/api/v2/project-submissions/${submission.id}/evaluation`,teacher,evaluation);
    expect(staleFeature.statusCode).toBe(409);
    expect(staleFeature.json().error.code).toBe('NEWER_SUBMISSION_EXISTS');
    const studentOverview = (await get('/api/v2/tasks')).json().items.find((item: any) => item.taskId === taskId).overview;
    expect(studentOverview.latestSubmission).toMatchObject({version:2,submissionId:second.json().submission.id});
    expect((await get(`/api/v2/project-submissions/${submission.id}/source?path=src%2Fmain.ts`)).json().content).toBe(source.files['src/main.ts']);
  });

  it('previews a new guide only for the author and teacher and requires explicit adoption', async () => {
    const {source,initial,submission} = await fixture({withAnalysis:true});
    const newer = await analysis(source.id,'尚未共享的新导读');
    await db.query('UPDATE project_submissions SET pending_analysis_id=$2 WHERE id=$1',[submission.id,newer.id]);
    for (const who of [student,teacher]) {
      const detail = (await get(`/api/v2/project-submissions/${submission.id}`,who)).json();
      expect(detail.analysis.id).toBe(initial!.id);
      expect(detail.pendingAnalysis).toMatchObject({id:newer.id,status:'succeeded',report:newer.report});
    }
    const peerDetail = await get(`/api/v2/project-submissions/${submission.id}`,peer);
    expect(peerDetail.json().analysis.id).toBe(initial!.id);
    expect(peerDetail.json().pendingAnalysis).not.toHaveProperty('report');
    expect(peerDetail.body).not.toContain('尚未共享的新导读');
    const url = `/api/v2/project-submissions/${submission.id}/analysis`;
    expect((await put(url,peer,{analysisId:newer.id})).statusCode).toBe(403);
    const otherSource = await project(), wrong = await analysis(otherSource.id,'其他源码版本');
    expect((await put(url,student,{analysisId:wrong.id})).statusCode).toBe(409);
    expect((await put(url,student,{analysisId:initial!.id})).statusCode).toBe(200);
    expect((await get(`/api/v2/project-submissions/${submission.id}`)).json().pendingAnalysis.id).toBe(newer.id);
    expect((await put(url,teacher,{analysisId:newer.id})).statusCode).toBe(200);
    const adopted = (await get(`/api/v2/project-submissions/${submission.id}`,peer)).json();
    expect(adopted.analysis.id).toBe(newer.id);
    expect(adopted.pendingAnalysis).toBeNull();
    const failed = await analysis(source.id,'失败不可采用','failed');
    expect((await put(url,student,{analysisId:failed.id})).statusCode).toBe(409);
  });

  it('does not let classmates initiate paid analysis or bypass explicit consent', async () => {
    const {source,submission} = await fixture();
    const url = `/api/v2/project-submissions/${submission.id}/analyze`;
    expect((await app.inject({method:'POST',url,headers:teacher.headers,payload:{}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url,headers:peer.headers,payload:{consent:true}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url,headers:outsider.headers,payload:{consent:true}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url,headers:teacher.headers,payload:{consent:true}})).statusCode).toBe(409);
    expect((await db.query('SELECT id FROM source_analyses WHERE project_id=$1',[source.id])).rows).toHaveLength(0);
  });
});
