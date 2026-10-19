import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Node 22.22.2 excludes the main environment but still serializes worker
// environments on OOM. Only enable native dumps on the validated release line.
// Other supported runtimes retain bounded numeric diagnostics without dumps.
export function supportsPrivateFatalReports(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!match && Number(match[1]) === 24 && Number(match[2]) >= 19;
}

/** Bounded numeric history; no environment, request bodies, errors or credentials. */
export function installWorkspaceDiagnostics(directory: string, instanceId: string, intervalMs = 15_000) {
  if (!/^[a-f0-9-]{36}$/.test(instanceId)) throw new Error('DIAGNOSTIC_INSTANCE_INVALID');
  if (!Number.isInteger(intervalMs) || intervalMs < 10) throw new Error('DIAGNOSTIC_INTERVAL_INVALID');
  const destination = path.join(directory, 'diagnostics', instanceId);
  const samples: object[] = [];
  let warned = false;
  const unavailable = () => {
    if (!warned) { warned = true; process.stderr.write('{"code":"WORKSPACE_DIAGNOSTICS_UNAVAILABLE"}\n'); }
  };
  // Reports remain private in .data. Node can produce a report on a V8 fatal error,
  // but TerminateProcess, a hard OS kill and some native fast-fails bypass Node.
  let fatalReportsEnabled = false;
  try {
    // Override inherited report flags before checking capabilities, including
    // on runtimes where exclusion flags exist but worker exclusion is broken.
    process.report.reportOnFatalError = false;
    process.report.reportOnUncaughtException = false;
    process.report.reportOnSignal = false;
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    if (supportsPrivateFatalReports() && 'excludeEnv' in process.report && 'excludeNetwork' in process.report) {
      process.report.excludeEnv = true;
      process.report.excludeNetwork = true;
      process.report.directory = destination;
      process.report.reportOnFatalError = true;
      // Application exceptions may contain user text. Do not auto-dump those.
      process.report.reportOnUncaughtException = false;
      process.report.reportOnSignal = false;
      fatalReportsEnabled = true;
    }
  } catch { unavailable(); }
  const sample = () => {
    try {
      const memory = process.memoryUsage(), cpu = process.cpuUsage();
      samples.push({ at: new Date().toISOString(), uptimeSeconds: process.uptime(),
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers,
        availableMemoryBytes: process.availableMemory(), hostFreeMemoryBytes: os.freemem(),
        cpuUserMicroseconds: cpu.user, cpuSystemMicroseconds: cpu.system });
      if (samples.length > 60) samples.shift();
      const pending = path.join(destination, 'resources.pending.json');
      writeFileSync(pending, JSON.stringify({
        version: 1, instanceId, pid: process.pid, parentPid: process.ppid,
        runtime: { node: process.version, v8: process.versions.v8, uv: process.versions.uv,
          platform: process.platform, arch: process.arch },
        fatalReportsEnabled,
        fatalReportPolicy: fatalReportsEnabled ? 'validated-runtime' : 'numeric-only-unverified-runtime',
        intervalMs, sampleLimit: 60, samples,
      }), { mode: 0o600 });
      // A failed/truncated new write must not erase the last complete sample set.
      renameSync(pending, path.join(destination, 'resources.json'));
    } catch { unavailable(); }
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  const onExit = () => { clearInterval(timer); sample(); };
  process.once('exit', onExit);
  return () => { clearInterval(timer); process.removeListener('exit', onExit); };
}
