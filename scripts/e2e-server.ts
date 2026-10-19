// Isolated browser-test database. Synthetic evidence is never used by production.
import { randomUUID } from "node:crypto";
import { testDB } from "../tests/db.js";
import { migrate } from "../apps/api/src/db.js";
import { seed } from "../apps/api/src/seed.js";
import { createApp } from "../apps/api/src/app.js";
import { fallback } from "../apps/api/src/agent.js";
const db = await testDB();
await migrate(db);
await seed(db, "Browser-test-only-2904!");
const task = (await db.query("SELECT * FROM tasks")).rows[0];
const rule = (await db.query("SELECT * FROM rules")).rows[0];
const student = (await db.query("SELECT id FROM users WHERE role='student'"))
  .rows[0].id;
const teacher = (await db.query("SELECT id FROM users WHERE role='teacher'"))
  .rows[0].id;
for (let i = 1; i <= 2; i++) {
  const sid = randomUUID(),
    rid = `00000000-0000-4000-8000-00000000000${i}`;
  const results = rule.criteria.map((c: any) => ({
    criterionId: c.id,
    status: (i === 1
      ? ["filter", "validation"]
      : ["validation", "persistence"]
    ).includes(c.id)
      ? "failed"
      : "passed",
    observation: "浏览器 UI 测试夹具：" + c.title,
    steps: ["测试夹具步骤，不是项目运行结论"],
    evidenceIds: ["fixture-dom"],
  }));
  const evidence = [
    {
      id: "fixture-dom",
      kind: "dom",
      title: "UI 测试证据（合成）",
      text: "仅验证复核交互，不代表实际执行结果。",
    },
  ];
  await db.query(
    "INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      sid,
      task.id,
      student,
      rule.id,
      String(i).repeat(64),
      "{}",
      randomUUID(),
      new Date(Date.now() - (3 - i) * 60000),
    ],
  );
  await db.query(
    "INSERT INTO runs(id,submission_id,status,execution_config,request_id,results,evidence,feedback,model_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      rid,
      sid,
      i === 1 ? "published" : "review",
      "{}",
      randomUUID(),
      JSON.stringify(results),
      JSON.stringify(evidence),
      JSON.stringify(fallback(results)),
      "unconfigured",
    ],
  );
  if (i === 1)
    await db.query(
      "INSERT INTO reports(id,run_id,snapshot,published_by) VALUES($1,$2,$3,$4)",
      [
        randomUUID(),
        rid,
        JSON.stringify({
          criteria: rule.criteria,
          results,
          evidence,
          feedback: fallback(results),
          ruleVersion: 1,
        }),
        teacher,
      ],
    );
}
const app = await createApp(db, {
  origin: process.env.APP_ORIGIN ?? "http://localhost:5173",
  secure: false,
  executionApproved: false,
  model: "unconfigured",
  image: "none",
});
await app.listen({ host: "127.0.0.1", port: Number(process.env.API_PORT ?? 3100) });
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
