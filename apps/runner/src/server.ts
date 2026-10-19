import Fastify from "fastify";
import { z } from "zod";
import {
  criterionSchema,
  probeSchema,
  type Criterion,
  type RunnerResponse,
} from "@codelab/contracts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readRunnerConfig } from "./config.js";
const exec = promisify(execFile);
const config = readRunnerConfig();
const base = path.resolve(config.RUNNER_DATA_DIR);
const token = config.RUNNER_TOKEN;
const schema = z.object({ id: z.string().uuid(), attempt: z.string().uuid() });
type Job = {
  key: string;
  dir: string;
  network: string;
  timer: NodeJS.Timeout;
  probeCount: number;
  cache: Map<string, unknown>;
  started: number;
  busy: boolean;
};
const jobs = new Map<string, Job>();
async function docker(args: string[], timeout = 10000) {
  return (
    await exec("docker", args, {
      timeout,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
    })
  ).stdout;
}
const name = (key: string, kind: string) => `codelab-${key}-${kind}`;
async function cleanup(key: string) {
  const j = jobs.get(key);
  if (!j) return;
  clearTimeout(j.timer);
  for (const k of ["build", "web", "test", "probe"])
    try {
      await docker(["rm", "-f", name(key, k)]);
    } catch {}
  try {
    await docker(["network", "rm", j.network]);
  } catch {}
  await rm(j.dir, { recursive: true, force: true });
  jobs.delete(key);
}
const limits = [
  "--user",
  "1000:1000",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--pids-limit",
  "128",
  "--cpus",
  "1",
];
const failResult = (
  criteria: Criterion[],
  outcome: "build_error" | "infra_error",
  text: string,
): RunnerResponse => ({
  outcome,
  results: criteria.map((c) => ({
    criterionId: c.id,
    status: "not_run",
    observation:
      outcome === "build_error"
        ? "项目构建未成功，功能检查未执行。"
        : "执行环境故障，无法判断项目功能。",
    steps: [],
    evidenceIds: ["execution-log"],
  })),
  evidence: [
    {
      id: "execution-log",
      kind: "log",
      title: outcome === "build_error" ? "构建日志" : "执行故障",
      text: text.slice(0, 16000),
    },
  ],
  screenshots: {},
});
const app = Fastify({ bodyLimit: 75 * 1024 * 1024, logger: true });
app.addHook("onRequest", async (req, reply) => {
  const provided = Buffer.from(req.headers.authorization ?? ""),
    expected = Buffer.from("Bearer " + token);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    return reply.code(401).send({ error: "unauthorized" });
});
app.setErrorHandler((e, req, reply) => {
  reply
    .code(e instanceof z.ZodError ? 400 : 500)
    .send({
      error: e instanceof z.ZodError ? "invalid request" : "runner failed",
    });
});
app.get("/health", () => ({ ok: true, active: jobs.size }));
app.post("/execute", async (req, reply) => {
  const b = schema
    .extend({
      files: z.record(z.string()),
      criteria: z.array(criterionSchema).max(15),
      templateVersion: z.literal("vue-board-v1"),
    })
    .parse(req.body);
  const key = b.attempt;
  if (jobs.size) {
    reply.code(409);
    return { error: "runner busy; retry as a new run" };
  }
  if (Object.keys(b.files).length > 2000)
    return reply.code(400).send({ error: "file count exceeded" });
  const dir = path.join(base, key),
    network = name(key, "network");
  const job: Job = {
    key,
    dir,
    network,
    timer: setTimeout(() => void cleanup(key), 300000),
    probeCount: 0,
    cache: new Map(),
    started: Date.now(),
    busy: true,
  };
  jobs.set(key, job);
  try {
    await mkdir(path.join(dir, "source"), { recursive: true, mode: 0o755 });
    await mkdir(path.join(dir, "dist"), { mode: 0o777 });
    await mkdir(path.join(dir, "evidence"), { mode: 0o777 });
    await chmod(path.join(dir, "dist"), 0o777);
    await chmod(path.join(dir, "evidence"), 0o777);
    let size = 0;
    for (const [file, encoded] of Object.entries(b.files)) {
      if (!file.startsWith("src/") && !file.startsWith("public/")) continue;
      if (
        !/^(src|public)\/[a-zA-Z0-9_./-]+$/.test(file) ||
        file.split("/").some((s) => s === ".." || s === ".")
      )
        throw new Error("unsafe filename");
      const bytes = Buffer.from(encoded, "base64");
      size += bytes.length;
      if (size > 50 * 1024 * 1024 || bytes.length > 2 * 1024 * 1024)
        throw new Error("file size exceeded");
      const target = path.join(dir, "source", file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o644 });
    }
    await writeFile(
      path.join(dir, "criteria.json"),
      JSON.stringify(b.criteria),
    );
    const buildArgs = [
      "run",
      "--name",
      name(key, "build"),
      "--label",
      "codelab.managed=true",
      "--network",
      "none",
      ...limits,
      "--memory",
      "1024m",
      "--memory-swap",
      "1024m",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=32m",
      "--tmpfs",
      "/workspace:rw,nosuid,size=256m,uid=1000,gid=1000",
      "--mount",
      `type=bind,src=${path.join(dir, "source")},dst=/submission,readonly`,
      "--mount",
      `type=bind,src=${path.join(dir, "dist")},dst=/out`,
      "codelab-build:vue-board-v1",
    ];
    let buildLog = "";
    try {
      buildLog = await docker(buildArgs, 60000);
    } catch (e: any) {
      const inspect = await docker([
        "inspect",
        "--format",
        "{{json .State}}",
        name(key, "build"),
      ]).catch(() => null);
      const state = inspect ? JSON.parse(inspect) : null;
      const outcome =
        state && !state.OOMKilled && !e.killed && state.ExitCode !== 125
          ? "build_error"
          : "infra_error";
      await cleanup(key);
      return failResult(b.criteria, outcome, String(e.stderr ?? e.message));
    }
    await docker(["rm", "-f", name(key, "build")]);
    await docker([
      "network",
      "create",
      "--internal",
      "--label",
      "codelab.managed=true",
      network,
    ]);
    await docker(
      [
        "run",
        "-d",
        "--name",
        name(key, "web"),
        "--label",
        "codelab.managed=true",
        "--network",
        network,
        "--network-alias",
        "project",
        ...limits,
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--mount",
        `type=bind,src=${path.join(dir, "dist")},dst=/site,readonly`,
        "codelab-web:vue-board-v1",
      ],
      20000,
    );
    await browser(job, "test", path.join(dir, "criteria.json"), 90000);
    const result = JSON.parse(
      await readFile(path.join(dir, "evidence", "result.json"), "utf8"),
    ) as RunnerResponse;
    result.evidence.push({
      id: "build-log",
      kind: "log",
      title: "构建日志",
      text: buildLog.slice(0, 16000),
    });
    for (const entry of result.evidence)
      if (entry.kind === "screenshot") {
        const filename = path.join(dir, "evidence", entry.id + ".png");
        const bytes = await readFile(filename);
        if (bytes.length > 1000000) throw new Error("screenshot too large");
        result.screenshots[entry.id] = bytes.toString("base64");
      }
    job.busy = false;
    return result;
  } catch (e: any) {
    await cleanup(key);
    return failResult(b.criteria, "infra_error", String(e.stderr ?? e.message));
  }
});
async function browser(
  job: Job,
  kind: "test" | "probe",
  input: string,
  timeout: number,
) {
  return docker(
    [
      "run",
      "--name",
      name(job.key, kind),
      "--label",
      "codelab.managed=true",
      "--network",
      job.network,
      ...limits,
      "--memory",
      "1536m",
      "--memory-swap",
      "1536m",
      "--shm-size",
      "256m",
      "--tmpfs",
      "/tmp:rw,nosuid,size=256m,uid=1000,gid=1000",
      "--mount",
      `type=bind,src=${input},dst=/input.json,readonly`,
      "--mount",
      `type=bind,src=${path.join(job.dir, "evidence")},dst=/evidence`,
      "codelab-browser:1.58.2",
      kind,
    ],
    timeout,
  );
}
app.post("/probe", async (req, reply) => {
  const b = schema
    .extend({
      actionId: z.string().regex(/^agent-[1-8]$/),
      actions: probeSchema.shape.actions,
    })
    .parse(req.body);
  const j = jobs.get(b.attempt);
  if (!j || j.busy || Date.now() - j.started > 280000)
    return reply.code(409).send({ error: "probe environment unavailable" });
  if (j.cache.has(b.actionId)) return j.cache.get(b.actionId);
  if (j.probeCount >= 2) return reply.code(429).send({ error: "probe limit" });
  j.probeCount++;
  j.busy = true;
  try {
    const input = path.join(j.dir, "probe.json");
    await writeFile(input, JSON.stringify({ actions: b.actions }));
    await browser(j, "probe", input, 12000);
    const output = JSON.parse(
      await readFile(path.join(j.dir, "evidence", "probe.json"), "utf8"),
    );
    j.cache.set(b.actionId, output);
    return output;
  } finally {
    await docker(["rm", "-f", name(j.key, "probe")]).catch(() => {});
    j.busy = false;
  }
});
app.post("/cleanup", async (req) => {
  const b = schema.parse(req.body);
  await cleanup(b.attempt);
  return { ok: true };
});
// Reclaim tagged remnants before accepting work after a VM/runner restart. Dedicated VM only.
for (const id of (
  await docker(["ps", "-aq", "--filter", "label=codelab.managed=true"])
)
  .split(/\s+/)
  .filter(Boolean))
  await docker(["rm", "-f", id]);
for (const id of (
  await docker([
    "network",
    "ls",
    "-q",
    "--filter",
    "label=codelab.managed=true",
  ])
)
  .split(/\s+/)
  .filter(Boolean))
  await docker(["network", "rm", id]);
await mkdir(base, { recursive: true });
for (const dir of await readdir(base))
  if (z.string().uuid().safeParse(dir).success)
    await rm(path.join(base, dir), { recursive: true, force: true });
await app.listen({
  host: config.RUNNER_HOST,
  port: config.RUNNER_PORT,
});
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    await app.close();
    for (const key of jobs.keys()) await cleanup(key);
    process.exit(0);
  });
