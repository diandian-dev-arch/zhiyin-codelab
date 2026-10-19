// Local UI/API development only: PGlite is never the execution or production database.
import { testDB } from "../tests/db.js";
import { migrate } from "../apps/api/src/db.js";
import { seed } from "../apps/api/src/seed.js";
import { createApp } from "../apps/api/src/app.js";
import { createUserModelService, loadModelVaultKey } from "../apps/api/src/user-model-settings.js";
const db = await testDB(process.env.LOCAL_DB_DIR ?? ".data/local-postgres");
await migrate(db);
if (process.env.SEED_PASSWORD) await seed(db, process.env.SEED_PASSWORD);
const userModels = createUserModelService(db, await loadModelVaultKey(db));
const app = await createApp(db, {
  userModels,
  origin: process.env.APP_ORIGIN ?? "http://localhost:5173",
  secure: false,
  executionApproved: false,
  // 本地工作台默认展示 v2 产品流程；执行仍由独立、已批准的 worker 提供。
  businessVersion: process.env.BUSINESS_API_VERSION === "1" ? 1 : 2,
  model: "unconfigured",
  image: "not-configured",
});
const port = Number(process.env.API_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("API_PORT 无效");
await app.listen({ port, host: "127.0.0.1" });
console.log(`本地开发 API http://127.0.0.1:${port}；执行入口关闭。`);
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
