import pg from "pg";
import { runMigrations, type MigrationSource } from "./migrations.js";
export interface DB {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
// Both execution and standalone analysis claims must acquire this transaction lock.
export const GLOBAL_QUEUE_LOCK_ID = 41722;
export function postgres(url = process.env.DATABASE_URL): DB {
  if (!url) throw new Error("DATABASE_URL 未配置");
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  // pg removes failed idle clients itself. Handle its notification so an idle
  // disconnect cannot become an unhandled EventEmitter error and kill the API.
  // Query/transaction failures still reject their callers; never log credentials.
  pool.on('error', () => console.error('DATABASE_IDLE_CONNECTION_LOST'));
  let savepointNumber = 0;
  const wrap = (
    client: pg.Pool | pg.PoolClient,
    inTransaction = false,
  ): DB => ({
    query: async (sql, p = []) => client.query(sql, p),
    exec: async (sql) => {
      await client.query(sql);
    },
    transaction: async (fn) => {
      if (inTransaction) {
        const savepoint = `codelab_sp_${++savepointNumber}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          const value = await fn(wrap(client, true));
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return value;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      }
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const value = await fn(wrap(c, true));
        await c.query("COMMIT");
        return value;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  });
  return wrap(pool);
}
export async function migrate(db: DB, sources?: readonly MigrationSource[]) {
  return runMigrations(db, sources);
}
