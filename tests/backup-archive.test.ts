import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { archiveVerifiedBackup } from '../scripts/backup-archive';
const roots: string[] = [];
const id = '11111111-1111-4111-8111-111111111111';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'codelab-backup-archive-')); roots.push(root);
  const backup = path.join(root, '.data/backups', id), evidence = path.join(backup, 'evidence-v2');
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(backup, 'database.dump'), 'dump');
  await writeFile(path.join(evidence, 'a.txt'), 'abc');
  await writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ id, evidence: { 'a.txt': { bytes: 3, sha256: hash('abc') } } }));
  const record = path.join(root, 'result.json');
  await writeFile(record, JSON.stringify({ id, passed: true, sourceUnchanged: true, cleanup: 'clean', dumpSha256: hash('dump'), evidenceFiles: 1, evidenceBytes: 3 }));
  return { root, backup, evidence, record };
}
it('archives a verified backup with exact dump and evidence bytes', async () => {
  const f = await fixture(), result = await archiveVerifiedBackup(f.root, id, f.record);
  const unpacked = unzipSync(result.archive);
  expect(Buffer.from(unpacked['database.dump']).toString()).toBe('dump');
  expect(Buffer.from(unpacked['evidence-v2/a.txt']).toString()).toBe('abc');
  expect(result.evidenceFiles).toBe(1);
  expect(Object.keys(unpacked)).toHaveLength(5);
});
it('rejects a changed database dump', async () => {
  const f = await fixture(); await writeFile(path.join(f.backup, 'database.dump'), 'oops');
  await expect(archiveVerifiedBackup(f.root, id, f.record)).rejects.toThrow('BACKUP_DUMP_CHANGED');
});
it('rejects same-length changed evidence', async () => {
  const f = await fixture(); await writeFile(path.join(f.evidence, 'a.txt'), 'xyz');
  await expect(archiveVerifiedBackup(f.root, id, f.record)).rejects.toThrow('BACKUP_EVIDENCE_CHANGED');
});
it('rejects missing evidence and does not accept an empty backup', async () => {
  const f = await fixture(); await rm(path.join(f.evidence, 'a.txt'));
  await expect(archiveVerifiedBackup(f.root, id, f.record)).rejects.toThrow('BACKUP_EVIDENCE_MISSING');
});
it('rejects unlisted evidence', async () => {
  const f = await fixture(); await writeFile(path.join(f.evidence, 'extra.txt'), 'extra');
  await expect(archiveVerifiedBackup(f.root, id, f.record)).rejects.toThrow('BACKUP_UNLISTED_EVIDENCE');
});
it('rejects unsuccessful restore records', async () => {
  const f = await fixture(); await writeFile(f.record, JSON.stringify({ id, passed: false }));
  await expect(archiveVerifiedBackup(f.root, id, f.record)).rejects.toThrow('BACKUP_NOT_VERIFIED');
});
it('rejects linked evidence directories without following them', async () => {
  const f = await fixture(); await symlink(f.backup, path.join(f.evidence, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(archiveVerifiedBackup(f.root, id, f.record)).rejects.toThrow();
});
it('rejects path input outside the registered UUID namespace', async () => {
  const f = await fixture();
  await expect(archiveVerifiedBackup(f.root, '../outside', f.record)).rejects.toThrow('BACKUP_ID_INVALID');
});

async function withVault() {
  const f = await fixture(), key = randomBytes(32);
  const keyDirectory = path.join(f.root, '.data/model-key-backups', id);
  await mkdir(keyDirectory, {recursive: true});
  await writeFile(path.join(keyDirectory, 'model-credentials.key'), key);
  const manifestFile = path.join(f.backup, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.tables = {user_model_settings: {rows: 1}};
  manifest.modelVault = {profiles: 1, saved: true, keySha256: createHash('sha256').update(key).digest('hex'), separateLocation: '../untrusted-path-is-not-followed'};
  await writeFile(manifestFile, JSON.stringify(manifest));
  const record = JSON.parse(await readFile(f.record, 'utf8'));
  record.modelCredentials = {profiles: 1, decrypted: 1};
  await writeFile(f.record, JSON.stringify(record));
  return {...f, key, keyDirectory};
}
it('requires the separately verified key and records it without packaging the key bytes', async () => {
  const f = await withVault(), result = await archiveVerifiedBackup(f.root, id, f.record);
  expect(result.modelVault).toMatchObject({status: 'separate_key_verified', keyIncluded: false, profiles: 1});
  const unpacked = unzipSync(result.archive);
  expect(Object.keys(unpacked).some(name => name.endsWith('.key'))).toBe(false);
  expect(Object.values(unpacked).some(bytes => Buffer.from(bytes).includes(f.key))).toBe(false);
  const metadata = JSON.parse(Buffer.from(unpacked['ARCHIVE_MANIFEST.json']).toString());
  expect(metadata.modelVault).toEqual(result.modelVault);
  expect(metadata.recoveryNotice).toContain('separate original vault key');
});
it('refuses a missing or substituted vault instead of claiming a complete recovery bundle', async () => {
  const f = await withVault(), keyFile = path.join(f.keyDirectory, 'model-credentials.key');
  await writeFile(keyFile, randomBytes(32));
  await expect(archiveVerifiedBackup(f.root, id, f.record)).rejects.toThrow('BACKUP_VAULT_CHANGED');
  await rm(keyFile);
  await expect(archiveVerifiedBackup(f.root, id, f.record)).rejects.toThrow();
});
it('rejects stripped vault metadata for a database with encrypted profiles', async () => {
  const f = await withVault();
  await writeFile(path.join(f.backup, 'manifest.json'), JSON.stringify({id,
    tables: {user_model_settings: {rows: 1}}, evidence: {'a.txt': {bytes: 3, sha256: hash('abc')}}}));
  await expect(archiveVerifiedBackup(f.root, id, f.record)).rejects.toThrow('BACKUP_VAULT_METADATA_INVALID');
});
