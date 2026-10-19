import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const container = `codelab-verification-pg-${suffix}`;
const network = `codelab-verification-net-${suffix}`;
const password = randomUUID();
const label = `codelab.verification=${suffix}`;
let networkCreated = false,
  containerCreated = false;
const docker = (args: string[]) =>
  exec("docker", args, {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
try {
  await docker(["network", "create", "--label", label, network]);
  networkCreated = true;
  // Random local-only port; the isolated database contains generated test records only.
  await docker([
    "run",
    "--detach",
    "--name",
    container,
    "--label",
    label,
    "--network",
    network,
    "--memory",
    "384m",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=codelab_verify",
    "postgres:17-alpine",
  ]);
  containerCreated = true;
  const ports = JSON.parse(
    (
      await docker([
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        container,
      ])
    ).stdout,
  );
  const port = ports["5432/tcp"][0].HostPort;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker([
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
        "-U",
        "postgres",
        "-d",
        "codelab_verify",
      ]);
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  if (!ready) throw new Error("隔离 PostgreSQL 未就绪");
  console.log(
    "已启动临时 PostgreSQL 17；随机本地端口、独立网络、384MiB上限。凭据不输出。",
  );
  const requested = process.argv.slice(2);
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      ...(requested.length
        ? requested
        : [
            "tests/lifecycle-v2.test.ts",
            "tests/migrations-v2.test.ts",
            "tests/reports-v2.test.ts",
            "tests/worker-v2.test.ts",
            "tests/database-idle.test.ts",
          ]),
    ],
    {
      windowsHide: true,
      stdio: "inherit",
      env: {
        ...process.env,
        CODELAB_TEST_POSTGRES_URL: `postgres://postgres:${password}@127.0.0.1:${port}/codelab_verify`,
      },
    },
  );
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch {
  // execFile errors include the command's arguments, which may contain credentials.
  console.error(
    "临时 PostgreSQL 验证失败；检查 Docker 可用性与 postgres:17-alpine 镜像。未输出连接凭据。",
  );
  process.exitCode = 1;
} finally {
  // Names are generated in this process; check ownership labels before any removal.
  if (containerCreated) {
    const actual = JSON.parse(
      (
        await docker([
          "inspect",
          "--format",
          "{{json .Config.Labels}}",
          container,
        ])
      ).stdout,
    );
    if (actual["codelab.verification"] !== suffix)
      throw new Error("临时容器归属不符，拒绝清理");
    await docker(["rm", "--force", "--volumes", container]);
  }
  if (networkCreated) {
    const actual = JSON.parse(
      (
        await docker([
          "network",
          "inspect",
          "--format",
          "{{json .Labels}}",
          network,
        ])
      ).stdout,
    );
    if (actual["codelab.verification"] !== suffix)
      throw new Error("临时网络归属不符，拒绝清理");
    await docker(["network", "rm", network]);
  }
  console.log("本轮创建的临时测试容器、数据库卷和网络已清理；不触及其他项目。");
}
