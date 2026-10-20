import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pocketbayRuntime, initializeOnlineOwner } from '../scripts/pocketbay-runtime.js';
import { deployablePath, prepareOnlineCredentials, packageOnline } from '../scripts/pocketbay-package.js';
import { testDB } from './db.js';
import { migrate } from '../apps/api/src/db.js';
const env = { DATABASE_URL: 'postgres://synthetic:unused@platform.invalid/isolated', POCKETBAY_DATA_DIR: '/data', PORT: '8080',
  CODELAB_BOOTSTRAP_EMAIL: 'owner@codelab.online', CODELAB_BOOTSTRAP_PASSWORD: 'synthetic-online-password-only-1234567890' };

it('forces HTTPS, v2, personal-model storage and disabled execution without inheriting local capability settings', () => {
  const runtime = pocketbayRuntime({ ...env, EXECUTION_APPROVED: 'true', BUSINESS_API_VERSION: '1', COOKIE_SECURE: 'false' }, ['--origin=https://codelab-test.pocketbay.app']);
  expect(runtime).toMatchObject({ APP_ORIGIN: 'https://codelab-test.pocketbay.app', API_HOST: '0.0.0.0', API_PORT: '8080',
    BUSINESS_API_VERSION: '2', COOKIE_SECURE: 'true', EXECUTION_APPROVED: 'false', DATA_DIR: '/data/codelab' });
});
it.each(['http://codelab-test.pocketbay.app', 'https://evil.invalid', 'https://evil.pocketbay.app.evil.invalid', 'https://user:pw@codelab.pocketbay.app', 'https://codelab.pocketbay.app:8443', 'https://codelab.pocketbay.app/path'])(
  'rejects an unapproved public origin %s', origin => expect(() => pocketbayRuntime(env, [`--origin=${origin}`])).toThrow());
it.each(['localhost', '127.0.0.1', 'db'])('refuses a local database target %s', host => {
  expect(() => pocketbayRuntime({ ...env, DATABASE_URL: `postgres://unused@${host}/original` }, ['--origin=https://codelab.pocketbay.app'])).toThrow();
});
it('requires platform storage, port and independent credentials', () => {
  for (const overrides of [{ PORT: '0' }, { PORT: '' }, { POCKETBAY_DATA_DIR: '' }, { POCKETBAY_DATA_DIR: '/' }, { POCKETBAY_DATA_DIR: '/data/..' }, { CODELAB_BOOTSTRAP_PASSWORD: 'short' }])
    expect(() => pocketbayRuntime({ ...env, ...overrides }, ['--origin=https://codelab.pocketbay.app'])).toThrow();
});
it('does not read or package configuration before exact path approval', async () => {
  await expect(packageOnline('codelab-test', [], 'a'.repeat(64))).rejects.toThrow('ONLINE_CONFIG_APPROVAL_REQUIRED');
  await expect(packageOnline('codelab-test', ['.env'], 'a'.repeat(64))).rejects.toThrow('ONLINE_CONFIG_APPROVAL_REQUIRED');
});
it('excludes hidden state, evidence, archives, configuration and credentials from the source walk', () => {
  for (const file of ['apps/web/node_modules/x.js', 'apps/web/dist/x.js', 'apps/web/.env', 'apps/api/credentials.json', 'apps/api/x.key', 'scripts/x.zip', 'scripts/.data/x', 'apps/api/../secret'])
    expect(deployablePath(file), file).toBe(false);
  for (const file of ['apps/web/src/main-codelab.ts', 'apps/api/src/main.ts', 'apps/web/public/logo.png', 'packages/contracts/src/index.ts']) expect(deployablePath(file)).toBe(true);
});
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true }); });
it('creates new cloud-only credentials once and never reads an existing local environment file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codelab-cloud-config-')); directories.push(directory);
  const first = await prepareOnlineCredentials(directory), bytes = await readFile(path.join(directory, first.path), 'utf8');
  expect(first.sensitive).toBe(true);
  expect(bytes).toMatch(/^CODELAB_BOOTSTRAP_EMAIL=owner@codelab.online\nCODELAB_BOOTSTRAP_PASSWORD=[A-Za-z0-9_-]{43}\n$/);
  expect(await prepareOnlineCredentials(directory)).toEqual(first);
});
it('initializes only an empty cloud business database and retains the account on restart', async () => {
  const db = await testDB();
  try {
    await migrate(db);
    const id = await initializeOnlineOwner(db, env.CODELAB_BOOTSTRAP_EMAIL, env.CODELAB_BOOTSTRAP_PASSWORD);
    const before = (await db.query('SELECT * FROM users')).rows;
    expect(before).toHaveLength(1);
    expect(before[0].email).toBe('owner@codelab.online');
    expect(await initializeOnlineOwner(db, env.CODELAB_BOOTSTRAP_EMAIL, 'another-valid-synthetic-password-1234567')).toBe(id);
    expect((await db.query('SELECT * FROM users')).rows).toEqual(before);
    expect((await db.query('SELECT * FROM course_assignments')).rows).toHaveLength(0);
  } finally { await db.close(); }
});
it('refuses an unmarked nonempty database without changing the existing account', async () => {
  const db = await testDB();
  try {
    await migrate(db);
    await db.query("INSERT INTO users(id,email,name,role,password_hash) VALUES(gen_random_uuid(),'existing@original.invalid','Existing','teacher','not-used')");
    await expect(initializeOnlineOwner(db, env.CODELAB_BOOTSTRAP_EMAIL, env.CODELAB_BOOTSTRAP_PASSWORD)).rejects.toThrow('ONLINE_UNMARKED_DATABASE_NOT_EMPTY');
    expect((await db.query('SELECT * FROM users')).rows).toHaveLength(1);
  } finally { await db.close(); }
});
