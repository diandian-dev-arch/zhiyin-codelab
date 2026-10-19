import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  canonicalJson,
  LIMITS_V1,
  ownerIdentitySchema,
  runnerOperationRecordSchema,
  sha256Schema,
  utcDateTimeSchema,
  uuidSchema,
  validateReplayIdentity,
  type RunnerOperationRecord,
} from "@codelab/contracts/v2";

export type OwnerIdentity = z.infer<typeof ownerIdentitySchema>;
export type OwnerKey = Pick<OwnerIdentity, "runId" | "ownerKind" | "ownerId">;
export type OperationIdentity = Pick<
  RunnerOperationRecord,
  "operationId" | "requestHash" | "kind"
>;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const json = canonicalJson;
const keyOf = (owner: Pick<OwnerKey, "ownerKind" | "ownerId">) =>
  `${owner.ownerKind}-${owner.ownerId}`;
const revisionName = (revision: number) =>
  `${String(revision).padStart(16, "0")}.json`;
const processSchema = z
  .object({
    pid: z.number().int().positive(),
    startMarker: z.string().nullable(),
  })
  .strict();
export type ProducerIdentity = z.infer<typeof processSchema>;

export async function currentProducerIdentity(
  pid = process.pid,
): Promise<ProducerIdentity> {
  if (process.platform !== "linux") return { pid, startMarker: null };
  const [bootId, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
  ]);
  const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  if (!startTicks || !/^\d+$/.test(startTicks))
    throw new Error("PRODUCER_IDENTITY_UNAVAILABLE");
  return { pid, startMarker: `${bootId.trim()}:${startTicks}` };
}

/** Unknown process state is conservatively alive; it must never release a slot. */
export async function producerStillAlive(
  identity: ProducerIdentity,
): Promise<boolean> {
  try {
    process.kill(identity.pid, 0);
    if (process.platform !== "linux" || !identity.startMarker) return true;
    return (
      (await currentProducerIdentity(identity.pid)).startMarker ===
      identity.startMarker
    );
  } catch (error) {
    return !["ESRCH", "ENOENT"].includes(errorCode(error) ?? "");
  }
}

const resourceSchema = z
  .object({
    kind: z.enum(["container", "network"]),
    role: z.enum(["build", "web", "check", "probe", "network"]),
    name: z
      .string()
      .regex(
        /^codelab-v2-(execution|analysis)-[a-f0-9-]{36}-(build|web|check|probe|network)$/,
      ),
    operationId: uuidSchema,
    labels: z.record(z.string()),
    // Missing fields in older snapshots mean this creation protocol was not used.
    // New callers durably mark the only allowed create before contacting Docker.
    creationStartedAt: utcDateTimeSchema.nullable().default(null),
    createdResourceId: sha256Schema.nullable().default(null),
  })
  .strict();
export type PlannedResource = z.infer<typeof resourceSchema>;
export const unconfirmedCreationKey = (resource: PlannedResource) =>
  resource.creationStartedAt && !resource.createdResourceId
    ? `unconfirmed-create:${resource.kind}:${resource.name}`
    : null;
const cleanupReceiptSchema = z
  .object({
    cleanupId: uuidSchema,
    state: z.enum(["clean", "cleanup_pending"]),
    checkedAt: utcDateTimeSchema,
    checkedResourceIds: z.array(z.string().min(1).max(180)).max(100),
    residualResourceIds: z.array(z.string().min(1).max(180)).max(100),
  })
  .strict();
export type ResourceCleanupReceipt = z.infer<typeof cleanupReceiptSchema>;
const ownerSchema = z
  .object({
    runId: uuidSchema,
    ownerKind: z.enum(["execution", "analysis"]),
    ownerId: uuidSchema,
    tokenHash: sha256Schema,
    createdAt: utcDateTimeSchema,
    startedAt: utcDateTimeSchema,
    workDeadlineAt: utcDateTimeSchema,
    effectiveWorkDeadlineAt: utcDateTimeSchema,
    hardDeadlineAt: utcDateTimeSchema,
    leaseUntil: utcDateTimeSchema,
    phase: z.enum(["active", "cleanup_pending", "clean"]),
    resources: z.array(resourceSchema).max(10),
    cleanupId: uuidSchema.nullable(),
    cleanupReason: z.string().max(100).nullable(),
    cleanupReceipt: cleanupReceiptSchema.nullable(),
  })
  .strict();
