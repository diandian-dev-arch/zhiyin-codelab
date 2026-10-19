import { describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("workspace lifecycle diagnostic journal", () => {
  it.each(["normal", "fatal", "reject", "kill"])("preserves %s exit evidence without private payloads", async (mode) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codelab-lifecycle-"));
    const child = fork(path.resolve("tests/helpers/workspace-lifecycle-child.ts"), [directory, mode], {
      execArgv: ["--import", "tsx"], silent: true, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP },
    });
    child.stdout?.resume(); child.stderr?.resume();
    const exited = once(child, "exit");
    try {
      if (mode === "kill") { await once(child, "message"); child.kill("SIGKILL"); }
      const [code] = await exited;
      const raw = await readFile(path.join(directory, "lifecycle.jsonl"), "utf8");
      expect(raw).not.toContain("synthetic-private");
      const events = raw.trim().split("\n").map(line => JSON.parse(line));
      expect(new Set(events.map(event => event.instanceId)).size).toBe(1);
      expect(events.every(event => event.pid === child.pid)).toBe(true);
      expect(events.map(event => event.event)).toEqual(mode === "kill" ? ["started", "ready"] :
        mode === "normal" ? ["started", "ready", "exit"] :
        ["started", "ready", mode === "fatal" ? "uncaught_exception" : "unhandled_rejection", "exit"]);
      if (mode !== "kill") {
        expect(code).toBe(mode === "normal" ? 7 : 1);
        expect(events.at(-1).exitCode).toBe(code);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
