import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {zipSync, strToU8} from 'fflate';
import {createApp} from '../apps/api/src/app';
import {migrate} from '../apps/api/src/db';
import {seed} from '../apps/api/src/seed';
import {sourceWorkerTick} from '../apps/api/src/source-projects';
import {sourceExecutionSnapshot} from '../apps/api/src/source-execution';
import {digest} from '../apps/api/src/auth';
import {importSourceZip} from '../apps/api/src/source-zip';
import type {SummaryProviderV2} from '../apps/api/src/model-provider-v2';
import {isolatedTestDB, type IsolatedTestDatabase} from './isolated-db';

describe('save before analysis and explicit billing identity', () => {
  let db: IsolatedTestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let headers: Record<string, string>;
  let teacherId: string;
  let studentId: string;
  const password = 'source-save-test-password-9368';
  const origin = 'http://localhost:5173';
  beforeAll(async () => {
    db = await isolatedTestDB();
    await migrate(db);
    await seed(db, password);
    teacherId = (await db.query("SELECT id FROM users WHERE role='teacher' LIMIT 1")).rows[0].id;
    studentId = (await db.query("SELECT id FROM users WHERE role='student' LIMIT 1")).rows[0].id;
    app = await createApp(db, {origin, secure:false, model:'fixture', image:'fixture', executionApproved: false, businessVersion: 2});
    const login = await app.inject({method:'POST',url:'/api/v1/session/login',headers:{origin},payload:{email:'student@codelab.local',password}});
    expect(login.statusCode).toBe(200);
    headers = {origin, cookie:login.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token':login.json().csrf};
  });
  afterAll(async () => {await app?.close(); await db?.close();});
  const source = {'课程项目/main.py':strToU8('print("hello")\n'.repeat(300)), '课程项目/README.md':strToU8('一个普通 Python 项目，不依赖课程模板。')};
  function upload(analyze: string, level: 0|6 = 6) {
    const boundary = 'source-save-test-boundary';
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="project.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(zipSync(source, {level})), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return app.inject({method:'POST',url:`/api/v2/projects?analyze=${analyze}`,headers:{...headers,'content-type':`multipart/form-data; boundary=${boundary}`},payload});
  }
  it('saves a non-template project with no API Key and no queued analysis', async () => {
    const response = await upload('false');
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({saved:true,analysisId:null,reused:false});
    expect((await db.query('SELECT id FROM source_analyses')).rows).toHaveLength(0);
    const detail = await app.inject({method:'GET',url:`/api/v2/projects/${response.json().id}`,headers});
    expect(detail.json()).toMatchObject({available:false,analyses:[]});
    expect(detail.json().files.map((f: any) => f.path)).toContain('课程项目/main.py');
  });
  it('reuses identical source even when the ZIP compression is different', async () => {
    const response = await upload('false', 0);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({saved:true,analysisId:null,reused:true});
    expect((await db.query('SELECT id FROM source_projects WHERE owner_id=$1',[studentId])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM source_analyses')).rows).toHaveLength(0);
  });
  it('requires a configured model only when analysis is requested', async () => {
    const response = await upload('true');
    expect(response.statusCode).toBe(409);
    expect((await db.query('SELECT id FROM source_analyses')).rows).toHaveLength(0);
    expect((await upload('perhaps')).statusCode).toBe(400);
  });
  it('accepts common language and build files without a framework template', async () => {
    const paths = ['mobile/lib/main.dart','stats/model.r','api/lib/app.ex','service/Main.kt','web/index.astro','db/schema.prisma','go.mod','CMakeLists.txt','scripts/setup.ps1'];
    const imported = await importSourceZip(Buffer.from(zipSync(Object.fromEntries(paths.map(path => [path,strToU8('source text\n')])))));
    expect(Object.keys(imported.files).sort()).toEqual(paths.sort());
    expect(imported.omitted).toEqual([]);
  });
  it('the worker resolves the explicit teacher payer and never the student owner', async () => {
    const projectId = (await db.query('SELECT id FROM source_projects WHERE owner_id=$1',[studentId])).rows[0].id;
    const provider: SummaryProviderV2 = {
      configuration:{provider:'fixture',model:'fixture',endpoint:'http://fixture'},
      complete: vi.fn(async () => {throw new Error('FIXTURE_MODEL_STOP');}),
    };
    const analysisId = randomUUID();
    await db.query("INSERT INTO source_analyses(id,project_id,status,analysis_options,execution_snapshot,billing_user_id) VALUES($1,$2,'queued',$3,$4,$5)",
      [analysisId,projectId,JSON.stringify({version:1,mode:'quick',modules:[]}),JSON.stringify(sourceExecutionSnapshot(provider)),teacherId]);
    const owners: string[] = [];
    await sourceWorkerTick(db, async userId => {owners.push(userId); return provider;}, new AbortController().signal);
    expect(owners.length).toBeGreaterThan(0);
    expect(new Set(owners)).toEqual(new Set([teacherId]));
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect((await db.query('SELECT status FROM source_analyses WHERE id=$1',[analysisId])).rows[0].status).toBe('failed');
    await expect(db.query('UPDATE source_analyses SET billing_user_id=$2 WHERE id=$1',[analysisId,studentId])).rejects.toThrow('immutable source billing identity');
  });
});

describe('analysis intent and delegated billing integration', () => {
  let db: IsolatedTestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let teacherId: string, studentId: string, classId: string;
  let teacherHeaders: Record<string,string>, studentHeaders: Record<string,string>;
  const origin = 'http://localhost:5173', password = 'delegated-source-tests-23794';
  const provider: SummaryProviderV2 = {
    configuration:{provider:'fixture',model:'deepseek-flash',endpoint:'https://api.deepseek.com',credentialRevision:randomUUID()},
    complete:vi.fn(async () => {throw new Error('NO_MODEL_CALL_EXPECTED');}),
  };
  beforeAll(async () => {
    db = await isolatedTestDB();
    await migrate(db);
    await seed(db,password);
    teacherId = (await db.query("SELECT id FROM users WHERE role='teacher' LIMIT 1")).rows[0].id;
    studentId = (await db.query("SELECT id FROM users WHERE role='student' LIMIT 1")).rows[0].id;
    classId = (await db.query('SELECT id FROM classes WHERE teacher_id=$1',[teacherId])).rows[0].id;
    // Hold the worker on an isolated sentinel so endpoint assertions concern only
    // queue intent. No fixture queues may race a background model invocation.
    const sentinel = await source(teacherId,'sentinel');
    await db.query("INSERT INTO source_analyses(id,project_id,status,deadline) VALUES($1,$2,'running',now()+interval '1 hour')",[randomUUID(),sentinel]);
    app = await createApp(db,{origin,secure:false,model:'fixture',image:'fixture',executionApproved:false,businessVersion:2,sourceProvider:provider});
    async function login(email: string) {
      const response = await app.inject({method:'POST',url:'/api/v1/session/login',headers:{origin},payload:{email,password}});
      expect(response.statusCode).toBe(200);
      return {origin,cookie:response.headers['set-cookie']!.toString().split(';')[0],'x-csrf-token':response.json().csrf};
    }
    teacherHeaders = await login('teacher@codelab.local');
    studentHeaders = await login('student@codelab.local');
  });
  afterAll(async () => {await app?.close(); await db?.close();});
  async function source(owner: string, signature: string) {
    const id = randomUUID();
    await db.query('INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,$3,$4,$5,$6)',
      [id,owner,signature,digest(id),JSON.stringify({'main.py':`print(${JSON.stringify(signature)})`}), '[]']);
    return id;
  }
  function upload(signature: string, query = 'analyze=true') {
    const boundary = 'analysis-intent-boundary';
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(zipSync({'main.py':strToU8(`print(${JSON.stringify(signature)})`)})),Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return app.inject({method:'POST',url:`/api/v2/projects?${query}`,headers:{...studentHeaders,'content-type':`multipart/form-data; boundary=${boundary}`},payload});
  }
  async function submit(projectId: string) {
    const task = await app.inject({method:'POST',url:'/api/v2/tasks',headers:{...teacherHeaders,'idempotency-key':randomUUID()},
      payload:{classId,title:'计费边界实训',description:'公开源码用于同班评阅',kind:'project'}});
    expect(task.statusCode,task.body).toBe(201);
    const response = await app.inject({method:'POST',url:`/api/v2/project-tasks/${task.json().taskId}/submissions`,
      headers:{...studentHeaders,'idempotency-key':randomUUID()},payload:{projectId,shareWithClass:true}});
    expect(response.statusCode,response.body).toBe(201);
    return response.json().submission.id as string;
  }
  async function successful(projectId: string, payer: string, tokens: number) {
    const id = randomUUID(), snapshot = sourceExecutionSnapshot(provider);
    const report = {report:{overview:'共享项目导读',stack:[],modules:[],flows:[],findings:[],readingPath:[],limitations:[]},
      coverage:{indexedFiles:1,readFiles:1,readLines:1},read:{'main.py':{start:1,end:1}},sourceMap:[],
      model:{name:'PRIVATE_MODEL_NAME',calls:[{requestId:'PRIVATE_MODEL_RECEIPT'}]},
      analysisOptions:{cost:{label:'PRIVATE_PRICE_POLICY'}},
      context:{policy:{private:'PRIVATE_MODEL_CAPACITY'},callsWithUsage:1,callsWithoutUsage:0,knownInputTokens:tokens,knownOutputTokens:tokens},costReuseVersion:1};
    await db.query("INSERT INTO source_analyses(id,project_id,status,billing_user_id,analysis_options,execution_snapshot,report) VALUES($1,$2,'succeeded',$3,$4,$5,$6)",
      [id,projectId,payer,JSON.stringify({version:1,mode:'quick',modules:[],cost:{inputPerMillion:2,outputPerMillion:8,label:'PRIVATE_PRICE_POLICY'}}),JSON.stringify(snapshot),JSON.stringify(report)]);
    return {id,report,snapshot};
  }

  it('deduplicates stored source without discarding explicit first analysis, scope changes or failed retries', async () => {
    const signature = randomUUID();
    const saved = await upload(signature,'analyze=false');
    expect(saved.statusCode,saved.body).toBe(201);
    expect(saved.json()).toMatchObject({analysisId:null,analysisDisposition:'not_requested'});
    const first = await upload(signature,'analyze=true&mode=deep');
    expect(first.statusCode,first.body).toBe(201);
    expect(first.json()).toMatchObject({id:saved.json().id,reused:true,analysisDisposition:'queued',analysisReused:false});
    const retry = await upload(signature,'analyze=true&mode=deep');
    expect(retry.json()).toMatchObject({analysisId:first.json().analysisId,analysisDisposition:'active',analysisReused:false});
    expect((await upload(signature,'analyze=true&mode=quick')).statusCode).toBe(409);
    await db.query("UPDATE source_analyses SET status='failed',code='FIXTURE_FAILURE' WHERE id=$1",[first.json().analysisId]);
    const afterFailure = await upload(signature,'analyze=true&mode=deep');
    expect(afterFailure.json()).toMatchObject({id:saved.json().id,analysisDisposition:'queued'});
    expect(afterFailure.json().analysisId).not.toBe(first.json().analysisId);
    expect((await upload(signature,'analyze=false')).json()).toMatchObject({analysisId:null,analysisDisposition:'not_requested'});
    expect((await db.query('SELECT id FROM source_analyses WHERE project_id=$1',[saved.json().id])).rows).toHaveLength(2);
  });

  it('reuses only successful reports with compatible scope and queue-time model configuration', async () => {
    const signature = randomUUID(), projectId = await source(studentId,signature);
    const previous = await successful(projectId,studentId,11);
    const reused = await upload(signature,'analyze=true&mode=quick');
    expect(reused.statusCode,reused.body).toBe(201);
    expect(reused.json()).toMatchObject({id:projectId,analysisId:previous.id,analysisDisposition:'reused',analysisReused:true});
    const deep = await upload(signature,'analyze=true&mode=deep');
    expect(deep.json()).toMatchObject({id:projectId,analysisDisposition:'queued'});
    expect(deep.json().analysisId).not.toBe(previous.id);
    await db.query("UPDATE source_analyses SET status='cancelled' WHERE id=$1",[deep.json().analysisId]);
    const oldModel = provider.configuration.model;
    try {
      provider.configuration.model = 'other-fixture-model';
      const changed = await upload(signature,'analyze=true&mode=quick');
      expect(changed.statusCode,changed.body).toBe(201);
      expect(changed.json().analysisDisposition).toBe('queued');
      expect(changed.json().analysisId).not.toBe(previous.id);
    } finally {provider.configuration.model = oldModel;}
  });

  it('validates incremental baselines even when the uploaded source already exists', async () => {
    const signature = randomUUID(), projectId = await source(studentId,signature);
    const otherOwnersProject = await source(teacherId,'private teacher project');
    expect((await upload(signature,`analyze=true&incrementalFrom=${otherOwnersProject}`)).statusCode).toBe(404);
    expect((await upload(signature,`analyze=true&incrementalFrom=${projectId}`)).statusCode).toBe(409);
    expect((await db.query('SELECT id FROM source_analyses WHERE project_id=$1',[projectId])).rows).toHaveLength(0);
    const baseline = await source(studentId,'previous source');
    const result = await upload(signature,`analyze=true&incrementalFrom=${baseline}`);
    expect(result.statusCode,result.body).toBe(201);
    expect((await db.query('SELECT analysis_options FROM source_analyses WHERE id=$1',[result.json().analysisId])).rows[0].analysis_options.incrementalFrom).toBe(baseline);
  });

  it('hides teacher model and billing details from the student project owner while preserving shared reading evidence', async () => {
    const projectId = await source(studentId,'shared privacy project');
    const teacherAnalysis = await successful(projectId,teacherId,9999);
    const ownAnalysis = await successful(projectId,studentId,25);
    const detail = await app.inject({url:`/api/v2/projects/${projectId}`,headers:studentHeaders});
    expect(detail.statusCode).toBe(200);
    const shared = detail.json().analyses.find((item: any) => item.id === teacherAnalysis.id);
    expect(shared).toMatchObject({shared:true,canCancel:false,report:{report:teacherAnalysis.report.report,coverage:teacherAnalysis.report.coverage}});
    for (const field of ['execution_snapshot','billing_user_id','costSummary','modelUsage']) expect(shared).not.toHaveProperty(field);
    expect(JSON.stringify(shared)).not.toContain('PRIVATE_');
    const own = detail.json().analyses.find((item: any) => item.id === ownAnalysis.id);
    expect(own.execution_snapshot).toEqual(ownAnalysis.snapshot);
    expect(own.report.context.knownInputTokens).toBe(25);
    expect(own).toHaveProperty('costSummary');
    const studentCosts = await app.inject({method:'POST',url:'/api/v2/source-cost-preview',headers:studentHeaders,payload:{mode:'quick'}});
    const teacherCosts = await app.inject({method:'POST',url:'/api/v2/source-cost-preview',headers:teacherHeaders,payload:{mode:'quick'}});
    expect(studentCosts.json().historicalRange.max).toBeLessThan(teacherCosts.json().historicalRange.min);
    expect(teacherCosts.json().historicalRange.samples).toBe(1);
  });

  it('preserves the initiating payer and scope and permits only that payer to cancel course analysis', async () => {
    const projectId = await source(studentId,'course payer boundary'), submissionId = await submit(projectId);
    const analyzeUrl = `/api/v2/project-submissions/${submissionId}/analyze`;
    const start = await app.inject({method:'POST',url:analyzeUrl,headers:teacherHeaders,payload:{consent:true,options:{mode:'quick'}}});
    expect(start.statusCode,start.body).toBe(200);
    expect(start.json()).toMatchObject({payerId:teacherId,analysisDisposition:'queued'});
    const analysisId = start.json().analysisId;
    const same = await app.inject({method:'POST',url:analyzeUrl,headers:teacherHeaders,payload:{consent:true,options:{mode:'quick'}}});
    expect(same.json()).toMatchObject({analysisId,active:true});
    expect((await app.inject({method:'POST',url:analyzeUrl,headers:teacherHeaders,payload:{consent:true,options:{mode:'deep'}}})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:analyzeUrl,headers:studentHeaders,payload:{consent:true,options:{mode:'quick'}}})).statusCode).toBe(409);
    const detailUrl = `/api/v2/project-submissions/${submissionId}`;
    expect((await app.inject({url:detailUrl,headers:teacherHeaders})).json().pendingAnalysis.canCancel).toBe(true);
    expect((await app.inject({url:detailUrl,headers:studentHeaders})).json().pendingAnalysis.canCancel).toBe(false);
    expect((await app.inject({url:`/api/v2/projects/${projectId}`,headers:studentHeaders})).json().analyses[0].canCancel).toBe(false);
    expect((await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/cancel`,headers:studentHeaders,payload:{analysisId}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:`/api/v2/project-submissions/${submissionId}/cancel`,headers:studentHeaders,payload:{analysisId}})).statusCode).toBe(403);
    const cancelled = await app.inject({method:'POST',url:`/api/v2/project-submissions/${submissionId}/cancel`,headers:teacherHeaders,payload:{analysisId}});
    expect(cancelled.statusCode,cancelled.body).toBe(200);
    expect((await db.query('SELECT status,billing_user_id FROM source_analyses WHERE id=$1',[analysisId])).rows[0]).toEqual({status:'cancelled',billing_user_id:teacherId});
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