export type DurableOwner = z.infer<typeof ownerSchema>;
const operationSchema = runnerOperationRecordSchema
  .extend({
    createdAt: utcDateTimeSchema,
    startedAt: utcDateTimeSchema.nullable(),
    finishedAt: utcDateTimeSchema.nullable(),
    producer: processSchema.nullable(),
    dispatchTokenHash: sha256Schema.nullable(),
    quiescedAt: utcDateTimeSchema.nullable(),
    errorCode: z.string().max(100).nullable(),
    cleanupReceipt: cleanupReceiptSchema.nullable(),
  })
  .strict();
export type DurableOperation = z.infer<typeof operationSchema>;
const snapshotSchema = z
  .object({
    version: z.literal(2),
    revision: z.number().int().nonnegative(),
    owners: z.record(ownerSchema),
    operations: z.record(operationSchema),
  })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;

export class RunnerStoreError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(code);
  }
}
const fail = (code: string, statusCode = 409): never => {
  throw new RunnerStoreError(code, statusCode);
};
function sameIdentity(
  stored: OwnerKey | undefined,
  incoming: OwnerKey,
): boolean {
  return Boolean(
    stored &&
      stored.runId === incoming.runId &&
      stored.ownerKind === incoming.ownerKind &&
      stored.ownerId === incoming.ownerId,
  );
}
function publicOperation(operation: DurableOperation): RunnerOperationRecord {
  return runnerOperationRecordSchema.parse({
    operationId: operation.operationId,
    requestHash: operation.requestHash,
    runId: operation.runId,
    ownerKind: operation.ownerKind,
    ownerId: operation.ownerId,
    kind: operation.kind,
    state: operation.state,
    responseHash: operation.responseHash,
  });
}
function cleanupResponse(
  operation: DurableOperation,
  receipt: ResourceCleanupReceipt,
) {
  return {
    protocolVersion: 2 as const,
    runId: operation.runId,
    ownerKind: operation.ownerKind,
    ownerId: operation.ownerId,
    operationId: operation.operationId,
    requestHash: operation.requestHash,
    state: receipt.state,
    residualResourceIds: receipt.residualResourceIds,
    completedAt: receipt.checkedAt,
  };
}

/**
 * A dedicated local filesystem is required. Every mutation appends an immutable,
 * fsynced snapshot with hard-link create-if-absent CAS. There is no stale lock to
 * steal after a crash, and readers never observe a half-written state file.
 * Student containers must not mount the journal, response, or workspace parent.
 */
export class DurableRunnerStore {
  readonly root: string;
  readonly storeId: string;
  private readonly clock: () => number;
  private constructor(root: string, clock?: () => number) {
    this.root = root;
    this.storeId = hash(root);
    const wall = Date.now(),
      monotonic = performance.now();
    let lastObserved = wall;
    this.clock =
      clock ??
      (() =>
        (lastObserved = Math.max(
          lastObserved,
          Date.now(),
          wall + performance.now() - monotonic,
        )));
  }

