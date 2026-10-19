import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectWorkspaceRuntime, selectWorkspaceRuntime } from './workspace-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const args = process.argv.slice(2);
  if (new Set(args).size !== args.length || args.some(a => !['--direct', '--check'].includes(a)))
    throw new Error('WORKSPACE_LAUNCH_ARGUMENT_INVALID');
  const runtime = await inspectWorkspaceRuntime(await selectWorkspaceRuntime(root));
  console.log(JSON.stringify({ event: 'workspace_runtime_selected', ...runtime }));
  if (!args.includes('--check')) {
    const child = spawn(runtime.executable, ['--import', 'tsx', '--env-file-if-exists=.env',
      args.includes('--direct') ? 'scripts/workspace-v2.ts' : 'scripts/supervised-workspace.ts'], {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    // Terminal Ctrl+C is delivered to the foreground process group on Windows.
    // Keep this parent alive so the supervisor can finish its bounded shutdown.
    const stop = () => { if (process.platform !== 'win32') child.kill('SIGTERM'); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      const [code] = await once(child, 'exit');
      process.exitCode = code ?? 1;
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
} catch (error) {
  const code = error instanceof Error && /^WORKSPACE_[A-Z_]+$/.test(error.message) ? error.message : 'WORKSPACE_LAUNCH_FAILED';
  console.error(JSON.stringify({ code, help: 'Use patched Node 24.19+; set CODELAB_NODE_EXECUTABLE to its absolute path or see docs/REPRODUCE.md.' }));
  process.exitCode = 1;
}
