import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root } from '../apps/api/src/template.js';
import { capacityLevel, defaultCapacityPolicy, inspectDirectory } from './storage-capacity.js';
import { workspaceDatabaseTarget, assertDatabaseTarget } from './workspace-database-target.js';

const exec = promisify(execFile);
const docker = async (args: string[]) => (await exec('docker', args, {
  timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024,
})).stdout;
const host = await inspectDirectory(path.join(root, '.data'));
const volumes: Record<string, unknown>[] = [];
const databaseTarget = await workspaceDatabaseTarget(root);
for (const target of [
  { name: 'codelab-desktop-control', label: 'codelab.desktop-control', value: 'v2', directory: '/var/lib/codelab-runner' },
  { name: databaseTarget.name, label: 'codelab.workspace', value: 'v2', directory: '/var/lib/postgresql/data' },
]) {
  try {
    const info = JSON.parse(await docker(['inspect', target.name]))[0];
    if (target.name === databaseTarget.name) assertDatabaseTarget(databaseTarget, info);
    if (info.Config.Labels?.[target.label] !== target.value || !info.State.Running)
      throw new Error('TARGET_NOT_READY_OR_NOT_OWNED');
    if (!info.Mounts.some((m: { Destination: string; Type: string }) => m.Destination === target.directory && m.Type === 'volume'))
      throw new Error('EXPECTED_VOLUME_MISSING');
    const usage = (await docker(['exec', info.Id, 'du', '-sk', target.directory])).trim();
    const disk = (await docker(['exec', info.Id, 'df', '-Pk', target.directory])).trim().split(/\r?\n/).at(-1)!;
    const used = usage.match(/^(\d+)\s/), fields = disk.trim().split(/\s+/);
    if (!used || fields.length < 6) throw new Error('INVALID_DISK_RESPONSE');
    const totalBytes = Number(fields[1]) * 1024, availableBytes = Number(fields[3]) * 1024;
    volumes.push({ name: target.name, complete: true, allocatedBytes: Number(used[1]) * 1024,
      totalBytes, availableBytes, level: capacityLevel(totalBytes, availableBytes) });
  } catch {
    // Never serialize Docker errors: inspect/exec errors may include sensitive context.
    volumes.push({ name: target.name, complete: false, level: 'unknown', issue: 'VOLUME_MEASUREMENT_FAILED' });
  }
}
const complete = host.complete && volumes.every(v => v.complete);
const levels = [host.filesystem?.level, ...volumes.map(v => v.level)];
const level = levels.includes('critical') ? 'critical' : !complete ? 'unknown' : levels.includes('warning') ? 'warning' : 'ok';
const report = { measuredAt: new Date().toISOString(), level, complete, policy: defaultCapacityPolicy,
  host: { scope: '.data (includes private backups and development evidence)', ...host }, volumes,
  limitations: ['Live snapshot, not an atomic quota or automatic admission gate',
    'Host logical sizes and Docker allocated sizes are different metrics; do not sum filesystem capacity',
    'Docker volumes may share the same virtual filesystem; its free space does not prove Windows backing-disk capacity',
    'No automatic retention deletion; published reports and failed verification evidence are preserved'] };
const directory = path.join(root, 'docs/verification', new Date().toISOString().slice(0, 10), `storage-${randomUUID()}`);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ level, complete, evidence: path.relative(root, path.join(directory, 'result.json')) }));
process.exitCode = level === 'ok' ? 0 : level === 'warning' ? 2 : 1;
