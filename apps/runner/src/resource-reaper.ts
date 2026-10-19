import {
  DurableRunnerStore,
  producerStillAlive,
  unconfirmedCreationKey,
  type DurableOwner,
  type OwnerKey,
  type PlannedResource,
  type ProducerIdentity,
  type ResourceCleanupReceipt,
} from "./durable-store.js";

export interface ObservedResource {
  kind: PlannedResource["kind"];
  id: string;
  name: string;
  labels: Record<string, string>;
}
export interface ResourceAdapter {
  listManaged(): Promise<ObservedResource[]>;
  listOwned(storeId: string, owner: OwnerKey): Promise<ObservedResource[]>;
  inspect(
    kind: PlannedResource["kind"],
    nameOrId: string,
  ): Promise<ObservedResource | null>;
  remove(kind: PlannedResource["kind"], id: string): Promise<void>;
}

/** Read-only admission observation; unknown/legacy resources are reported, never removed. */
export async function inspectReadiness(
  store: DurableRunnerStore,
  resources: ResourceAdapter,
): Promise<{
  state: "ready" | "busy" | "cleanup_pending" | "unavailable";
  activeOwner: OwnerKey | null;
  residualResourceIds: string[];
}> {
  const { owners } = await store.inspect();
  const active = owners.find((owner) => owner.phase !== "clean");
  const activeOwner = active
    ? {
        runId: active.runId,
        ownerKind: active.ownerKind,
        ownerId: active.ownerId,
      }
    : null;
  const residuals = new Set(await store.workspaceResidues());
  for (const owner of owners) {
    if (owner.phase !== "cleanup_pending") continue;
    for (const resource of owner.resources) {
      const pending = unconfirmedCreationKey(resource);
      if (pending) residuals.add(pending);
    }
  }
  try {
    for (const actual of await resources.listManaged()) {
      const owner = owners.find(
        (item) =>
          item.ownerId === actual.labels["codelab.owner"] &&
          item.ownerKind === actual.labels["codelab.owner-kind"] &&
          item.runId === actual.labels["codelab.run"],
      );
      const planned = owner?.resources.find(
        (resource) =>
          resource.kind === actual.kind && resource.name === actual.name,
      );
      if (
        !owner ||
        owner.phase === "clean" ||
        !planned ||
        !belongs(actual, planned)
      )
        residuals.add(identityKey(actual));
    }
  } catch {
    return {
      state: "unavailable",
      activeOwner,
      residualResourceIds: ["docker:inspection_unavailable"],
    };
  }
  const list = [...residuals];
  const residualResourceIds =
    list.length <= 50
      ? list
      : [...list.slice(0, 49), `additional-resources:${list.length - 49}`];
  return {
    state:
      residuals.size ||
      owners.some((owner) => owner.phase === "cleanup_pending")
        ? "cleanup_pending"
        : active
          ? "busy"
          : "ready",
    activeOwner,
    residualResourceIds,
  };
}
const identityKey = (resource: Pick<ObservedResource, "kind" | "id">) =>
  `${resource.kind}:${resource.id}`;
const belongs = (actual: ObservedResource, planned: PlannedResource) =>
  actual.kind === planned.kind &&
  actual.name === planned.name &&
  (!planned.createdResourceId || actual.id === planned.createdResourceId) &&
  Object.entries(planned.labels).every(
    ([key, value]) => actual.labels[key] === value,
  );
const sameOwner = (a: OwnerKey, b: OwnerKey) =>
  a.runId === b.runId && a.ownerKind === b.ownerKind && a.ownerId === b.ownerId;

