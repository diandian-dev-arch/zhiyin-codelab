import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// This check starts only an isolated local API. Worker and runner must reject
// disabled execution before reaching PostgreSQL, Docker or any model service.
const scratch = await mkdtemp(path.join(tmpdir(), "codelab-service-smoke-"));
const children: ChildProcess[] = [];
function launch(entry: string, overrides: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    windowsHide: true,
    env: { ...process.env, MODEL_API_KEY: "", SEED_PASSWORD: "", ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (data) => { output = (output + data.toString()).slice(-16000); });
  child.stderr?.on("data", (data) => { output = (output + data.toString()).slice(-16000); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { child, output: () => output, exit };
}
async function requireGuard(entry: string, env: NodeJS.ProcessEnv, expected: string) {
  const proc = launch(entry, env);
  const timeout = setTimeout(() => proc.child.kill(), 15000);
  try {
    const code = await proc.exit;
    if (code === 0 || !proc.output().includes(expected)) throw new Error(`${entry}: 启动守卫未按预期拒绝`);
    console.log(`PASS ${entry}: 依赖加载成功，未配置/未批准时拒绝启动`);
  } finally { clearTimeout(timeout); }
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配测试端口");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
try {
  await requireGuard("apps/api/src/main.ts", { DATABASE_URL: "" }, "配置无效");
  await requireGuard("apps/api/src/worker.ts", { EXECUTION_APPROVED: "false" }, "worker 拒绝启动");
  await requireGuard("apps/runner/src/server.ts", { RUNNER_APPROVED: "false" }, "Runner 仅在专用 Linux");
  await requireGuard("apps/api/src/worker-v2.ts", { EXECUTION_APPROVED: "false" }, "EXECUTION_NOT_APPROVED");
  await requireGuard("apps/runner/src/server-v2.ts", { RUNNER_APPROVED: "false" }, "Runner 仅在专用 Linux");
  const port = await freePort();
  const proc = launch("scripts/local.ts", { API_PORT: String(port), LOCAL_DB_DIR: path.join(scratch, "postgres") });
  let healthy = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null) throw new Error("本地 API 提前退出");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json() as { ok?: boolean; executionApproved?: boolean };
      if (response.ok && body.ok === true && body.executionApproved === false) { healthy = true; break; }
    } catch { /* API and isolated PGlite are still starting. */ }
    await delay(150);
  }
  if (!healthy) throw new Error("本地 API 未在期限内返回健康且执行关闭的状态");
  console.log("PASS local API: 独立端口、临时数据库、真实 HTTP 200、执行入口关闭");
  proc.child.kill();
  await proc.exit;
  console.log("BOUNDARY: 不代表 worker 实际取单、Linux runner 或容器镜像已通过验收。");
} finally {
  await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) =>
    new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); })));
  // The target is the exact directory returned by mkdtemp above, never a user path.
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
