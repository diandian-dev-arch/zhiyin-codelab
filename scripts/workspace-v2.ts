// Persistent workspace for authorized team samples; LAN sharing is opt-in.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { postgres } from "../apps/api/src/db.js";
import { migrateWorkspace } from './workspace-migration-policy.js';
import { seed } from "../apps/api/src/seed.js";
import { createApp } from "../apps/api/src/app.js";
import { ArtifactStore } from "../apps/api/src/artifacts-v2.js";
import { loadRuntimeCatalogV2 } from "../apps/api/src/runtime-catalog-v2.js";
import { createRunnerClientV2 } from "../apps/api/src/runner-client-v2.js";
import { runWorkerV2Loop } from "../apps/api/src/worker-v2.js";
import { createUserModelService, loadModelVaultKey } from "../apps/api/src/user-model-settings.js";
import { root } from "../apps/api/src/template.js";
import {
  createStorageAdmission,
  assertStorageHeadroom,
  StorageAdmissionError,
} from "../apps/runner/src/storage-admission.js";
import { readInitialAnalysisModeV2 } from "../apps/api/src/analysis-mode-v2.js";
import { createWorkspaceShutdown } from "./workspace-shutdown.js";
import { withWorkspaceStartup } from "./workspace-startup.js";
import { installWorkspaceLifecycle } from "./workspace-lifecycle.js";
import { assertWorkspaceRuntime } from './workspace-runtime.js';
import { workspaceDatabaseTarget, assertDatabaseTarget } from './workspace-database-target.js';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';

assertWorkspaceRuntime();