/** Cleanup uses persisted identity, generated workspace paths and exact labels only. */
export async function reapOwner(
  store: DurableRunnerStore,
  resources: ResourceAdapter,
  identity: OwnerKey,
  options: {
    reason?: string;
    producerAlive?: (producer: ProducerIdentity) => Promise<boolean>;
  } = {},
): Promise<ResourceCleanupReceipt> {
  const owner = await store.revokeForCleanup(
    identity,
    options.reason ?? "explicit_cleanup",
  );
  if (owner.phase === "clean" && owner.cleanupReceipt)
    return owner.cleanupReceipt;
  const inspected = await store.inspect();
  const residuals = new Set<string>(),
    checked = new Set<string>(),
    stoppedOperationIds: string[] = [];
  for (const operation of inspected.operations) {
    if (
      !sameOwner(operation, owner) ||
      !operation.producer ||
      operation.quiescedAt
    )
      continue;
    try {
      if (
        await (options.producerAlive ?? producerStillAlive)(operation.producer)
      )
        residuals.add(`producer:${operation.operationId}`);
      else stoppedOperationIds.push(operation.operationId);
    } catch {
      residuals.add(`producer:${operation.operationId}`);
    }
  }
  const plannedByName = new Map(
    owner.resources.map((resource) => [
      `${resource.kind}:${resource.name}`,
      resource,
    ]),
  );
  const observed = new Map<string, ObservedResource>();
  try {
    for (const resource of await resources.listOwned(store.storeId, owner))
      observed.set(identityKey(resource), resource);
    for (const planned of owner.resources) {
      const actual = await resources.inspect(planned.kind, planned.name);
      if (actual) observed.set(identityKey(actual), actual);
      else checked.add(`${planned.kind}:${planned.name}`);
      if (planned.createdResourceId) {
        const byId = await resources.inspect(planned.kind, planned.createdResourceId);
        if (byId) observed.set(identityKey(byId), byId);
        else checked.add(`${planned.kind}:${planned.createdResourceId}`);
      }
    }
  } catch {
    residuals.add("docker:inspection_unavailable");
  }
  // Containers go first so attached networks can be removed afterwards.
  const ordered = [...observed.values()].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "container" ? -1 : 1,
  );
  for (const actual of ordered) {
    const planned = plannedByName.get(`${actual.kind}:${actual.name}`);
    if (!planned || !belongs(actual, planned)) {
      residuals.add(`ownership:${identityKey(actual)}`);
      continue;
    }
    try {
      // A persisted create acknowledgement survives a crash between removal and
      // the final absence check, and settles a formerly ambiguous CLI dispatch.
      const confirmed = await store.recordObservedResourceCreated(owner, actual);
      plannedByName.set(`${confirmed.kind}:${confirmed.name}`, confirmed);
      // Reinspect the immutable Docker ID before deletion; never delete by a caller-supplied name.
      const fresh = await resources.inspect(actual.kind, actual.id);
      if (!fresh) {
        checked.add(identityKey(actual));
        continue;
      }
      if (fresh.id !== actual.id || !belongs(fresh, confirmed)) {
        residuals.add(`ownership:${identityKey(actual)}`);
        continue;
      }
      await resources.remove(actual.kind, actual.id);
    } catch {
      // A failed/late CLI response is not itself absence; the verification pass decides.
    }
  }
  const finalOwner = (await store.inspect()).owners.find((entry) => sameOwner(entry, owner));
  if (!finalOwner) throw new Error("OWNER_NOT_FOUND");
  for (const planned of finalOwner.resources) {
    const pending = unconfirmedCreationKey(planned);
    if (pending) residuals.add(pending);
  }
  try {
    for (const actual of await resources.listOwned(store.storeId, owner))
      residuals.add(identityKey(actual));
    for (const planned of finalOwner.resources) {
      const actual = await resources.inspect(planned.kind, planned.name);
      if (actual) residuals.add(identityKey(actual));
      else checked.add(`${planned.kind}:${planned.name}`);
      if (planned.createdResourceId) {
        const byId = await resources.inspect(planned.kind, planned.createdResourceId);
        if (byId) residuals.add(identityKey(byId));
        else checked.add(`${planned.kind}:${planned.createdResourceId}`);
      }
    }
  } catch {
    residuals.add("docker:inspection_unavailable");
  }
  if (!residuals.size) {
    try {
      await store.removeWorkspace(owner);
      checked.add(`workspace:${owner.ownerKind}-${owner.ownerId}`);
    } catch {
      residuals.add(`workspace:${owner.ownerKind}-${owner.ownerId}`);
    }
  }
  return store.recordCleanup(owner, {
    checkedResourceIds: [...checked],
    residualResourceIds: [...residuals],
    stoppedOperationIds,
  });
}

export async function reapExpired(
  store: DurableRunnerStore,
  resources: ResourceAdapter,
  options: {
    producerAlive?: (producer: ProducerIdentity) => Promise<boolean>;
  } = {},
): Promise<Array<{ owner: OwnerKey; receipt: ResourceCleanupReceipt }>> {
  const { owners } = await store.inspect();
  const results: Array<{ owner: OwnerKey; receipt: ResourceCleanupReceipt }> =
    [];
  for (const owner of owners) {
    if (
      owner.phase === "clean" ||
      (owner.phase === "active" && !expired(store, owner))
    )
      continue;
    const identity = {
      runId: owner.runId,
      ownerKind: owner.ownerKind,
      ownerId: owner.ownerId,
    };
    results.push({
      owner: identity,
      receipt: await reapOwner(store, resources, identity, {
        ...options,
        reason: "lease_or_deadline_expired",
      }),
    });
  }
  return results;
}

function expired(store: DurableRunnerStore, owner: DurableOwner): boolean {
  return [
    owner.leaseUntil,
    owner.effectiveWorkDeadlineAt,
    owner.hardDeadlineAt,
  ].some((deadline) => store.now() >= Date.parse(deadline));
}
