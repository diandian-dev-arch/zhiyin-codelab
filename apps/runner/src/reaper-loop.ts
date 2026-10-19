import { setTimeout } from 'node:timers/promises';
import { readRunnerConfig } from './config.js';
import { DurableRunnerStore } from './durable-store.js';
import { DockerResourceAdapter } from './docker-resources.js';
import { reapExpired } from './resource-reaper.js';

const config = readRunnerConfig();
const store = await DurableRunnerStore.open(config.RUNNER_DATA_DIR);
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
while (!stopping) {
  try {
    const results = await reapExpired(store, new DockerResourceAdapter());
    if (results.length) process.stdout.write(JSON.stringify({
      service: 'reaper', checkedAt: new Date().toISOString(), results,
    }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ service: 'reaper', error: 'SWEEP_FAILED',
      kind: error instanceof Error ? error.name : 'UnknownError' }) + '\n');
  }
  await setTimeout(2000);
}
