import { z } from "zod";
import { artifactManifestSchema, artifactPayloadSchema, validateArtifactManifest, validateArtifactPayloads } from "./evidence";
import { executionContextSchema, uuidSchema, sha256Schema, utcDateTimeSchema, canonicalJson, decodeBase64, assertContextMatches, fail, LIMITS_V1 } from "./primitives";
import { validateProbeRequest, type RunnerProbeRequest } from "./runner";
import type { RuleSnapshot } from "./task-packs";

const unavailable = z.object({status:z.literal('unavailable'),reason:z.enum(['STATE_UNAVAILABLE','SCREENSHOT_UNAVAILABLE','TIME_BUDGET'])}).strict();
export const probeCaptureSchema = z.object({
  pathId:z.enum(['A','B']), stepId:z.string().max(100), capturedAt:utcDateTimeSchema,
  state:z.union([unavailable,z.object({status:z.literal('captured'),controlValue:z.enum(['all','active','done']),
    visible:z.array(z.object({title:z.string().max(200),done:z.boolean()}).strict()).max(100)}).strict()]),
  screenshot:z.union([unavailable,z.object({status:z.literal('captured'),byteSize:z.number().int().min(8).max(LIMITS_V1.pngMaxBytes),
    sha256:sha256Schema,filename:z.string().regex(/^probe-[AB]-[0-9]\.png$/),evidenceId:uuidSchema.optional()}).strict()]),
}).strict();

export const runnerProbeResponseSchema = z.object({
  protocolVersion: z.literal(2), context: executionContextSchema,
  analysisAttemptId: uuidSchema, operationId: uuidSchema, requestHash: sha256Schema,
  probeId: z.literal("FILTER_ORDER_CHECK"),
  supplementalManifest: artifactManifestSchema,
  artifacts: z.array(artifactPayloadSchema).min(1).max(11),
  stepCaptures:z.array(probeCaptureSchema).max(10).optional(),
  resourceState: z.enum(["retained_for_initial_analysis","retained_for_reanalysis"]),
}).strict();
export type RunnerProbeResponse = z.infer<typeof runnerProbeResponseSchema>;

export async function validateProbeResponse(value: unknown, request: RunnerProbeRequest, rule: RuleSnapshot): Promise<RunnerProbeResponse> {
  await validateProbeRequest(request,rule);
  const response = runnerProbeResponseSchema.parse(value);
  if(response.resourceState !== (request.owner.ownerKind === "execution" ? "retained_for_initial_analysis" : "retained_for_reanalysis"))
    fail("PROBE_RESOURCE_OWNER_MISMATCH",request.operationId);
  assertContextMatches(request.context,response.context);
  if (response.operationId !== request.operationId || response.requestHash !== request.requestHash ||
      response.analysisAttemptId !== request.analysisAttemptId || response.probeId !== request.probeId)
    fail("PROBE_RESPONSE_IDENTITY_MISMATCH",request.operationId);
  const manifest = await validateArtifactManifest(response.supplementalManifest,{rule,expectedContext:request.context});
  if (manifest.source !== "supplemental" || manifest.analysisAttemptId !== request.analysisAttemptId || manifest.operationId !== request.operationId)
    fail("PROBE_MANIFEST_IDENTITY_MISMATCH",request.operationId);
  for (const evidence of manifest.evidence)
    if (evidence.phase !== "probe" || evidence.collector !== "runner" ||
        evidence.criterionId !== "filter" || evidence.caseId !== "FILTER-03" ||
        !((evidence.mediaType === 'application/json' && evidence.contentOrigin === 'checker_observation') ||
          (evidence.mediaType === 'image/png' && evidence.contentOrigin === 'rendered_page')))
      fail("PROBE_EVIDENCE_SCOPE_INVALID",evidence.evidenceId);
  const images = manifest.evidence.filter(e=>e.mediaType==='image/png');
  const captures = response.stepCaptures;
  if (images.length && !captures) fail('PROBE_CAPTURE_REQUIRED',request.operationId);
  if (captures) {
    const definition = rule.packManifest.probes.find(p=>p.probeId===request.probeId)!;
    const seen = new Set<string>(), referenced = new Set<string>(), filenames = new Set<string>();
    for (const capture of captures) {
      const key = `${capture.pathId}:${capture.stepId}`;
      if(seen.has(key) || !definition.plannedPaths.find(p=>p.pathId===capture.pathId)?.plannedSteps.some(s=>s.stepId===capture.stepId))
        fail('PROBE_CAPTURE_STEP_INVALID',key);
      seen.add(key);
      const screenshot = capture.screenshot;
      if(screenshot.status==='captured') {
        const evidence = images.find(e=>e.evidenceId===screenshot.evidenceId);
        if(!evidence || referenced.has(evidence.evidenceId) || filenames.has(screenshot.filename) ||
          !screenshot.filename.startsWith(`probe-${capture.pathId}-`) || evidence.sha256!==screenshot.sha256 || evidence.byteSize!==screenshot.byteSize ||
          evidence.capturedAt!==capture.capturedAt) fail('PROBE_CAPTURE_IMAGE_INVALID',key);
        referenced.add(evidence.evidenceId); filenames.add(screenshot.filename);
      }
    }
    if(referenced.size!==images.length) fail('PROBE_CAPTURE_UNREFERENCED_IMAGE',request.operationId);
    if(manifest.completeness==='complete' && (captures.some(c=>c.state.status!=='captured'||c.screenshot.status!=='captured') ||
      definition.plannedPaths.some(p=>p.plannedSteps.some(s=>!seen.has(`${p.pathId}:${s.stepId}`)))))
      fail('PROBE_CAPTURE_INCOMPLETE',request.operationId);
  }
  if (new TextEncoder().encode(JSON.stringify(response)).byteLength > LIMITS_V1.runnerResponseMaxBytes)
    fail("PAYLOAD_TOO_LARGE","probe response");
  await validateArtifactPayloads(manifest,response.artifacts);
  if(captures) {
    const json = manifest.evidence.filter(e=>e.mediaType==='application/json');
    if(json.length!==1) fail('PROBE_CAPTURE_OBSERVATION_REQUIRED',request.operationId);
    const payload=response.artifacts.find(a=>a.evidenceId===json[0].evidenceId)!;
    const output=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decodeBase64(payload.data,LIMITS_V1.textEvidenceMaxBytes)));
    const raw=z.array(probeCaptureSchema).max(10).parse(output.observation?.captures);
    const stripped=captures.map(c=>({...c,screenshot:c.screenshot.status==='captured'
      ? (({evidenceId:_,...screenshot})=>screenshot)(c.screenshot):c.screenshot}));
    if(canonicalJson(raw)!==canonicalJson(stripped)) fail('PROBE_CAPTURE_OBSERVATION_MISMATCH',request.operationId);
    for(const capture of captures) {
      const paths=output.observation?.paths;
      if(!Array.isArray(paths) || !paths.some(p=>p.pathId===capture.pathId && Array.isArray(p.executedSteps) &&
        p.executedSteps.some((s:{stepId?:string})=>s.stepId===capture.stepId))) fail('PROBE_CAPTURE_UNEXECUTED_STEP',capture.stepId);
    }
  }
  return response;
}
