import { randomUUID } from "node:crypto";
import {unzipSync} from 'fflate';
import { StorageAdmissionError } from '../apps/runner/src/storage-admission';
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "../apps/api/node_modules/fastify";
import { createApp, type Config } from "../apps/api/src/app";
import { hashPassword } from "../apps/api/src/auth";
import { createPackCatalog } from "../apps/api/src/catalog-v2";
import { migrate, type DB } from "../apps/api/src/db";
import { seed } from "../apps/api/src/seed";
import { root, templateFiles, hashTemplateFiles } from "../apps/api/src/template";
import {
  createDevelopmentPack,
  sha256,
  type TaskPackManifest,
} from "../packages/contracts/src/v2/index";
import { testDB } from "./db";

// All database/manifest evidence in this file is ui_fixture. No checker is run.
const source = "ui_fixture";
const origin = "http://localhost:5173";
const password = "Only-for-api-v2-tests-2904!";
type Session = {
  cookie: string;
  csrf: string;
  user: { id: string; role: string };
};
let db: DB;
let app: FastifyInstance;
let pack: TaskPackManifest;
let teacher: Session;
let student: Session;
let peer: Session;
let outsider: Session;
let taskId: string;
let ruleId: string;
let zip: Buffer;
const openApps: FastifyInstance[] = [];
const baseConfig = {
  origin,
  secure: false,
  executionApproved: true,
  model: "ui_fixture",
  image: "ui_fixture-not-an-image",
};

