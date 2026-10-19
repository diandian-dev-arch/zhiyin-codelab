import type { DB } from '../apps/api/src/db.js';
import { changeRetentionHoldV2 } from '../apps/api/src/retention-holds-v2.js';
import { connectDesktopDatabase } from './desktop-database.js';

let db: DB | undefined;
try {
  const [flag, action, targetId, requestId, reason, ...extra] = process.argv.slice(2);
  if (flag !== '--desktop' || !reason || extra.length) throw new Error('RETENTION_ARGUMENTS_INVALID');
  db = await connectDesktopDatabase();
  console.log(JSON.stringify(await changeRetentionHoldV2(db, { action, targetId, requestId, reason })));
} catch (error) {
  console.error(error instanceof Error && /^RETENTION_[A-Z_]+$/.test(error.message) ? error.message : 'RETENTION_HOLD_COMMAND_FAILED');
  process.exitCode = 1;
} finally { await db?.close(); }
