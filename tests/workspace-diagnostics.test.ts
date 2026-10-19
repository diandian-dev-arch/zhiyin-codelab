import { it, expect } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { supportsPrivateFatalReports } from '../scripts/workspace-diagnostics.js';

it('limits native fatal reports to the validated release line', () => {
  for (const version of ['22.22.2', '24.18.1', '25.0.0', '26.0.0', 'invalid'])
    expect(supportsPrivateFatalReports(version)).toBe(false);
  expect(supportsPrivateFatalReports('24.19.0')).toBe(true);
});

it.each(['normal', 'fatal'])('keeps bounded private diagnostics for a real %s child', async mode => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codelab-diagnostics-'));
  const child = fork(path.resolve('tests/helpers/workspace-diagnostics-child.ts'), [directory, mode], {
    execArgv: ['--import', 'tsx', '--report-on-fatalerror', ...(mode === 'fatal' ? ['--max-old-space-size=32'] : [])],
    silent: true, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP },
  });
  child.stdout?.resume(); child.stderr?.resume();
  const exited = once(child, 'exit');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const [code] = await exited;
    expect(code === 0).toBe(mode === 'normal');
    const directories = await readdir(path.join(directory, 'diagnostics'));
    expect(directories).toHaveLength(1);
    const location = path.join(directory, 'diagnostics', directories[0]);
    const raw = await readFile(path.join(location, 'resources.json'), 'utf8');
    expect(raw).not.toContain('synthetic-private');
    const state = JSON.parse(raw);
    expect(state.pid).toBe(child.pid);
    expect(state.fatalReportsEnabled).toBe(supportsPrivateFatalReports());
    expect(state.samples.length).toBeGreaterThan(0);
    expect(state.samples.length).toBeLessThanOrEqual(60);
    expect(state.samples.every((s: {rssBytes:number}) => s.rssBytes > 0)).toBe(true);
    const reports = (await readdir(location)).filter(f => f.startsWith('report.'));
    if (mode === 'normal' || !supportsPrivateFatalReports()) {
      expect(reports).toHaveLength(0);
      if (mode === 'normal') expect(state.samples.length).toBeGreaterThan(5);
    } else {
      expect(reports).toHaveLength(1);
      const fatal = await readFile(path.join(location, reports[0]), 'utf8');
      // Avoid printing the entire sensitive report if this assertion regresses.
      expect(fatal.includes('synthetic-private')).toBe(false);
      const parsed = JSON.parse(fatal);
      expect(parsed.environmentVariables).toBeUndefined();
      expect(parsed.header.event).toMatch(/heap|allocation/i);
      expect(parsed.nativeStack.length).toBeGreaterThan(0);
    }
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
