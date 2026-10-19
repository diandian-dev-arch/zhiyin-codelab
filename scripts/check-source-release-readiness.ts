import { connectDesktopDatabase } from './desktop-database.js';

// Read-only maintenance inventory. Never start workers, migrate, or resolve models.
let db: Awaited<ReturnType<typeof connectDesktopDatabase>> | undefined;
try {
  db = await connectDesktopDatabase();
  const summary = await db.transaction(async tx => {
    await tx.exec("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='5s'");
    const schema = (await tx.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.version;
    const sourceTasks = (await tx.query('SELECT status,count(*)::int AS count FROM source_analyses GROUP BY status ORDER BY status')).rows;
    const courseTasks = (await tx.query('SELECT status,count(*)::int AS count FROM runs GROUP BY status ORDER BY status')).rows;
    const projectCount = (await tx.query('SELECT count(*)::int AS count FROM source_projects')).rows[0].count;
    return { schema, projectCount, sourceTasks, courseTasks };
  });
  console.log(JSON.stringify({ state: 'read-only-inventory', ...summary,
    modelCalls: 0, restartAuthorized: false,
    note: 'Counts alone do not prove paid calls settled, backup validity, or deployment readiness.' }, null, 2));
} catch {
  // Driver and Docker errors may contain credentials or environment details.
  console.error(JSON.stringify({ code: 'SOURCE_READINESS_UNAVAILABLE',
    help: 'Check Docker, pinned container identity, loopback binding and existing schema. No database was created or migrated.' }));
  process.exitCode = 1;
} finally { await db?.close(); }
