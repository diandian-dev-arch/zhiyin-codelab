import { mkdir } from 'node:fs/promises';
import { postgres, migrate } from '../apps/api/src/db.js';
import { initializeOnlineOwner, pocketbayRuntime } from './pocketbay-runtime.js';

try {
  const runtime = pocketbayRuntime(process.env, process.argv.slice(2));
  Object.assign(process.env, runtime);
  // Cloud analysis uses personal models; never inherit an execution catalog or platform model fallback.
  for (const name of ['CODELAB_V2_RUNTIME_FILE', 'WORKER_V2_FINGERPRINT_FILE', 'RUNNER_URL', 'RUNNER_TOKEN',
    'MODEL_API_KEY', 'OPENAI_API_KEY', 'MODEL_CREDENTIAL_KEY']) delete process.env[name];
  await mkdir(runtime.DATA_DIR, { recursive: true });
  const db = postgres();
  try {
    await migrate(db);
    await initializeOnlineOwner(db, process.env.CODELAB_BOOTSTRAP_EMAIL!, process.env.CODELAB_BOOTSTRAP_PASSWORD!);
  } finally { await db.close(); }
  await import('../apps/api/src/main.js');
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(JSON.stringify({ code: /^ONLINE_[A-Z_]+$/.test(message) ? message : 'ONLINE_START_FAILED',
    help: 'Check the platform database, PORT, persistent volume and approved cloud-only bootstrap configuration.' }));
  process.exitCode = 1;
}
