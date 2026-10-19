import { PGlite } from "@electric-sql/pglite";
import type { DB } from "../apps/api/src/db.js";
export async function testDB(dataDir?: string): Promise<DB> {
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  let savepointNumber = 0;
  function wrap(p: any, inTransaction = false): DB {
    return {
      query: async (sql, params = []) => {
        if (sql.startsWith("CREATE TABLE")) {
          await p.exec(sql);
          return { rows: [] };
        }
        return p.query(sql, params);
      },
      exec: async (sql) => {
        await p.exec(sql);
      },
      transaction: async (fn) => {
        if (!inTransaction)
          return p.transaction((tx: any) => fn(wrap(tx, true)));
        const savepoint = `codelab_test_sp_${++savepointNumber}`;
        await p.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = await fn(wrap(p, true));
          await p.exec(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          await p.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await p.exec(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      },
      close: () => pg.close(),
    };
  }
  return wrap(pg);
}