  static async open(
    root: string,
    options: { now?: () => number } = {},
  ): Promise<DurableRunnerStore> {
    if (!path.isAbsolute(root)) fail("RUNNER_ROOT_MUST_BE_ABSOLUTE", 500);
    const resolved = path.resolve(root);
    if (
      [
        path.parse(resolved).root,
        path.resolve(homedir()),
        path.resolve(process.cwd()),
      ].includes(resolved)
    )
      fail("RUNNER_ROOT_TOO_BROAD", 500);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    if ((await lstat(resolved)).isSymbolicLink())
      fail("RUNNER_ROOT_SYMLINK", 500);
    const actual = await realpath(resolved);
    if (actual !== resolved) fail("RUNNER_ROOT_NOT_CANONICAL", 500);
    const store = new DurableRunnerStore(actual, options.now);
    for (const directory of ["journal", "responses", "resources"]) {
      const target = path.join(actual, directory);
      await mkdir(target, { mode: 0o700 }).catch((error) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      await store.assertDirectory(target);
    }
    await store.read();
    return store;
  }

  now(): number {
    return this.clock();
  }
  private stamp(): string {
    return new Date(this.now()).toISOString();
  }
  private async assertDirectory(directory: string) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      fail("UNSAFE_RUNNER_DIRECTORY", 500);
  }
  private async syncDirectory(directory: string) {
    // Windows test filesystems do not support opening a directory for fsync.
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async readJson(filename: string, maxBytes: number): Promise<unknown> {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
      fail("PERSISTED_RECORD_INVALID", 500);
    return JSON.parse(await readFile(filename, "utf8"));
  }
  private async read(): Promise<Snapshot> {
    const directory = path.join(this.root, "journal");
    await this.assertDirectory(directory);
    const entries = (await readdir(directory))
      .filter((name) => /^\d{16}\.json$/.test(name))
      .sort();
    const latest = entries.at(-1);
    if (!latest) return { version: 2, revision: 0, owners: {}, operations: {} };
    const state = snapshotSchema.parse(
      await this.readJson(path.join(directory, latest), 64 * 1024 * 1024),
    );
    if (revisionName(state.revision) !== latest)
      fail("JOURNAL_REVISION_MISMATCH", 500);
    for (const [key, owner] of Object.entries(state.owners)) {
      if (key !== keyOf(owner)) fail("PERSISTED_OWNER_SCOPE_INVALID", 500);
      if (
        owner.phase === "clean" &&
        (!owner.cleanupReceipt ||
          owner.cleanupReceipt.state !== "clean" ||
          owner.cleanupReceipt.residualResourceIds.length ||
          owner.cleanupReceipt.cleanupId !== owner.cleanupId)
      )
        fail("PERSISTED_CLEANUP_RECEIPT_INVALID", 500);
      for (const resource of owner.resources) {
        if (owner.phase === "clean" && unconfirmedCreationKey(resource))
          fail("PERSISTED_CREATE_BARRIER_INVALID", 500);
        const operation = state.operations[resource.operationId];
        const expected = {
          "codelab.managed": "true",
          "codelab.protocol": "2",
          "codelab.store": this.storeId,
          "codelab.run": owner.runId,
          "codelab.owner-kind": owner.ownerKind,
          "codelab.owner": owner.ownerId,
          "codelab.operation": resource.operationId,
          "codelab.request-hash": operation?.requestHash,
          "codelab.hard-deadline": owner.hardDeadlineAt,
          "codelab.resource-role": resource.role,
        };
        if (
          !operation ||
          !sameIdentity(operation, owner) ||
          resource.name !== `codelab-v2-${keyOf(owner)}-${resource.role}` ||
          (resource.kind === "network") !== (resource.role === "network") ||
          Object.entries(expected).some(
            ([label, value]) => resource.labels[label] !== value,
          )
        )
          fail("PERSISTED_RESOURCE_SCOPE_INVALID", 500);
      }
    }
    for (const [key, operation] of Object.entries(state.operations)) {
      if (
        key !== operation.operationId ||
        !sameIdentity(state.owners[keyOf(operation)]!, operation)
      )
        fail("PERSISTED_OPERATION_SCOPE_INVALID", 500);
    }
    return state;
  }
  private async publish(
    directory: string,
    name: string,
    value: unknown,
  ): Promise<boolean> {
    await this.assertDirectory(directory);
    const temporary = path.join(directory, `.pending-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(json(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path.join(directory, name));
      await this.syncDirectory(directory);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    } finally {
      await unlink(temporary).catch((error) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  }
  private async mutate<T>(
    change: (state: Snapshot) => { changed: boolean; result: T },
  ): Promise<T> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const state = await this.read();
      const update = change(state);
      if (!update.changed) return update.result;
      state.revision++;
      snapshotSchema.parse(state);
      if (Buffer.byteLength(json(state)) > 64 * 1024 * 1024)
        fail("RUNNER_METADATA_CAPACITY", 503);
      if (
        await this.publish(
          path.join(this.root, "journal"),
          revisionName(state.revision),
          state,
        )
      )
        return update.result;
    }
    return fail("RUNNER_STORE_CONTENTION", 503);
  }
  private authenticate(state: Snapshot, value: OwnerIdentity): DurableOwner {
    const identity = ownerIdentitySchema.parse(value);
    const owner = state.owners[keyOf(identity)];
    if (
      !owner ||
      !sameIdentity(owner, identity) ||
      !timingSafeEqual(
        Buffer.from(owner.tokenHash, "hex"),
        Buffer.from(hash(identity.ownerToken), "hex"),
      )
    )
      fail("OWNER_NOT_FOUND", 404);
    return owner;
  }
  private active(owner: DurableOwner) {
    if (owner.phase !== "active" || this.now() >= Date.parse(owner.leaseUntil))
      fail("OWNER_REVOKED");
    if (this.now() >= Date.parse(owner.effectiveWorkDeadlineAt))
      fail("WORK_DEADLINE_EXCEEDED");
  }
  private operation(state: Snapshot, owner: OwnerKey, operationId: string) {
    const operation = state.operations[uuidSchema.parse(operationId)];
    if (!operation || !sameIdentity(operation, owner))
      fail("OPERATION_NOT_FOUND", 404);
    return operation;
  }
  private dispatch(operation: DurableOperation, dispatchToken: string) {
    if (
      !operation.dispatchTokenHash ||
      !timingSafeEqual(
        Buffer.from(operation.dispatchTokenHash, "hex"),
        Buffer.from(hash(dispatchToken), "hex"),
      )
    )
      fail("DISPATCH_TOKEN_INVALID", 403);
  }

  async registerOwner(input: {
    owner: OwnerIdentity;
    startedAt: string;
    workDeadlineAt: string;
    hardDeadlineAt: string;
    leaseUntil: string;
    remainingWorkMs: number;
  }): Promise<DurableOwner> {
    const identity = ownerIdentitySchema.parse(input.owner);
    for (const value of [
      input.startedAt,
      input.workDeadlineAt,
      input.hardDeadlineAt,
      input.leaseUntil,
    ])
      utcDateTimeSchema.parse(value);
    const started = Date.parse(input.startedAt),
      work = Date.parse(input.workDeadlineAt),
      hard = Date.parse(input.hardDeadlineAt);
    const maximum = identity.ownerKind === "execution" ? 300000 : 90000;
    if (
      !Number.isSafeInteger(input.remainingWorkMs) ||
      input.remainingWorkMs <= 0 ||
      input.remainingWorkMs > maximum - 30000 ||
      started > this.now() + 5000 ||
      hard - started > maximum ||
      hard <= work ||
      work > hard - 30000 ||
      work <= started ||
      Date.parse(input.leaseUntil) > hard ||
      Date.parse(input.leaseUntil) > this.now() + 30000
    )
      fail("OWNER_DEADLINES_INVALID", 400);
    return this.mutate((state) => {
      const existing = state.owners[keyOf(identity)];
      if (existing) {
        this.authenticate(state, identity);
        if (
          ["startedAt", "workDeadlineAt", "hardDeadlineAt"].some(
            (field) =>
              existing[field as keyof DurableOwner] !==
              input[field as keyof typeof input],
          )
        )
          fail("OWNER_CONTEXT_CONFLICT");
        return { changed: false, result: existing };
      }
      if (Object.values(state.owners).some((owner) => owner.phase !== "clean"))
        fail("RUNNER_BUSY");
      const owner: DurableOwner = {
        ...identity,
        tokenHash: hash(identity.ownerToken),
        createdAt: this.stamp(),
        startedAt: input.startedAt,
        workDeadlineAt: input.workDeadlineAt,
        effectiveWorkDeadlineAt: new Date(
          Math.min(work, this.now() + input.remainingWorkMs),
        ).toISOString(),
        hardDeadlineAt: input.hardDeadlineAt,
        leaseUntil: input.leaseUntil,
        phase: "active",
        resources: [],
        cleanupId: null,
        cleanupReason: null,
        cleanupReceipt: null,
      };
      // The service token/lease is never serialized into persistent metadata.
      delete (owner as unknown as Record<string, unknown>).ownerToken;
      this.active(owner);
      state.owners[keyOf(identity)] = owner;
      return { changed: true, result: owner };
    });
  }

  /**
   * A cleanup that arrives before execute must leave a durable admission fence.
   * These timestamps are internal placeholders, never a lease or work budget.
   * Existing owners still require their original token and are not renewed.
   */
  async registerCleanupOwner(value: OwnerIdentity): Promise<DurableOwner> {
    const identity = ownerIdentitySchema.parse(value);
    const cleanupId = randomUUID();
    return this.mutate((state) => {
      if (state.owners[keyOf(identity)])
        return {
          changed: false,
          result: this.authenticate(state, identity),
        };
      const timestamp = this.stamp();
      const { ownerToken, ...ownerKey } = identity;
      const owner: DurableOwner = {
        ...ownerKey,
        tokenHash: hash(ownerToken),
        createdAt: timestamp,
        startedAt: timestamp,
        workDeadlineAt: timestamp,
        effectiveWorkDeadlineAt: timestamp,
        hardDeadlineAt: timestamp,
        leaseUntil: timestamp,
        phase: "cleanup_pending",
        resources: [],
        cleanupId,
        cleanupReason: "cleanup_before_admission",
        cleanupReceipt: null,
      };
      // No single-owner admission check: this record cannot execute or own new resources.
      state.owners[keyOf(identity)] = owner;
      return { changed: true, result: owner };
    });
  }

  async heartbeat(
    identity: OwnerIdentity,
    leaseUntil: string,
  ): Promise<DurableOwner> {
    utcDateTimeSchema.parse(leaseUntil);
    return this.mutate((state) => {
      const owner = this.authenticate(state, identity);
      this.active(owner);
      const lease = Date.parse(leaseUntil);
      if (
        lease < Date.parse(owner.leaseUntil) ||
        lease > Date.parse(owner.hardDeadlineAt) ||
        lease > this.now() + 30000
      )
        fail("OWNER_DEADLINES_INVALID", 400);
      owner.leaseUntil = leaseUntil;
      return { changed: true, result: owner };
    });
  }

  async reserveOperation(
    identity: OwnerIdentity,
    input: OperationIdentity,
  ): Promise<{ created: boolean; operation: DurableOperation }> {
    const cleanupId = randomUUID();
    return this.mutate<{ created: boolean; operation: DurableOperation }>(
      (state) => {
        const owner = this.authenticate(state, identity);
        const record = runnerOperationRecordSchema.parse({
          ...input,
          ...{
            runId: owner.runId,
            ownerKind: owner.ownerKind,
            ownerId: owner.ownerId,
          },
          state: "accepted",
          responseHash: null,
        });
        const existing = state.operations[record.operationId];
        if (existing) {
          const {
            state: _state,
            responseHash: _responseHash,
            ...incoming
          } = record;
          validateReplayIdentity(publicOperation(existing), incoming);
          return {
            changed: false,
            result: { created: false, operation: existing },
          };
        }
        if (input.kind === "cleanup") {
          const operation: DurableOperation = {
            ...record,
            createdAt: this.stamp(),
            startedAt: null,
            finishedAt: null,
            producer: null,
            dispatchTokenHash: null,
            quiescedAt: null,
            errorCode: null,
            cleanupReceipt: null,
          };
          state.operations[record.operationId] = operation;
          if (owner.phase === "clean" && owner.cleanupReceipt) {
            operation.state = "completed";
            operation.startedAt =
              operation.finishedAt =
              operation.quiescedAt =
                this.stamp();
            operation.cleanupReceipt = owner.cleanupReceipt;
            operation.responseHash = hash(
              json(cleanupResponse(operation, owner.cleanupReceipt)),
            );
          } else {
            this.fenceOwner(state, owner, cleanupId, "explicit_cleanup");
          }
          return { changed: true, result: { created: true, operation } };
        }
        if (
          (input.kind === "execute" && owner.ownerKind !== "execution") ||
          (input.kind === "prepare_probe" && owner.ownerKind !== "analysis")
        )
          fail("OPERATION_OWNER_KIND_MISMATCH", 400);
        this.active(owner);
        if (
          Object.values(state.operations).some(
            (operation) =>
              sameIdentity(operation, owner) &&
              ["accepted", "running"].includes(operation.state),
          )
        )
          fail("OWNER_OPERATION_BUSY");
        if (
          Object.values(state.operations).some(
            (operation) =>
              sameIdentity(operation, owner) && operation.kind === input.kind,
          )
        )
          fail("OPERATION_KIND_ALREADY_REGISTERED");
        const operation: DurableOperation = {
          ...record,
          createdAt: this.stamp(),
          startedAt: null,
          finishedAt: null,
          producer: null,
          dispatchTokenHash: null,
          quiescedAt: null,
          errorCode: null,
          cleanupReceipt: null,
        };
        state.operations[record.operationId] = operation;
        return { changed: true, result: { created: true, operation } };
      },
    );
  }

  async beginOperation(
    identity: OwnerIdentity,
    operationId: string,
  ): Promise<{
    started: boolean;
    dispatchToken: string | null;
    operation: DurableOperation;
  }> {
    const producer = await currentProducerIdentity(),
      dispatchToken = randomUUID();
    return this.mutate<{
      started: boolean;
      dispatchToken: string | null;
      operation: DurableOperation;
    }>((state) => {
      const owner = this.authenticate(state, identity);
      const operation = this.operation(state, owner, operationId);
      if (operation.kind === "cleanup") fail("USE_REAPER_CLEANUP", 400);
      if (operation.state !== "accepted")
        return {
          changed: false,
          result: { started: false, dispatchToken: null, operation },
        };
      this.active(owner);
      operation.state = "running";
      operation.startedAt = this.stamp();
      operation.producer = producer;
      operation.dispatchTokenHash = hash(dispatchToken);
      return {
        changed: true,
        result: { started: true, dispatchToken, operation },
      };
    });
  }

  async planResource(
    identity: OwnerIdentity,
    operationId: string,
    dispatchToken: string,
    kind: PlannedResource["kind"],
    role: PlannedResource["role"],
  ): Promise<PlannedResource> {
    return this.mutate((state) => {
      const owner = this.authenticate(state, identity);
      this.active(owner);
      const operation = this.operation(state, owner, operationId);
      this.dispatch(operation, dispatchToken);
      if (operation.state !== "running") fail("OPERATION_NOT_RUNNING");
      if ((kind === "network") !== (role === "network"))
        fail("RESOURCE_KIND_INVALID", 400);
      const existing = owner.resources.find(
        (resource) => resource.role === role,
      );
      if (existing) {
        if (existing.operationId !== operationId)
          fail("RESOURCE_OPERATION_CONFLICT");
        return { changed: false, result: existing };
      }
      const resource: PlannedResource = resourceSchema.parse({
        kind,
        role,
        name: `codelab-v2-${keyOf(owner)}-${role}`,
        operationId,
        labels: {
          "codelab.managed": "true",
          "codelab.protocol": "2",
          "codelab.store": this.storeId,
          "codelab.run": owner.runId,
          "codelab.owner-kind": owner.ownerKind,
          "codelab.owner": owner.ownerId,
          "codelab.operation": operationId,
          "codelab.request-hash": operation.requestHash,
          "codelab.hard-deadline": owner.hardDeadlineAt,
          "codelab.resource-role": role,
        },
      });
      owner.resources.push(resource);
      return { changed: true, result: resource };
    });
  }

  /** Exactly one durable permission to send create; a retry never grants another call. */
  async markResourceCreateStarted(
    identity: OwnerIdentity,
    operationId: string,
    dispatchToken: string,
    role: PlannedResource["role"],
  ): Promise<PlannedResource> {
    return this.mutate((state) => {
      const owner = this.authenticate(state, identity);
      this.active(owner);
      const operation = this.operation(state, owner, operationId);
      this.dispatch(operation, dispatchToken);
      if (operation.state !== "running") fail("OPERATION_NOT_RUNNING");
      const resource = owner.resources.find((entry) => entry.role === role);
      if (!resource || resource.operationId !== operationId)
        return fail("RESOURCE_NOT_PLANNED");
      if (resource.creationStartedAt || resource.createdResourceId)
        fail("RESOURCE_CREATE_ALREADY_STARTED");
      resource.creationStartedAt = this.stamp();
      return { changed: true, result: resource };
    });
  }

  /** A late CLI result may record an immutable fact, never restore working authority. */
  async recordResourceCreated(
    identity: OwnerIdentity,
    operationId: string,
    dispatchToken: string,
    role: PlannedResource["role"],
    resourceId: string,
  ): Promise<PlannedResource> {
    sha256Schema.parse(resourceId);
    return this.mutate((state) => {
      const owner = this.authenticate(state, identity);
      const operation = this.operation(state, owner, operationId);
      this.dispatch(operation, dispatchToken);
      const resource = owner.resources.find((entry) => entry.role === role);
      if (!resource || resource.operationId !== operationId)
        return fail("RESOURCE_NOT_PLANNED");
      if (!resource.creationStartedAt) fail("RESOURCE_CREATE_NOT_STARTED");
      if (resource.createdResourceId && resource.createdResourceId !== resourceId)
        fail("RESOURCE_ID_CONFLICT");
      if (resource.createdResourceId)
        return { changed: false, result: resource };
      resource.createdResourceId = resourceId;
      return { changed: true, result: resource };
    });
  }

  /** Internal reaper only. Persist full-label observation before deleting its exact ID. */
  async recordObservedResourceCreated(
    identity: OwnerKey,
    observed: {
      kind: PlannedResource["kind"];
      id: string;
      name: string;
      labels: Record<string, string>;
    },
  ): Promise<PlannedResource> {
    sha256Schema.parse(observed.id);
    return this.mutate((state) => {
      const owner = state.owners[keyOf(identity)];
      if (!owner || !sameIdentity(owner, identity)) fail("OWNER_NOT_FOUND", 404);
      if (owner.phase !== "cleanup_pending") fail("CLEANUP_FENCE_MISSING");
      const resource = owner.resources.find((entry) =>
        entry.kind === observed.kind && entry.name === observed.name);
      if (!resource || Object.entries(resource.labels).some(
        ([label, value]) => observed.labels[label] !== value))
        return fail("RESOURCE_OBSERVATION_MISMATCH");
      if (resource.createdResourceId && resource.createdResourceId !== observed.id)
        fail("RESOURCE_ID_CONFLICT");
      if (resource.createdResourceId)
        return { changed: false, result: resource };
      resource.createdResourceId = observed.id;
      return { changed: true, result: resource };
    });
  }

  workspacePath(owner: OwnerKey): string {
    const identity = z
      .object({
        runId: uuidSchema,
        ownerKind: z.enum(["execution", "analysis"]),
        ownerId: uuidSchema,
      })
      .parse(owner);
    const target = path.resolve(this.root, "resources", keyOf(identity));
    if (path.dirname(target) !== path.join(this.root, "resources"))
      fail("UNSAFE_WORKSPACE", 500);
    return target;
  }
  async ensureWorkspace(
    identity: OwnerIdentity,
    operationId: string,
    dispatchToken: string,
  ): Promise<string> {
    const state = await this.read(),
      owner = this.authenticate(state, identity);
    this.active(owner);
    const operation = this.operation(state, owner, operationId);
    this.dispatch(operation, dispatchToken);
    if (operation.state !== "running") fail("OPERATION_NOT_RUNNING");
    const target = this.workspacePath(owner);
    await this.assertDirectory(path.dirname(target));
    await mkdir(target, { mode: 0o700 }).catch((error) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    await this.assertDirectory(target);
    // Recheck the durable fence after filesystem work.
    this.active(this.authenticate(await this.read(), identity));
    return target;
  }

  async finishOperation(
    identity: OwnerIdentity,
    operationId: string,
    dispatchToken: string,
    outcome: "completed" | "failed" | "unknown",
    result?: unknown,
  ): Promise<DurableOperation> {
    if (outcome === "completed" && result === undefined)
      fail("COMPLETED_RESULT_REQUIRED", 400);
    const before = await this.read();
    const authenticated = this.authenticate(before, identity);
    const dispatched = this.operation(before, authenticated, operationId);
    this.dispatch(dispatched, dispatchToken);
    if (dispatched.kind === "cleanup") fail("USE_REAPER_CLEANUP", 400);
    let responseHash: string | null = null;
    if (result !== undefined) {
      const encoded = json(result);
      if (Buffer.byteLength(encoded) > LIMITS_V1.runnerResponseMaxBytes)
        fail("RESPONSE_TOO_LARGE", 413);
      responseHash = hash(encoded);
      await this.publish(
        path.join(this.root, "responses"),
        `${responseHash}.json`,
        result,
      );
    }
    const completed = await this.mutate((state) => {
      const owner = this.authenticate(state, identity),
        operation = this.operation(state, owner, operationId);
      this.dispatch(operation, dispatchToken);
      if (operation.quiescedAt)
        return {
          changed: false,
          result: {
            accepted:
              operation.state === outcome &&
              operation.responseHash === responseHash,
            operation,
          },
        };
      const allowed =
        owner.phase === "active" &&
        this.now() < Date.parse(owner.leaseUntil) &&
        this.now() < Date.parse(owner.effectiveWorkDeadlineAt) &&
        operation.state === "running";
      // An unknown Docker outcome may still create a resource later. It retains
      // the producer fence until that process is gone or a real late completion
      // explicitly proves the producing call has ended.
      if (outcome !== "unknown") operation.quiescedAt = this.stamp();
      operation.finishedAt = this.stamp();
      operation.state = allowed ? outcome : "unknown";
      operation.responseHash = allowed ? responseHash : null;
      operation.errorCode = allowed ? null : "OWNER_REVOKED";
      if (allowed && outcome === "unknown")
        this.fenceOwner(
          state,
          owner,
          randomUUID(),
          "operation_outcome_unknown",
        );
      return { changed: true, result: { accepted: allowed, operation } };
    });
    if (!completed.accepted) fail("LATE_OPERATION_RESULT_REJECTED");
    return completed.operation;
  }

  async queryOperation(
    identity: OwnerIdentity,
    operationId: string,
  ): Promise<{ operation: RunnerOperationRecord; response: unknown | null }> {
    const state = await this.read(),
      owner = this.authenticate(state, identity);
    const operation = this.operation(state, owner, operationId);
    const record = publicOperation(operation);
    let response: unknown | null = null;
    if (record.responseHash) {
      await this.assertDirectory(path.join(this.root, "responses"));
      response =
        operation.kind === "cleanup" && operation.cleanupReceipt
          ? cleanupResponse(operation, operation.cleanupReceipt)
          : await this.readJson(
              path.join(this.root, "responses", `${record.responseHash}.json`),
              LIMITS_V1.runnerResponseMaxBytes,
            );
      if (hash(json(response)) !== record.responseHash)
        fail("PERSISTED_RESPONSE_HASH_MISMATCH", 500);
    }
    return { operation: record, response };
  }

  /** Internal recovery API. It grants cleanup authority only, never execution. */
  async revokeForCleanup(
    identity: OwnerKey,
    reason: string,
  ): Promise<DurableOwner> {
    const cleanupId = randomUUID();
    return this.mutate((state) => {
      const owner = state.owners[keyOf(identity)];
      if (!owner || !sameIdentity(owner, identity))
        fail("OWNER_NOT_FOUND", 404);
      if (owner.phase === "clean") return { changed: false, result: owner };
      this.fenceOwner(state, owner, cleanupId, reason);
      return { changed: true, result: owner };
    });
  }

  private fenceOwner(
    state: Snapshot,
    owner: DurableOwner,
    cleanupId: string,
    reason: string,
  ) {
    owner.phase = "cleanup_pending";
    owner.cleanupId ??= cleanupId;
    owner.cleanupReason ??= reason.slice(0, 100);
    for (const operation of Object.values(state.operations)) {
      if (
        !sameIdentity(operation, owner) ||
        operation.kind === "cleanup" ||
        !["accepted", "running"].includes(operation.state)
      )
        continue;
      if (operation.state === "accepted") operation.quiescedAt = this.stamp();
      operation.state = "unknown";
      operation.errorCode = "OWNER_REVOKED";
      operation.finishedAt = this.stamp();
    }
  }

  async recordCleanup(
    identity: OwnerKey,
    proof: {
      checkedResourceIds: string[];
      residualResourceIds: string[];
      stoppedOperationIds: string[];
    },
  ): Promise<ResourceCleanupReceipt> {
    return this.mutate((state) => {
      const owner = state.owners[keyOf(identity)];
      if (
        !owner ||
        !sameIdentity(owner, identity) ||
        owner.phase === "active" ||
        !owner.cleanupId
      )
        fail("CLEANUP_FENCE_MISSING");
      for (const id of proof.stoppedOperationIds) {
        const operation = this.operation(state, owner, id);
        operation.quiescedAt ??= this.stamp();
      }
      const residuals = new Set(proof.residualResourceIds);
      // Producer death does not prove an orphaned Docker CLI/daemon create ended.
      // Only a returned or independently observed immutable ID settles that call.
      for (const resource of owner.resources) {
        const pending = unconfirmedCreationKey(resource);
        if (pending) residuals.add(pending);
      }
      for (const operation of Object.values(state.operations))
        if (
          sameIdentity(operation, owner) &&
          operation.producer &&
          !operation.quiescedAt
        )
          residuals.add(`producer:${operation.operationId}`);
      const receipt = cleanupReceiptSchema.parse({
        cleanupId: owner.cleanupId,
        state: residuals.size ? "cleanup_pending" : "clean",
        checkedAt: this.stamp(),
        checkedResourceIds: [...new Set(proof.checkedResourceIds)],
        residualResourceIds: [...residuals],
      });
      owner.cleanupReceipt = receipt;
      owner.phase = receipt.state;
      for (const operation of Object.values(state.operations)) {
        if (
          !sameIdentity(operation, owner) ||
          operation.kind !== "cleanup" ||
          operation.state === "completed"
        )
          continue;
        operation.startedAt ??= this.stamp();
        operation.state = receipt.state === "clean" ? "completed" : "running";
        if (receipt.state === "clean") {
          operation.finishedAt = operation.quiescedAt = this.stamp();
          operation.cleanupReceipt = receipt;
          operation.responseHash = hash(
            json(cleanupResponse(operation, receipt)),
          );
        }
      }
      return { changed: true, result: receipt };
    });
  }

  async inspect(): Promise<{
    owners: DurableOwner[];
    operations: DurableOperation[];
  }> {
    const state = await this.read();
    return {
      owners: Object.values(state.owners),
      operations: Object.values(state.operations),
    };
  }

  async workspaceResidues(): Promise<string[]> {
    const state = await this.read(),
      directory = path.join(this.root, "resources");
    await this.assertDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          !state.owners[entry.name] ||
          state.owners[entry.name]!.phase === "clean",
      )
      .map((entry) => `workspace:${entry.name.slice(0, 120)}`);
  }

  /** Only the independently fenced reaper may use this generated path. */
  async removeWorkspace(owner: OwnerKey): Promise<void> {
    const state = await this.read(),
      stored = state.owners[keyOf(owner)];
    if (!stored || !sameIdentity(stored, owner) || stored.phase === "active")
      fail("CLEANUP_FENCE_MISSING");
    if (stored.resources.some((resource) => unconfirmedCreationKey(resource)))
      fail("RESOURCE_CREATE_UNCONFIRMED");
    const target = this.workspacePath(stored);
    await this.assertDirectory(path.dirname(target));
    try {
      await this.assertDirectory(target);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    await rm(target, { recursive: true, force: false });
    try {
      await lstat(target);
      fail("WORKSPACE_RESIDUAL", 500);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}
