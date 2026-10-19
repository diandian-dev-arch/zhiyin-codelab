import { installWorkspaceLifecycle } from "../../scripts/workspace-lifecycle.js";

const record = installWorkspaceLifecycle(process.argv[2]);
record("ready");
if (process.argv[3] === "fatal") {
  setImmediate(() => { throw new Error("synthetic-private-error-payload"); });
} else if (process.argv[3] === "reject") {
  void Promise.reject(new Error("synthetic-private-error-payload"));
} else if (process.argv[3] === "kill") {
  setInterval(() => {}, 1000);
  process.send?.("ready");
} else {
  process.exitCode = 7;
}
