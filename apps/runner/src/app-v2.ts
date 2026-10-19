import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  CORE_CASE_IDS, LIMITS_V1, canonicalJson, hashCleanupRequest, runnerCleanupRequestSchema, runnerCleanupResponseSchema,
  runnerHeartbeatRequestSchema, runnerOperationQueryRequestSchema, runnerCapabilitiesSchema,
  validateRunRequest, type RunnerExecuteRequest,
  runnerProbeRequestSchema, hashProbeRequest,
  validatePreparationRequest, validatePreparationResponse,
} from '@codelab/contracts/v2';
import { DurableRunnerStore, RunnerStoreError, type OwnerIdentity } from './durable-store.js';
import { DockerResourceAdapter } from './docker-resources.js';
import { inspectReadiness, reapOwner, type ResourceAdapter } from './resource-reaper.js';
import { executeV2, AmbiguousDockerDispatch } from './engine-v2.js';
import { executionFingerprint, type TrustedRunnerEnvironment } from './environment-v2.js';
import { executeProbeV2, loadProbeContext } from './probe-v2.js';
import { prepareProbeV2 } from './preparation-v2.js';
import { StorageAdmissionError } from './storage-admission.js';

export async function createRunnerAppV2(options: {
  store: DurableRunnerStore; environment: TrustedRunnerEnvironment; token: string; volumeName: string;
  resources?: () => ResourceAdapter;
  execute?: typeof executeV2;
  probe?: typeof executeProbeV2;
  prepareProbe?: typeof prepareProbeV2;
  fatal?: () => void;
  storageAdmission?: () => Promise<void>;
}) {
  const { store, environment } = options;
  const resources = options.resources ?? (() => new DockerResourceAdapter());
  const execute = options.execute ?? executeV2;
  const app = Fastify({ logger: false, bodyLimit: LIMITS_V1.runnerRequestMaxBytes, requestTimeout: 30000 });
  const tokenHash = createHash('sha256').update(options.token).digest();
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ') ||
      !timingSafeEqual(tokenHash, createHash('sha256').update(auth.slice(7)).digest()))
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StorageAdmissionError)
      return reply.code(503).send({ error: { code: error.code } });
    const code = error instanceof Error ? error.message.split(':')[0] : '';
    const conflict = ['OPERATION_PAYLOAD_CONFLICT','OPERATION_SCOPE_MISMATCH'].includes(code);
    const httpError = error as {code?: unknown; statusCode?: unknown};
    const fastifyStatus = typeof httpError?.code === 'string' && httpError.code.startsWith('FST_ERR_') &&
      typeof httpError.statusCode === 'number' && httpError.statusCode >= 400 && httpError.statusCode < 500 ?
      httpError.statusCode : undefined;
    const status = error instanceof RunnerStoreError ? error.statusCode : error instanceof z.ZodError ? 400 :
      conflict ? 409 : fastifyStatus ?? 500;
    reply.code(status).send({ error: { code: error instanceof RunnerStoreError ? error.code :
      conflict ? code : status === 413 ? 'REQUEST_TOO_LARGE' :
      status < 500 ? 'INVALID_REQUEST' : 'RUNNER_OPERATION_FAILED' } });
  });
  app.get('/health', async () => ({ protocolVersion: 2, now: new Date().toISOString(), pid: process.pid }));
  app.get('/v2/catalog', async () => ({ packs: [environment.pack] }));
  app.get('/v2/capabilities', async () => {
    const readiness = await inspectReadiness(store, resources());
    if (readiness.state === 'ready') {
      try { await options.storageAdmission?.(); }
      catch { readiness.state = 'unavailable'; }
    }
    return runnerCapabilitiesSchema.parse({
    protocolVersion: 2, limitsVersion: 'limits-v1', ...readiness,
    templateHashes: [environment.pack.templateHash], packManifestHashes: [environment.pack.contentHash],
    actualEnvironment: environment.measurement, admissionRecordVersion: 'desktop-team-admission-v1',
  }); });
  app.post('/v2/heartbeat', { bodyLimit: LIMITS_V1.runnerMetadataMaxBytes }, async req => {
    const body = runnerHeartbeatRequestSchema.parse(req.body);
    const owner = await store.heartbeat(body.owner, body.leaseUntil);
    return { protocolVersion: 2, leaseUntil: owner.leaseUntil };
  });
  app.post('/v2/operations/query', { bodyLimit: LIMITS_V1.runnerMetadataMaxBytes }, async req => {
    const body = runnerOperationQueryRequestSchema.parse(req.body);
    const result = await store.queryOperation(body.owner, body.operationId);
    if (body.requestHash && body.requestHash !== result.operation.requestHash)
      throw new RunnerStoreError('OPERATION_PAYLOAD_CONFLICT');
    return { record: result.operation, response: result.response };
  });
  app.post('/v2/cleanup', { bodyLimit: LIMITS_V1.runnerMetadataMaxBytes }, async req => {
    const body = runnerCleanupRequestSchema.parse(req.body);
    if (await hashCleanupRequest(body) !== body.requestHash) throw new RunnerStoreError('REQUEST_HASH_MISMATCH',400);
    await store.registerCleanupOwner(body.owner);
    await store.reserveOperation(body.owner, { operationId: body.operationId, requestHash: body.requestHash, kind: 'cleanup' });
    const receipt = await reapOwner(store, resources(), body.owner);
    const saved = await store.queryOperation(body.owner, body.operationId);
    return saved.response ?? runnerCleanupResponseSchema.parse({ protocolVersion: 2,
      runId: body.owner.runId, ownerKind: body.owner.ownerKind, ownerId: body.owner.ownerId,
      operationId: body.operationId, requestHash: body.requestHash, state: receipt.state,
      residualResourceIds: receipt.residualResourceIds, completedAt: receipt.checkedAt });
  });
  app.post('/v2/execute', async (req, reply) => {
    let request: RunnerExecuteRequest;
    try { request = await validateRunRequest(req.body); }
    catch (error) {
      if (error instanceof z.ZodError) throw error;
      const code = error instanceof Error ? error.message.split(':')[0] : '';
      if (/^(SOURCE_HASH_MISMATCH|REQUEST_HASH_MISMATCH|RULE_CONTEXT_MISMATCH|FINGERPRINT_RULE_MISMATCH|PACK_HASH_MISMATCH|RULE_HASH_MISMATCH|PARAMETERS_HASH_MISMATCH)$/.test(code))
        throw new RunnerStoreError(code,400);
      throw error;
    }
    const owner: OwnerIdentity = { runId: request.context.runId, ownerKind: 'execution',
      ownerId: request.context.executionAttemptId, ownerToken: request.ownerToken };
    // Reading a persisted action is independent of today's admission environment.
    // Authenticate the original owner and exact payload before returning any result.
    const knownOperation = (await store.inspect()).operations.some(op => op.operationId === request.operationId);
    if (knownOperation) {
      const saved = await store.queryOperation(owner, request.operationId);
      if (saved.operation.kind !== 'execute') throw new RunnerStoreError('OPERATION_SCOPE_MISMATCH');
      if (saved.operation.requestHash !== request.requestHash) throw new RunnerStoreError('OPERATION_PAYLOAD_CONFLICT');
      return saved.response ?? reply.code(202).send({ record: saved.operation, response: null });
    }
    if (request.budgetConfigVersion !== environment.measurement.values.resourceTimeoutConfigVersion ||
      request.ruleSnapshot.packManifestHash !== environment.pack.contentHash ||
      !request.ruleSnapshot.requiredCaseIds.length ||
      request.ruleSnapshot.requiredCaseIds.some(id => !(CORE_CASE_IDS as readonly string[]).includes(id)))
      throw new RunnerStoreError('UNSUPPORTED_EXECUTION_PACK',422);
    if (canonicalJson(request.approvedFingerprint) !== canonicalJson(executionFingerprint(environment,
      request.context.ruleHash, request.ruleSnapshot.parametersHash)))
      throw new RunnerStoreError('ACTUAL_ENVIRONMENT_MISMATCH',422);
    const known = (await store.inspect()).owners.some(item => item.ownerKind === owner.ownerKind && item.ownerId === owner.ownerId);
    if (!known) {
      const readiness = await inspectReadiness(store, resources());
      if (readiness.state !== 'ready') throw new RunnerStoreError('RUNNER_NOT_READY');
    }
    await options.storageAdmission?.();
    await store.registerOwner({ owner, startedAt: request.startedAt, workDeadlineAt: request.workDeadlineAt,
      hardDeadlineAt: request.hardDeadlineAt, leaseUntil: request.leaseUntil, remainingWorkMs: request.remainingWorkMs });
    const reserved = await store.reserveOperation(owner, { operationId: request.operationId,
      requestHash: request.requestHash, kind: 'execute' }).catch(error => {
        const code = error instanceof Error ? error.message.split(':')[0] : '';
        if (['OPERATION_PAYLOAD_CONFLICT','OPERATION_SCOPE_MISMATCH'].includes(code))
          throw new RunnerStoreError(code);
        throw error;
      });
    if (!reserved.created) {
      const saved = await store.queryOperation(owner, request.operationId);
      return saved.response ?? reply.code(202).send({ record: saved.operation, response: null });
    }
    const dispatch = await store.beginOperation(owner, request.operationId);
    if (!dispatch.started || !dispatch.dispatchToken) throw new RunnerStoreError('OPERATION_NOT_DISPATCHED');
    try {
      const response = await execute(store, environment, options.volumeName, request, dispatch.dispatchToken);
      await store.finishOperation(owner, request.operationId, dispatch.dispatchToken, 'completed', response);
      return response;
    } catch (error) {
      // Do not remove the owner or recreate this operation on a lost response.
      try { await store.finishOperation(owner, request.operationId, dispatch.dispatchToken,
        error instanceof AmbiguousDockerDispatch ? 'unknown' : 'failed'); } catch { /* durable fence wins */ }
      if (error instanceof AmbiguousDockerDispatch) options.fatal?.();
      throw error;
    }
  });
  app.post('/v2/prepare-probe', async (req,reply) => {
    let request;
    try { request=await validatePreparationRequest(req.body); }
    catch { throw new RunnerStoreError('INVALID_PREPARATION_REQUEST',400); }
    const probe=request.probe, owner=probe.owner;
    const known=(await store.inspect()).operations.find(op=>op.operationId===request.operationId);
    if(known){
      const saved=await store.queryOperation(owner,request.operationId);
      if(saved.operation.kind!=='prepare_probe') throw new RunnerStoreError('OPERATION_SCOPE_MISMATCH');
      if(saved.operation.requestHash!==request.requestHash) throw new RunnerStoreError('OPERATION_PAYLOAD_CONFLICT');
      return saved.response ?? reply.code(202).send({record:saved.operation,response:null});
    }
    if(probe.budgetConfigVersion!==environment.measurement.values.resourceTimeoutConfigVersion || request.ruleSnapshot.packManifestHash!==environment.pack.contentHash)
      throw new RunnerStoreError('UNSUPPORTED_EXECUTION_PACK',422);
    if(canonicalJson(request.approvedFingerprint)!==canonicalJson(executionFingerprint(environment,probe.context.ruleHash,request.ruleSnapshot.parametersHash)))
      throw new RunnerStoreError('ACTUAL_ENVIRONMENT_MISMATCH',422);
    const registered=(await store.inspect()).owners.some(item=>item.ownerKind===owner.ownerKind && item.ownerId===owner.ownerId);
    if(!registered && (await inspectReadiness(store,resources())).state!=='ready') throw new RunnerStoreError('RUNNER_NOT_READY');
    await options.storageAdmission?.();
    await store.registerOwner({owner,startedAt:request.startedAt,leaseUntil:request.leaseUntil,
      workDeadlineAt:probe.workDeadlineAt,hardDeadlineAt:probe.hardDeadlineAt,remainingWorkMs:probe.remainingWorkMs});
    const reserved=await store.reserveOperation(owner,{operationId:request.operationId,requestHash:request.requestHash,kind:'prepare_probe'});
    if(!reserved.created){
      const saved=await store.queryOperation(owner,request.operationId);
      return saved.response ?? reply.code(202).send({record:saved.operation,response:null});
    }
    const dispatch=await store.beginOperation(owner,request.operationId);
    if(!dispatch.started || !dispatch.dispatchToken) throw new RunnerStoreError('OPERATION_NOT_DISPATCHED');
    try{
      const response=validatePreparationResponse(await (options.prepareProbe ?? prepareProbeV2)(store,environment,options.volumeName,request,dispatch.dispatchToken),request);
      await store.finishOperation(owner,request.operationId,dispatch.dispatchToken,'completed',response);
      return response;
    }catch(error){
      try { await store.finishOperation(owner,request.operationId,dispatch.dispatchToken,error instanceof AmbiguousDockerDispatch?'unknown':'failed'); } catch {}
      if(error instanceof AmbiguousDockerDispatch) options.fatal?.();
      throw error;
    }
  });
  app.post('/v2/probe', { bodyLimit: LIMITS_V1.runnerMetadataMaxBytes }, async (req,reply) => {
    const request=runnerProbeRequestSchema.parse(req.body);
    if (await hashProbeRequest(request) !== request.requestHash)
      throw new RunnerStoreError('REQUEST_HASH_MISMATCH',400);
    // Completed responses remain replayable after the execution workspace is reclaimed.
    const known=(await store.inspect()).operations.find(op=>op.operationId===request.operationId);
    if (known) {
      const saved=await store.queryOperation(request.owner,request.operationId);
      if(saved.operation.kind !== 'probe') throw new RunnerStoreError('OPERATION_SCOPE_MISMATCH',409);
      if(saved.operation.requestHash !== request.requestHash) throw new RunnerStoreError('OPERATION_PAYLOAD_CONFLICT',409);
      return saved.response ?? reply.code(202).send({record:saved.operation,response:null});
    }
    if(request.budgetConfigVersion !== environment.measurement.values.resourceTimeoutConfigVersion || request.context.packManifestHash !== environment.pack.contentHash)
      throw new RunnerStoreError('UNSUPPORTED_EXECUTION_PACK',422);
    await loadProbeContext(store,request);
    await options.storageAdmission?.();
    const reserved=await store.reserveOperation(request.owner,{operationId:request.operationId,requestHash:request.requestHash,kind:'probe'});
    if (!reserved.created) {
      const saved=await store.queryOperation(request.owner,request.operationId);
      return saved.response ?? reply.code(202).send({record:saved.operation,response:null});
    }
    const dispatch=await store.beginOperation(request.owner,request.operationId);
    if (!dispatch.started || !dispatch.dispatchToken) throw new RunnerStoreError('OPERATION_NOT_DISPATCHED');
    try {
      const response=await (options.probe ?? executeProbeV2)(store,environment,options.volumeName,request,dispatch.dispatchToken);
      await store.finishOperation(request.owner,request.operationId,dispatch.dispatchToken,'completed',response);
      return response;
    } catch(error) {
      try { await store.finishOperation(request.owner,request.operationId,dispatch.dispatchToken,error instanceof AmbiguousDockerDispatch ? 'unknown':'failed'); } catch {}
      if(error instanceof AmbiguousDockerDispatch) options.fatal?.();
      throw error;
    }
  });
  return app;
}
