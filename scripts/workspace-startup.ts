type Close = () => Promise<unknown>;

/** Roll back acquired process resources on startup failure; persistent data is never removed. */
export async function withWorkspaceStartup<T>(
  start: (acquired: (stage: string, close: Close) => void) => Promise<T>,
  reportFailure: (stage: string) => void,
): Promise<T> {
  const acquired: { stage: string; close: Close }[] = [];
  try {
    return await start((stage, close) => acquired.push({ stage, close }));
  } catch (error) {
    for (const resource of acquired.reverse()) {
      try {
        await resource.close();
      } catch {
        reportFailure(resource.stage);
      }
    }
    throw error;
  }
}
