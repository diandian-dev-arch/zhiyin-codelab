import { randomUUID } from "node:crypto";
import { postgres, type DB } from "../apps/api/src/db.js";
import { testDB } from "./db.js";

export interface IsolatedTestDatabase extends DB {
  backend: "pglite" | "postgres";
  connectPeer(): DB;
}

/** A disposable schema per test. The URL is provided only by the test harness. */
export async function isolatedTestDB(): Promise<IsolatedTestDatabase> {
  const connectionUrl = process.env.CODELAB_TEST_POSTGRES_URL;
  if (!connectionUrl) {
    const db = await testDB();
    return {
      ...db,
      backend: "pglite",
      connectPeer() {
        throw new Error("Independent connections require real PostgreSQL");
      },
    };
  }
  const administration = postgres(connectionUrl);
  const schema = `codelab_test_${randomUUID().replaceAll("-", "")}`;
  const quoted = `"${schema}"`;
  let scoped: DB | undefined;
  let created = false;
  let closed = false;
  try {
    await administration.exec(`CREATE SCHEMA ${quoted}`);
    created = true;
    const target = new URL(connectionUrl);
    target.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
    const scopedUrl = target.toString();
    scoped = postgres(scopedUrl);
    if (
      (await scoped.query("SELECT current_schema() AS name")).rows[0]?.name !==
      schema
    ) {
      throw new Error("Isolated PostgreSQL schema was not selected");
    }
    const database = scoped;
    return {
      ...database,
      backend: "postgres",
      connectPeer: () => postgres(scopedUrl),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await database.close();
        } finally {
          try {
            // The exact schema was generated and created by this invocation.
            await administration.exec(`DROP SCHEMA ${quoted} CASCADE`);
          } finally {
            await administration.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      await scoped?.close();
    } finally {
      try {
        if (created) await administration.exec(`DROP SCHEMA ${quoted} CASCADE`);
      } finally {
        await administration.close();
      }
    }
    throw error;
  }
}
