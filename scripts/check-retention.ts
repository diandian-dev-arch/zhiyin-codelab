import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { root } from '../apps/api/src/template.js';
import type { DB } from '../apps/api/src/db.js';
import { connectDesktopDatabase } from './desktop-database.js';
import { ArtifactStore } from '../apps/api/src/artifacts-v2.js';
import { auditRetentionV2 } from '../apps/api/src/retention-v2.js';

let db: DB | undefined;
try {
  if (process.argv.slice(2).join(' ') !== '--desktop') throw new Error('RETENTION_DESKTOP_FLAG_REQUIRED');
  db = await connectDesktopDatabase();
  const result = await auditRetentionV2(db, new ArtifactStore({ root: path.join(root, '.data/business-v2/evidence-v2') }));
  const directory = path.join(root, '.data/retention-audits', randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = JSON.stringify(result, null, 2) + '\n';
  const file = path.join(directory, 'result.json');
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  console.log(JSON.stringify({ complete: result.complete, deletionAuthorized: false,
    counts: result.counts, sourceInventory: result.sourceInventory, sourceRetention: result.sourceRetention, activeRecords: result.activeRecords, issueCount: result.issues.length,
    result: path.relative(root, file).replaceAll('\\', '/'), sha256 }));
  process.exitCode = result.complete ? 0 : 2;
} catch (error) {
  // pg/Docker errors may contain private connection data. Only emit our known codes.
  console.error(error instanceof Error && /^RETENTION_[A-Z_]+$/.test(error.message) ? error.message : 'RETENTION_AUDIT_FAILED');
  process.exitCode = 1;
} finally { await db?.close(); }
