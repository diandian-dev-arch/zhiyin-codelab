import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { archiveVerifiedBackup } from './backup-archive.js';
import { root } from '../apps/api/src/template.js';

const [id, date, ...extra] = process.argv.slice(2);
if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || extra.length)
  throw new Error('Usage: pnpm backup:archive <backup-uuid> <verification-date>');
try {
  const result = await archiveVerifiedBackup(root, id, path.join(root, 'docs/verification', date, `backup-${id}/result.json`));
  const operation = randomUUID();
  const destination = path.join(root, '.data/backup-archives', operation);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'backup.zip'), result.archive, { flag: 'wx' });
  if (createHash('sha256').update(await readFile(path.join(destination, 'backup.zip'))).digest('hex') !== result.sha256)
    throw new Error('BACKUP_ARCHIVE_WRITE_MISMATCH');
  const summary = { backupId: id, operation, state: 'integrity_verified_archive', sha256: result.sha256,
    archiveBytes: result.archive.length, evidenceFiles: result.evidenceFiles, entries: result.entries,
    modelVault: result.modelVault,
    sourceBytes: result.sourceBytes, originalRetained: true, encrypted: false,
    limitation: 'Same-disk copy; not an offsite backup, new restore drill, retention deletion, or authenticity proof' };
  await writeFile(path.join(destination, 'result.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...summary, privateDirectory: path.relative(root, destination) }));
} catch {
  console.error('BACKUP_ARCHIVE_FAILED: check restore record, unchanged dump/evidence, separate model vault key, links and 64MiB input limit. No original data deleted.');
  process.exitCode = 1;
}
