import type {DB} from '../apps/api/src/db.js';
import {migrate} from '../apps/api/src/db.js';
import {loadMigrations,MIGRATION_LOCK_ID} from '../apps/api/src/migrations.js';

/** Maintenance can pin the already deployed schema while preparing an upgrade.
 * Pinning never downgrades and never upgrades: the ledger must already end at the pin.
 * Unset retains the existing automatic migration behavior.
 */
export async function migrateWorkspace(db:DB,env:NodeJS.ProcessEnv=process.env){
  const pin=env.CODELAB_WORKSPACE_SCHEMA_PIN;
  if(pin===undefined)return migrate(db);
  if(!/^[1-9][0-9]*$/.test(pin))throw new Error('WORKSPACE_SCHEMA_PIN_INVALID');
  const version=Number(pin),sources=await loadMigrations();
  if(!Number.isSafeInteger(version)||!sources.some(m=>m.version===version))throw new Error('WORKSPACE_SCHEMA_PIN_INVALID');
  // Read and validate inside the same advisory lock used by the migration engine.
  return db.transaction(async tx=>{
    // The engine obtains its own transaction-level lock too (reentrant on this connection).
    await tx.exec("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
    await tx.query('SELECT pg_advisory_xact_lock($1)',[MIGRATION_LOCK_ID]);
    const current=(await tx.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.version;
    if(current!==version)throw new Error('WORKSPACE_SCHEMA_PIN_MISMATCH');
    return migrate(tx,sources.filter(m=>m.version<=version));
  });
}
