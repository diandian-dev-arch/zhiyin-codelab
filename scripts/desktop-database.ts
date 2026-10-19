import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../apps/api/src/template.js';
import { postgres } from '../apps/api/src/db.js';
import { workspaceDatabaseTarget, assertDatabaseTarget } from './workspace-database-target.js';

/** Connect only to the already-running labelled local workspace. Never migrate or recreate it. */
export async function connectDesktopDatabase() {
  const target = await workspaceDatabaseTarget(root);
  const info = JSON.parse((await promisify(execFile)('docker', ['inspect', target.name],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout)[0];
  assertDatabaseTarget(target, info);
  const binding = info.NetworkSettings.Ports['5432/tcp']?.[0];
  if (!info.State.Running || info.Config.Labels?.['codelab.workspace'] !== 'v2' || binding?.HostIp !== '127.0.0.1')
    throw new Error('RETENTION_DATABASE_IDENTITY_MISMATCH');
  const credentials = JSON.parse(await readFile(path.join(root, '.data/business-v2/development-credentials.json'), 'utf8'));
  return postgres(`postgres://postgres:${encodeURIComponent(credentials.databasePassword)}@127.0.0.1:${binding.HostPort}/codelab`);
}
