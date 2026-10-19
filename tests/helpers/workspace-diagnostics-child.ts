import { installWorkspaceDiagnostics } from '../../scripts/workspace-diagnostics.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

process.env.SYNTHETIC_PRIVATE_TOKEN = 'synthetic-private-diagnostics-do-not-record';
const stop = installWorkspaceDiagnostics(process.argv[2], randomUUID(), 10);
if (process.argv[3] === 'fatal') {
  const held: number[][] = [];
  // Only this disposable child has a 32MiB V8 heap; do not exhaust host memory.
  while (true) held.push(new Array<number>(100_000).fill(17));
} else {
  await delay(750);
  stop();
}
