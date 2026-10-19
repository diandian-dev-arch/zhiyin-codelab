import { postgres, type DB } from '../../apps/api/src/db.js';
import { runInitialAnalysisV2, runReanalysisSummaryV2 } from '../../apps/api/src/analysis-v2.js';
import { runInitialAgentV2, runReanalysisAgentV2 } from '../../apps/api/src/agent-v2.js';
import type { RunnerClientV2 } from '../../apps/api/src/runner-client-v2.js';
import { createSummaryProviderV2 } from '../../apps/api/src/model-provider-v2.js';
import type { OwnerIdentity } from '../../apps/api/src/lifecycle-v2.js';

// Deliberately no .env loading. Parent supplies only a disposable database and
// a loopback synthetic endpoint; credentials never travel on the command line.
process.once('message', async (input: { url: string; owner: OwnerIdentity; endpoint: string; stage: string; strategy: string }) => {
  const endpoint = new URL(input.endpoint);
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') process.exit(2);
  const db = postgres(input.url);
  const intercept = (database: DB): DB => ({
    ...database,
    transaction: fn => database.transaction(tx => fn(intercept(tx))),
    query: async (sql, params) => {
      if (input.stage === 'candidate-commit' && sql.startsWith('UPDATE analysis_attempts SET status=$2,candidate=$3')) {
        if (!params?.[2]) throw new Error('FIXTURE_EXPECTED_VALID_CANDIDATE');
        process.send?.({ state: 'candidate-commit' });
        await new Promise<never>(() => {});
      }
      return database.query(sql, params);
    },
  });
  try {
    const options = { db: intercept(db), owner: input.owner, provider: createSummaryProviderV2({
      MODEL_BASE_URL: input.endpoint, MODEL_API_KEY: 'synthetic-local-only', MODEL_NAME: 'crash-fixture',
    })! };
    const agent = input.owner.kind === 'execution' ? runInitialAgentV2 : runReanalysisAgentV2;
    const summary = input.owner.kind === 'execution' ? runInitialAnalysisV2 : runReanalysisSummaryV2;
    const result = input.strategy === 'agent'
      ? await agent({ ...options, runner: {} as RunnerClientV2, artifacts: {
        storeManifest: async () => { throw new Error('UNEXPECTED_ARTIFACT_WRITE'); },
        readEvidence: async () => { throw new Error('UNEXPECTED_ARTIFACT_READ'); },
      } })
      : await summary(options);
    if (input.stage === 'candidate-committed' && result?.status === 'succeeded') {
      process.send?.({ state: input.stage });
      await new Promise<never>(() => {});
    }
    process.send?.({ state: 'unexpected-completion' });
  } catch {
    process.send?.({ state: 'unexpected-error' });
  } finally {
    await db.close();
    process.disconnect();
  }
});
