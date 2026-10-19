import { readRunnerConfig } from "./config.js";
import { DurableRunnerStore } from "./durable-store.js";
import { DockerResourceAdapter } from "./docker-resources.js";
import { inspectReadiness, reapExpired } from "./resource-reaper.js";

// Standalone entry point: importing runner/server.ts is deliberately unnecessary.
try {
  const config = readRunnerConfig();
  const store = await DurableRunnerStore.open(config.RUNNER_DATA_DIR);
  const results = await reapExpired(store, new DockerResourceAdapter());
  const readiness = await inspectReadiness(
    store,
    new DockerResourceAdapter(5000),
  );
  const pending = results.filter((result) => result.receipt.state !== "clean");
  process.stdout.write(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      ownersChecked: results.length,
      cleanupPending: pending.length,
      readiness,
      results,
    }) + "\n",
  );
  if (
    pending.length ||
    ["cleanup_pending", "unavailable"].includes(readiness.state)
  )
    process.exitCode = 2;
} catch (error) {
  // Do not print env values, filesystem records, owner tokens or CLI request data.
  process.stderr.write(
    JSON.stringify({
      error: "REAPER_FAILED",
      kind: error instanceof Error ? error.name : "UnknownError",
    }) + "\n",
  );
  process.exitCode = 1;
}
