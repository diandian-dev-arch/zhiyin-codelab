/** Close in dependency order, even when a previous resource fails to close.
 * Error values are deliberately not logged: providers and database errors can contain secrets.
 */
export function createWorkspaceShutdown(options: {
  abort: () => void;
  worker: Promise<unknown>;
  closeWeb: () => Promise<unknown>;
  closeApi: () => Promise<unknown>;
  closeDatabase: () => Promise<unknown>;
  reportFailure: (stage: string) => void;
}) {
  let stopping: Promise<void> | undefined;
  // Attach immediately, not only when a signal arrives, so an early worker rejection is handled.
  const worker = options.worker.then(
    () => true,
    () => false,
  );
  return () => {
    if (stopping) return stopping;
    stopping = Promise.resolve().then(async () => {
      const steps: [string, () => unknown][] = [
        ["abort", options.abort],
        [
          "worker",
          async () => {
            if (!(await worker)) throw new Error("WORKER_FAILED");
          },
        ],
        ["web", options.closeWeb],
        ["api", options.closeApi],
        ["database", options.closeDatabase],
      ];
      for (const [stage, close] of steps) {
        try {
          await close();
        } catch {
          options.reportFailure(stage);
        }
      }
    });
    return stopping;
  };
}