it('pages more than 200 submissions without timestamp ties leaking or losing another student history', async () => {
  const pagedTask=randomUUID(), pagedRule=randomUUID();
  await db.query(`INSERT INTO tasks(id,class_id,title,description) SELECT $1,class_id,'pagination fixture','fixture' FROM tasks WHERE id=$2`,[pagedTask,taskId]);
  await db.query(`INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
    SELECT $1::uuid,$2,1,template_version,criteria,2,rule_snapshot,$1::text,request_hash FROM rules WHERE id=$3`,[pagedRule,pagedTask,ruleId]);
  const ids=Array.from({length:205},()=>randomUUID()).sort();
  const insert=async(values:string[],owner:string,time:string)=>db.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256,created_at)
    SELECT value::uuid,$2,$3,$4,$5,'{}',value,2,'{"version":1,"files":[]}',$5,$6::timestamptz FROM jsonb_array_elements_text($1::jsonb)`,
    [JSON.stringify(values),pagedTask,owner,pagedRule,'a'.repeat(64),time]);
  await insert(ids,student.user.id,'2026-09-27T00:00:00.123456Z');
  const other=randomUUID();await insert([other],peer.user.id,'2026-09-27T00:00:00.123456Z');
  const get=(who:Session,after?:string)=>app.inject({url:`/api/v2/tasks/${pagedTask}/submissions${after?'?after='+after:''}`,headers:headers(who)});
  const first=await get(student);expect(first.statusCode).toBe(200);
  expect(first.json().total).toBe(205);expect(first.json().items.map((i:any)=>i.submissionId)).toEqual(ids.slice(0,200));
  // A newer insertion must not shift the older-page boundary.
  await insert([randomUUID()],student.user.id,'2026-09-28T00:00:00Z');
  const second=await get(student,first.json().nextCursor);
  expect(second.json().items.map((i:any)=>i.submissionId)).toEqual(ids.slice(200));
  expect(second.json().nextCursor).toBeNull();expect(second.json().total).toBe(206);
  expect((await get(student,other)).statusCode).toBe(400);
  expect((await get(student,'invalid')).statusCode).toBe(400);
  expect((await get(peer)).json().total).toBe(1);
  expect((await get(teacher)).json().total).toBe(207);
  expect((await get(outsider)).statusCode).toBe(404);
});

it('pages task history with exact timestamp ties and scoped cursors',async()=>{
  const ids=Array.from({length:205},()=>randomUUID()).sort();
  const get=(who:Session,after?:string)=>app.inject({url:'/api/v2/tasks'+(after?'?after='+after:''),headers:headers(who)});
  const before=(await get(teacher)).json().total;
  try{
    await db.query(`INSERT INTO tasks(id,class_id,title,description,created_at)
      SELECT value::uuid,t.class_id,'paged task','fixture','2099-01-01T00:00:00.123456Z'::timestamptz
      FROM tasks t CROSS JOIN jsonb_array_elements_text($1::jsonb) WHERE t.id=$2`,[JSON.stringify(ids),taskId]);
    const first=(await get(teacher)).json();
    expect(first.total).toBe(before+205);
    expect(first.items.map((t:any)=>t.taskId)).toEqual(ids.slice(0,200));
    const second=(await get(teacher,first.nextCursor)).json();
    expect(second.items.slice(0,5).map((t:any)=>t.taskId)).toEqual(ids.slice(200));
    expect((await get(student,first.nextCursor)).statusCode).toBe(200);
    expect((await get(outsider,first.nextCursor)).statusCode).toBe(400);
    expect((await get(outsider)).json()).toMatchObject({total:0,items:[],nextCursor:null});
    expect((await get(teacher,'bad')).statusCode).toBe(400);
  }finally{await db.query('DELETE FROM tasks WHERE id=ANY($1::uuid[])',[ids]);}
});

it('reads all historical rule snapshots with stable version pagination and task access',async()=>{
  const task=randomUUID();
  await db.query(`INSERT INTO tasks(id,class_id,title,description) SELECT $1,class_id,'rule history fixture','fixture' FROM tasks WHERE id=$2`,[task,taskId]);
  const original=(await db.query('SELECT rule_snapshot FROM rules WHERE id=$1',[ruleId])).rows[0].rule_snapshot;
  const add=async(version:number)=>{
    const id=randomUUID(),snapshot={...original,ruleId:id,taskId:task,version};
    await db.query(`INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
      VALUES($1,$2,$3,'vue-board-v1','[]',2,$4,$5,$6)`,[id,task,version,JSON.stringify(snapshot),randomUUID(),'a'.repeat(64)]);
  };
  for(let version=1;version<=102;version++)await add(version);
  const get=(session:Session,before?:number)=>app.inject({url:`/api/v2/tasks/${task}/rules${before?'?beforeVersion='+before:''}`,headers:headers(session)});
  const first=await get(teacher);expect(first.statusCode).toBe(200);
  expect(first.json().items).toHaveLength(100);expect(first.json().nextBeforeVersion).toBe(3);
  await add(103);
  const second=await get(teacher,3);
  expect(second.json().items.map((item:any)=>item.version)).toEqual([2,1]);expect(second.json().nextBeforeVersion).toBe(null);
  expect((await get(student)).json().items[0].version).toBe(103);
  expect((await get(outsider)).statusCode).toBe(404);
  expect((await app.inject({url:`/api/v2/tasks/${task}/rules?beforeVersion=0`,headers:headers(teacher)})).statusCode).toBe(400);
});

it('binds template downloads to an authorized rule and rejects unavailable template submissions',async()=>{
  const task=randomUUID(),first=randomUUID(),second=randomUUID();
  await db.query(`INSERT INTO tasks(id,class_id,title,description) SELECT $1,class_id,'template fixture','fixture' FROM tasks WHERE id=$2`,[task,taskId]);
  const original=(await db.query('SELECT rule_snapshot FROM rules WHERE id=$1',[ruleId])).rows[0].rule_snapshot;
  const add=async(id:string,version:number,template:string,hash=original.packManifest.templateHash)=>{
    const snapshot={...original,ruleId:id,taskId:task,version,packManifest:{...original.packManifest,templateVersion:template,templateHash:hash}};
    await db.query(`INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
      VALUES($1::uuid,$2,$3,$4,'[]',2,$5,$1::text,$6)`,[id,task,version,template,JSON.stringify(snapshot),'a'.repeat(64)]);
  };
  await add(first,1,'vue-board-v1');
  const detail=await app.inject({url:`/api/v2/tasks/${task}`,headers:headers(student)});
  expect(detail.json().template).toMatchObject({available:true,downloadUrl:`/api/v2/tasks/${task}/template?ruleId=${first}`});
  await add(second,2,'not-deployed-template');
  const download=await app.inject({url:detail.json().template.downloadUrl,headers:headers(student)});
  expect(download.statusCode).toBe(200);expect(Object.keys(unzipSync(download.rawPayload))).toContain('package.json');
  expect((await app.inject({url:`/api/v2/tasks/${task}/template`,headers:headers(student)})).statusCode).toBe(409);
  expect((await app.inject({url:`/api/v2/tasks/${task}/template?ruleId=${ruleId}`,headers:headers(student)})).statusCode).toBe(404);
  expect((await app.inject({url:detail.json().template.downloadUrl,headers:headers(outsider)})).statusCode).toBe(404);
  const rejected=await upload({targetTask:task,selectedRule:second});expect(rejected.statusCode).toBe(409);
  expect((await db.query('SELECT id FROM submissions WHERE task_id=$1',[task])).rows).toHaveLength(0);
  expect(hashTemplateFiles(unzipSync(download.rawPayload))).toBe(original.packManifest.templateHash);
  const drifted=randomUUID();await add(drifted,3,'vue-board-v1','0'.repeat(64));
  expect((await app.inject({url:`/api/v2/tasks/${task}`,headers:headers(student)})).json().template.available).toBe(false);
  const wrong=await app.inject({url:`/api/v2/tasks/${task}/template?ruleId=${drifted}`,headers:headers(student)});
  expect(wrong.statusCode).toBe(409);expect(wrong.json().error.code).toBe('TEMPLATE_INTEGRITY_MISMATCH');
  const badUpload=await upload({targetTask:task,selectedRule:drifted});
  expect(badUpload.statusCode).toBe(409);expect(badUpload.json().error.code).toBe('TEMPLATE_INTEGRITY_MISMATCH');
  expect((await db.query('SELECT id FROM submissions WHERE task_id=$1',[task])).rows).toHaveLength(0);
});

it('scopes task overview to the owner and keeps a saved submission distinct from a run', async () => {
  const own = await upload();
  const other = await upload({session:peer});
  expect(own.statusCode).toBe(201);
  expect(other.statusCode).toBe(201);
  async function overview(session: Session) {
    const response = await app.inject({url:'/api/v2/tasks',headers:headers(session)});
    expect(response.statusCode).toBe(200);
    return response.json().items;
  }
  const ownTask = (await overview(student)).find((t:any)=>t.taskId===taskId);
  expect(ownTask.overview.latestSubmission).toMatchObject({submissionId:own.json().submissionId,status:'saved',runId:null});
  expect(ownTask.overview.latestPublication).toBeNull();
  expect(JSON.stringify(ownTask)).not.toContain(other.json().submissionId);
  expect(ownTask.overview).not.toHaveProperty('pendingReviews');
  expect((await overview(peer)).find((t:any)=>t.taskId===taskId).overview.latestSubmission.submissionId).toBe(other.json().submissionId);
  const teacherTask = (await overview(teacher)).find((t:any)=>t.taskId===taskId);
  expect(teacherTask.overview).toEqual({submittedStudents:2,pendingReviewCount:0,pendingReviews:[]});
  expect(await overview(outsider)).toEqual([]);
});

it('persists the service-selected initial analysis mode through the public run API', async () => {
  const target = await makeApp({ initialAnalysisMode: 'summary' });
  const submitted = await upload({ target });
  expect(submitted.statusCode).toBe(201);
  const created = await enqueue(submitted.json().submissionId, { target });
  expect(created.statusCode).toBe(202);
  expect((await db.query('SELECT execution_config FROM runs WHERE id=$1', [created.json().runId])).rows[0].execution_config.initialAnalysisMode).toBe('summary');
});

it('blocks new uploads under low capacity while preserving upload replay and reads', async () => {
  let blocked = false;
  const target = await makeApp({ storageAdmission: async () => {
    if (blocked) throw new StorageAdmissionError('STORAGE_CAPACITY_LOW');
  } });
  const key = randomUUID();
  const original = await upload({ target, key });
  expect(original.statusCode).toBe(201);
  const runKey = randomUUID(), submissionId = original.json().submissionId;
  const run = await enqueue(submissionId, { target, key: runKey });
  expect(run.statusCode).toBe(202);
  blocked = true;
  expect((await enqueue(submissionId, { target, key: runKey })).statusCode).toBe(200);
  expect((await enqueue(submissionId, { target })).statusCode).toBe(503);
  expect((await target.inject({ method: 'POST', url: `/api/v2/runs/${run.json().runId}/cancel`,
    headers: { ...headers(student), 'idempotency-key': randomUUID() }, payload: {} })).statusCode).toBe(200);
  const replay = await upload({ target, key });
  expect(replay.statusCode).toBe(200);
  expect(replay.json().submissionId).toBe(original.json().submissionId);
  const denied = await upload({ target });
  expect(denied.statusCode).toBe(503);
  expect(denied.json().error.code).toBe('STORAGE_CAPACITY_LOW');
  const reads = await target.inject({ method: 'GET', url: `/api/v2/tasks/${taskId}/submissions`, headers: headers(student) });
  expect(reads.statusCode).toBe(200);
});

async function makeApp(overrides: Partial<Config> = {}) {
  const value = await createApp(db, {
    ...baseConfig,
    businessVersion: 2,
    packs: [pack],
    ...overrides,
  });
  openApps.push(value);
  return value;
}
async function login(email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/session/login",
    headers: { origin },
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
    csrf: response.json().csrf,
    user: response.json().user,
  } as Session;
}
const headers = (session: Session) => ({
  cookie: session.cookie,
  origin,
  "x-csrf-token": session.csrf,
});
function ruleBody() {
  return {
    packId: pack.packId,
    packVersion: pack.packVersion,
    packManifestHash: pack.contentHash,
    enabledCriterionIds: ["create"],
    parameterValues: {},
    confirmed: true,
  };
}
function publish(
  target = app,
  body: unknown = ruleBody(),
  key = randomUUID(),
  session = teacher,
) {
  return target.inject({
    method: "POST",
    url: `/api/v2/tasks/${taskId}/rules`,
    headers: { ...headers(session), "idempotency-key": key },
    payload: body as any,
  });
}
function upload({
  target = app,
  session = student,
  key = randomUUID(),
  bytes = zip,
  selectedRule = ruleId,
  targetTask = taskId,
}: {
  target?: FastifyInstance;
  session?: Session;
  key?: string;
  bytes?: Buffer;
  selectedRule?: string;
  targetTask?: string;
} = {}) {
  const boundary = "codelab-v2-fixture-boundary";
  return target.inject({
    method: "POST",
    url: `/api/v2/tasks/${targetTask}/submissions`,
    headers: {
      ...headers(session),
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "idempotency-key": key,
      "x-rule-id": selectedRule,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ui_fixture.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
function enqueue(
  submissionId: string,
  {
    target = app,
    session = student,
    key = randomUUID(),
    body = {},
  }: {
    target?: FastifyInstance;
    session?: Session;
    key?: string;
    body?: object;
  } = {},
) {
  return target.inject({
    method: "POST",
    url: `/api/v2/submissions/${submissionId}/runs`,
    headers: { ...headers(session), "idempotency-key": key },
    payload: body,
  });
}
function cancel(
  runId: string,
  session = student,
  key = randomUUID(),
  body: object = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v2/runs/${runId}/cancel`,
    headers: { ...headers(session), "idempotency-key": key },
    payload: body,
  });
}
async function newSubmission(session = student) {
  const response = await upload({ session });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().submissionId as string;
}
async function newRun(session = student) {
  const submissionId = await newSubmission(session);
  const response = await enqueue(submissionId, { session });
  expect(response.statusCode, response.body).toBe(202);
  return { submissionId, runId: response.json().runId as string };
}

