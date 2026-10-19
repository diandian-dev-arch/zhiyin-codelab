import { describe, expect, it } from "vitest";
import { createWorkspaceShutdown } from "../scripts/workspace-shutdown.js";
import { fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

describe("workspace shutdown", () => {
  it("closes a real HTTP listener and exits after duplicate signal handlers despite a close error", async () => {
    const child = fork(
      path.resolve("tests/helpers/workspace-shutdown-child.ts"),
      [],
      {
        execArgv: ["--import", "tsx"],
        silent: true,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
        },
      },
    );
    const messages: unknown[] = [];
    let output = "";
    child.on("message", (message) => messages.push(message));
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    const exited = once(child, "exit");
    try {
      const [ready] = (await once(child, "message")) as [
        { state: string; port: number },
      ];
      expect(ready.state).toBe("ready");
      const url = `http://127.0.0.1:${ready.port}`;
      expect(await (await fetch(url)).text()).toBe("ready");
      child.send("stop");
      expect((await exited)[0]).toBe(0);
      expect(
        messages.filter((message: any) => message.state === "database_closed"),
      ).toHaveLength(1);
      expect(messages).toContainEqual({ state: "failure", stage: "api" });
      expect(output).not.toContain("synthetic-secret");
      await expect(
        fetch(url, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    }
  });

  it("waits for worker settlement before closing its database and shares repeated stops", async () => {
    const events: string[] = [];
    let settle!: () => void;
    const worker = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const stop = createWorkspaceShutdown({
      abort: () => {
        events.push("abort");
      },
      worker,
      closeWeb: async () => {
        events.push("web");
      },
      closeApi: async () => {
        events.push("api");
      },
      closeDatabase: async () => {
        events.push("database");
      },
      reportFailure: (stage) => {
        events.push(`failed:${stage}`);
      },
    });
    const pending = stop();
    expect(stop()).toBe(pending);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["abort"]);
    settle();
    await pending;
    await stop();
    expect(events).toEqual(["abort", "web", "api", "database"]);
  });

  it("isolates failures at every close stage without exposing error details", async () => {
    const events: string[] = [];
    const fail = () => {
      throw new Error("secret-provider-and-database-details");
    };
    const stop = createWorkspaceShutdown({
      abort: fail,
      worker: Promise.reject(new Error("secret-worker-details")),
      closeWeb: async () => fail(),
      closeApi: async () => fail(),
      closeDatabase: async () => fail(),
      reportFailure: (stage) => {
        events.push(stage);
      },
    });
    await expect(stop()).resolves.toBeUndefined();
    expect(events).toEqual(["abort", "worker", "web", "api", "database"]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });
});
