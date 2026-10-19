import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { runnerResponseSchema, type Evidence } from "@codelab/contracts";
import { postgres, type DB } from "./db.js";
import { claim, ownedUpdate } from "./queue.js";
import { analyze, fallback } from "./agent.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./template.js";
import { readWorkerConfig } from "./config.js";
export const artifactRoot = () =>
  path.resolve(process.env.DATA_DIR ?? path.join(root, ".data"), "evidence");
export async function processNext(db: DB, checkpointer?: PostgresSaver) {
  const run = await claim(db);
  if (!run) return false;
  const audit = async (kind: string, payload: unknown) => {
    await db.query(
      "INSERT INTO events(run_id,kind,payload) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM runs WHERE id=$1 AND lease_token=$4)",
      [run.id, kind, JSON.stringify(payload), run.lease_token],
    );
  };
  const submission = (
    await db.query(
      "SELECT s.*,ru.criteria,ru.template_version FROM submissions s JOIN rules ru ON ru.id=s.rule_id WHERE s.id=$1",
      [run.submission_id],
    )
  ).rows[0];
  const runnerURL = process.env.RUNNER_URL ?? "http://127.0.0.1:3200";
  const runner = async (endpoint: string, body: unknown, timeout = 165000) => {
    const response = await fetch(runnerURL + endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(timeout),
      headers: {
        Authorization: `Bearer ${process.env.RUNNER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("执行服务请求失败 " + response.status);
    const txt = await response.text();
    if (txt.length > 16 * 1024 * 1024) throw new Error("证据总量超限");
    return JSON.parse(txt);
  };
  try {
    await audit("building", {});
    const result = runnerResponseSchema.parse(
      await runner("/execute", {
        id: run.id,
        attempt: run.lease_token,
        files: submission.files,
        criteria: submission.criteria,
        templateVersion: submission.template_version,
      }),
    );
    const ids = new Set(result.evidence.map((e) => e.id));
    if (
      ids.size !== result.evidence.length ||
      result.results.length !== submission.criteria.length ||
      new Set(result.results.map((r) => r.criterionId)).size !==
        result.results.length ||
      result.results.some(
        (r) =>
          !submission.criteria.some((c: any) => c.id === r.criterionId) ||
          r.evidenceIds.some((id) => !ids.has(id)),
      )
    )
      throw new Error("执行结果契约不一致");
    for (const e of result.evidence) {
      if (e.kind === "screenshot") {
        const png = result.screenshots[e.id];
        if (
          !png ||
          png.length > 1500000 ||
          !Buffer.from(png, "base64")
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error("截图格式或大小不合法");
        const filename = `${run.id}/${run.lease_token}/${e.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
        await mkdir(path.dirname(path.join(artifactRoot(), filename)), {
          recursive: true,
        });
        await writeFile(
          path.join(artifactRoot(), filename),
          Buffer.from(png, "base64"),
        );
        e.file = filename;
      } else delete e.file;
    }
    const deterministic = fallback(result.results);
    const saved = await ownedUpdate(
      db,
      run.id,
      run.lease_token,
      "status=$3,outcome=$4,results=$5,evidence=$6,feedback=$7",
      [
        result.outcome === "infra_error" ? "infra_error" : "analyzing",
        result.outcome,
        JSON.stringify(result.results),
        JSON.stringify(result.evidence),
        JSON.stringify(deterministic),
      ],
    );
    if (!saved) return true;
    if (result.outcome === "infra_error") {
      await ownedUpdate(
        db,
        run.id,
        run.lease_token,
        "finished_at=now(),lease_token=NULL,lease_until=NULL",
      );
      await audit("infra_error", {});
      return true;
    }
    await audit("analyzing", {});
    const prior = (
      await db.query(
        "SELECT r.results,s.files FROM runs r JOIN submissions s ON s.id=r.submission_id WHERE s.task_id=$1 AND s.user_id=$2 AND s.rule_id=$3 AND s.created_at<$4 AND r.status='published' ORDER BY s.created_at DESC LIMIT 1",
        [
          submission.task_id,
          submission.user_id,
          submission.rule_id,
          submission.created_at,
        ],
      )
    ).rows[0];
    const ctx = {
      runId: run.id,
      criteria: submission.criteria,
      results: result.results,
      evidence: result.evidence as Evidence[],
      files: submission.files,
      previous: prior
        ? {
            results: prior.results,
            changedFiles: Object.keys(submission.files).filter(
              (f) =>
                f.startsWith("src/") && submission.files[f] !== prior.files[f],
            ),
          }
        : undefined,
      audit,
      probe: async (actions: any, actionId: string) => {
        const p = await runner(
          "/probe",
          { id: run.id, attempt: run.lease_token, actionId, ...actions },
          15000,
        );
        return {
          id: actionId,
          kind: "probe" as const,
          title: "补充浏览器观察",
          text: JSON.stringify(p).slice(0, 16000),
        };
      },
    };
    const report = await analyze(ctx, {
      model: process.env.MODEL_NAME,
      baseURL: process.env.MODEL_BASE_URL,
      apiKey: process.env.MODEL_API_KEY,
      checkpointer,
    });
    await audit("review", { modelStatus: report.status });
    await ownedUpdate(
      db,
      run.id,
      run.lease_token,
      "status='review',feedback=$3,evidence=$4,model_status=$5,finished_at=now(),lease_token=NULL,lease_until=NULL",
      [
        JSON.stringify(report.feedback),
        JSON.stringify(ctx.evidence),
        report.status,
      ],
    );
  } catch (e) {
    await audit("infra_error", { message: String(e).slice(0, 500) });
    const unexecuted = submission.criteria.map((c: any) => ({
      criterionId: c.id,
      status: "not_run",
      observation: "执行环境故障，本次无法判断。",
      steps: [],
      evidenceIds: [],
    }));
    await ownedUpdate(
      db,
      run.id,
      run.lease_token,
      "status='infra_error',outcome='infra_error',results=$3,feedback=$4,model_status='not_started',finished_at=now(),lease_token=NULL,lease_until=NULL",
      [JSON.stringify(unexecuted), JSON.stringify(fallback(unexecuted))],
    );
  } finally {
    try {
      await runner("/cleanup", { id: run.id, attempt: run.lease_token }, 10000);
    } catch {
      /* runner has independent expiration */
    }
  }
  return true;
}
if (process.argv[1]?.endsWith("worker.ts")) {
  const config = readWorkerConfig();
  const db = postgres(config.DATABASE_URL);
  let saver: PostgresSaver | undefined;
  if (process.env.MODEL_API_KEY) {
    saver = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
    await saver.setup();
  }
  let stop = false;
  process.on("SIGTERM", () => {
    stop = true;
  });
  process.on("SIGINT", () => {
    stop = true;
  });
  while (!stop) {
    try {
      if (!(await processNext(db, saver)))
        await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      console.error("Worker error", e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await db.close();
  await saver?.end();
}
