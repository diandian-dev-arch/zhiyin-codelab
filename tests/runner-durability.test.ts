import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  lstat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runnerCleanupResponseSchema } from "../packages/contracts/src/v2/index.js";
import {
  DurableRunnerStore,
  type OwnerIdentity,
  type OwnerKey,
  type PlannedResource,
} from "../apps/runner/src/durable-store.js";
import {
  inspectReadiness,
  reapExpired,
  reapOwner,
  type ObservedResource,
  type ResourceAdapter,
} from "../apps/runner/src/resource-reaper.js";

const exec = promisify(execFile);
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
class FakeDocker implements ResourceAdapter {
  records = new Map<string, ObservedResource>();
  removed: string[] = [];
  failingRemovals = new Set<string>();
  unavailable = false;
  async listManaged() {
    if (this.unavailable) throw new Error("Daemon unavailable");
    return [...this.records.values()].filter(
      (resource) => resource.labels["codelab.managed"] === "true",
    );
  }
  add(plan: PlannedResource, labels = plan.labels) {
    const resource = {
      ...plan,
      id: digest(randomUUID()),
      labels: { ...labels },
    };
    this.records.set(resource.id, resource);
    return resource;
  }
  async listOwned(storeId: string, owner: OwnerKey) {
    if (this.unavailable) throw new Error("Daemon unavailable");
    return [...this.records.values()].filter(
      (record) =>
        record.labels["codelab.store"] === storeId &&
        record.labels["codelab.run"] === owner.runId &&
        record.labels["codelab.owner-kind"] === owner.ownerKind &&
        record.labels["codelab.owner"] === owner.ownerId,
    );
  }
  async inspect(kind: PlannedResource["kind"], nameOrId: string) {
    if (this.unavailable) throw new Error("Daemon unavailable");
    return (
      [...this.records.values()].find(
        (record) =>
          record.kind === kind &&
          (record.id === nameOrId || record.name === nameOrId),
      ) ?? null
    );
  }
  async remove(_kind: PlannedResource["kind"], id: string) {
    if (this.failingRemovals.has(id)) throw new Error("Removal failed");
    this.removed.push(id);
    this.records.delete(id);
  }
}

let directory: string,
  store: DurableRunnerStore,
  docker: FakeDocker,
  now: number;
