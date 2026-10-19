import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDB } from "./db";
import { migrate, type DB } from "../apps/api/src/db";
import { seed } from "../apps/api/src/seed";
import { createApp } from "../apps/api/src/app";
import { zipSync } from "fflate";
import { templateFiles, templateZip } from "../apps/api/src/template";
import { fallback } from "../apps/api/src/agent";
import { claim, ownedUpdate } from "../apps/api/src/queue";
import type { FastifyInstance } from "../apps/api/node_modules/fastify";
let db: DB,
  app: FastifyInstance,
  teacher: any,
  student: any,
  task: any,
  classId: string;
const origin = "http://localhost:5173",
  password = "Only-for-tests-2904!";
async function login(email: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/session/login",
    headers: { origin },
    payload: { email, password },
  });
  expect(r.statusCode).toBe(200);
  return {
    cookie: r.cookies[0].name + "=" + r.cookies[0].value,
    csrf: r.json().csrf,
    user: r.json().user,
  };
}
it("bounds read polling independently and preserves the stricter login limit", async () => {
  const limited = await createApp(db, { origin, secure: false, executionApproved: false, model: "", image: "" });
  try {
    for (let index = 0; index < 240; index++) {
      const response = await limited.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: student.cookie } });
      expect(response.statusCode).not.toBe(429);
    }
    expect((await limited.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: student.cookie } })).statusCode).toBe(429);
    for (let index = 0; index < 10; index++) {
      const response = await limited.inject({ method: "POST", url: "/api/v1/session/login", headers: { origin }, payload: {} });
      expect(response.statusCode).not.toBe(429);
    }
    expect((await limited.inject({ method: "POST", url: "/api/v1/session/login", headers: { origin }, payload: {} })).statusCode).toBe(429);
  } finally { await limited.close(); }
});
const headers = (u: any) => ({
  cookie: u.cookie,
  origin,
  "x-csrf-token": u.csrf,
});
async function upload(u = student, key = randomUUID(), bytes?: Buffer) {
  const zip = bytes ?? (await templateZip()),
    boundary = "--codelab-form";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="project.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: `/api/v1/tasks/${task.id}/submissions`,
    headers: {
      ...headers(u),
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "idempotency-key": key,
    },
    payload,
  });
}
async function draft() {
  const submitted = await upload();
  expect(submitted.statusCode).toBe(201);
  const sid = submitted.json().id;
  const rule = (
    await db.query("SELECT * FROM rules WHERE task_id=$1", [task.id])
  ).rows[0];
  const run = randomUUID();
  const results = rule.criteria.map((c: any) => ({
    criterionId: c.id,
    status: c.id === "filter" ? "failed" : "passed",
    observation: c.id === "filter" ? "筛选仍显示全部" : "通过",
    steps: ["执行基础检查"],
    evidenceIds: ["dom"],
  }));
  await db.query(
    "INSERT INTO runs(id,submission_id,status,execution_config,request_id,results,evidence,feedback,model_status) VALUES($1,$2,'review','{}',$3,$4,$5,$6,'unconfigured')",
    [
      run,
      sid,
      randomUUID(),
      JSON.stringify(results),
      JSON.stringify([
        { id: "dom", kind: "dom", title: "页面证据", text: "A B" },
      ]),
      JSON.stringify(fallback(results)),
    ],
  );
  return { run, sid, results, feedback: fallback(results) };
}
beforeAll(async () => {
  db = await testDB();
  await migrate(db);
  await seed(db, password);
  app = await createApp(db, {
    origin,
    secure: false,
    executionApproved: true,
    model: "test",
    image: "test-only",
  });
  teacher = await login("teacher@codelab.local");
  student = await login("student@codelab.local");
  task = (await db.query("SELECT * FROM tasks")).rows[0];
  classId = task.class_id;
}, 60000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});
describe("API ownership, review and immutable publication", () => {
  it('deduplicates class creation by owner/key and rejects changed payloads', async()=>{
    const key=randomUUID();
    const create=(name:string)=>app.inject({method:'POST',url:'/api/v1/classes',headers:{...headers(teacher),'idempotency-key':key},payload:{name}});
    const [first,second]=await Promise.all([create('去重班级'),create('去重班级')]);
    expect(first.statusCode).toBe(200);expect(second.json()).toEqual(first.json());
    expect((await create('变更名称')).statusCode).toBe(409);
    expect((await db.query('SELECT * FROM classes WHERE teacher_id=$1 AND name=$2',[teacher.user.id,'去重班级'])).rows).toHaveLength(1);
  });
  it('lists only owned class members with public fields, exact email and stable pagination',async()=>{
    const otherOwner=randomUUID(),foreign=randomUUID();
    await db.query("INSERT INTO users VALUES($1,$2,'other','teacher','unused')",[otherOwner,`${otherOwner}@test.local`]);
    await db.query("INSERT INTO classes VALUES($1,'private',$2)",[foreign,otherOwner]);
    const get=(id:string,query='',actor=teacher)=>app.inject({url:`/api/v1/classes/${id}/students${query}`,headers:headers(actor)});
    expect((await get(foreign)).statusCode).toBe(404);
    expect((await get(classId,'',student)).statusCode).toBe(403);
    expect((await app.inject(`/api/v1/classes/${classId}/students`)).statusCode).toBe(401);
    const created=await app.inject({method:'POST',url:'/api/v1/classes',headers:headers(teacher),payload:{name:'分页核对'}});
    const id=created.json().id;
    for(let i=0;i<101;i++){
      const member=randomUUID();await db.query("INSERT INTO users VALUES($1,$2,'member','student','sensitive-password-hash')",[member,`${member}@test.local`]);
      await db.query('INSERT INTO memberships VALUES($1,$2)',[id,member]);
    }
    const first=await get(id),a=first.json();expect(first.statusCode).toBe(200);expect(a.items).toHaveLength(100);
    const second=(await get(id,`?after=${a.nextCursor}`)).json();expect(second.items).toHaveLength(1);expect(second.nextCursor).toBeNull();
    expect(new Set([...a.items,...second.items].map(x=>x.id)).size).toBe(101);
    expect(Object.keys(a.items[0]).sort()).toEqual(['email','id','name']);expect(first.body).not.toContain('sensitive-password-hash');
    const found=(await get(id,`?email=${encodeURIComponent(a.items[0].email.toUpperCase())}`)).json();expect(found.items).toEqual([a.items[0]]);
  });
  it("requires session and origin/CSRF for mutations", async () => {
    expect((await app.inject("/api/v1/tasks")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/classes",
          headers: { cookie: teacher.cookie },
          payload: { name: "bad" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/classes",
          headers: { cookie: teacher.cookie, origin },
          payload: { name: "bad" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("stores ZIP once for repeated upload identifiers", async () => {
    // A retry resends identical bytes; rebuilding ZIPs changes their timestamps.
    const key = randomUUID(), bytes = await templateZip(),
      a = await upload(student, key, bytes),
      b = await upload(student, key, bytes);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect(b.json().reused).toBe(true);
    expect((await db.query("SELECT id FROM submissions WHERE user_id=$1 AND request_id=$2",
      [student.user.id,key])).rows).toHaveLength(1);
  });
  it("rejects reuse of an upload key with different source contents", async () => {
    const key = randomUUID();
    expect((await upload(student, key)).statusCode).toBe(201);
    const files = await templateFiles();
    files["src/App.vue"] = Buffer.concat([
      files["src/App.vue"],
      Buffer.from("\n<!-- changed -->"),
    ]);
    expect(
      (await upload(student, key, Buffer.from(zipSync(files)))).statusCode,
    ).toBe(409);
  });
  it("hides draft and evidence from student then publishes immutable snapshot", async () => {
    const d = await draft();
    const get = () =>
      app.inject({ url: `/api/v1/runs/${d.run}`, headers: headers(student) });
    expect((await get()).json().report).toBeNull();
    expect(
      (
        await app.inject({
          url: `/api/v1/runs/${d.run}/evidence/dom`,
          headers: headers(student),
        })
      ).statusCode,
    ).toBe(404);
    const publish = (revision: number) =>
      app.inject({
        method: "POST",
        url: `/api/v1/runs/${d.run}/publish`,
        headers: headers(teacher),
        payload: { revision },
      });
    expect((await publish(0)).statusCode).toBe(409);
    for (let i = 0; i < d.feedback.length; i++) {
      const r = await app.inject({
        method: "PUT",
        url: `/api/v1/runs/${d.run}/review`,
        headers: headers(teacher),
        payload: {
          revision: i,
          criterionId: d.feedback[i].criterionId,
          feedback: d.feedback[i],
        },
      });
      expect(r.statusCode).toBe(200);
    }
    expect((await publish(0)).statusCode).toBe(409);
    expect((await publish(d.feedback.length)).statusCode).toBe(200);
    const snapshot = (await get()).json().report;
    expect(snapshot.feedback).toHaveLength(7);
    expect(
      snapshot.results.find((r: any) => r.criterionId === "filter").status,
    ).toBe("failed");
    expect(
      (
        await app.inject({
          url: `/api/v1/runs/${d.run}/evidence/dom`,
          headers: headers(student),
        })
      ).json().text,
    ).toBe("A B");
    await expect(
      db.query("UPDATE reports SET snapshot=$1 WHERE run_id=$2", ["{}", d.run]),
    ).rejects.toThrow("immutable");
  });
  it("rejects stale edits, forged evidence and outcome overrides", async () => {
    const d = await draft();
    const save = (body: any) =>
      app.inject({
        method: "PUT",
        url: `/api/v1/runs/${d.run}/review`,
        headers: headers(teacher),
        payload: body,
      });
    const b = { revision: 0, criterionId: "create", feedback: d.feedback[0] };
    expect(
      (
        await save({
          ...b,
          feedback: { ...b.feedback, evidenceIds: ["foreign"] },
        })
      ).statusCode,
    ).toBe(400);
    expect((await save({ ...b, manualStatus: "failed" })).statusCode).toBe(400);
    expect((await save(b)).statusCode).toBe(200);
    expect((await save(b)).statusCode).toBe(409);
  });
  it("prevents cross-student and cross-class reads", async () => {
    const d = await draft();
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/classes/${classId}/students`,
      headers: headers(teacher),
      payload: { email: "other@example.com", name: "另一个学生", password },
    });
    expect(r.statusCode).toBe(200);
    const other = await login("other@example.com");
    expect(
      (
        await app.inject({
          url: `/api/v1/runs/${d.run}`,
          headers: headers(other),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/runs/${d.run}/publish`,
          headers: headers(other),
          payload: { revision: 0 },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("does not publish an older submission after a new upload", async () => {
    const d = await draft();
    await db.query("UPDATE runs SET reviewed=$2 WHERE id=$1", [
      d.run,
      JSON.stringify(d.results.map((r: any) => r.criterionId)),
    ]);
    await upload();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/runs/${d.run}/publish`,
          headers: headers(teacher),
          payload: { revision: 0 },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("deduplicates queue requests and fences stale worker writes", async () => {
    const u = await upload();
    const sid = u.json().id;
    const key = randomUUID();
    const run = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/submissions/${sid}/runs`,
        headers: { ...headers(student), "idempotency-key": key },
      });
    const a = await run(),
      b = await run();
    expect(a.statusCode).toBe(200);
    expect(a.json().id).toBe(b.json().id);
    const claimed = await claim(db);
    expect(claimed.id).toBe(a.json().id);
    expect(await claim(db)).toBeNull();
    expect(
      await ownedUpdate(db, claimed.id, randomUUID(), "status='review'"),
    ).toBe(false);
    await db.query(
      "UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [claimed.id],
    );
    await claim(db);
    expect(
      (await db.query("SELECT status FROM runs WHERE id=$1", [claimed.id]))
        .rows[0].status,
    ).toBe("infra_error");
    expect(
      await ownedUpdate(db, claimed.id, claimed.lease_token, "status='review'"),
    ).toBe(false);
  });
});
