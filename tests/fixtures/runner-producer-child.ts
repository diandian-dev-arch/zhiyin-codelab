import { DurableRunnerStore } from "../../apps/runner/src/durable-store.js";

// No Docker daemon is contacted. The parent test observes a real process exit
// with a durable, unacknowledged dispatch and then runs an independent reaper.
const input = JSON.parse(
  Buffer.from(process.argv[3]!, "base64url").toString("utf8"),
);
const store = await DurableRunnerStore.open(process.argv[2]!, {
  now: () => input.now,
});
await store.registerOwner(input.registration);
await store.reserveOperation(input.registration.owner, input.operation);
const dispatch = await store.beginOperation(
  input.registration.owner,
  input.operation.operationId,
);
if (!dispatch.dispatchToken) throw new Error("Dispatch was not started");
await store.ensureWorkspace(
  input.registration.owner,
  input.operation.operationId,
  dispatch.dispatchToken,
);
await store.planResource(
  input.registration.owner,
  input.operation.operationId,
  dispatch.dispatchToken,
  "container",
  "build",
);
// Exit without completing the operation or cleaning its owner, as a crashed
// runner would. An accepted/running action must never be replayed after this.
process.stdout.write("persisted\n");
