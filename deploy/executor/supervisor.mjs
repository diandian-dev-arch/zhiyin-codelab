import { spawn } from 'node:child_process';
// Two independent processes in one trusted PID namespace. A runner exit does
// not terminate the reaper. Neither student nor browser gets this namespace.
let stopping = false;
const children = new Map();
function start(name, entry) {
  if (stopping) return;
  const child = spawn('node', ['--import', 'tsx', entry], { stdio: 'inherit' });
  children.set(name, child);
  process.stdout.write(JSON.stringify({ service: name, event: 'started', pid: child.pid }) + '\n');
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    children.delete(name);
    process.stdout.write(JSON.stringify({ service: name, event: 'exited', code, signal }) + '\n');
    if (!stopping) setTimeout(() => start(name, entry), 2000);
  });
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopping = true;
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 8000).unref();
});
start('reaper', 'apps/runner/src/reaper-loop.ts');
start('runner', 'apps/runner/src/server-v2.ts');
