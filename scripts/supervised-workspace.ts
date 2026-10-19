import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { root } from '../apps/api/src/template.js';
import { superviseWorkspace } from './workspace-supervisor.js';
import { assertWorkspaceRuntime } from './workspace-runtime.js';

assertWorkspaceRuntime();

// An exclusive loopback guard belongs to this process, and the OS releases it on
// exit. No stale PID-file deletion, adoption, or killing of existing workspaces.
const guard = createServer(socket => socket.destroy());
const controller = new AbortController();
const supervisorId = randomUUID();
let ownedChild: ChildProcess | undefined;
const directory = path.join(root, '.data/business-v2');
mkdirSync(directory, { recursive: true });
const record = (event: object) => appendFileSync(path.join(directory, 'supervisor.jsonl'), JSON.stringify({
  supervisorId, supervisorPid: process.pid, at: new Date().toISOString(), ...event,
}) + '\n', { mode: 0o600 });
try {
  await new Promise<void>((resolve, reject) => {
    guard.once('error', reject);
    guard.listen({ host: '127.0.0.1', port: 3103, exclusive: true }, resolve);
  });
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  record({ event: 'supervisor_started', node: process.versions.node, uv: process.versions.uv });
  const result = await superviseWorkspace({
    signal: controller.signal, record,
    start: () => ownedChild = spawn(process.execPath, ['--import', 'tsx', '--env-file-if-exists=.env', 'scripts/workspace-v2.ts'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }),
  });
  record({ event: 'supervisor_finished', ...result });
  process.exitCode = result.code;
} catch {
  // Never print spawn arguments, connection strings, or model configuration.
  console.error('{"code":"WORKSPACE_SUPERVISOR_FAILED"}');
  process.exitCode = 1;
} finally {
  // A synchronous journal/entrypoint failure must not abandon the child while
  // releasing the exclusive guard. Wait for the owned process, never a PID file.
  if (ownedChild?.pid && ownedChild.exitCode === null && ownedChild.signalCode === null) {
    const child = ownedChild;
    const exited = once(child, 'exit');
    if (child.connected) child.send({ type: 'codelab-workspace-stop' }, () => {});
    else child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { await exited; } finally { clearTimeout(force); }
  }
  if (guard.listening) await new Promise<void>(resolve => guard.close(() => resolve()));
}