let lanAddress: string | undefined;
try {
  const config = JSON.parse(await readFile(path.join(root, '.data/workspace-lan.json'), 'utf8'));
  if (config.enabled === true) {
    if (typeof config.address !== 'string' || !isIPv4(config.address) ||
        !Object.values(networkInterfaces()).flat().some(n => n && n.address === config.address && !n.internal))
      throw new Error('WORKSPACE_LAN_ADDRESS_INVALID');
    lanAddress = config.address;
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const directory = path.join(root, ".data/business-v2");
const lifecycle = installWorkspaceLifecycle(directory);
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
const { createServer } = await import(
  pathToFileURL(webRequire.resolve("vite")).href
);
const databaseTarget = await workspaceDatabaseTarget(root);
const name = databaseTarget.name;
const ownership = "codelab.workspace=v2";
const exec = promisify(execFile);
async function docker(args: string[], env = process.env) {
  try {
    return (
      await exec("docker", args, { env, windowsHide: true, timeout: 60000 })
    ).stdout;
  } catch {
    // Docker errors can echo secret environment values; never print the command.
    throw new Error(
      "WORKSPACE_DOCKER_FAILED: check Docker Desktop and project container status",
    );
  }
}

await mkdir(directory, { recursive: true });
const credential = await (async () => {
  try {
    const value = JSON.parse(await readFile(path.join(root, '.data/desktop-runner/credentials.json'), 'utf8'));
    if (typeof value.url !== 'string' || typeof value.token !== 'string' || !value.token)
      throw new Error('INVALID');
    return value;
  } catch {
    throw new Error('WORKSPACE_RUNNER_SETUP_REQUIRED: 请先按 docs/REPRODUCE.md 安装并启动 Docker Desktop，构建执行镜像，再运行 pnpm runner:desktop up；不要创建空凭据文件。');
  }
})();
const runtime = await loadRuntimeCatalogV2(
  path.join(root, ".data/desktop-runner/runtime-catalog.json"),
);
const capabilities = await fetch(credential.url + "/v2/capabilities", {
  headers: { authorization: `Bearer ${credential.token}` },
  signal: AbortSignal.timeout(5000),
}).catch(() => { throw new Error('WORKSPACE_RUNNER_UNREACHABLE: 请运行 pnpm runner:desktop status 核对执行器状态。'); });
if (!capabilities.ok || (await capabilities.json()).state !== "ready")
  throw new Error("WORKSPACE_RUNNER_NOT_READY: 请运行 pnpm runner:desktop status，确认执行器就绪。");
const existing = (
  await docker(["ps", "-aq", "--filter", `name=^/${name}$`])
).trim();
if (databaseTarget.id && !existing)
  throw new Error('WORKSPACE_DATABASE_TARGET_REPLACED');
const secretFile = path.join(directory, "development-credentials.json");
let secrets: { databasePassword: string; loginPassword: string };
try {
  secrets = JSON.parse(await readFile(secretFile, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  if (existing) throw new Error('WORKSPACE_DATABASE_CREDENTIALS_MISSING: 已存在同名数据库，但当前目录没有对应凭据。请使用原工作目录或独立Docker环境；不要删除原容器或数据卷。');
  let loginPassword: string;
  try {
    loginPassword = (
      await readFile(
        path.join(root, ".data/local-preview-password.txt"),
        "utf8",
      )
    ).trim();
  } catch {
    loginPassword = randomBytes(18).toString("base64url");
  }
  secrets = {
    databasePassword: randomBytes(32).toString("hex"),
    loginPassword,
  };
  await writeFile(secretFile, JSON.stringify(secrets), {
    flag: "wx",
    mode: 0o600,
  });
}
if (existing) {
  const info = JSON.parse(await docker(["inspect", existing]))[0];
  assertDatabaseTarget(databaseTarget, info);
  if (info.Config.Labels?.["codelab.workspace"] !== "v2")
    throw new Error("DATABASE_NAME_OCCUPIED");
  if (!info.State.Running) await docker(["start", existing]);
} else {
  await docker(
    [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      ownership,
      "--restart",
      "unless-stopped",
      "--publish",
      "127.0.0.1::5432",
      "--mount",
      "type=volume,source=codelab-workspace-postgres-v2,target=/var/lib/postgresql/data",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB=codelab",
      "postgres:17-alpine",
    ],
    { ...process.env, POSTGRES_PASSWORD: secrets.databasePassword },
  );
}
const info = JSON.parse(await docker(["inspect", name]))[0];
const binding = info.NetworkSettings.Ports["5432/tcp"]?.[0];
if (binding?.HostIp !== "127.0.0.1")
  throw new Error("DATABASE_MUST_BE_LOOPBACK_ONLY");
await withWorkspaceStartup(
  async (acquired) => {
    const db = postgres(
      `postgres://postgres:${secrets.databasePassword}@127.0.0.1:${binding.HostPort}/codelab`,
    );
    acquired("database", () => db.close());
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await db.query("SELECT 1");
        ready = true;
        break;
      } catch (error) {
        if ((error as {code?: string}).code === '28P01')
          throw new Error('WORKSPACE_DATABASE_AUTH_MISMATCH');
        await delay(500);
      }
    }
    if (!ready) throw new Error("DATABASE_NOT_READY");
    await migrateWorkspace(db);
    await seed(db, secrets.loginPassword);
    const apiPort = 3102,
      webPort = 5174;
    const artifacts = new ArtifactStore({
      root: path.join(directory, "evidence-v2"),
    });
    const userModels = createUserModelService(db, await loadModelVaultKey(db));
    const initialAnalysisMode = readInitialAnalysisModeV2();
    const localStorageAdmission = createStorageAdmission(directory);
    const storageAdmission = async (requiredBytes?: number) => {
      await localStorageAdmission(requiredBytes);
      try {
        // Read only the already ownership-verified database container by immutable ID.
        const disk = (
          await exec(
            "docker",
            ["exec", info.Id, "df", "-Pk", "/var/lib/postgresql/data"],
            { timeout: 3000, windowsHide: true, maxBuffer: 4096 },
          )
        ).stdout
          .trim()
          .split(/\r?\n/)
          .at(-1)!
          .split(/\s+/);
        assertStorageHeadroom(
          Number(disk[1]) * 1024,
          Number(disk[3]) * 1024,
          requiredBytes,
        );
      } catch (error) {
        if (error instanceof StorageAdmissionError) throw error;
        throw new StorageAdmissionError("STORAGE_CAPACITY_UNKNOWN");
      }
    };
    const app = await createApp(db, {
      initialAnalysisMode,
      storageAdmission,
      origin: `http://127.0.0.1:${webPort}`,
      additionalOrigins: lanAddress ? [`http://${lanAddress}:${webPort}`] : [],
      secure: false,
      executionApproved: true,
      businessVersion: 2,
      model: "personal-model",
      userModels,
      image: "runtime-catalog",
      packs: runtime.packs,
      approvedFingerprint: runtime.approvedFingerprint,
      evidenceReader: (evidence) => artifacts.readEvidence(evidence),
    });
    acquired("api", () => app.close());
    await app.listen({ host: "127.0.0.1", port: apiPort });
    const web = await createServer({
      root: path.join(root, "apps/web"),
      server: {
        host: lanAddress ? "0.0.0.0" : "127.0.0.1",
        port: webPort,
        strictPort: true,
        proxy: { "/api": `http://127.0.0.1:${apiPort}` },
      },
    });
    acquired("web", () => web.close());
    await web.listen();
    if (lanAddress) console.log(`团队局域网入口 http://${lanAddress}:${webPort}/`);
    lifecycle("ready");
    const controller = new AbortController();
    const worker = runWorkerV2Loop({
      db,
      artifacts,
      signal: controller.signal,
      personalModels: userModels.resolve,
      analysisMode: initialAnalysisMode,
      storageAdmission,
      runner: createRunnerClientV2({
        baseUrl: credential.url,
        token: credential.token,
      }),
      approvedFingerprint: ({ rule }) => runtime.approvedFingerprint(rule),
      onResult: (result) => {
        if (result.state !== "idle") console.log(JSON.stringify(result));
      },
      onError: (issue) => console.error(JSON.stringify(issue)),
    });
    console.log(
      `持久 v2 工作台 http://127.0.0.1:${webPort}/ — 已连接 PostgreSQL 与团队样本执行器`,
    );
    console.log(
      "账号 teacher@codelab.local / student@codelab.local；密码沿用本地预览，保存在私有 .data/business-v2/development-credentials.json",
    );
    const shutdown = createWorkspaceShutdown({
      abort: () => controller.abort(),
      worker,
      closeWeb: () => web.close(),
      closeApi: () => app.close(),
      closeDatabase: () => db.close(),
      reportFailure: (stage) => {
        process.exitCode = 1;
        console.error(
          JSON.stringify({ code: "WORKSPACE_SHUTDOWN_FAILED", stage }),
        );
      },
    });
    const stop = () => shutdown().finally(() => { if (process.connected) process.disconnect(); });
    process.on("SIGINT", () => { lifecycle("sigint"); void stop(); });
    process.on("SIGTERM", () => { lifecycle("sigterm"); void stop(); });
    if (process.send) {
      process.on('message', message => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'codelab-workspace-stop') {
          lifecycle('supervisor_stop'); void stop();
        }
      });
      process.on('disconnect', () => { lifecycle('supervisor_disconnected'); void stop(); });
      process.send({ type: 'codelab-workspace-ready' }, () => {});
    }
    // An unexpectedly terminated worker must not leave an apparently usable web service behind.
    void worker.then(
      () => {
        if (!controller.signal.aborted) {
          lifecycle("worker_ended");
          process.exitCode = 1;
          void stop();
        }
      },
      () => {
        lifecycle("worker_rejected");
        process.exitCode = 1;
        void stop();
      },
    );
  },
  (stage) => {
    console.error(
      JSON.stringify({ code: "WORKSPACE_STARTUP_CLEANUP_FAILED", stage }),
    );
  },
).catch((error: unknown) => {
  lifecycle("startup_failed");
  // Raw startup errors may include connection strings or model configuration.
  const known = error instanceof Error && ['WORKSPACE_DATABASE_AUTH_MISMATCH', 'DATABASE_NOT_READY'].includes(error.message)
    ? error.message : 'WORKSPACE_STARTUP_FAILED';
  console.error(JSON.stringify({ code: known, help: known === 'WORKSPACE_DATABASE_AUTH_MISMATCH'
    ? '数据库与当前目录的凭据不匹配。请使用原工作目录或独立Docker环境；不要清空数据库。'
    : '请核对Docker、runner状态和端口占用，参见 docs/REPRODUCE.md。' }));
  process.exitCode = 1;
});
