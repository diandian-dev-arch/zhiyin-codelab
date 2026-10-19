import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { withWorkspaceStartup } from "../scripts/workspace-startup.js";

describe("workspace startup rollback", () => {
  it("closes an acquired HTTP listener when the next port is occupied without closing its owner", async () => {
    const owner = createServer((_req, res) => res.end("existing-owner"));
    const api = createServer((_req, res) => res.end("temporary-api"));
    const web = createServer();
    const listen = (server: typeof owner, port = 0) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    const close = (server: typeof owner) =>
      new Promise<void>((resolve) => server.close(() => resolve()));
    await listen(owner);
    const ownerPort = (owner.address() as { port: number }).port;
    let apiPort = 0;
    const closed: string[] = [];
    try {
      await expect(
        withWorkspaceStartup(
          async (acquired) => {
            acquired("database", async () => {
              closed.push("database");
            });
            acquired("api", () => close(api));
            await listen(api);
            apiPort = (api.address() as { port: number }).port;
            acquired("web", () => close(web));
            await listen(web, ownerPort);
          },
          (stage) => {
            closed.push(`failed:${stage}`);
          },
        ),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(closed).toEqual(["database"]);
      await expect(
        fetch(`http://127.0.0.1:${apiPort}`, {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow();
      expect(await (await fetch(`http://127.0.0.1:${ownerPort}`)).text()).toBe(
        "existing-owner",
      );
    } finally {
      await Promise.all([close(owner), close(api), close(web)]);
    }
  });

  it("continues rollback in reverse order while preserving the original startup error", async () => {
    const original = new Error("startup");
    const events: string[] = [];
    await expect(
      withWorkspaceStartup(
        async (acquired) => {
          acquired("database", async () => {
            events.push("database");
          });
          acquired("api", async () => {
            events.push("api");
            throw new Error("private-details");
          });
          throw original;
        },
        (stage) => {
          events.push(`failed:${stage}`);
        },
      ),
    ).rejects.toBe(original);
    expect(events).toEqual(["api", "failed:api", "database"]);
  });

  it("keeps acquired resources open after successful startup", async () => {
    let closed = false;
    expect(
      await withWorkspaceStartup(
        async (acquired) => {
          acquired("database", async () => {
            closed = true;
          });
          return "running";
        },
        () => {
          throw new Error("unexpected");
        },
      ),
    ).toBe("running");
    expect(closed).toBe(false);
  });
});
