import { z } from 'zod';
import { readRunnerConfig } from './config.js';
import { DurableRunnerStore } from './durable-store.js';
import { measureRunnerEnvironment } from './environment-v2.js';
import { createRunnerAppV2 } from './app-v2.js';
import { createStorageAdmission } from './storage-admission.js';

const config = readRunnerConfig();
const volumeName = z.string().regex(/^codelab-[a-z0-9][a-z0-9_-]{0,80}$/).parse(process.env.RUNNER_DATA_VOLUME);
const store = await DurableRunnerStore.open(config.RUNNER_DATA_DIR);
const environment = await measureRunnerEnvironment();
const app = await createRunnerAppV2({ store, environment, token: config.RUNNER_TOKEN, volumeName,
  storageAdmission: createStorageAdmission(config.RUNNER_DATA_DIR),
  fatal: () => { setTimeout(() => process.exit(1), 100).unref(); } });
await app.listen({ host: config.RUNNER_HOST, port: config.RUNNER_PORT });
process.stdout.write(JSON.stringify({ service: 'runner', event: 'ready', port: config.RUNNER_PORT,
  packManifestHash: environment.pack.contentHash }) + '\n');
for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal, () => {
  void app.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
});
