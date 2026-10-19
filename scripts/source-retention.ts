import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DB } from '../apps/api/src/db.js';
import { planSourceDeletion, changeSourceRetentionHold, executeSourceDeletion } from '../apps/api/src/source-retention.js';
import { connectDesktopDatabase } from './desktop-database.js';

let db: DB | undefined;
try {
  const [flag, action, argument, owner, ...extra] = process.argv.slice(2);
  if (flag !== '--desktop' || !argument || extra.length || !['plan','hold','release','delete'].includes(action ?? ''))
    throw new Error('RETENTION_ARGUMENTS_INVALID');
  let input: unknown;
  if (action === 'plan') {
    if (!owner) throw new Error('RETENTION_ARGUMENTS_INVALID');
    input = { projectId: argument, ownerId: owner };
  } else {
    if (owner) throw new Error('RETENTION_ARGUMENTS_INVALID');
    const file = path.resolve(argument), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('RETENTION_REQUEST_FILE_INVALID');
    input = JSON.parse(await readFile(file, 'utf8'));
    if (action !== 'delete' && (input as any)?.action !== action) throw new Error('RETENTION_ARGUMENTS_INVALID');
  }
  db = await connectDesktopDatabase();
  // No implicit migration; an operator must deploy schema 014 first.
  if (!(await db.query('SELECT version FROM schema_migrations WHERE version=14')).rows.length)
    throw new Error('RETENTION_MIGRATION_REQUIRED');
  if (action === 'plan') console.log(JSON.stringify(await planSourceDeletion(db, input)));
  else {
    const result = action === 'delete' ? await executeSourceDeletion(db, input) : await changeSourceRetentionHold(db, input);
    console.log(JSON.stringify({ eventId: result.eventId, action: result.action, replayed: result.replayed }));
  }
} catch (error) {
  console.error(error instanceof Error && /^RETENTION_[A-Z_]+$/.test(error.message) ? error.message : 'RETENTION_SOURCE_COMMAND_FAILED');
  process.exitCode = 1;
} finally { await db?.close(); }
