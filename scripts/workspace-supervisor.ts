import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export interface SupervisorEvent {
  event: 'spawned' | 'ready' | 'spawn_failed' | 'control_failed' | 'startup_timeout' | 'stop_requested' | 'forced_stop' | 'exited' | 'restarting' | 'restart_limit';
  pid?: number;
  restart: number;
  exitCode?: number | null;
  signal?: string | null;
}

/** One owned child at a time. A failed start never becomes a retry loop. */
export async function superviseWorkspace(input: {
  start: () => ChildProcess;
  signal: AbortSignal;
  record: (event: SupervisorEvent) => void;
  maxRestarts?: number;
  restartDelayMs?: number;
  startupTimeoutMs?: number;
  stopGraceMs?: number;
}) {
  const maxRestarts = input.maxRestarts ?? 3;
  let restarts = 0;
  while (!input.signal.aborted) {
    let child: ChildProcess;
    try { child = input.start(); }
    catch { input.record({ event: 'spawn_failed', restart: restarts }); return { code: 1, reason: 'spawn_failed', restarts }; }
    let ready = false, stopping = false, startupTimedOut = false;
    const record = (event: SupervisorEvent['event'], details: Partial<SupervisorEvent> = {}) =>
      input.record({ event, pid: child.pid, restart: restarts, ...details });
    record('spawned');
    const outcome = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
      let finished = false;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (finished || stopping) return;
        stopping = true;
        record('stop_requested');
        if (child.connected) child.send({ type: 'codelab-workspace-stop' }, () => {});
        else child.kill('SIGTERM');
        stopTimer = setTimeout(() => { if (!finished) { record('forced_stop'); child.kill('SIGKILL'); } }, input.stopGraceMs ?? 15_000);
      };
      const startupTimer = setTimeout(() => {
        if (!ready && !finished) { startupTimedOut = true; record('startup_timeout'); stop(); }
      }, input.startupTimeoutMs ?? 60_000);
      const onMessage = (message: unknown) => {
        if (!ready && !stopping && message && typeof message === 'object'
          && (message as { type?: unknown }).type === 'codelab-workspace-ready') {
          ready = true; clearTimeout(startupTimer); record('ready');
        }
      };
      const finish = (code: number | null, signal: string | null) => {
        if (finished) return;
        finished = true; clearTimeout(startupTimer); clearTimeout(stopTimer);
        input.signal.removeEventListener('abort', stop); child.removeListener('message', onMessage);
        resolve({ code, signal });
      };
      child.on('message', onMessage);
      child.on('error', () => {
        if (finished) return;
        if (!child.pid) { record('spawn_failed'); finish(1, null); }
        else { record('control_failed'); child.kill('SIGKILL'); }
      });
      child.once('exit', (code, signal) => finish(code, signal));
      input.signal.addEventListener('abort', stop, { once: true });
      if (input.signal.aborted) stop();
    });
    record('exited', { exitCode: outcome.code, signal: outcome.signal });
    if (input.signal.aborted) return { code: 0, reason: 'stopped', restarts };
    if (startupTimedOut || !ready) return { code: 1, reason: 'startup_failed', restarts };
    if (outcome.code === 0) return { code: 0, reason: 'clean_exit', restarts };
    if (restarts >= maxRestarts) { record('restart_limit'); return { code: 1, reason: 'restart_limit', restarts }; }
    restarts++;
    record('restarting');
    try { await delay((input.restartDelayMs ?? 2000) * restarts, undefined, { signal: input.signal }); }
    catch { return { code: 0, reason: 'stopped', restarts }; }
  }
  return { code: 0, reason: 'stopped', restarts };
}
