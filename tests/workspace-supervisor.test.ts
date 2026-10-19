import { describe, expect, it } from 'vitest';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { superviseWorkspace, type SupervisorEvent } from '../scripts/workspace-supervisor.js';

const launch = (mode: string) => fork(path.resolve('tests/helpers/workspace-supervisor-child.mjs'), [mode], {
  execArgv: [], silent: true, windowsHide: true,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP },
});
describe('bounded workspace supervisor with real child processes', () => {
  it('restarts a killed HTTP child only after exit and stops the replacement without replaying work', async () => {
    const controller = new AbortController(), events: SupervisorEvent[] = [], children: ChildProcess[] = [];
    const ports: number[] = [], messages: unknown[] = [];
    let ready!: () => void;
    const bothReady = new Promise<void>(resolve => { ready = resolve; });
    const result = superviseWorkspace({ signal: controller.signal, record: e => events.push(e), restartDelayMs: 10,
      start: () => {
        if (children.length) expect(children.at(-1)!.exitCode !== null || children.at(-1)!.signalCode !== null).toBe(true);
        const child = launch('wait'); children.push(child);
        child.on('message', async (message: any) => {
          messages.push(message); ports.push(message.port);
          if (children.length === 1) child.kill('SIGKILL'); else ready();
        });
        return child;
      },
    });
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await Promise.race([bothReady, result.then(() => { throw new Error('SUPERVISOR_ENDED_BEFORE_READY'); })]);
      expect(await (await fetch(`http://127.0.0.1:${ports[1]}`)).text()).toBe('ready');
      await expect(fetch(`http://127.0.0.1:${ports[0]}`)).rejects.toThrow();
    } finally { clearTimeout(timeout); controller.abort(); }
    expect(await result).toEqual({ code: 0, reason: 'stopped', restarts: 1 });
    expect(children).toHaveLength(2); expect(messages).toHaveLength(2);
    expect(events.filter(e => e.event === 'exited')).toHaveLength(2);
    expect(events.some(e => e.event === 'forced_stop')).toBe(false);
  });
  it('bounds repeated crashes to three restarts and records each actual exit code', async () => {
    const events: SupervisorEvent[] = [];
    expect(await superviseWorkspace({ start: () => launch('crash'), signal: new AbortController().signal,
      record: e => events.push(e), restartDelayMs: 5 })).toEqual({ code: 1, reason: 'restart_limit', restarts: 3 });
    expect(events.filter(e => e.event === 'exited').map(e => e.exitCode)).toEqual([7, 7, 7, 7]);
  });
  it.each(['startup-fail', 'clean'])('does not restart %s', async mode => {
    let starts = 0;
    const result = await superviseWorkspace({ start: () => { starts++; return launch(mode); }, signal: new AbortController().signal, record: () => {} });
    expect(starts).toBe(1); expect(result.restarts).toBe(0);
    expect(result.reason).toBe(mode === 'clean' ? 'clean_exit' : 'startup_failed');
  });
  it('terminates a child that never becomes ready without retrying startup', async () => {
    const events: SupervisorEvent[] = [];
    const result = await superviseWorkspace({ start: () => launch('no-ready'), signal: new AbortController().signal,
      record: e => events.push(e), startupTimeoutMs: 250, stopGraceMs: 500 });
    expect(result).toEqual({ code: 1, reason: 'startup_failed', restarts: 0 });
    expect(events.some(e => e.event === 'startup_timeout')).toBe(true);
  });
  it('forces only its own unresponsive child to stop and never restarts after cancellation', async () => {
    const controller = new AbortController(), events: SupervisorEvent[] = [];
    const result = await superviseWorkspace({ start: () => launch('ignore-stop'), signal: controller.signal, stopGraceMs: 30,
      record: e => { events.push(e); if (e.event === 'ready') controller.abort(); } });
    expect(result).toEqual({ code: 0, reason: 'stopped', restarts: 0 });
    expect(events.some(e => e.event === 'forced_stop')).toBe(true);
  });
  it('does not retry a command that cannot spawn', async () => {
    const result = await superviseWorkspace({ start: () => spawn(path.resolve('.data/nonexistent-supervisor-command'), [], { windowsHide: true }),
      signal: new AbortController().signal, record: () => {} });
    expect(result).toEqual({ code: 1, reason: 'startup_failed', restarts: 0 });
  });
});
