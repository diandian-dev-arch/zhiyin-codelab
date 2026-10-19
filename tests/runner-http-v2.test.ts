import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIMITS_V1, createArtifactManifest, createDevelopmentPack, createRuleSnapshot,
  createSourceManifest, hashCleanupRequest, hashExecuteRequest, hashRuleSnapshot,
  validateRunRequest, validateRunResponse,
  hashProbeRequest, hashPreparationRequest, validatePreparationRequest, validatePreparationResponse,
  type RunnerPreparationRequest, type RunnerPreparationResponse,
  type MeasurementFingerprint, type RunnerCleanupRequest,
  type RunnerExecuteRequest, type RunnerExecuteResponse,
} from "../packages/contracts/src/v2/index.js";
import { createRunnerAppV2 } from "../apps/runner/src/app-v2.js";
import { StorageAdmissionError } from '../apps/runner/src/storage-admission';
import { DurableRunnerStore, type OwnerIdentity, type OwnerKey, type PlannedResource } from "../apps/runner/src/durable-store.js";
import { AmbiguousDockerDispatch, type executeV2 } from "../apps/runner/src/engine-v2.js";
import type { TrustedRunnerEnvironment } from "../apps/runner/src/environment-v2.js";
import type { ObservedResource, ResourceAdapter } from "../apps/runner/src/resource-reaper.js";

// Synthetic HTTP boundary vectors. No image or browser measurement is claimed here.
const hash = "1".repeat(64);
const token = "http-test-service-token-only";
const headers = { authorization: `Bearer ${token}` };
class FakeResources implements ResourceAdapter {
  records: ObservedResource[] = [];
  removed: string[] = [];
  unavailable = false;
  async listManaged() {
    if (this.unavailable) throw new Error("synthetic daemon unavailable");
    return [...this.records];
  }
  async listOwned(storeId: string, owner: OwnerKey) {
    return (await this.listManaged()).filter(resource =>
      resource.labels["codelab.store"] === storeId &&
      resource.labels["codelab.run"] === owner.runId &&
      resource.labels["codelab.owner-kind"] === owner.ownerKind &&
      resource.labels["codelab.owner"] === owner.ownerId);
  }
  async inspect(kind: PlannedResource["kind"], nameOrId: string) {
    return (await this.listManaged()).find(resource => resource.kind === kind &&
      (resource.id === nameOrId || resource.name === nameOrId)) ?? null;
  }
  async remove(_kind: PlannedResource["kind"], id: string) {
    this.removed.push(id);
    this.records = this.records.filter(resource => resource.id !== id);
  }
}

