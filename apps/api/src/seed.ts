import { randomUUID } from "node:crypto";
import { postgres, migrate, type DB } from "./db.js";
import { hashPassword } from "./auth.js";
import { defaultCriteria } from "@codelab/contracts";
export async function seed(db: DB, password: string) {
  if (password.length < 12)
    throw new Error("SEED_PASSWORD 至少 12 位，请配置独立的本地测试密码");
  if ((await db.query("SELECT id FROM users LIMIT 1")).rows.length) return;
  await db.transaction(async (tx) => {
    const teacher = randomUUID(),
      student = randomUUID(),
      classId = randomUUID(),
      task = randomUUID();
    for (const [id, email, name, role] of [
      [teacher, "teacher@codelab.local", "示例教师", "teacher"],
      [student, "student@codelab.local", "示例学生", "student"],
    ])
      await tx.query("INSERT INTO users VALUES($1,$2,$3,$4,$5)", [
        id,
        email,
        name,
        role,
        hashPassword(password),
      ]);
    await tx.query("INSERT INTO classes VALUES($1,$2,$3)", [
      classId,
      "Vue 项目实训 · 示例班",
      teacher,
    ]);
    await tx.query("INSERT INTO memberships VALUES($1,$2)", [classId, student]);
    await tx.query(
      "INSERT INTO tasks(id,class_id,title,description) VALUES($1,$2,$3,$4)",
      [
        task,
        classId,
        "任务管理看板",
        "内置开发与演示任务，尚非教师确认的真实课程。实现新增、编辑、删除、状态、筛选、校验及本地持久化。保留模板 data-testid 接口，只修改 src/ 和允许的静态资源。",
      ],
    );
    await tx.query(
      "INSERT INTO rules(id,task_id,version,template_version,criteria) VALUES($1,$2,1,$3,$4)",
      [randomUUID(), task, "vue-board-v1", JSON.stringify(defaultCriteria)],
    );
  });
}
if (
  import.meta.url === new URL(process.argv[1] ?? "", "file:///").href ||
  process.argv[1]?.endsWith("seed.ts")
) {
  const db = postgres();
  try {
    await migrate(db);
    await seed(db, process.env.SEED_PASSWORD ?? "");
    console.log("示例账号已初始化，密码来自 SEED_PASSWORD");
  } finally {
    await db.close();
  }
}
