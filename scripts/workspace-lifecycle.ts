import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { installWorkspaceDiagnostics } from './workspace-diagnostics.js';

type Event = "started" | "ready" | "sigint" | "sigterm" | "worker_ended"
  | "worker_rejected" | "startup_failed" | "uncaught_exception"
  | "unhandled_rejection" | "exit" | "supervisor_stop" | "supervisor_disconnected";

/** Append only fixed event names and process metadata, never exception/config values.
 * Synchronous writes also work in exit handlers. OS kills cannot run those handlers;
 * a missing exit event is evidence of an unobserved exit, not proof of a particular cause.
 */
export function installWorkspaceLifecycle(directory: string) {
  const instanceId = randomUUID();
  const filename = path.join(directory, "lifecycle.jsonl");
  mkdirSync(directory, { recursive: true });
  let warned = false;
  function record(event: Event, exitCode?: number) {
    try {
      appendFileSync(filename, JSON.stringify({
        instanceId, pid: process.pid, at: new Date().toISOString(), event,
        ...(Number.isSafeInteger(exitCode) ? { exitCode } : {}),
      }) + "\n", { mode: 0o600 });
    } catch {
      if (!warned) {
        warned = true;
        process.stderr.write('{"code":"WORKSPACE_LIFECYCLE_WRITE_FAILED"}\n');
      }
    }
  }
  record("started");
  installWorkspaceDiagnostics(directory, instanceId);
  process.on("exit", (code) => record("exit", code));
  // Monitor only: do not override Node's fatal-error behavior or resume execution.
  process.on("uncaughtExceptionMonitor", (_error, origin) => {
    record(origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception");
  });
  return record;
}
