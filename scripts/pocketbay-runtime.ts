import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DB } from '../apps/api/src/db.js';
import { hashPassword } from '../apps/api/src/auth.js';

export function pocketbayRuntime(env: NodeJS.ProcessEnv, args: string[]) {
  assert(args.length <= 1 && args.every(arg => arg.startsWith('--origin=')), 'ONLINE_ORIGIN_ARGUMENT_INVALID');
  const origin = new URL(args[0]?.slice('--origin='.length) ?? env.APP_ORIGIN ?? '');
  assert(origin.protocol === 'https:' && /^[a-z0-9][a-z0-9-]*\.pocketbay\.app$/.test(origin.hostname) &&
    origin.port === '' && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password,
  'ONLINE_HTTPS_ORIGIN_REQUIRED');
  assert(env.DATABASE_URL, 'ONLINE_PLATFORM_DATABASE_REQUIRED');
  const database = new URL(env.DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(database.protocol) &&
    !['localhost', '127.0.0.1', '::1', '[::1]', 'db'].includes(database.hostname), 'ONLINE_PLATFORM_DATABASE_REQUIRED');
  assert(env.POCKETBAY_DATA_DIR && path.posix.isAbsolute(env.POCKETBAY_DATA_DIR) && env.POCKETBAY_DATA_DIR !== '/' &&
    !env.POCKETBAY_DATA_DIR.split('/').some(part => part === '..' || part === '.'), 'ONLINE_PERSISTENT_DIRECTORY_REQUIRED');
  const port = Number(env.PORT);
  assert(Number.isInteger(port) && port > 0 && port < 65536, 'ONLINE_PORT_REQUIRED');
  assert(env.CODELAB_BOOTSTRAP_EMAIL === 'owner@codelab.online' &&
    typeof env.CODELAB_BOOTSTRAP_PASSWORD === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(env.CODELAB_BOOTSTRAP_PASSWORD),
  'ONLINE_INDEPENDENT_ACCOUNT_REQUIRED');
  return {
    APP_ORIGIN: origin.origin, API_HOST: '0.0.0.0', API_PORT: String(port),
    BUSINESS_API_VERSION: '2', COOKIE_SECURE: 'true', EXECUTION_APPROVED: 'false',
    DATA_DIR: path.posix.join(env.POCKETBAY_DATA_DIR, 'codelab'),
  };
}

export async function initializeOnlineOwner(db: DB, email: string, password: string) {
  assert(email === 'owner@codelab.online' && /^[a-zA-Z0-9_-]{32,128}$/.test(password), 'ONLINE_INDEPENDENT_ACCOUNT_REQUIRED');
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(41729)');
    const marker = (await tx.query("SELECT to_regclass('codelab_online_setup') AS name")).rows[0]?.name;
    if (marker) {
      const owners = (await tx.query(`SELECT u.id FROM codelab_online_setup s JOIN users u ON u.id=s.owner_id
        WHERE s.singleton=true AND s.version=1 AND u.role='teacher' AND u.email=$1`, [email])).rows;
      assert(owners.length === 1, 'ONLINE_OWNER_IDENTITY_CHANGED');
      return owners[0].id as string;
    }
    const tables = (await tx.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name<>'schema_migrations'")).rows;
    for (const { table_name: table } of tables) {
      assert(/^[a-z_][a-z0-9_]*$/.test(table), 'ONLINE_SCHEMA_UNEXPECTED');
      assert((await tx.query(`SELECT 1 FROM "${table}" LIMIT 1`)).rows.length === 0, 'ONLINE_UNMARKED_DATABASE_NOT_EMPTY');
    }
    const id = randomUUID();
    await tx.exec('CREATE TABLE codelab_online_setup(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL,owner_id uuid NOT NULL REFERENCES users(id))');
    await tx.query('INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)', [id, email, '平台负责人', 'teacher', hashPassword(password)]);
    await tx.query('INSERT INTO classes(id,name,teacher_id) VALUES($1,$2,$3)', [randomUUID(), '线上试用班', id]);
    await tx.query('INSERT INTO codelab_online_setup VALUES(true,1,$1)', [id]);
    return id;
  });
}
