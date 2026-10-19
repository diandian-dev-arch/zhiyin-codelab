import { postgres, migrate } from "./db.js";
const db = postgres();
try {
  await migrate(db);
  console.log("数据库迁移完成");
} finally {
  await db.close();
}