beforeAll(async () => {
  db = await testDB();
  await migrate(db);
  await seed(db, password);
  // Deliberately synthetic descriptor identities. Only API semantics are tested.
  pack = await createDevelopmentPack("new-only", {
    packVersion: "ui-fixture-v1",
    templateVersion: "vue-board-v1",
    templateHash: hashTemplateFiles(await templateFiles()),
    dependencyLockHash: await sha256(`${source}:not-a-measured-lock`),
    initializationVersion: "ui-fixture-initialization",
    caseImplementationHashes: {
      "NEW-01": await sha256(`${source}:not-an-executed-checker`),
    },
  });
  const task = (await db.query("SELECT id,class_id FROM tasks LIMIT 1"))
    .rows[0];
  taskId = task.id;
  for (const [email, role, member] of [
    ["peer-v2@example.test", "student", true],
    ["outsider-v2@example.test", "teacher", false],
  ] as const) {
    const userId = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)",
      [userId, email, source, role, hashPassword(password)],
    );
    if (member)
      await db.query(
        "INSERT INTO memberships(class_id,user_id) VALUES($1,$2)",
        [task.class_id, userId],
      );
  }
  zip = await readFile(path.join(root, "fixtures/correct.zip"));
  app = await makeApp();
  teacher = await login("teacher@codelab.local");
  student = await login("student@codelab.local");
  peer = await login("peer-v2@example.test");
  outsider = await login("outsider-v2@example.test");
  const firstRule = await publish();
  expect(firstRule.statusCode, firstRule.body).toBe(201);
  ruleId = firstRule.json().rule.ruleId;
}, 60000);
afterAll(async () => {
  for (const value of openApps) await value.close();
  await db?.close();
});

