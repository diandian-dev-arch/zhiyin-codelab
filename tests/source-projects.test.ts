import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { randomUUID } from "node:crypto";
import { importSourceZip, redactSource } from "../apps/api/src/source-zip";
import {
  analyzeSource,
  validateSourceReport,
} from "../apps/api/src/source-agent";
import { sourceWorkerTick } from "../apps/api/src/source-projects";
import { sourceExecutionSnapshot } from "../apps/api/src/source-execution";
import {
  registerSourceCall,
  finishSourceCall,
  summarizeSourceUsage,
} from "../apps/api/src/source-usage";
import {
  sourceContextPolicy,
  checkSourceRequestBudget,
} from "../apps/api/src/source-context";
import { ModelRequestError } from "../apps/api/src/model-provider-v2";
import { createApp } from "../apps/api/src/app";
import { migrate, type DB } from "../apps/api/src/db";
import { isolatedTestDB, type IsolatedTestDatabase } from "./isolated-db";
import { seed } from "../apps/api/src/seed";
import type { SummaryProviderV2 } from "../apps/api/src/model-provider-v2";
const zip = (files: Record<string, string>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([p, s]) => [p, strToU8(s)]),
      ),
    ),
  );
const cite = { path: "hello/app.py", start: 1, end: 1 };
const section = { title: "入口", body: "命令行输出", citations: [cite] };
const report = {
  overview: "测试项目",
  stack: ["Python"],
  modules: [section],
  flows: [section],
  findings: [],
  readingPath: [section],
  limitations: ["静态片段分析，未运行"],
};
const provider: SummaryProviderV2 = {
  configuration: { provider: "test", model: "test", endpoint: "http://test" },
  complete: async (input) => ({
    content: JSON.stringify(
      JSON.parse(input.user).draft
        ? JSON.parse(input.user).shape || JSON.parse(input.user).checkShape
          ? { report, checks: [] }
          : { searches: [], reads: [] }
        : JSON.parse(input.user).shape
          ? report
          : { paths: ["hello/app.py"] },
    ),
    raw: "fixture",
    requestId: null,
    usage: null,
  }),
};
it("imports an ordinary Python ZIP without any course template and skips dependencies/secrets", async () => {
  const r = await importSourceZip(
    zip({
      "hello/app.py": 'print("hi")',
      "hello/.env": "SECRET=hidden",
      "hello/node_modules/a.js": "huge",
      "hello/photo.png": "binary",
    }),
  );
  expect(Object.keys(r.files)).toEqual(["hello/app.py"]);
  expect(r.omitted).toHaveLength(3);
});
it("rejects traversal, duplicate case names and empty source", async () => {
  for (const input of [
    zip({ "../app.py": "x" }),
    zip({ "app.py": "x", "APP.py": "y" }),
    zip({ "photo.png": "x" }),
  ])
    await expect(importSourceZip(input)).rejects.toThrow();
});
it("redacts recognizable credentials without destroying line locations", () => {
  const raw =
    'const apiKey = "my-super-secret";\nconst url="postgres://user:pass@host/db";\nprint(1)';
  const clean = redactSource(raw);
  expect(clean).not.toContain("my-super-secret");
  expect(clean).not.toContain("user:pass");
  expect(clean.split("\n")).toHaveLength(3);
  const embedded =
    "const key = `-----BEGIN PRIVATE KEY-----\r\nprivate-data\r\n-----END PRIVATE KEY-----`;\r\nconst next = 1;";
  const redacted = redactSource(embedded);
  expect(redacted).not.toContain("private-data");
  expect(redacted.split("\r\n")).toHaveLength(4);
  expect(redacted.split("\r\n")[3]).toBe("const next = 1;");
});
it("rejects fabricated/unread/out-of-range references", () => {
  expect(() => validateSourceReport(report, {})).toThrow();
  expect(() =>
    validateSourceReport(
      {
        ...report,
        modules: [{ ...section, citations: [{ ...cite, end: 9 }] }],
      },
      { "hello/app.py": { start: 1, end: 1 } },
    ),
  ).toThrow();
  expect(
    validateSourceReport(report, { "hello/app.py": { start: 1, end: 1 } })
      .overview,
  ).toBe("测试项目");
});
it("records real read actions and validates the report before returning", async () => {
  const events: any[] = [];
  const result = await analyzeSource({
    files: { "hello/app.py": 'print("hi")' },
    provider,
    signal: new AbortController().signal,
    emit: async (e) => {
      events.push(e);
    },
  });
  expect(events.map((e) => e.kind)).toEqual([
    "map",
    "plan",
    "read",
    "synthesize",
    "validate",
    "verify_plan",
    "verify",
    "validate",
    "verified",
  ]);
  expect(result.read[cite.path].end).toBe(1);
  expect(result.coverage).toMatchObject({
    indexedFiles: 1,
    planningFiles: 1,
    readFiles: 1,
    readLines: 1,
    totalLines: 1,
    characterBudget: 100_000,
  });
});
it("repairs invalid model citations once and never fabricates or clamps their location", async () => {
  let calls = 0;
  const repaired = {
    ...provider,
    complete: async (input: Parameters<SummaryProviderV2["complete"]>[0]) => {
      calls++;
      if (calls === 2)
        return {
          content: JSON.stringify({
            ...report,
            modules: [{ ...section, citations: [{ ...cite, end: 999 }] }],
          }),
          raw: "fixture",
          requestId: null,
          usage: null,
        };
      return provider.complete(input);
    },
  };
  const events: any[] = [];
  const result = await analyzeSource({
    files: { "hello/app.py": "print(1)" },
    provider: repaired,
    signal: new AbortController().signal,
    emit: async (e) => {
      events.push(e);
    },
  });
  expect(calls).toBe(5);
  expect(result.report.modules[0].citations[0].end).toBe(1);
  expect(events.some((e) => e.kind === "repair")).toBe(true);
  const invalid = {
    ...provider,
    complete: async (input: Parameters<SummaryProviderV2["complete"]>[0]) =>
      JSON.parse(input.user).shape
        ? {
            content: JSON.stringify({
              ...report,
              modules: [{ ...section, citations: [{ ...cite, end: 999 }] }],
            }),
            raw: "fixture",
            requestId: null,
            usage: null,
          }
        : provider.complete(input),
  };
  await expect(
    analyzeSource({
      files: { "hello/app.py": "print(1)" },
      provider: invalid,
      signal: new AbortController().signal,
      emit: async () => {},
    }),
  ).rejects.toThrow("INVALID_SOURCE_CITATION");
});
describe("source persistence and owner boundary (test model)", () => {
  let db: IsolatedTestDatabase;
  let owner: string;
  let other: string;
  const origin = "http://localhost:5173";
  const password = "Source-project-test-only-9368!";
  beforeAll(async () => {
    db = await isolatedTestDB();
    await migrate(db);
    await seed(db, password);
    owner = (
      await db.query("SELECT id FROM users WHERE email='teacher@codelab.local'")
    ).rows[0].id;
    other = (
      await db.query("SELECT id FROM users WHERE email='student@codelab.local'")
    ).rows[0].id;
  });
  afterAll(async () => {
    await db.close();
  });
  async function job(options: unknown = null) {
    const p = randomUUID(),
      id = randomUUID();
    await db.query(
      "INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,$3,$4,$5,$6)",
      [
        p,
        owner,
        "hello.zip",
        p,
        JSON.stringify({ "hello/app.py": 'print("hi")' }),
        "[]",
      ],
    );
    await db.query(
      "INSERT INTO source_analyses(id,project_id,status,analysis_options) VALUES($1,$2,'queued',$3)",
      [id, p, options === null ? null : JSON.stringify(options)],
    );
    return { p, id };
  }
  async function frozenJob(snapshot = sourceExecutionSnapshot(provider)) {
    const { p, id } = await job();
    await db.query(
      "UPDATE source_analyses SET status='cancelled' WHERE id=$1",
      [id],
    );
    const next = randomUUID();
    await db.query(
      "INSERT INTO source_analyses(id,project_id,status,execution_snapshot) VALUES($1,$2,'queued',$3)",
      [next, p, JSON.stringify(snapshot)],
    );
    return { p, id: next, legacy: id };
  }
  it('persists budget stops without registering or sending a paid request', async () => {
    const {p,id}=await job();
    await db.query("UPDATE source_analyses SET status='cancelled' WHERE id=$1",[id]);
    const next=randomUUID();
    await db.query("INSERT INTO source_analyses(id,project_id,status,analysis_options) VALUES($1,$2,'queued',$3)",[next,p,JSON.stringify({version:1,mode:'quick',modules:[],cost:{inputPerMillion:100000,outputPerMillion:100000,label:'test',limitCny:.01}})]);
    let sent=0;
    await sourceWorkerTick(db,{...provider,complete:async request=>{sent++;return provider.complete(request);}},new AbortController().signal);
    expect(sent).toBe(0);
    expect((await db.query('SELECT status,code,report FROM source_analyses WHERE id=$1',[next])).rows[0]).toMatchObject({status:'failed',code:'SOURCE_COST_BUDGET',report:null});
    expect((await db.query('SELECT id FROM source_model_calls WHERE analysis_id=$1',[next])).rows).toHaveLength(0);
  });
  it('persists final verification field errors without publishing or requeueing failed reports', async () => {
    const {id}=await job();
    let reviews=0;
    const invalid={...provider,complete:async (input:Parameters<SummaryProviderV2['complete']>[0])=>{
      if(JSON.parse(input.user).checkShape){
        reviews++;
        return {content:JSON.stringify({checks:'private-invalid-response'}),raw:'fixture',requestId:null,usage:null};
      }
      return provider.complete(input);
    }};
    await sourceWorkerTick(db,invalid,new AbortController().signal);
    const failed=(await db.query('SELECT status,code,report,events FROM source_analyses WHERE id=$1',[id])).rows[0];
    expect(failed).toMatchObject({status:'failed',code:'REPORT_SCHEMA_INVALID',report:null});
    expect(reviews).toBe(2);
    expect(failed.events.find((e:any)=>e.kind==='validation_failed').issues).toEqual([{path:'checks',code:'invalid_type',expected:'array'}]);
    expect(JSON.stringify(failed.events)).not.toContain('private-invalid-response');
    expect(await sourceWorkerTick(db,invalid,new AbortController().signal)).toBe(false);
  });
  it("persists partial vendor usage through a later HTTP failure without a report or retry", async () => {
    const { id } = await frozenJob();
    let count = 0;
    const failing = {
      ...provider,
      complete: async (
        request: Parameters<SummaryProviderV2["complete"]>[0],
      ) => {
        count++;
        if (count === 2)
          throw new ModelRequestError("MODEL_HTTP_403", "failed");
        return {
          ...(await provider.complete(request)),
          usage: { inputTokens: 101, outputTokens: 17 },
        };
      },
    };
    await sourceWorkerTick(db, failing, new AbortController().signal);
    const analysis = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [id])
    ).rows[0];
    const calls = (
      await db.query(
        "SELECT * FROM source_model_calls WHERE analysis_id=$1 ORDER BY call_no",
        [id],
      )
    ).rows;
    expect(analysis).toMatchObject({
      status: "failed",
      code: "MODEL_HTTP_403",
      report: null,
      usage_recording_version: 1,
    });
    expect(calls.map((c) => c.state)).toEqual(["returned", "failed"]);
    expect(
      summarizeSourceUsage(
        analysis.usage_recording_version,
        analysis.status,
        calls,
      ),
    ).toMatchObject({
      registeredCalls: 2,
      failedCalls: 1,
      knownInputTokens: 101,
      knownOutputTokens: 17,
      callsWithoutUsage: 1,
    });
    expect(
      await sourceWorkerTick(db, failing, new AbortController().signal),
    ).toBe(false);
    expect(count).toBe(2);
    await expect(
      db.query("UPDATE source_model_calls SET usage='{}' WHERE id=$1", [
        calls[0].id,
      ]),
    ).rejects.toThrow("immutable source model call");
  });
  it("records a late cancellation receipt without reviving status, report or further calls", async () => {
    const { id } = await frozenJob();
    let count = 0;
    const cancelled = {
      ...provider,
      complete: async (
        request: Parameters<SummaryProviderV2["complete"]>[0],
      ) => {
        count++;
        await db.query(
          "UPDATE source_analyses SET status='cancelled',finished_at=now() WHERE id=$1",
          [id],
        );
        return {
          ...(await provider.complete(request)),
          usage: { inputTokens: 77, outputTokens: 9 },
        };
      },
    };
    await sourceWorkerTick(db, cancelled, new AbortController().signal);
    expect(count).toBe(1);
    const analysis = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [id])
    ).rows[0];
    const calls = (
      await db.query("SELECT * FROM source_model_calls WHERE analysis_id=$1", [
        id,
      ])
    ).rows;
    expect(analysis).toMatchObject({ status: "cancelled", report: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      state: "returned",
      usage: { inputTokens: 77, outputTokens: 9 },
    });
    await expect(
      finishSourceCall(db, calls[0].id, {
        state: "returned",
        durationMs: 1,
        usage: null,
        requestId: null,
        errorCode: null,
      }),
    ).rejects.toThrow("SOURCE_CALL_RECEIPT_CONFLICT");
    expect(
      (await db.query("SELECT * FROM source_analyses WHERE id=$1", [id]))
        .rows[0],
    ).toEqual(analysis);
  });
  it("preserves an interrupted pending request as unknown and refuses calls from an expired owner", async () => {
    const { id } = await frozenJob();
    await db.query(
      "UPDATE source_analyses SET status='running',usage_recording_version=1,deadline=now()+interval '1 minute' WHERE id=$1",
      [id],
    );
    const budget = checkSourceRequestBudget(
      sourceContextPolicy(),
      (s) => s.length,
      { system: "x", user: "y", maxOutputTokens: 100 },
    );
    await registerSourceCall(db, id, 1, budget);
    await db.query(
      "UPDATE source_analyses SET deadline=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    await expect(registerSourceCall(db, id, 2, budget)).rejects.toThrow(
      "OWNER_EXPIRED",
    );
    let count = 0;
    await sourceWorkerTick(
      db,
      {
        ...provider,
        complete: async (request) => {
          count++;
          return provider.complete(request);
        },
      },
      new AbortController().signal,
    );
    const analysis = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [id])
    ).rows[0];
    const calls = (
      await db.query("SELECT * FROM source_model_calls WHERE analysis_id=$1", [
        id,
      ])
    ).rows;
    expect(analysis).toMatchObject({
      status: "failed",
      code: "INTERRUPTED",
      report: null,
    });
    expect(summarizeSourceUsage(1, analysis.status, calls)).toMatchObject({
      pendingCalls: 0,
      unknownCalls: 1,
      knownInputTokens: null,
      knownOutputTokens: null,
    });
    expect(count).toBe(0);
    expect(calls[0].state).toBe("started");
  });
  it("keeps received usage even when model content is unusable", async () => {
    const { id } = await frozenJob();
    await sourceWorkerTick(
      db,
      {
        ...provider,
        complete: async () => ({
          raw: "invalid",
          content: "",
          requestId: null,
          usage: { inputTokens: 22, outputTokens: 3 },
        }),
      },
      new AbortController().signal,
    );
    const analysis = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [id])
    ).rows[0];
    const calls = (
      await db.query("SELECT * FROM source_model_calls WHERE analysis_id=$1", [
        id,
      ])
    ).rows;
    expect(analysis.status).toBe("failed");
    expect(analysis.report).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].usage).toEqual({ inputTokens: 22, outputTokens: 3 });
  });
  it("freezes execution configuration in the database, preserving historical NULL", async () => {
    const { id, legacy, p } = await frozenJob();
    for (const target of [id, legacy])
      await expect(
        db.query(
          "UPDATE source_analyses SET execution_snapshot=$2 WHERE id=$1",
          [
            target,
            JSON.stringify({
              ...sourceExecutionSnapshot(provider),
              version: 2,
            }),
          ],
        ),
      ).rejects.toThrow("immutable source execution snapshot");
    for (const invalid of [
      null,
      {},
      { version: 1, model: null, context: {} },
      { version: "1", model: {}, context: {} },
    ])
      await expect(
        db.query(
          "INSERT INTO source_analyses(id,project_id,status,execution_snapshot) VALUES($1,$2,'failed',$3)",
          [randomUUID(), p, JSON.stringify(invalid)],
        ),
      ).rejects.toThrow();
    await sourceWorkerTick(db, provider, new AbortController().signal);
    const row = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [id])
    ).rows[0];
    expect(row.status).toBe("succeeded");
    expect(row.execution_snapshot).toEqual(sourceExecutionSnapshot(provider));
    expect(row.report.context.policy).toEqual(row.execution_snapshot.context);
    expect(
      (
        await db.query(
          "SELECT execution_snapshot FROM source_analyses WHERE id=$1",
          [legacy],
        )
      ).rows[0].execution_snapshot,
    ).toBeNull();
  });
  it("rejects changed queued settings before any request and keeps old reports unchanged", async () => {
    const old = await job();
    await sourceWorkerTick(db, provider, new AbortController().signal);
    const before = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [old.id])
    ).rows[0];
    const { id } = await frozenJob();
    let calls = 0;
    const changed = {
      ...provider,
      sourceContext: {
        contextWindowTokens: 128000,
        maxOutputTokens: 12000,
        tokenizer: "utf8-conservative" as const,
      },
      complete: async (input: Parameters<SummaryProviderV2["complete"]>[0]) => {
        calls++;
        return provider.complete(input);
      },
    };
    await sourceWorkerTick(db, changed, new AbortController().signal);
    const failed = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [id])
    ).rows[0];
    expect(failed).toMatchObject({
      status: "failed",
      code: "SOURCE_CONFIGURATION_CHANGED",
      report: null,
      events: [],
    });
    expect(calls).toBe(0);
    expect(
      await sourceWorkerTick(db, changed, new AbortController().signal),
    ).toBe(false);
    expect(
      (await db.query("SELECT * FROM source_analyses WHERE id=$1", [old.id]))
        .rows[0],
    ).toEqual(before);
  });
  it("rechecks frozen configuration before subsequent model calls", async () => {
    const { id } = await frozenJob();
    let calls = 0;
    const changing = {
      ...provider,
      configuration: { ...provider.configuration },
      complete: async (input: Parameters<SummaryProviderV2["complete"]>[0]) => {
        calls++;
        const response = await provider.complete(input);
        changing.configuration.model = "another-model";
        return response;
      },
    };
    await sourceWorkerTick(db, changing, new AbortController().signal);
    expect(calls).toBe(1);
    expect(
      (
        await db.query(
          "SELECT status,code,report FROM source_analyses WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({
      status: "failed",
      code: "SOURCE_CONFIGURATION_CHANGED",
      report: null,
    });
  });
  it("finishes deep analysis when investigation plans need only bounded local normalization", async () => {
    const { id } = await job({ version: 1, mode: "deep", modules: [] });
    const tolerantProvider = {
      ...provider,
      complete: async (input: Parameters<SummaryProviderV2["complete"]>[0]) => {
        if (JSON.parse(input.user).phase === "investigation") return {
          content: JSON.stringify({ goal: "追踪业务链路".repeat(40), searches: [],
            reads: [{ path: cite.path, start: "1", count: "999" }] }),
          raw: "fixture", requestId: null, usage: null,
        };
        return provider.complete(input);
      },
    };
    await sourceWorkerTick(db, tolerantProvider, new AbortController().signal);
    const result = (await db.query("SELECT * FROM source_analyses WHERE id=$1", [id])).rows[0];
    expect(result.status).toBe("succeeded");
    expect(result.report).not.toBeNull();
    expect(result.events.filter((e: any) => e.kind === "plan_normalized")).toHaveLength(2);
    expect(result.events.filter((e: any) => e.kind === "repair_plan")).toHaveLength(0);
  });

  it("persists a bounded plan-repair failure without replacing older reports or requeueing", async () => {
    const { p, id } = await job();
    await sourceWorkerTick(db, provider, new AbortController().signal);
    const old = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [id])
    ).rows[0];
    expect(old.status).toBe("succeeded");
    const next = randomUUID();
    await db.query(
      "INSERT INTO source_analyses(id,project_id,status,analysis_options) VALUES($1,$2,'queued',$3)",
      [next, p, JSON.stringify({ version: 1, mode: "deep", modules: [] })],
    );
    let calls = 0;
    const invalidProvider = {
      ...provider,
      complete: async (input: Parameters<SummaryProviderV2["complete"]>[0]) => {
        calls++;
        if (JSON.parse(input.user).phase === "investigation")
          return {
            content: JSON.stringify({
              goal: "invalid",
              searches: [],
              reads: [{ path: cite.path, start: 0, count: 120 }],
            }),
            raw: "fixture",
            requestId: null,
            usage: null,
          };
        return provider.complete(input);
      },
    };
    await sourceWorkerTick(db, invalidProvider, new AbortController().signal);
    const failed = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [next])
    ).rows[0];
    expect(failed.status).toBe("failed");
    expect(failed.code).toBe("SOURCE_PLAN_INVALID");
    expect(failed.report).toBeNull();
    expect(
      failed.events.filter((e: any) => e.kind === "repair_plan"),
    ).toHaveLength(1);
    expect(failed.events.some((e: any) => e.kind === "investigate_done")).toBe(
      false,
    );
    expect(
      (await db.query("SELECT * FROM source_analyses WHERE id=$1", [id]))
        .rows[0],
    ).toEqual(old);
    expect(
      await sourceWorkerTick(db, invalidProvider, new AbortController().signal),
    ).toBe(false);
    expect(calls).toBe(3);
  });
  it('persists optional-plan limitations and returns them through the authenticated project API', async () => {
    const { p, id } = await job();
    let calls = 0;
    const limitedProvider: SummaryProviderV2 = { ...provider, complete: async request => {
      calls++;
      const body = JSON.parse(request.user);
      if (body.draft && !body.checkShape) return {
        content: JSON.stringify({ searches: [], reads: null }), raw: 'fixture', requestId: null, usage: null,
      };
      return provider.complete(request);
    } };
    await sourceWorkerTick(db, limitedProvider, new AbortController().signal);
    const saved = (await db.query('SELECT * FROM source_analyses WHERE id=$1', [id])).rows[0];
    expect(saved.status).toBe('succeeded');
    expect(saved.report.report.analysisWarnings).toEqual([expect.stringContaining('补充核查未完成')]);
    expect(saved.report.report.reportQuality).toBe('limited');
    expect(saved.report.report.reportLimitReasons).toEqual(['COUNTEREVIDENCE_PLAN_INVALID']);
    expect(calls).toBe(5);
    const app = await createApp(db, { origin, secure: false, executionApproved: false, model: 'test', image: 'test' });
    try {
      const login = await app.inject({ method: 'POST', url: '/api/v1/session/login', headers: { origin }, payload: { email: 'teacher@codelab.local', password } });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const response = await app.inject({ url: `/api/v2/projects/${p}`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().analyses.find((a: any) => a.id === id).report.report.analysisWarnings).toEqual(saved.report.report.analysisWarnings);
      expect(response.json().analyses.find((a: any) => a.id === id).report.report).toMatchObject({ reportQuality: 'limited', reportLimitReasons: ['COUNTEREVIDENCE_PLAN_INVALID'] });
      const library = await app.inject({ url: '/api/v2/projects', headers: { cookie } });
      expect(library.statusCode).toBe(200);
      expect(library.json().projects.find((item: any) => item.id === p)).toMatchObject({ status: 'succeeded', report_quality: 'limited' });
      expect(library.json().projects.find((item: any) => item.id === p)).not.toHaveProperty('quality');
    } finally { await app.close(); }
  });
  it('persists a budget-limited validated draft with honest quality and exact paid-call receipts', async () => {
    const { p, id } = await job({ version: 1, mode: 'quick', modules: [], cost: { inputPerMillion: 1, outputPerMillion: 1, limitCny: 1, label: 'fixture' } });
    let calls = 0;
    const budgetProvider: SummaryProviderV2 = { ...provider, complete: async request => {
      calls++;
      return { ...(await provider.complete(request)), usage: { inputTokens: calls === 1 ? 1 : 998_000, outputTokens: 0 } };
    } };
    await sourceWorkerTick(db, budgetProvider, new AbortController().signal);
    const saved = (await db.query('SELECT * FROM source_analyses WHERE id=$1', [id])).rows[0];
    expect(saved).toMatchObject({ status: 'succeeded', code: null });
    expect(saved.report.report).toMatchObject({ reportQuality: 'limited', reportLimitReasons: ['COST_BUDGET_LIMITED'] });
    expect(saved.report.report).not.toHaveProperty('verification');
    expect(saved.report.verification.completed).toBe(false);
    expect(calls).toBe(2);
    const ledger = (await db.query('SELECT state,usage FROM source_model_calls WHERE analysis_id=$1 ORDER BY call_no', [id])).rows;
    expect(ledger).toHaveLength(2);
    expect(ledger.map(call => call.state)).toEqual(['returned', 'returned']);
    expect(ledger[1].usage.inputTokens).toBe(998_000);
    const app = await createApp(db, { origin, secure: false, executionApproved: false, model: 'test', image: 'test' });
    try {
      const login = await app.inject({ method: 'POST', url: '/api/v1/session/login', headers: { origin }, payload: { email: 'teacher@codelab.local', password } });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const response = await app.inject({ url: `/api/v2/projects/${p}`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().analyses[0].report.report.reportQuality).toBe('limited');
      expect(response.json().analyses[0].modelUsage.registeredCalls).toBe(2);
      const library = await app.inject({ url: '/api/v2/projects', headers: { cookie } });
      expect(library.json().projects.find((item: any) => item.id === p).report_quality).toBe('limited');
    } finally { await app.close(); }
  });
  it("stores immutable mode snapshots and rejects malformed database options", async () => {
    const { p, id } = await job();
    expect(
      (
        await db.query(
          "SELECT analysis_options FROM source_analyses WHERE id=$1",
          [id],
        )
      ).rows[0].analysis_options,
    ).toBeNull();
    await db.query(
      "UPDATE source_analyses SET status='cancelled' WHERE id=$1",
      [id],
    );
    const deep = { version: 1, mode: "deep", modules: [] };
    const nextId = randomUUID();
    await db.query(
      "INSERT INTO source_analyses(id,project_id,status,analysis_options) VALUES($1,$2,'queued',$3)",
      [nextId, p, JSON.stringify(deep)],
    );
    await expect(
      db.query("UPDATE source_analyses SET analysis_options=$2 WHERE id=$1", [
        nextId,
        JSON.stringify({ ...deep, mode: "quick" }),
      ]),
    ).rejects.toThrow("immutable source analysis options");
    for (const options of [
      null,
      {},
      { version: 1, mode: null, modules: [] },
      { version: null, mode: "deep", modules: [] },
      { version: "1", mode: "deep", modules: [] },
      { version: 1, mode: "deep", modules: null },
      { version: 1, mode: "deep", modules: {} },
      { version: 1, mode: "deep", modules: Array(7).fill("a") },
    ]) {
      await expect(
        db.query(
          "INSERT INTO source_analyses(id,project_id,status,analysis_options) VALUES($1,$2,'cancelled',$3)",
          [randomUUID(), p, JSON.stringify(options)],
        ),
      ).rejects.toThrow();
    }
    const deepProvider = {
      ...provider,
      complete: async (input: Parameters<SummaryProviderV2["complete"]>[0]) =>
        JSON.parse(input.user).phase === "investigation"
          ? {
              content: JSON.stringify({
                goal: "核查入口",
                searches: [],
                reads: [{ path: cite.path, start: 1, count: 10 }],
              }),
              raw: "fixture",
              requestId: null,
              usage: null,
            }
          : provider.complete(input),
    };
    await sourceWorkerTick(db, deepProvider, new AbortController().signal);
    const a = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [nextId])
    ).rows[0];
    expect(a.status).toBe("succeeded");
    expect(a.analysis_options).toEqual(deep);
    expect(a.report.analysisOptions).toEqual(deep);
    expect(a.report.investigation).toHaveLength(2);
    expect(
      new Date(a.deadline).getTime() - new Date(a.started_at).getTime(),
    ).toBe(840000);
  });
  it("validates focus selection, freezes active options, and preserves history on reanalysis", async () => {
    const { p, id } = await job();
    await db.query(
      "UPDATE source_analyses SET status='cancelled' WHERE id=$1",
      [id],
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pausedProvider = {
      ...provider,
      complete: async (input: Parameters<SummaryProviderV2["complete"]>[0]) => {
        await gate;
        return provider.complete(input);
      },
    };
    const app = await createApp(db, {
      origin,
      secure: false,
      executionApproved: false,
      model: "test",
      image: "test",
      sourceProvider: pausedProvider,
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/session/login",
        headers: { origin },
        payload: { email: "teacher@codelab.local", password },
      });
      const headers = {
        origin,
        cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-csrf-token": login.json().csrf,
      };
      const post = (payload: unknown) =>
        app.inject({
          method: "POST",
          url: `/api/v2/projects/${p}/analyze`,
          headers,
          payload: payload as any,
        });
      for (const payload of [
        { mode: "deep", modules: ["foreign"] },
        { mode: "quick", modules: ["."] },
        { mode: "deep", modules: [".", "."] },
        { mode: "bad" },
      ])
        expect((await post(payload)).statusCode).toBe(400);
      const options = { version: 1, mode: "deep", modules: ["."] };
      const first = await post(options);
      expect(first.statusCode).toBe(200);
      expect((await post(options)).json().id).toBe(first.json().id);
      expect((await post({ mode: "quick" })).statusCode).toBe(409);
      const detail = (
        await app.inject({ url: `/api/v2/projects/${p}`, headers })
      ).json();
      expect(detail.modules).toMatchObject([{ id: ".", fileCount: 1 }]);
      expect(
        detail.analyses.find((a: any) => a.id === first.json().id)
          .execution_snapshot,
      ).toEqual(sourceExecutionSnapshot(pausedProvider));
      expect(
        detail.analyses.find((a: any) => a.id === first.json().id)
          .analysis_options,
      ).toEqual(options);
      expect(
        detail.analyses.find((a: any) => a.id === id).analysis_options,
      ).toBeNull();
      const cancel = await app.inject({
        method: "POST",
        url: `/api/v2/projects/${p}/cancel`,
        headers,
        payload: { analysisId: first.json().id },
      });
      expect(cancel.statusCode).toBe(200);
      expect((await post({ mode: "quick" })).statusCode).toBe(200);
    } finally {
      release();
      await app.close();
      await db.query(
        "UPDATE source_analyses SET status='cancelled' WHERE project_id=$1 AND status IN ('queued','running')",
        [p],
      );
    }
  });
  it.runIf(!!process.env.CODELAB_TEST_POSTGRES_URL)(
    "deduplicates simultaneous analysis submissions across independent API connections",
    async () => {
      const { p, id } = await job();
      await db.query("UPDATE source_analyses SET status='cancelled' WHERE id=$1", [id]);
      const peer = db.connectPeer();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const pausedProvider: SummaryProviderV2 = {
        ...provider,
        complete: async input => { await gate; return provider.complete(input); },
      };
      const config = { origin, secure: false, executionApproved: false,
        model: "test", image: "test", sourceProvider: pausedProvider };
      const firstApp = await createApp(db, config);
      const secondApp = await createApp(peer, config);
      try {
        const login = await firstApp.inject({ method: "POST", url: "/api/v1/session/login",
          headers: { origin }, payload: { email: "teacher@codelab.local", password } });
        expect(login.statusCode).toBe(200);
        const headers = { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '),
          "x-csrf-token": login.json().csrf };
        const submit = (app: typeof firstApp, mode = "quick") => app.inject({
          method: "POST", url: `/api/v2/projects/${p}/analyze`, headers,
          payload: { mode },
        });
        const results = await Promise.all([submit(firstApp), submit(secondApp)]);
        expect(results.map(r => r.statusCode)).toEqual([200, 200]);
        expect(results[0].json().id).toBe(results[1].json().id);
        expect(results.map(r => r.json().analysisDisposition).sort()).toEqual(["active", "queued"]);
        const records = await db.query("SELECT id FROM source_analyses WHERE project_id=$1 AND id<>$2", [p, id]);
        expect(records.rows.map(r => r.id)).toEqual([results[0].json().id]);
        // A second tab changing mode must not replace or create additional paid work.
        expect((await submit(secondApp, "deep")).statusCode).toBe(409);
        const detail = await secondApp.inject({ url: `/api/v2/projects/${p}`, headers });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().analyses.filter((a: any) => a.id !== id)).toHaveLength(1);
      } finally {
        release();
        await Promise.all([firstApp.close(), secondApp.close()]);
        await peer.close();
        await db.query("UPDATE source_analyses SET status='cancelled' WHERE project_id=$1 AND status IN ('queued','running')", [p]);
      }
    },
  );
  it("persists report/events and finishes one source analysis", async () => {
    const { id } = await job();
    await sourceWorkerTick(db, provider, new AbortController().signal);
    const a = (
      await db.query("SELECT * FROM source_analyses WHERE id=$1", [id])
    ).rows[0];
    expect(a.status).toBe("succeeded");
    expect(a.events).toHaveLength(9);
    expect(a.report.report.modules[0].citations[0]).toEqual(cite);
  });
  it.runIf(!!process.env.CODELAB_TEST_POSTGRES_URL)(
    "keeps a second worker out while another connection owns a running source analysis",
    async () => {
      const first = await job(),
        second = await job();
      const peer = db.connectPeer();
      let started!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const slow = {
        ...provider,
        complete: async (
          input: Parameters<SummaryProviderV2["complete"]>[0],
        ) => {
          calls++;
          if (calls === 1) {
            started();
            await gate;
          }
          return provider.complete(input);
        },
      };
      const pending = sourceWorkerTick(db, slow, AbortSignal.timeout(10000));
      try {
        await Promise.race([
          entered,
          pending.then(() => {
            throw new Error("Worker did not enter provider");
          }),
        ]);
        let peerCalls = 0;
        const skipped = await sourceWorkerTick(
          peer,
          {
            ...provider,
            complete: async (input) => {
              peerCalls++;
              return provider.complete(input);
            },
          },
          AbortSignal.timeout(10000),
        );
        expect(skipped).toBe(false);
        expect(peerCalls).toBe(0);
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM source_analyses WHERE status='running'",
            )
          ).rows[0].n,
        ).toBe(1);
        release();
        await pending;
        await sourceWorkerTick(peer, provider, AbortSignal.timeout(10000));
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM source_analyses WHERE id IN ($1,$2) AND status='succeeded'",
              [first.id, second.id],
            )
          ).rows[0].n,
        ).toBe(2);
      } finally {
        release();
        await pending;
        await peer.close();
      }
    },
  );
  it("cancellation prevents late results from resurrecting the job", async () => {
    const { id } = await job();
    const cancelling = {
      ...provider,
      complete: async (input: Parameters<SummaryProviderV2["complete"]>[0]) => {
        await db.query(
          "UPDATE source_analyses SET status='cancelled' WHERE id=$1",
          [id],
        );
        return provider.complete(input);
      },
    };
    await sourceWorkerTick(db, cancelling, new AbortController().signal);
    expect(
      (
        await db.query(
          "SELECT status,report FROM source_analyses WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ status: "cancelled", report: null });
  });
  it("expires interrupted owners without replaying the model call", async () => {
    const { id } = await job();
    await db.query(
      "UPDATE source_analyses SET status='running',deadline=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    let calls = 0;
    await sourceWorkerTick(
      db,
      {
        ...provider,
        complete: async (i) => {
          calls++;
          return provider.complete(i);
        },
      },
      new AbortController().signal,
    );
    expect(calls).toBe(0);
    expect(
      (await db.query("SELECT code FROM source_analyses WHERE id=$1", [id]))
        .rows[0].code,
    ).toBe("INTERRUPTED");
  });
  it("protects project detail and source from another user and requires CSRF", async () => {
    const { p, id } = await job();
    await db.query(
      "UPDATE source_analyses SET status='cancelled' WHERE id=$1",
      [id],
    );
    const app = await createApp(db, {
      origin,
      secure: false,
      executionApproved: false,
      model: "test",
      image: "test",
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/session/login",
        headers: { origin },
        payload: { email: "student@codelab.local", password },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      expect(
        (
          await app.inject({
            url: `/api/v2/projects/${p}`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: `/api/v2/projects/${p}/source?path=hello/app.py`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v2/projects/${p}/cancel`,
            headers: { cookie, origin },
            payload: { analysisId: id },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({ url: "/api/v2/projects", headers: { cookie } })
        ).json().projects,
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });
  it('binds cited source to its report project even when versions have identical file paths', async () => {
    const first = await job();
    const secondProject = randomUUID();
    const secondAnalysis = randomUUID();
    await db.query('INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,$3,$4,$5,$6)',
      [secondProject, owner, 'hello.zip', secondProject, JSON.stringify({ 'hello/app.py': 'print("version two")' }), '[]']);
    await db.query("INSERT INTO source_analyses(id,project_id,status) VALUES($1,$2,'cancelled')", [secondAnalysis, secondProject]);
    const app = await createApp(db, { origin, secure: false, executionApproved: false, model: 'test', image: 'test' });
    try {
      const login = await app.inject({ method: 'POST', url: '/api/v1/session/login', headers: { origin },
        payload: { email: 'teacher@codelab.local', password } });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const get = (project: string, analysis: string) => app.inject({
        url: `/api/v2/projects/${project}/source?path=hello/app.py&analysisId=${analysis}`, headers: { cookie },
      });
      const oldSource = await get(first.p, first.id);
      expect(oldSource.statusCode).toBe(200);
      expect(oldSource.json()).toMatchObject({ projectId: first.p, analysisId: first.id, content: 'print("hi")' });
      const newSource = await get(secondProject, secondAnalysis);
      expect(newSource.statusCode).toBe(200);
      expect(newSource.json().content).toBe('print("version two")');
      expect((await get(secondProject, first.id)).statusCode).toBe(404);
      expect((await get(first.p, secondAnalysis)).statusCode).toBe(404);
      expect((await get(first.p, randomUUID())).statusCode).toBe(404);
      const snippet = await app.inject({ url: `/api/v2/projects/${secondProject}/source?path=hello/app.py&analysisId=${secondAnalysis}&start=1&end=1`, headers: { cookie } });
      expect(snippet.statusCode).toBe(200);
      expect(snippet.json()).toMatchObject({ content: 'print("version two")', startLine: 1, totalLines: 1, analysisId: secondAnalysis });
      expect((await app.inject({ url: `/api/v2/projects/${secondProject}/source?path=hello/app.py&analysisId=${first.id}&start=1&end=1`, headers: { cookie } })).statusCode).toBe(404);
      expect((await app.inject({ url: `/api/v2/projects/${first.p}/source?path=hello/app.py&start=0&end=1`, headers: { cookie } })).statusCode).toBe(400);
      const citation = { path: 'hello/app.py', start: 1, end: 1 };
      const readingBrief = { version: 1, purpose: { text: '输出固定文本', sourceRefs: [{ section: 'modules', index: 0 }], citations: [citation] } };
      const enhancedReport = { overview: '输出工具', stack: [], modules: [{ title: '入口', body: '输出文本', citations: [citation] }], flows: [], findings: [], readingPath: [], limitations: ['未执行'], readingBrief };
      await db.query("UPDATE source_analyses SET status='succeeded',report=$2 WHERE id=$1", [first.id, JSON.stringify({ report: enhancedReport })]);
      const restored = (await app.inject({ url: `/api/v2/projects/${first.p}`, headers: { cookie } })).json();
      expect(restored.analyses.find((a: any) => a.id === first.id).report.report.readingBrief).toEqual(readingBrief);
    } finally { await app.close(); }
  });
  it("uploads directly and deduplicates retries, with no task or template", async () => {
    const app = await createApp(db, {
      origin,
      secure: false,
      executionApproved: false,
      model: "test",
      image: "test",
      sourceProvider: provider,
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/session/login",
        headers: { origin },
        payload: { email: "student@codelab.local", password },
      });
      const cookie = login.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const csrf = login.json().csrf;
      const boundary = "source_test_boundary";
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="python.zip"\r\nContent-Type: application/zip\r\n\r\n`,
        ),
        Buffer.from(
          zipSync(
            {
              "hello/app.py": strToU8('print("hello")'),
              "photo.png": new Uint8Array(11 * 1024 * 1024),
            },
            { level: 0 },
          ),
        ),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const upload = () =>
        app.inject({
          method: "POST",
          url: "/api/v2/projects",
          headers: {
            cookie,
            origin,
            "x-csrf-token": csrf,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          payload,
        });
      const first = await upload();
      expect(first.statusCode).toBe(201);
      expect((await upload()).json().id).toBe(first.json().id);
      const detail = await app.inject({
        url: `/api/v2/projects/${first.json().id}`,
        headers: { cookie },
      });
      expect(detail.json().files).toEqual([{ path: "hello/app.py", lines: 1 }]);
      expect(detail.json().analyses).toHaveLength(1);
      expect(detail.json().analyses[0].execution_snapshot).toEqual(
        sourceExecutionSnapshot(provider),
      );
      expect(detail.json().omitted).toEqual([
        { path: "photo.png", reason: "非源码文件" },
      ]);
      const before = (
        await db.query("SELECT count(*)::int AS n FROM source_projects")
      ).rows[0].n;
      const extraPart = Buffer.concat([
        payload.subarray(
          0,
          payload.length - Buffer.byteLength(`--${boundary}--\r\n`),
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\nnot allowed\r\n--${boundary}--\r\n`,
        ),
      ]);
      const invalid = await app.inject({
        method: "POST",
        url: "/api/v2/projects",
        headers: {
          cookie,
          origin,
          "x-csrf-token": csrf,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: extraPart,
      });
      expect(invalid.statusCode).toBe(413);
      expect(
        (await db.query("SELECT count(*)::int AS n FROM source_projects"))
          .rows[0].n,
      ).toBe(before);
    } finally {
      await app.close();
    }
  });
});
