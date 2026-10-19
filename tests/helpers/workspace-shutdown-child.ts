import { createServer } from "node:http";
import { createWorkspaceShutdown } from "../../scripts/workspace-shutdown.js";

const server = createServer((_request, response) => response.end("ready"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
let finish!: () => void;
const worker = new Promise<void>((resolve) => {
  finish = resolve;
});
const stop = createWorkspaceShutdown({
  abort: finish,
  worker,
  closeWeb: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  closeApi: async () => {
    throw new Error("synthetic-secret-must-not-be-printed");
  },
  closeDatabase: async () => {
    process.send?.({ state: "database_closed" });
  },
  reportFailure: (stage) => {
    process.send?.({ state: "failure", stage });
  },
});
process.on("SIGTERM", () => {
  void stop().then(() => {
    if (process.connected) process.disconnect?.();
  });
});
process.on("message", () => {
  // Windows kill() force-terminates; explicitly exercise the application's signal handler here.
  process.emit("SIGTERM");
  process.emit("SIGTERM");
});
const address = server.address();
process.send?.({
  state: "ready",
  port: typeof address === "object" ? address?.port : undefined,
});