const disposable: string[] = [];
beforeEach(async () => {
  now = Date.now();
  directory = await mkdtemp(
    path.join(await realpath(tmpdir()), "codelab-durable-test-"),
  );
  disposable.push(directory);
  store = await DurableRunnerStore.open(directory, { now: () => now });
  docker = new FakeDocker();
});
afterEach(async () => {
  const temporaryRoot = await realpath(tmpdir());
  for (const target of disposable.splice(0)) {
    if (
      path.dirname(path.resolve(target)) !== temporaryRoot ||
      !path.basename(target).startsWith("codelab-durable-test-")
    )
      throw new Error("Unexpected test cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});

function registration(kind: OwnerIdentity["ownerKind"] = "execution") {
  const limit = kind === "execution" ? 300000 : 90000;
  return {
    owner: {
      runId: randomUUID(),
      ownerKind: kind,
      ownerId: randomUUID(),
      ownerToken: randomUUID(),
    },
    startedAt: new Date(now).toISOString(),
    workDeadlineAt: new Date(now + limit - 30000).toISOString(),
    hardDeadlineAt: new Date(now + limit).toISOString(),
    leaseUntil: new Date(now + 30000).toISOString(),
    remainingWorkMs: limit - 30000,
  };
}
async function running() {
  const input = registration();
  await store.registerOwner(input);
  const operation = {
    operationId: randomUUID(),
    requestHash: digest("execute request"),
    kind: "execute" as const,
  };
  await store.reserveOperation(input.owner, operation);
  const dispatch = await store.beginOperation(
    input.owner,
    operation.operationId,
  );
  const token = dispatch.dispatchToken!;
  const workspace = await store.ensureWorkspace(
    input.owner,
    operation.operationId,
    token,
  );
  const container = await store.planResource(
    input.owner,
    operation.operationId,
    token,
    "container",
    "build",
  );
  const network = await store.planResource(
    input.owner,
    operation.operationId,
    token,
    "network",
    "network",
  );
  return { input, operation, token, workspace, container, network };
}

describe("durable runner admission and operation identity", () => {
  it("allows only one owner across independent store instances and preserves its deadlines on replay", async () => {
    const peer = await DurableRunnerStore.open(directory, { now: () => now });
    const first = registration(),
      second = registration("analysis");
    const attempts = await Promise.allSettled([
      store.registerOwner(first),
      peer.registerOwner(second),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected")[0],
    ).toMatchObject({ reason: { code: "RUNNER_BUSY" } });
    const existing = (await store.inspect()).owners[0]!;
    const accepted = existing.ownerId === first.owner.ownerId ? first : second;
    now += 1000;
    expect(
      await peer.registerOwner({
        ...accepted,
        remainingWorkMs: accepted.remainingWorkMs - 1000,
      }),
    ).toEqual(existing);
    await expect(
      peer.registerOwner({
        ...accepted,
        hardDeadlineAt: new Date(now + 80000).toISOString(),
      }),
    ).rejects.toThrow();
    const persisted = (await readdir(path.join(directory, "journal"))).filter(
      (name) => name.endsWith(".json"),
    );
    const contents = await Promise.all(
      persisted.map((name) =>
        readFile(path.join(directory, "journal", name), "utf8"),
      ),
    );
    expect(contents.join("")).not.toContain(accepted.owner.ownerToken);
  });

  it("dispatches a repeated operation once and returns the persisted result after reopening", async () => {
    const input = registration();
    await store.registerOwner(input);
    const peer = await DurableRunnerStore.open(directory, { now: () => now });
    const operation = {
      kind: "execute" as const,
      operationId: randomUUID(),
      requestHash: digest("same"),
    };
    const reservations = await Promise.all([
      store.reserveOperation(input.owner, operation),
      peer.reserveOperation(input.owner, operation),
    ]);
    expect(reservations.filter((item) => item.created)).toHaveLength(1);
    const starts = await Promise.all([
      store.beginOperation(input.owner, operation.operationId),
      peer.beginOperation(input.owner, operation.operationId),
    ]);
    expect(starts.filter((item) => item.started)).toHaveLength(1);
    const token = starts.find((item) => item.started)!.dispatchToken!;
    const result = {
      context: { operationId: operation.operationId },
      caseResults: [{ caseId: "NEW-01", verdict: "passed" }],
    };
    await store.finishOperation(
      input.owner,
      operation.operationId,
      token,
      "completed",
      result,
    );
    const reopened = await DurableRunnerStore.open(directory, {
      now: () => now,
    });
    expect(
      await reopened.queryOperation(input.owner, operation.operationId),
    ).toMatchObject({
      operation: {
        state: "completed",
        responseHash: digest(
          JSON.stringify({
            caseResults: result.caseResults,
            context: result.context,
          }),
        ),
      },
      response: result,
    });
    expect(
      (await reopened.reserveOperation(input.owner, operation)).created,
    ).toBe(false);
    expect(
      (await reopened.beginOperation(input.owner, operation.operationId))
        .started,
    ).toBe(false);
    await expect(
      reopened.reserveOperation(input.owner, {
        ...operation,
        requestHash: digest("different"),
      }),
    ).rejects.toThrow("OPERATION_PAYLOAD_CONFLICT");
    await expect(
      reopened.queryOperation(
        { ...input.owner, ownerToken: randomUUID() },
        operation.operationId,
      ),
    ).rejects.toMatchObject({ code: "OWNER_NOT_FOUND", statusCode: 404 });
    await expect(
      reopened.reserveOperation(input.owner, {
        ...operation,
        operationId: randomUUID(),
      }),
    ).rejects.toThrow("OPERATION_KIND_ALREADY_REGISTERED");
  });

  it("keeps an unknown action unknown and never gives it another dispatch token", async () => {
    const task = await running();
    await store.finishOperation(
      task.input.owner,
      task.operation.operationId,
      task.token,
      "unknown",
    );
    const peer = await DurableRunnerStore.open(directory, { now: () => now });
    expect(
      (await peer.reserveOperation(task.input.owner, task.operation)).operation
        .state,
    ).toBe("unknown");
    expect(
      await peer.beginOperation(task.input.owner, task.operation.operationId),
    ).toMatchObject({ started: false, dispatchToken: null });
    expect(
      (await peer.queryOperation(task.input.owner, task.operation.operationId))
        .response,
    ).toBeNull();
    await expect(
      peer.reserveOperation(task.input.owner, {
        ...task.operation,
        operationId: randomUUID(),
      }),
    ).rejects.toThrow("OWNER_REVOKED");
    expect((await peer.inspect()).owners[0]?.phase).toBe("cleanup_pending");
    expect((await reapExpired(peer, docker))[0]?.receipt.state).toBe(
      "cleanup_pending",
    );
  });

  it("cannot regain write time after the wall clock moves forward and then backward", async () => {
    const original = now;
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const monotonicStore = await DurableRunnerStore.open(directory);
      const input = registration();
      await monotonicStore.registerOwner(input);
      now += 3600000;
      const operation = {
        operationId: randomUUID(),
        requestHash: digest("clock"),
        kind: "execute" as const,
      };
      await expect(
        monotonicStore.reserveOperation(input.owner, operation),
      ).rejects.toThrow("OWNER_REVOKED");
      now = original;
      await expect(
        monotonicStore.reserveOperation(input.owner, operation),
      ).rejects.toThrow("OWNER_REVOKED");
    } finally {
      wallClock.mockRestore();
    }
  });

  it("rejects expanded budgets, wrong owner kinds, expired writes and reset deadlines", async () => {
    const bad = registration("analysis");
    await expect(
      store.registerOwner({
        ...bad,
        hardDeadlineAt: new Date(now + 100000).toISOString(),
      }),
    ).rejects.toThrow("OWNER_DEADLINES_INVALID");
    await expect(
      store.registerOwner({
        ...bad,
        workDeadlineAt: new Date(now + 80000).toISOString(),
      }),
    ).rejects.toThrow("OWNER_DEADLINES_INVALID");
    await store.registerOwner(bad);
    await expect(
      store.reserveOperation(bad.owner, {
        operationId: randomUUID(),
        requestHash: digest("x"),
        kind: "execute",
      }),
    ).rejects.toThrow("OPERATION_OWNER_KIND_MISMATCH");
    await expect(
      store.heartbeat(bad.owner, new Date(now + 30001).toISOString()),
    ).rejects.toThrow("OWNER_DEADLINES_INVALID");
    now += 31000;
    await expect(
      store.heartbeat(bad.owner, new Date(now + 30000).toISOString()),
    ).rejects.toThrow("OWNER_REVOKED");
    await expect(
      store.reserveOperation(bad.owner, {
        operationId: randomUUID(),
        requestHash: digest("x"),
        kind: "probe",
      }),
    ).rejects.toThrow("OWNER_REVOKED");
  });
});

describe("independent fenced resource cleanup", () => {
  it("persists cleanup before admission and never revives a delayed execute after a clean receipt", async () => {
    const input = registration();
    const peer = await DurableRunnerStore.open(directory, { now: () => now });
    const tombstones = await Promise.all([
      store.registerCleanupOwner(input.owner),
      peer.registerCleanupOwner(input.owner),
    ]);
    expect(tombstones[0]).toEqual(tombstones[1]);
    expect(tombstones[0]).toMatchObject({
      phase: "cleanup_pending",
      resources: [],
      startedAt: new Date(now).toISOString(),
      workDeadlineAt: new Date(now).toISOString(),
      hardDeadlineAt: new Date(now).toISOString(),
      leaseUntil: new Date(now).toISOString(),
      cleanupReason: "cleanup_before_admission",
    });
    expect(tombstones[0]).not.toHaveProperty("ownerToken");
    await expect(
      store.heartbeat(input.owner, input.leaseUntil),
    ).rejects.toThrow("OWNER_REVOKED");
    await expect(
      store.reserveOperation(input.owner, {
        kind: "execute",
        operationId: randomUUID(),
        requestHash: digest("late execute"),
      }),
    ).rejects.toThrow("OWNER_REVOKED");
    const cleanup = {
      kind: "cleanup" as const,
      operationId: randomUUID(),
      requestHash: digest("cleanup before admission"),
    };
    await store.reserveOperation(input.owner, cleanup);
    const receipt = await reapOwner(store, docker, input.owner);
    expect(receipt).toMatchObject({ state: "clean", residualResourceIds: [] });
    const saved = await store.queryOperation(input.owner, cleanup.operationId);
    expect(runnerCleanupResponseSchema.parse(saved.response)).toMatchObject({
      state: "clean",
      ownerId: input.owner.ownerId,
      operationId: cleanup.operationId,
    });

    now += 1_000;
    const reopened = await DurableRunnerStore.open(directory, {
      now: () => now,
    });
    await expect(reopened.registerOwner(input)).rejects.toThrow(
      "OWNER_CONTEXT_CONFLICT",
    );
    await expect(
      reopened.heartbeat(input.owner, new Date(now + 30_000).toISOString()),
    ).rejects.toThrow("OWNER_REVOKED");
    const replay = await reopened.registerCleanupOwner(input.owner);
    expect(replay.phase).toBe("clean");
    expect(replay.startedAt).toBe(tombstones[0]!.startedAt);
    expect(replay.leaseUntil).toBe(tombstones[0]!.leaseUntil);
    expect(
      (await reopened.reserveOperation(input.owner, cleanup)).created,
    ).toBe(false);
    expect(
      await reopened.queryOperation(input.owner, cleanup.operationId),
    ).toEqual(saved);
    expect((await reopened.inspect()).owners).toHaveLength(1);
    expect((await inspectReadiness(reopened, docker)).state).toBe("ready");
    expect(docker.removed).toEqual([]);
  });

  it("authenticates cleanup registration without altering known owners or allowing token/run substitution", async () => {
    const active = registration();
    const original = await store.registerOwner(active);
    now += 1_000;
    expect(await store.registerCleanupOwner(active.owner)).toEqual(original);
    const pending = registration("analysis");
    await store.registerCleanupOwner(pending.owner);
    const before = await store.inspect();
    for (const owner of [active.owner, pending.owner]) {
      await expect(
        store.registerCleanupOwner({ ...owner, ownerToken: randomUUID() }),
      ).rejects.toMatchObject({ code: "OWNER_NOT_FOUND", statusCode: 404 });
      await expect(
        store.registerCleanupOwner({ ...owner, runId: randomUUID() }),
      ).rejects.toMatchObject({ code: "OWNER_NOT_FOUND", statusCode: 404 });
    }
    expect(await store.inspect()).toEqual(before);
    const journals = (await readdir(path.join(directory, "journal"))).filter(
      (name) => name.endsWith(".json"),
    );
    const persisted = await Promise.all(
      journals.map((name) =>
        readFile(path.join(directory, "journal", name), "utf8"),
      ),
    );
    expect(persisted.join("")).not.toContain(active.owner.ownerToken);
    expect(persisted.join("")).not.toContain(pending.owner.ownerToken);
  });

  it("cleans an unknown owner beside an active execution without touching that execution or its resources", async () => {
    const task = await running();
    const resource = docker.add(task.container);
    const activeBefore = (await store.inspect()).owners.find(
      (owner) => owner.ownerId === task.input.owner.ownerId,
    );
    const cleanupOnly = registration("analysis");
    await store.registerCleanupOwner(cleanupOnly.owner);
    await store.reserveOperation(cleanupOnly.owner, {
      kind: "cleanup",
      operationId: randomUUID(),
      requestHash: digest("unrelated empty cleanup"),
    });
    expect((await reapOwner(store, docker, cleanupOnly.owner)).state).toBe(
      "clean",
    );
    expect(docker.removed).toEqual([]);
    expect(docker.records.get(resource.id)).toEqual(resource);
    const current = await store.inspect();
    expect(
      current.owners.find(
        (owner) => owner.ownerId === task.input.owner.ownerId,
      ),
    ).toEqual(activeBefore);
    expect(
      current.operations.find(
        (operation) => operation.operationId === task.operation.operationId,
      )?.state,
    ).toBe("running");
    expect((await inspectReadiness(store, docker)).state).toBe("busy");
    await expect(store.registerOwner(registration())).rejects.toThrow(
      "RUNNER_BUSY",
    );
    expect(
      (
        await store.finishOperation(
          task.input.owner,
          task.operation.operationId,
          task.token,
          "completed",
          { ok: true },
        )
      ).state,
    ).toBe("completed");
  });

  it("keeps unregistered resources attributed to a cleanup-only tombstone as unresolved ownership", async () => {
    const input = registration();
    await store.registerCleanupOwner(input.owner);
    const unregistered: PlannedResource = {
      kind: "container",
      role: "build",
      name: `codelab-v2-execution-${input.owner.ownerId}-build`,
      operationId: randomUUID(),
      creationStartedAt: null,
      createdResourceId: null,
      labels: {
        "codelab.managed": "true",
        "codelab.protocol": "2",
        "codelab.store": store.storeId,
        "codelab.run": input.owner.runId,
        "codelab.owner-kind": input.owner.ownerKind,
        "codelab.owner": input.owner.ownerId,
      },
    };
    const resource = docker.add(unregistered);
    const receipt = await reapOwner(store, docker, input.owner);
    expect(receipt.state).toBe("cleanup_pending");
    expect(receipt.residualResourceIds).toContain(
      `ownership:container:${resource.id}`,
    );
    expect(docker.removed).toEqual([]);
    expect(docker.records.has(resource.id)).toBe(true);
    expect((await inspectReadiness(store, docker)).state).toBe(
      "cleanup_pending",
    );
    await expect(store.registerOwner(input)).rejects.toThrow(
      "OWNER_CONTEXT_CONFLICT",
    );
  });

  it("persists explicit cleanup identity and returns the same verified receipt on replay", async () => {
    const task = await running();
    docker.add(task.container);
    await store.finishOperation(
      task.input.owner,
      task.operation.operationId,
      task.token,
      "completed",
      { ok: true },
    );
    const cleanup = {
      kind: "cleanup" as const,
      operationId: randomUUID(),
      requestHash: digest("cleanup"),
    };
    expect(
      (await store.reserveOperation(task.input.owner, cleanup)).created,
    ).toBe(true);
    expect(
      (await store.reserveOperation(task.input.owner, cleanup)).created,
    ).toBe(false);
    await expect(
      store.reserveOperation(task.input.owner, {
        ...cleanup,
        requestHash: digest("altered cleanup"),
      }),
    ).rejects.toThrow("OPERATION_PAYLOAD_CONFLICT");
    await expect(
      store.beginOperation(task.input.owner, cleanup.operationId),
    ).rejects.toThrow("USE_REAPER_CLEANUP");
    expect((await inspectReadiness(store, docker)).state).toBe(
      "cleanup_pending",
    );
    await reapOwner(store, docker, task.input.owner);
    const result = await store.queryOperation(
      task.input.owner,
      cleanup.operationId,
    );
    expect(result.operation.state).toBe("completed");
    expect(runnerCleanupResponseSchema.parse(result.response)).toMatchObject({
      state: "clean",
      residualResourceIds: [],
      operationId: cleanup.operationId,
      requestHash: cleanup.requestHash,
    });
    const reopened = await DurableRunnerStore.open(directory, {
      now: () => now,
    });
    expect(
      await reopened.queryOperation(task.input.owner, cleanup.operationId),
    ).toEqual(result);
    expect(
      (await reopened.reserveOperation(task.input.owner, cleanup)).created,
    ).toBe(false);
    expect((await inspectReadiness(reopened, docker)).state).toBe("ready");
  });

  it("reports unregistered Docker resources and workspace directories without deleting them", async () => {
    expect((await inspectReadiness(store, docker)).state).toBe("ready");
    const legacy = {
      kind: "container" as const,
      id: digest("legacy"),
      name: "codelab-legacy-build",
      labels: { "codelab.managed": "true" },
    };
    docker.records.set(legacy.id, legacy);
    const orphan = `execution-${randomUUID()}`;
    await mkdir(path.join(directory, "resources", orphan));
    const readiness = await inspectReadiness(store, docker);
    expect(readiness).toMatchObject({
      state: "cleanup_pending",
      activeOwner: null,
    });
    expect(readiness.residualResourceIds).toContain(`container:${legacy.id}`);
    expect(readiness.residualResourceIds).toContain(`workspace:${orphan}`);
    expect(await reapExpired(store, docker)).toEqual([]);
    expect(docker.removed).toEqual([]);
    expect(
      (await lstat(path.join(directory, "resources", orphan))).isDirectory(),
    ).toBe(true);
  });

  it("recovers a producer that exited in another process using durable metadata only", async () => {
    const input = registration();
    const operation = {
      operationId: randomUUID(),
      requestHash: digest("child"),
      kind: "execute",
    };
    const child = fileURLToPath(
      new URL("./fixtures/runner-producer-child.ts", import.meta.url),
    );
    const output = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        child,
        directory,
        Buffer.from(
          JSON.stringify({ now, registration: input, operation }),
        ).toString("base64url"),
      ],
      { windowsHide: true, timeout: 15000 },
    );
    expect(output.stdout).toBe("persisted\n");
    const reopened = await DurableRunnerStore.open(directory, {
      now: () => now,
    });
    const owner = (await reopened.inspect()).owners[0]!;
    const actual = docker.add(owner.resources[0]!);
    now += 31000;
    const results = await reapExpired(reopened, docker);
    expect(results[0]?.receipt).toMatchObject({
      state: "clean",
      residualResourceIds: [],
    });
    expect(docker.removed).toEqual([actual.id]);
    await expect(
      lstat(reopened.workspacePath(input.owner)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await reopened.queryOperation(input.owner, operation.operationId))
        .operation.state,
    ).toBe("unknown");
    expect(
      (await reopened.beginOperation(input.owner, operation.operationId))
        .started,
    ).toBe(false);
    await expect(reopened.registerOwner(registration())).resolves.toMatchObject(
      { phase: "active" },
    );
  });

  it("keeps admission blocked while an old dispatch can still create resources, and rejects its late result", async () => {
    const task = await running();
    docker.add(task.container);
    now += 31000;
    const receipt = (await reapExpired(store, docker))[0]!.receipt;
    expect(receipt.state).toBe("cleanup_pending");
    expect(receipt.residualResourceIds).toContain(
      `producer:${task.operation.operationId}`,
    );
    expect((await lstat(task.workspace)).isDirectory()).toBe(true);
    await expect(store.registerOwner(registration())).rejects.toThrow(
      "RUNNER_BUSY",
    );
    await expect(
      store.finishOperation(
        task.input.owner,
        task.operation.operationId,
        task.token,
        "completed",
        { fabricatedLate: true },
      ),
    ).rejects.toThrow("LATE_OPERATION_RESULT_REJECTED");
    expect(
      await store.queryOperation(task.input.owner, task.operation.operationId),
    ).toMatchObject({ operation: { state: "unknown" }, response: null });
    expect((await reapExpired(store, docker))[0]?.receipt.state).toBe("clean");
  });

  it("keeps a started but unconfirmed create fenced after its producer dies and across restarts", async () => {
    const task = await running();
    await store.markResourceCreateStarted(task.input.owner, task.operation.operationId, task.token, "build");
    await expect(store.markResourceCreateStarted(
      task.input.owner, task.operation.operationId, task.token, "build",
    )).rejects.toThrow("RESOURCE_CREATE_ALREADY_STARTED");
    now += 31000;
    const pendingKey = `unconfirmed-create:container:${task.container.name}`;
    const first = (await reapExpired(store, docker, { producerAlive: async () => false }))[0]!.receipt;
    expect(first.state).toBe("cleanup_pending");
    expect(first.residualResourceIds).toContain(pendingKey);
    expect(first.residualResourceIds).not.toContain(`producer:${task.operation.operationId}`);
    expect((await lstat(task.workspace)).isDirectory()).toBe(true);
    // The final journal transition must enforce the barrier even if a caller
    // omits it from an otherwise empty observation result.
    expect(await store.recordCleanup(task.input.owner, {
      checkedResourceIds: [], residualResourceIds: [], stoppedOperationIds: [],
    })).toMatchObject({ state: "cleanup_pending", residualResourceIds: [pendingKey] });
    await expect(store.removeWorkspace(task.input.owner)).rejects.toThrow("RESOURCE_CREATE_UNCONFIRMED");
    const reopened = await DurableRunnerStore.open(directory, { now: () => now });
    now += 600000;
    expect((await reapExpired(reopened, docker, { producerAlive: async () => false }))[0]!.receipt)
      .toMatchObject({ state: "cleanup_pending", residualResourceIds: [pendingKey] });
    expect((await inspectReadiness(reopened, docker)).residualResourceIds).toContain(pendingKey);
    await expect(reopened.registerOwner(registration())).rejects.toThrow("RUNNER_BUSY");
  });

  it("settles a formerly invisible create only after a matching resource appears, then removes its exact ID", async () => {
    const task = await running();
    await store.markResourceCreateStarted(task.input.owner, task.operation.operationId, task.token, "build");
    now += 31000;
    expect((await reapExpired(store, docker, { producerAlive: async () => false }))[0]!.receipt.state)
      .toBe("cleanup_pending");
    // The orphaned CLI's one create becomes observable only after the first sweep.
    const late = docker.add(task.container);
    const reopened = await DurableRunnerStore.open(directory, { now: () => now });
    expect((await reapExpired(reopened, docker, { producerAlive: async () => false }))[0]!.receipt.state)
      .toBe("clean");
    expect(docker.removed).toEqual([late.id]);
    const persisted = (await reopened.inspect()).owners[0]!;
    expect(persisted.resources.find(resource => resource.role === "build")!.createdResourceId).toBe(late.id);
    expect(persisted.phase).toBe("clean");
    await expect(lstat(task.workspace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(reopened.registerOwner(registration())).resolves.toMatchObject({ phase: "active" });
    expect((await reopened.queryOperation(task.input.owner, task.operation.operationId)).operation.state).toBe("unknown");
  });

  it("never accepts mismatched resource labels as proof that an unconfirmed create landed", async () => {
    const task = await running();
    await store.markResourceCreateStarted(task.input.owner, task.operation.operationId, task.token, "build");
    const wrong = docker.add(task.container, { ...task.container.labels, "codelab.operation": randomUUID() });
    now += 31000;
    const receipt = (await reapExpired(store, docker, { producerAlive: async () => false }))[0]!.receipt;
    expect(receipt.state).toBe("cleanup_pending");
    expect(receipt.residualResourceIds).toContain(`unconfirmed-create:container:${task.container.name}`);
    expect(docker.removed).toEqual([]);
    expect((await store.inspect()).owners[0]!.resources.find(resource => resource.role === "build")!.createdResourceId).toBeNull();
    await expect(store.recordObservedResourceCreated(task.input.owner, wrong))
      .rejects.toThrow("RESOURCE_OBSERVATION_MISMATCH");
    docker.records.delete(wrong.id);
    expect((await reapExpired(store, docker, { producerAlive: async () => false }))[0]!.receipt.state)
      .toBe("cleanup_pending");
  });

  it("accepts a late immutable create acknowledgement without restoring owner or operation authority", async () => {
    const task = await running();
    await store.markResourceCreateStarted(task.input.owner, task.operation.operationId, task.token, "build");
    now += 31000;
    await reapExpired(store, docker, { producerAlive: async () => false });
    const late = docker.add(task.container);
    await store.recordResourceCreated(task.input.owner, task.operation.operationId, task.token, "build", late.id);
    await store.recordResourceCreated(task.input.owner, task.operation.operationId, task.token, "build", late.id);
    await expect(store.recordResourceCreated(
      task.input.owner, task.operation.operationId, task.token, "build", digest("different resource"),
    )).rejects.toThrow("RESOURCE_ID_CONFLICT");
    expect((await store.inspect()).owners[0]!.phase).toBe("cleanup_pending");
    expect((await store.queryOperation(task.input.owner, task.operation.operationId)).operation.state).toBe("unknown");
    await expect(store.heartbeat(task.input.owner, new Date(now + 30000).toISOString()))
      .rejects.toThrow("OWNER_REVOKED");
    await expect(store.markResourceCreateStarted(task.input.owner, task.operation.operationId, task.token, "network"))
      .rejects.toThrow("OWNER_REVOKED");
    expect((await store.beginOperation(task.input.owner, task.operation.operationId)).started).toBe(false);
    expect((await reapExpired(store, docker, { producerAlive: async () => false }))[0]!.receipt.state).toBe("clean");
    expect(docker.removed).toEqual([late.id]);
  });

  it("preserves an observed creation acknowledgement if the reaper crashes after removing the resource", async () => {
    const task = await running();
    await store.markResourceCreateStarted(task.input.owner, task.operation.operationId, task.token, "build");
    const actual = docker.add(task.container);
    now += 31000;
    const originalRecordCleanup = store.recordCleanup.bind(store);
    const crash = vi.spyOn(store, "recordCleanup").mockRejectedValueOnce(new Error("REAPER_CRASH_AFTER_REMOVE"));
    await expect(reapExpired(store, docker, { producerAlive: async () => false }))
      .rejects.toThrow("REAPER_CRASH_AFTER_REMOVE");
    expect(docker.records.has(actual.id)).toBe(false);
    crash.mockImplementation(originalRecordCleanup);
    const reopened = await DurableRunnerStore.open(directory, { now: () => now });
    expect((await reopened.inspect()).owners[0]!.resources.find(resource => resource.role === "build")!.createdResourceId)
      .toBe(actual.id);
    expect((await reapExpired(reopened, docker, { producerAlive: async () => false }))[0]!.receipt.state).toBe("clean");
  });

  it("does not apply an unresolved-create barrier to a plan that never received permission to dispatch", async () => {
    const task = await running();
    now += 31000;
    const receipt = (await reapExpired(store, docker, { producerAlive: async () => false }))[0]!.receipt;
    expect(receipt.state).toBe("clean");
    expect(receipt.residualResourceIds).toEqual([]);
    expect(docker.removed).toEqual([]);
    await expect(lstat(task.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires observed absence after removal and retries only cleanup when residue remains", async () => {
    const task = await running();
    const container = docker.add(task.container),
      network = docker.add(task.network);
    docker.failingRemovals.add(container.id);
    await store.finishOperation(
      task.input.owner,
      task.operation.operationId,
      task.token,
      "completed",
      { ok: true },
    );
    const first = await reapOwner(store, docker, task.input.owner);
    expect(first.state).toBe("cleanup_pending");
    expect(first.residualResourceIds).toContain(`container:${container.id}`);
    expect(docker.removed).toContain(network.id);
    await expect(store.registerOwner(registration())).rejects.toThrow(
      "RUNNER_BUSY",
    );
    docker.failingRemovals.clear();
    const reopened = await DurableRunnerStore.open(directory, {
      now: () => now,
    });
    const second = await reapOwner(reopened, docker, task.input.owner);
    expect(second.state).toBe("clean");
    expect(second.cleanupId).toBe(first.cleanupId);
    expect(
      (
        await reopened.queryOperation(
          task.input.owner,
          task.operation.operationId,
        )
      ).response,
    ).toEqual({ ok: true });
    expect(await reapOwner(reopened, docker, task.input.owner)).toEqual(second);
  });

  it("never removes a name collision or foreign owner's resource", async () => {
    const task = await running();
    const collision = docker.add(task.container, {
      ...task.container.labels,
      "codelab.run": randomUUID(),
    });
    const foreign = docker.add(
      { ...task.network, name: task.network.name + "-other" },
      { ...task.network.labels, "codelab.owner": randomUUID() },
    );
    await store.finishOperation(
      task.input.owner,
      task.operation.operationId,
      task.token,
      "failed",
      { reason: "not executed" },
    );
    const receipt = await reapOwner(store, docker, task.input.owner);
    expect(receipt.state).toBe("cleanup_pending");
    expect(docker.removed).toEqual([]);
    expect(docker.records.has(collision.id)).toBe(true);
    expect(docker.records.has(foreign.id)).toBe(true);
    expect(receipt.residualResourceIds).toContain(
      `ownership:container:${collision.id}`,
    );
  });

  it("does not treat an unavailable Docker daemon as proof of cleanup", async () => {
    const task = await running();
    await store.finishOperation(
      task.input.owner,
      task.operation.operationId,
      task.token,
      "failed",
    );
    docker.unavailable = true;
    const receipt = await reapOwner(store, docker, task.input.owner);
    expect(receipt.state).toBe("cleanup_pending");
    expect(receipt.residualResourceIds).toContain(
      "docker:inspection_unavailable",
    );
    expect((await lstat(task.workspace)).isDirectory()).toBe(true);
  });

  it("refuses a workspace symlink and leaves its external contents intact", async () => {
    const input = registration();
    await store.registerOwner(input);
    const outside = await mkdtemp(
      path.join(await realpath(tmpdir()), "codelab-durable-test-outside-"),
    );
    disposable.push(outside);
    await writeFile(path.join(outside, "sentinel.txt"), "keep");
    const workspace = store.workspacePath(input.owner);
    await symlink(
      outside,
      workspace,
      process.platform === "win32" ? "junction" : "dir",
    );
    const receipt = await reapOwner(store, docker, input.owner);
    expect(receipt.state).toBe("cleanup_pending");
    expect(receipt.residualResourceIds).toContain(
      `workspace:execution-${input.owner.ownerId}`,
    );
    expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe(
      "keep",
    );
    await expect(DurableRunnerStore.open(workspace)).rejects.toThrow(
      "RUNNER_ROOT_SYMLINK",
    );
  });

  it("fails closed on a corrupt newest journal instead of recovering an older writable state", async () => {
    await store.registerOwner(registration());
    const journals = (await readdir(path.join(directory, "journal")))
      .filter((name) => name.endsWith(".json"))
      .sort();
    await writeFile(
      path.join(directory, "journal", journals.at(-1)!),
      "{truncated",
    );
    await expect(DurableRunnerStore.open(directory)).rejects.toThrow();
    expect(docker.removed).toEqual([]);
  });

  it("rejects persisted resource scope changes and corrupted retained results", async () => {
    const task = await running();
    await store.finishOperation(
      task.input.owner,
      task.operation.operationId,
      task.token,
      "completed",
      { observed: "real" },
    );
    const result = await store.queryOperation(
      task.input.owner,
      task.operation.operationId,
    );
    await writeFile(
      path.join(
        directory,
        "responses",
        `${result.operation.responseHash}.json`,
      ),
      JSON.stringify({ observed: "changed" }),
    );
    await expect(
      store.queryOperation(task.input.owner, task.operation.operationId),
    ).rejects.toThrow("PERSISTED_RESPONSE_HASH_MISMATCH");
    const journals = (await readdir(path.join(directory, "journal")))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const latest = path.join(directory, "journal", journals.at(-1)!);
    const state = JSON.parse(await readFile(latest, "utf8"));
    state.owners[`execution-${task.input.owner.ownerId}`].resources[0].labels[
      "codelab.run"
    ] = randomUUID();
    await writeFile(latest, JSON.stringify(state));
    await expect(DurableRunnerStore.open(directory)).rejects.toThrow(
      "PERSISTED_RESOURCE_SCOPE_INVALID",
    );
    expect(docker.removed).toEqual([]);
  });
});