describe("v2 task catalog and immutable rules (ui_fixture)", () => {
  it("creates a task before a rule, with scoped idempotency and teacher authorization", async () => {
    const classId = randomUUID();
    await db.query(
      "INSERT INTO classes(id,name,teacher_id) VALUES($1,'ui_fixture empty classroom',$2)",
      [classId, teacher.user.id],
    );
    const key = randomUUID(),
      body = {
        classId,
        title: "ui_fixture first task",
        description: "Create first, publish rules separately",
      };
    const create = (payload: unknown = body, session = teacher) =>
      app.inject({
        method: "POST",
        url: "/api/v2/tasks",
        headers: { ...headers(session), "idempotency-key": key },
        payload: payload as any,
      });
    const created = await create();
    expect(created.statusCode, created.body).toBe(201);
    const replay = await create();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());
    expect((await create({ ...body, title: "different" })).statusCode).toBe(
      409,
    );
    expect((await create(body, outsider)).statusCode).toBe(404);
    expect((await create(body, student)).statusCode).toBe(403);
    expect((await create({ ...body, criteria: [] })).statusCode).toBe(400);
    const detail = await app.inject({
      url: `/api/v2/tasks/${created.json().taskId}`,
      headers: headers(teacher),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().currentRule).toBeNull();
    const unpublishedList = await app.inject({url:'/api/v2/tasks',headers:headers(teacher)});
    expect(unpublishedList.json().items.find((t:any)=>t.taskId===created.json().taskId).ruleScope).toBeNull();
    const first = await app.inject({
      method: "POST",
      url: `/api/v2/tasks/${created.json().taskId}/rules`,
      headers: { ...headers(teacher), "idempotency-key": randomUUID() },
      payload: ruleBody(),
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().rule.version).toBe(1);
  });

  it("requires the existing session, origin and CSRF protections with structured v2 errors", async () => {
    const anonymous = await app.inject(`/api/v2/tasks/${taskId}`);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.requestId).toBeTypeOf("string");
    const badCsrf = await app.inject({
      method: "POST",
      url: `/api/v2/tasks/${taskId}/rules`,
      headers: {
        cookie: teacher.cookie,
        origin,
        "idempotency-key": randomUUID(),
      },
      payload: ruleBody(),
    });
    expect(badCsrf.statusCode).toBe(403);
    expect(badCsrf.json().error.code).toBe("FORBIDDEN");
    const badOrigin = await app.inject({
      method: "POST",
      url: `/api/v2/tasks/${taskId}/rules`,
      headers: {
        ...headers(teacher),
        origin: "https://other.invalid",
        "idempotency-key": randomUUID(),
      },
      payload: ruleBody(),
    });
    expect(badOrigin.statusCode).toBe(403);
  });

  it("shows the selected v2 case scope without converting the existing legacy rule", async () => {
    const response = await app.inject({
      url: `/api/v2/tasks/${taskId}`,
      headers: headers(student),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.currentRule.requiredCaseIds).toEqual(["NEW-01"]);
    expect(body.rules.every((rule: any) => rule.contractVersion === 2)).toBe(
      true,
    );
    expect(body).not.toHaveProperty("availablePacks");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM rules WHERE task_id=$1 AND contract_version=1",
          [taskId],
        )
      ).rows[0].n,
    ).toBe(1);
    const list = await app.inject({
      url: "/api/v2/tasks",
      headers: headers(student),
    });
    expect(list.json().items.some((task: any) => task.taskId === taskId)).toBe(
      true,
    );
    const listed = list.json().items.find((task:any)=>task.taskId===taskId);
    expect(listed.ruleScope).toEqual({caseCount:1,criteria:body.currentRule.packManifest.criteria
      .filter((c:any)=>body.currentRule.enabledCriterionIds.includes(c.criterionId))
      .map((c:any)=>({criterionId:c.criterionId,title:c.title,mode:c.mode}))});
    expect(listed.ruleScope.criteria.some((c:any)=>c.criterionId==='filter')).toBe(false);
    expect(listed.ruleScope.criteria.map((c:any)=>c.criterionId)).toEqual(['create']);
  });

  it("keeps v2 writes closed before the business version switch", async () => {
    const legacyMode = await makeApp({ businessVersion: 1 });
    const response = await publish(legacyMode);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("BUSINESS_VERSION_DISABLED");
  });

  it("keeps account sessions working while blocking legacy business writes after the switch", async () => {
    const session = await app.inject({
      url: "/api/v1/session",
      headers: headers(teacher),
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.id).toBe(teacher.user.id);
    const legacyWrite = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/rules`,
      headers: headers(teacher),
      payload: {},
    });
    expect(legacyWrite.statusCode).toBe(409);
    expect(legacyWrite.json().error.code).toBe("CLIENT_UPGRADE_REQUIRED");
  });

  it("does not fabricate a task pack when the startup registry is empty", async () => {
    const emptyCatalog = await makeApp({ packs: [] });
    const response = await publish(emptyCatalog);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PACK_NOT_AVAILABLE");
  });

  it("rejects client manifests, unbounded fields and stale pack contents", async () => {
    const supplied = await publish(app, { ...ruleBody(), packManifest: pack });
    expect(supplied.statusCode).toBe(400);
    const naturalLanguage = await publish(app, {
      ...ruleBody(),
      instruction: "generate and execute any test",
    });
    expect(naturalLanguage.statusCode).toBe(400);
    const wrongHash = await publish(app, {
      ...ruleBody(),
      packManifestHash: "0".repeat(64),
    });
    expect(wrongHash.statusCode).toBe(409);
    expect(wrongHash.json().error.code).toBe("PACK_VERSION_CONFLICT");
    const wrongParameter = await publish(app, {
      ...ruleBody(),
      parameterValues: { arbitraryUrl: "https://example.invalid" },
    });
    expect(wrongParameter.statusCode).toBe(400);
  });

  it("publishes only for the owning teacher and authorizes before idempotent replay", async () => {
    const key = randomUUID();
    const accepted = await publish(app, ruleBody(), key);
    expect(accepted.statusCode).toBe(201);
    expect((await publish(app, ruleBody(), key, student)).statusCode).toBe(403);
    expect((await publish(app, ruleBody(), key, outsider)).statusCode).toBe(
      404,
    );
    const replay = await publish(app, ruleBody(), key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(accepted.json());
    const conflict = await publish(
      app,
      { ...ruleBody(), packVersion: "other-ui-fixture" },
      key,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    await expect(
      db.query("UPDATE rules SET rule_snapshot='{}' WHERE id=$1", [
        accepted.json().rule.ruleId,
      ]),
    ).rejects.toThrow("immutable");
  });

  it("freezes a cloned startup catalog and rejects mismatched or duplicate registrations", async () => {
    const input = structuredClone(pack);
    const catalog = await createPackCatalog([input]);
    const registered = catalog.get(input.packId, input.packVersion)!;
    input.criteria[0].title = "changed after startup";
    expect(registered.criteria[0].title).toBe(pack.criteria[0].title);
    expect(Object.isFrozen(registered.criteria[0])).toBe(true);
    await expect(createPackCatalog([input])).rejects.toThrow(
      "PACK_HASH_MISMATCH",
    );
    await expect(createPackCatalog([pack, pack])).rejects.toThrow(
      "DUPLICATE_PACK_VERSION",
    );
  });
});

describe("v2 submissions, queue and private status (ui_fixture)", () => {
  it("keeps the course ZIP limit at 10MB when ordinary source imports allow 100MB", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM submissions")).rows[0].n;
    const response = await upload({ bytes: Buffer.alloc(10 * 1024 * 1024 + 1) });
    expect(response.statusCode).toBe(413);
    expect((await db.query("SELECT count(*)::int AS n FROM submissions")).rows[0].n).toBe(before);
  });
  it("stores the explicit immutable rule and exact source identities without automatically queuing", async () => {
    const key = randomUUID();
    const accepted = await upload({ key });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({
      contractVersion: 2,
      ruleId,
      accepted: true,
      enqueueState: "not_requested",
    });
    const row = (
      await db.query("SELECT * FROM submissions WHERE id=$1", [
        accepted.json().submissionId,
      ])
    ).rows[0];
    expect(row.contract_version).toBe(2);
    expect(row.rule_id).toBe(ruleId);
    expect(row.sha256).toBe(accepted.json().originalZipSha256);
    expect(row.source_manifest.sourceManifestSha256).toBe(
      accepted.json().sourceManifestSha256,
    );
    expect(row.source_manifest_version).toBe("source-manifest-v1");
    expect(
      (await db.query("SELECT id FROM runs WHERE submission_id=$1", [row.id]))
        .rows,
    ).toEqual([]);
    const replay = await upload({ key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(accepted.json());
    const anotherRule = (await publish()).json().rule.ruleId;
    const conflict = await upload({ key, selectedRule: anotherRule });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects malformed ZIPs, missing or legacy rules and teacher submissions", async () => {
    expect((await upload({ bytes: Buffer.from("not a zip") })).statusCode).toBe(
      400,
    );
    expect((await upload({ selectedRule: "" })).statusCode).toBe(400);
    const legacyRule = (
      await db.query(
        "SELECT id FROM rules WHERE task_id=$1 AND contract_version=1",
        [taskId],
      )
    ).rows[0].id;
    expect((await upload({ selectedRule: legacyRule })).statusCode).toBe(404);
    expect((await upload({ session: teacher })).statusCode).toBe(403);
  });

  it("keeps an accepted submission when execution is disabled", async () => {
    const disabled = await makeApp({ executionApproved: false });
    const accepted = await upload({ target: disabled });
    expect(accepted.statusCode).toBe(201);
    const response = await enqueue(accepted.json().submissionId, {
      target: disabled,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("EXECUTION_DISABLED");
    expect(
      (
        await db.query("SELECT id FROM submissions WHERE id=$1", [
          accepted.json().submissionId,
        ])
      ).rows,
    ).toHaveLength(1);
  });

  it("queues once per authorized request and rejects another student's replay or changed retry reference", async () => {
    const submissionId = await newSubmission();
    const key = randomUUID();
    const accepted = await enqueue(submissionId, { key });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      contractVersion: 2,
      submissionId,
      status: "queued",
    });
    const replay = await enqueue(submissionId, { key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(accepted.json());
    expect(
      (await enqueue(submissionId, { key, session: peer })).statusCode,
    ).toBe(404);
    const changed = await enqueue(submissionId, {
      key,
      body: { retryOfRunId: randomUUID() },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      (await enqueue(submissionId, { body: { actorId: teacher.user.id } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await db.query(
          "SELECT contract_version FROM runs WHERE submission_id=$1",
          [submissionId],
        )
      ).rows,
    ).toEqual([{ contract_version: 2 }]);
    const teacherRequest = await enqueue(submissionId, {
      session: teacher,
      key,
    });
    expect(teacherRequest.statusCode).toBe(202);
    expect(teacherRequest.json().runId).not.toBe(accepted.json().runId);
  });

  it("cancels only queued work, replays cancellation, and never creates an execution attempt", async () => {
    const { runId } = await newRun();
    const key = randomUUID();
    const first = await cancel(runId, student, key);
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("cancelled");
    expect((await cancel(runId, student, key)).json()).toEqual(first.json());
    expect((await cancel(runId, peer, key)).statusCode).toBe(404);
    expect(
      (await cancel(runId, student, key, { ownerToken: "pretend" })).statusCode,
    ).toBe(400);
    expect(
      (
        await db.query("SELECT id FROM execution_attempts WHERE run_id=$1", [
          runId,
        ])
      ).rows,
    ).toEqual([]);
    const active = await newRun();
    await db.query("UPDATE runs SET status='preparing' WHERE id=$1", [
      active.runId,
    ]); // ui_fixture, no external runner.
    const response = await cancel(active.runId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("RUN_ALREADY_STARTED");
  });

  it("returns an allowlisted status, keeping source, drafts, evidence and ownership tokens private", async () => {
    const { runId } = await newRun();
    const secret = "ui_fixture-private-sentinel";
    await db.query(
      "UPDATE runs SET results=$2,evidence=$2,feedback=$2,execution_config=$3,lease_token=$4 WHERE id=$1",
      [
        runId,
        JSON.stringify([{ secret }]),
        JSON.stringify({ secret }),
        randomUUID(),
      ],
    );
    await db.query(
      `INSERT INTO analysis_attempts(id,run_id,mode,status,configuration,candidate)
      VALUES($1,$2,'reanalysis','queued',$3,$3)`,
      [randomUUID(), runId, JSON.stringify({ secret })],
    );
    const response = await app.inject({
      url: `/api/v2/runs/${runId}`,
      headers: headers(student),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(secret);
    expect(response.json()).toMatchObject({
      runId,
      status: "queued",
      analysis: { mode: "reanalysis", status: "queued" },
      report: { state: "unpublished", latestPublication: null },
    });
    for (const field of [
      "results",
      "evidence",
      "feedback",
      "files",
      "candidate",
      "lease_token",
      "leaseToken",
      "execution_config",
    ])
      expect(response.json()).not.toHaveProperty(field);
    expect(
      (
        await app.inject({
          url: `/api/v2/runs/${runId}`,
          headers: headers(peer),
        })
      ).statusCode,
    ).toBe(404);
    const denied = await app.inject({
      url: `/api/v2/runs/${runId}`,
      headers: headers(outsider),
    });
    const missing = await app.inject({
      url: `/api/v2/runs/${randomUUID()}`,
      headers: headers(outsider),
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.message).toBe(missing.json().error.message);
    const history = await app.inject({
      url: `/api/v2/tasks/${taskId}/submissions`,
      headers: headers(peer),
    });
    expect(history.statusCode).toBe(200);
    expect(
      history
        .json()
        .items.every((entry: any) => entry.studentId === peer.user.id),
    ).toBe(true);
    expect(
      (
        await app.inject({
          url: `/api/v2/runs/${runId}/review`,
          headers: headers(student),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/v2/runs/${runId}/evidence/${randomUUID()}`,
          headers: headers(student),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("does not expose v2 runs or submissions through the legacy read adapters", async () => {
    const { runId, submissionId } = await newRun();
    expect(
      (
        await app.inject({
          url: `/api/v1/runs/${runId}`,
          headers: headers(student),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/v1/runs/${runId}`,
          headers: headers(teacher),
        })
      ).statusCode,
    ).toBe(404);
    const history = await app.inject({
      url: `/api/v1/tasks/${taskId}/submissions`,
      headers: headers(student),
    });
    expect(history.statusCode).toBe(200);
    expect(
      history.json().items.some((entry: any) => entry.id === submissionId),
    ).toBe(false);
    const task = await app.inject({
      url: `/api/v1/tasks/${taskId}`,
      headers: headers(teacher),
    });
    expect(task.statusCode).toBe(200);
    expect(
      task.json().rules.every((rule: any) => rule.contract_version === 1),
    ).toBe(true);
  });

  it("returns only publication identity in the status endpoint, never its unrestricted JSON payload", async () => {
    const { runId } = await newRun();
    const revisionId = randomUUID(),
      publicationId = randomUUID();
    const privatePayload = JSON.stringify({
      source: "ui_fixture",
      secret: "unrestricted-snapshot-must-not-escape",
    });
    await db.query(
      `INSERT INTO report_revisions(id,run_id,revision_no,base_manifest_id,source,created_by,idempotency_key,request_hash)
      VALUES($1,$2,1,$3,'ui_fixture',$4,$5,$6)`,
      [
        revisionId,
        runId,
        randomUUID(),
        teacher.user.id,
        randomUUID(),
        "a".repeat(64),
      ],
    );
    await db.query(
      `INSERT INTO publications(id,run_id,publication_no,revision_id,purpose,snapshot,published_by,idempotency_key,request_hash)
      VALUES($1,$2,1,$3,'latest',$4,$5,$6,$7)`,
      [
        publicationId,
        runId,
        revisionId,
        privatePayload,
        teacher.user.id,
        randomUUID(),
        "b".repeat(64),
      ],
    );
    const response = await app.inject({
      url: `/api/v2/runs/${runId}`,
      headers: headers(student),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().report).toMatchObject({
      state: "published",
      latestPublication: { publicationId, publicationNo: 1, purpose: "latest" },
    });
    expect(response.body).not.toContain(
      "unrestricted-snapshot-must-not-escape",
    );
  });

  it("returns QUEUE_FULL without losing an accepted submission and still allows an existing replay", async () => {
    const replaySubmissionId = await newSubmission();
    const key = randomUUID();
    const accepted = await enqueue(replaySubmissionId, { key });
    expect(accepted.statusCode).toBe(202);
    const blockedSubmissionId = await newSubmission();
    const waiting = Number(
      (
        await db.query(`SELECT (SELECT count(*) FROM runs WHERE status='queued') +
      (SELECT count(*) FROM analysis_attempts WHERE mode='reanalysis' AND status='queued') AS n`)
      ).rows[0].n,
    );
    for (let index = waiting; index < 30; index++) {
      await db.query(
        `INSERT INTO runs(id,submission_id,rule_id,contract_version,status,execution_config,request_id,idempotency_key,request_hash)
        VALUES($1,$2,$3,2,'queued','{}',$4,$5,$6)`,
        [
          randomUUID(),
          blockedSubmissionId,
          ruleId,
          randomUUID(),
          `ui_fixture_queue_${index}`,
          "c".repeat(64),
        ],
      );
    }
    const rejected = await enqueue(blockedSubmissionId);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().error.code).toBe("QUEUE_FULL");
    expect(
      (
        await db.query("SELECT id FROM submissions WHERE id=$1", [
          blockedSubmissionId,
        ])
      ).rows,
    ).toHaveLength(1);
    const replay = await enqueue(replaySubmissionId, { key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().runId).toBe(accepted.json().runId);
  });
});