let now: number;
let store: DurableRunnerStore;
let resources: FakeResources;
let directory: string;
const apps: Awaited<ReturnType<typeof createRunnerAppV2>>[] = [];
beforeEach(async () => {
  now = Date.now();
  directory = await mkdtemp(path.join(await realpath(tmpdir()), "codelab-http-v2-test-"));
  store = await DurableRunnerStore.open(directory, { now: () => now });
  resources = new FakeResources();
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  const temporaryRoot = await realpath(tmpdir());
  if (path.dirname(path.resolve(directory)) !== temporaryRoot ||
    !path.basename(directory).startsWith("codelab-http-v2-test-"))
    throw new Error("Unexpected HTTP test cleanup target");
  await rm(directory, { recursive: true, force: true });
});
const iso = (offset = 0) => new Date(now + offset).toISOString();
const ownerFor = (request: RunnerExecuteRequest): OwnerIdentity => ({
  runId: request.context.runId, ownerKind: "execution",
  ownerId: request.context.executionAttemptId, ownerToken: request.ownerToken,
});
async function fixture(withProbe = false) {
  const pack = await createDevelopmentPack(withProbe ? "new-filter" : "new-only", {
    packVersion: "http-test-v1", templateVersion: "http-template-v1",
    templateHash: hash, dependencyLockHash: hash, initializationVersion: "http-init-v1",
    caseImplementationHashes: { "NEW-01": hash, ...(withProbe ? {"FILTER-03":hash}: {}) },
    ...(withProbe ? {probeImplementationHashes:{FILTER_ORDER_CHECK:hash}} : {}),
  });
  const rule = await createRuleSnapshot({
    ruleId: randomUUID(), taskId: randomUUID(), version: 1, packManifest: pack,
    enabledCriterionIds: withProbe ? ["create","filter"] : ["create"], parameterValues: {},
    confirmedBy: randomUUID(), confirmedAt: iso(),
  });
  const files = { "src/App.vue": Buffer.from("<template>HTTP fixture only</template>").toString("base64") };
  const source = await createSourceManifest(files);
  const context = {
    runId: randomUUID(), executionAttemptId: randomUUID(), submissionId: randomUUID(),
    originalZipSha256: hash, sourceManifestSha256: source.sourceManifestSha256,
    ruleId: rule.ruleId, ruleHash: await hashRuleSnapshot(rule),
    packManifestHash: pack.contentHash, templateHash: pack.templateHash,
  };
  const fingerprint: MeasurementFingerprint = {
    ruleHash: context.ruleHash, packManifestHash: pack.contentHash,
    templateHash: pack.templateHash, dependencyLockHash: pack.dependencyLockHash,
    initializationVersion: pack.initializationVersion, parametersHash: rule.parametersHash,
    aggregationVersion: pack.aggregationVersion,
    buildImage: { identifierType: "local_image_id", value: `sha256:${hash}` },
    webImage: { identifierType: "local_image_id", value: `sha256:${hash}` },
    browserImage: { identifierType: "local_image_id", value: `sha256:${hash}` },
    playwrightVersion: "synthetic-http-1", chromiumVersion: "synthetic-http-1",
    viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
    locale: "zh-CN", timezone: "Asia/Shanghai", clockPolicy: "http-clock-v1",
    randomPolicy: "http-random-v1", pageServerPolicy: "http-page-v1",
    resourceTimeoutConfigVersion: "http-measured-limits-v2",
  };
  const { ruleHash: _ruleHash, parametersHash: _parametersHash, ...measured } = fingerprint;
  const environment: TrustedRunnerEnvironment = {
    pack, measurement: { completeness: "partial", values: measured,
      missingFields: ["ruleHash", "parametersHash"] },
    buildImage: fingerprint.buildImage.value, webImage: fingerprint.webImage.value,
    browserImage: fingerprint.browserImage.value,
  };
  const request = await rehash({
    protocolVersion: 2, context, ownerToken: randomUUID(), operationId: randomUUID(),
    requestId: randomUUID(), files, ruleSnapshot: rule, approvedFingerprint: fingerprint,
    startedAt: iso(), leaseUntil: iso(20_000), workDeadlineAt: iso(270_000),
    hardDeadlineAt: iso(300_000), remainingWorkMs: 270_000,
    budgetConfigVersion: "http-measured-limits-v2", requestHash: hash,
  });
  await validateRunRequest(request);
  return { environment, request };
}
async function rehash(request: RunnerExecuteRequest) {
  return { ...request, requestHash: await hashExecuteRequest(request) };
}
async function preparationFixture() {
  const {environment,request:base}=await fixture(true), analysisId=randomUUID();
  const probe={protocolVersion:2 as const,context:base.context,owner:{runId:base.context.runId,ownerKind:"analysis" as const,ownerId:analysisId,ownerToken:randomUUID()},
    analysisAttemptId:analysisId,operationId:randomUUID(),requestId:randomUUID(),requestHash:hash,probeId:"FILTER_ORDER_CHECK",parameters:{},
    workDeadlineAt:iso(60_000),hardDeadlineAt:iso(90_000),remainingWorkMs:60_000,budgetConfigVersion:"http-measured-limits-v2"};
  probe.requestHash=await hashProbeRequest(probe);
  const request:RunnerPreparationRequest={protocolVersion:2,operationId:randomUUID(),requestId:randomUUID(),requestHash:hash,
    probe,files:base.files,ruleSnapshot:base.ruleSnapshot,approvedFingerprint:base.approvedFingerprint,startedAt:iso(),leaseUntil:iso(20_000)};
  request.requestHash=await hashPreparationRequest(request);
  const response:RunnerPreparationResponse={protocolVersion:2,context:probe.context,analysisAttemptId:analysisId,
    operationId:request.operationId,requestHash:request.requestHash,observedSourceManifestSha256:probe.context.sourceManifestSha256,
    actualFingerprint:base.approvedFingerprint,state:"ready"};
  return {environment,request,response};
}
describe("independent probe preparation HTTP",()=>{
  it('rejects preparation before owner registration when capacity is unknown', async () => {
    const { environment, request } = await preparationFixture();
    const prepareProbe = vi.fn();
    const app = await createRunnerAppV2({ store, environment, token, volumeName: 'codelab-http-test',
      resources: () => resources, prepareProbe, storageAdmission: async () => { throw new StorageAdmissionError('STORAGE_CAPACITY_UNKNOWN'); } });
    apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/v2/prepare-probe', headers, payload: request });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('STORAGE_CAPACITY_UNKNOWN');
    expect((await store.inspect()).owners).toHaveLength(0);
    expect(prepareProbe).not.toHaveBeenCalled();
  });
  it("binds archived source, owner, deadlines and measured response",async()=>{
    const {request,response}=await preparationFixture();
    await expect(validatePreparationRequest(request)).resolves.toEqual(request);
    expect(validatePreparationResponse(response,request)).toEqual(response);
    await expect(validatePreparationRequest({...request,files:{"src/App.vue":Buffer.from("changed").toString("base64")}})).rejects.toThrow("SOURCE_HASH_MISMATCH");
    await expect(validatePreparationRequest({...request,probe:{...request.probe,remainingWorkMs:61_000}})).rejects.toThrow();
    await expect(validatePreparationRequest({...request,probe:{...request.probe,owner:{...request.probe.owner,ownerKind:"execution"}}})).rejects.toThrow();
    expect(()=>validatePreparationResponse({...response,analysisAttemptId:randomUUID()},request)).toThrow("PREPARATION_RESPONSE_MISMATCH");
    expect(()=>validatePreparationResponse({...response,actualFingerprint:{...response.actualFingerprint,chromiumVersion:"unapproved"}},request)).toThrow();
  });
  it("dispatches once under an analysis owner and replays without extending its lease",async()=>{
    const {environment,request,response}=await preparationFixture(),prepareProbe=vi.fn(async()=>response);
    const app=await createRunnerAppV2({store,environment,token,volumeName:"codelab-http-test",resources:()=>resources,prepareProbe});apps.push(app);
    expect((await app.inject({method:"POST",url:"/v2/prepare-probe",payload:request})).statusCode).toBe(401);
    const first=await app.inject({method:"POST",url:"/v2/prepare-probe",headers,payload:request});
    expect(first.statusCode,first.body).toBe(200);
    now+=25_000;
    expect((await app.inject({method:"POST",url:"/v2/prepare-probe",headers,payload:request})).json()).toEqual(response);
    expect(prepareProbe).toHaveBeenCalledOnce();
    expect((await store.inspect()).owners[0]).toMatchObject({ownerKind:"analysis",ownerId:request.probe.analysisAttemptId,leaseUntil:request.leaseUntil});
    const changed={...request,files:{"src/App.vue":Buffer.from("different").toString("base64")}};
    expect((await app.inject({method:"POST",url:"/v2/prepare-probe",headers,payload:changed})).statusCode).toBe(400);
  });
  it("retains an uncertain preparation operation and never redispatches it",async()=>{
    const {environment,request}=await preparationFixture();
    const prepareProbe=vi.fn(async()=>{throw new AmbiguousDockerDispatch("PREPARATION_CREATE_OUTCOME_UNKNOWN");}),fatal=vi.fn();
    const app=await createRunnerAppV2({store,environment,token,volumeName:"codelab-http-test",resources:()=>resources,prepareProbe,fatal});apps.push(app);
    expect((await app.inject({method:"POST",url:"/v2/prepare-probe",headers,payload:request})).statusCode).toBe(500);
    const replay=await app.inject({method:"POST",url:"/v2/prepare-probe",headers,payload:request});
    expect(replay.statusCode).toBe(202);expect(replay.json().record.state).toBe("unknown");
    expect(prepareProbe).toHaveBeenCalledOnce();expect(fatal).toHaveBeenCalledOnce();
  });
});
async function cleanupFor(request: RunnerExecuteRequest, operationId: string = randomUUID()): Promise<RunnerCleanupRequest> {
  const body = { protocolVersion: 2 as const, owner: ownerFor(request), operationId, requestId: randomUUID() };
  return { ...body, requestHash: await hashCleanupRequest(body) };
}
async function syntheticResponse(request: RunnerExecuteRequest): Promise<RunnerExecuteResponse> {
  const manifest = await createArtifactManifest({
    manifestId: randomUUID(), context: request.context, source: "base",
    analysisAttemptId: null, operationId: null, evidence: [], completeness: "partial",
  });
  return validateRunResponse({
    protocolVersion: 2, context: { ...request.context, operationId: request.operationId,
      requestHash: request.requestHash, observedSourceManifestSha256: null,
      sourceVerificationReason: "SYNTHETIC_HTTP_TEST" },
    actualFingerprint: { completeness: "complete", values: request.approvedFingerprint, missingFields: [] },
    outcome: "infra_error", caseResults: request.ruleSnapshot.packManifest.cases.map(definition => ({
      criterionId: definition.criterionId, caseId: definition.caseId, verdict: "not_run",
      preconditionStatus: "blocked", reasonCode: "INFRA_ERROR", expected: definition.expected,
      observed: "Synthetic HTTP fixture: no browser execution was attempted.",
      executedSteps: [], unexecutedStepIds: definition.plannedSteps.map(step => step.stepId),
      blockedBy: [{ kind: "execution_stage", id: "prepare", reasonCode: "INFRA_ERROR" }], evidenceIds: [],
    })), baseManifest: manifest, artifacts: [], timings: [], resourceState: "retained_for_initial_analysis",
  }, { rule: request.ruleSnapshot, expectedContext: { ...request.context,
    operationId: request.operationId, requestHash: request.requestHash },
    approvedFingerprint: request.approvedFingerprint });
}
async function application(environment: TrustedRunnerEnvironment, execute: typeof executeV2 =
  async (_store, _environment, _volume, request) => syntheticResponse(request), fatal = vi.fn()) {
  const app = await createRunnerAppV2({ store, environment, token, volumeName: "codelab-http-test",
    resources: () => resources, execute, fatal });
  apps.push(app);
  return app;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe("runner v2 HTTP admission and durable replay", () => {
  it('blocks new execution without creating an owner and allows replay after capacity drops', async () => {
    const { environment, request } = await fixture();
    let blocked = true;
    const execute = vi.fn<typeof executeV2>(async (_s, _e, _v, req) => syntheticResponse(req));
    const app = await createRunnerAppV2({ store, environment, token, volumeName: 'codelab-http-test',
      resources: () => resources, execute, storageAdmission: async () => {
        if (blocked) throw new StorageAdmissionError('STORAGE_CAPACITY_LOW');
      } }); apps.push(app);
    const send = () => app.inject({ method: 'POST', url: '/v2/execute', headers, payload: request });
    expect((await send()).statusCode).toBe(503);
    expect((await store.inspect()).owners).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'GET', url: '/v2/capabilities', headers })).json().state).toBe('unavailable');
    blocked = false; const first = await send(); expect(first.statusCode).toBe(200);
    blocked = true; const replay = await send(); expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json()); expect(execute).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: 'GET', url: '/v2/capabilities', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v2/cleanup', headers, payload: await cleanupFor(request) })).statusCode).toBe(200);
  });
  it("authenticates every route before exposing metadata or mutating durable state", async () => {
    const { environment } = await fixture(), app = await application(environment);
    for (const [method, url] of [["GET", "/health"], ["GET", "/v2/catalog"],
      ["GET", "/v2/capabilities"], ["POST", "/v2/execute"], ["POST", "/v2/heartbeat"],
      ["POST", "/v2/operations/query"], ["POST", "/v2/cleanup"]] as const) {
      for (const supplied of [undefined, "Bearer incorrect-token"]) {
        const response = await app.inject({ method, url,
          headers: supplied ? { authorization: supplied } : {},
          ...(method === "POST" ? { payload: {} } : {}) });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
        expect(response.json()).toEqual({ error: { code: "UNAUTHORIZED" } });
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    }
    expect((await store.inspect()).owners).toHaveLength(0);
  });

  it("returns 400 for invalid JSON and 413 for an oversized body", async () => {
    const { environment } = await fixture(), app = await application(environment);
    const invalid = await app.inject({ method: "POST", url: "/v2/execute",
      headers: { ...headers, "content-type": "application/json" }, payload: "{" });
    expect(invalid.statusCode).toBe(400);
    const oversized = await app.inject({ method: "POST", url: "/v2/heartbeat", headers,
      payload: { padding: "x".repeat(LIMITS_V1.runnerMetadataMaxBytes) } });
    expect(oversized.statusCode).toBe(413);
    expect((await store.inspect()).owners).toHaveLength(0);
  });

  it.each(["schema", "source", "hash"] as const)("rejects %s tampering before admission", async kind => {
    const { environment, request } = await fixture(), execute = vi.fn<typeof executeV2>();
    const app = await application(environment, execute);
    const payload = structuredClone(request);
    if (kind === "schema") (payload as unknown as { extra: string }).extra = "unexpected";
    if (kind === "source") payload.files["src/App.vue"] = Buffer.from("changed").toString("base64");
    if (kind === "hash") payload.requestHash = "2".repeat(64);
    const response = await app.inject({ method: "POST", url: "/v2/execute", headers, payload });
    expect(response.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect((await store.inspect()).owners).toHaveLength(0);
  });

  it.each(["budget", "measurement"] as const)("rejects an unsupported %s without starting an owner", async kind => {
    const { environment, request } = await fixture(), app = await application(environment);
    if (kind === "budget") request.budgetConfigVersion = "unapproved-budget-v1";
    else request.approvedFingerprint.chromiumVersion = "different-browser";
    const response = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: await rehash(request) });
    expect(response.statusCode).toBe(422);
    expect((await store.inspect()).owners).toHaveLength(0);
  });

  it("returns the same durable result on replay and on query, including after cleanup", async () => {
    const { environment, request } = await fixture();
    const execute = vi.fn<typeof executeV2>(async (_store, _env, _volume, incoming) => syntheticResponse(incoming));
    const app = await application(environment, execute);
    const first = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({ method: "POST", url: "/v2/execute", headers,
      payload: { ...request, requestId: randomUUID() } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const query = await app.inject({ method: "POST", url: "/v2/operations/query", headers,
      payload: { protocolVersion: 2, owner: ownerFor(request), operationId: request.operationId, requestHash: request.requestHash } });
    expect(query.statusCode).toBe(200);
    expect(query.json()).toMatchObject({ record: { state: "completed" }, response: first.json() });
    const cleanup = await cleanupFor(request);
    const clean = await app.inject({ method: "POST", url: "/v2/cleanup", headers, payload: cleanup });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().state).toBe("clean");
    const repeatClean = await app.inject({ method: "POST", url: "/v2/cleanup", headers,
      payload: { ...cleanup, requestId: randomUUID() } });
    expect(repeatClean.json()).toEqual(clean.json());
    const afterClean = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    expect(afterClean.statusCode).toBe(200);
    expect(afterClean.json()).toEqual(first.json());
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "GET", url: "/v2/capabilities", headers })).json().state).toBe("ready");
  });

  it('replays archived execution after environment changes without admission, renewal or redispatch', async () => {
    const { environment, request } = await fixture();
    const execute = vi.fn<typeof executeV2>(async (_store, _env, _volume, incoming) => syntheticResponse(incoming));
    const app = await application(environment, execute);
    const first = await app.inject({ method: 'POST', url: '/v2/execute', headers, payload: request });
    expect(first.statusCode).toBe(200);
    const before = await store.inspect();
    environment.measurement.values.chromiumVersion = 'upgraded-browser';
    const replay = await app.inject({ method: 'POST', url: '/v2/execute', headers,
      payload: { ...request, requestId: randomUUID(), leaseUntil: iso(30_000) } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(await store.inspect()).toEqual(before);
    const wrongToken = await app.inject({ method: 'POST', url: '/v2/execute', headers,
      payload: { ...request, ownerToken: randomUUID() } });
    expect(wrongToken.statusCode).toBe(404);
    const changed = await app.inject({ method: 'POST', url: '/v2/execute', headers,
      payload: await rehash({ ...request, remainingWorkMs: request.remainingWorkMs - 1 }) });
    expect(changed.statusCode).toBe(409);
    const fresh = await app.inject({ method: 'POST', url: '/v2/execute', headers,
      payload: await rehash({ ...request, operationId: randomUUID() }) });
    expect(fresh.statusCode).toBe(422);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps a running operation unique while allowing authenticated heartbeat and query", async () => {
    const { environment, request } = await fixture(), entered = deferred<void>(), release = deferred<void>();
    const execute = vi.fn<typeof executeV2>(async (_store, _env, _volume, incoming) => {
      entered.resolve(); await release.promise; return syntheticResponse(incoming);
    });
    const app = await application(environment, execute);
    const first = app.inject({ method: "POST", url: "/v2/execute", headers, payload: request }).then(response => response);
    await entered.promise;
    try {
      const replay = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toMatchObject({ record: { state: "running" }, response: null });
      const conflict = await app.inject({ method: "POST", url: "/v2/execute", headers,
        payload: await rehash({ ...request, remainingWorkMs: request.remainingWorkMs - 1 }) });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe("OPERATION_PAYLOAD_CONFLICT");
      const other = (await fixture()).request;
      const busy = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: other });
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error.code).toBe("RUNNER_NOT_READY");
      const newOperation = await app.inject({ method: "POST", url: "/v2/execute", headers,
        payload: await rehash({ ...request, operationId: randomUUID() }) });
      expect(newOperation.statusCode).toBe(409);
      expect(newOperation.json().error.code).toBe("OWNER_OPERATION_BUSY");
      const heartbeat = await app.inject({ method: "POST", url: "/v2/heartbeat", headers,
        payload: { protocolVersion: 2, owner: ownerFor(request), leaseUntil: iso(30_000) } });
      expect(heartbeat.statusCode).toBe(200);
      expect(heartbeat.json().leaseUntil).toBe(iso(30_000));
      expect((await app.inject({ method: "GET", url: "/v2/capabilities", headers })).json().state).toBe("busy");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); await first; }
  });

  it("requires the original owner token for query, heartbeat, and cleanup", async () => {
    const { environment, request } = await fixture(), app = await application(environment);
    await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    const owner = { ...ownerFor(request), ownerToken: randomUUID() };
    const cleanup = { ...(await cleanupFor(request)), owner };
    for (const [url, payload] of [
      ["/v2/operations/query", { protocolVersion: 2, owner, operationId: request.operationId }],
      ["/v2/heartbeat", { protocolVersion: 2, owner, leaseUntil: iso(30_000) }],
      ["/v2/cleanup", cleanup],
    ] as const) {
      const response = await app.inject({ method: "POST", url, headers, payload });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("OWNER_NOT_FOUND");
    }
    expect((await store.inspect()).owners[0].phase).toBe("active");
  });

  it("returns 409 for a mismatched query hash and 404 for another operation", async () => {
    const { environment, request } = await fixture(), app = await application(environment);
    await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    const query = { protocolVersion: 2, owner: ownerFor(request), operationId: request.operationId };
    const conflict = await app.inject({ method: "POST", url: "/v2/operations/query", headers,
      payload: { ...query, requestHash: "2".repeat(64) } });
    expect(conflict.statusCode).toBe(409);
    const missing = await app.inject({ method: "POST", url: "/v2/operations/query", headers,
      payload: { ...query, operationId: randomUUID() } });
    expect(missing.statusCode).toBe(404);
  });

  it("persists a cleanup-before-execute tombstone that cannot renew or execute", async () => {
    const { environment, request } = await fixture(), execute = vi.fn<typeof executeV2>();
    const app = await application(environment, execute);
    const cleanup = await cleanupFor(request);
    const clean = await app.inject({ method: "POST", url: "/v2/cleanup", headers, payload: cleanup });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().state).toBe("clean");
    const executeLate = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    expect(executeLate.statusCode).toBe(409);
    const heartbeat = await app.inject({ method: "POST", url: "/v2/heartbeat", headers,
      payload: { protocolVersion: 2, owner: ownerFor(request), leaseUntil: iso(30_000) } });
    expect(heartbeat.statusCode).toBe(409);
    expect(execute).not.toHaveBeenCalled();
    expect((await store.inspect()).operations).toHaveLength(1);
  });

  it("rejects cleanup hash tampering before writing a tombstone", async () => {
    const { environment, request } = await fixture(), app = await application(environment);
    const cleanup = await cleanupFor(request);
    const response = await app.inject({ method: "POST", url: "/v2/cleanup", headers,
      payload: { ...cleanup, requestHash: "2".repeat(64) } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("REQUEST_HASH_MISMATCH");
    expect((await store.inspect()).owners).toHaveLength(0);
  });

  it("returns 409 when a cleanup reuses an execution operationId", async () => {
    const { environment, request } = await fixture(), app = await application(environment);
    await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    const response = await app.inject({ method: "POST", url: "/v2/cleanup", headers,
      payload: await cleanupFor(request, request.operationId) });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("OPERATION_SCOPE_MISMATCH");
    expect((await store.inspect()).owners[0].phase).toBe("active");
  });

  it.each(["foreign", "unavailable"] as const)("blocks admission for %s resources without removing them", async kind => {
    const { environment, request } = await fixture(), execute = vi.fn<typeof executeV2>();
    if (kind === "foreign") resources.records.push({ kind: "container", id: "foreign-id", name: "unregistered-container",
      labels: { "codelab.managed": "true" } });
    else resources.unavailable = true;
    const app = await application(environment, execute);
    const capabilities = await app.inject({ method: "GET", url: "/v2/capabilities", headers });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().state).toBe(kind === "foreign" ? "cleanup_pending" : "unavailable");
    expect(capabilities.json().residualResourceIds).toEqual([
      kind === "foreign" ? "container:foreign-id" : "docker:inspection_unavailable",
    ]);
    const response = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    expect(response.statusCode).toBe(409);
    expect(execute).not.toHaveBeenCalled();
    expect(resources.removed).toEqual([]);
  });

  it("keeps ambiguous dispatch unknown and cleanup pending until its producer has stopped", async () => {
    const { environment, request } = await fixture(), fatal = vi.fn();
    const execute = vi.fn<typeof executeV2>(async () => { throw new AmbiguousDockerDispatch("sensitive internal detail"); });
    const app = await application(environment, execute, fatal);
    const response = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("sensitive");
    expect(fatal).toHaveBeenCalledTimes(1);
    const replay = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ record: { state: "unknown" }, response: null });
    const clean = await app.inject({ method: "POST", url: "/v2/cleanup", headers, payload: await cleanupFor(request) });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().state).toBe("cleanup_pending");
    expect(clean.json().residualResourceIds).toContain(`producer:${request.operationId}`);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "GET", url: "/v2/capabilities", headers })).json().state).toBe("cleanup_pending");
  });

  it("persists a known failure without redispatch and allows its quiesced resources to clean", async () => {
    const { environment, request } = await fixture(), fatal = vi.fn();
    const execute = vi.fn<typeof executeV2>(async () => { throw new Error("sensitive internal detail"); });
    const app = await application(environment, execute, fatal);
    const response = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("sensitive");
    const replay = await app.inject({ method: "POST", url: "/v2/execute", headers, payload: request });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ record: { state: "failed" }, response: null });
    const clean = await app.inject({ method: "POST", url: "/v2/cleanup", headers, payload: await cleanupFor(request) });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().state).toBe("clean");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fatal).not.toHaveBeenCalled();
  });
});
