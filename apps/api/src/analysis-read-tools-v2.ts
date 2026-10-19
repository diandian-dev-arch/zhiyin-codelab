import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  businessIdSchema, uuidSchema, canonicalJson, sha256, createSourceManifest, validateSourceFiles,
  createArtifactManifest, aggregateResults, type Evidence, type ArtifactManifest,
} from "@codelab/contracts/v2";
import type { ArtifactStore } from "./artifacts-v2.js";
import { analysisContextV2, getRunComparisonV2 } from "./reports-v2.js";
import { reserveAnalysisOperationV2, sendAnalysisOperationV2, finishAnalysisOperationV2, type AnalysisOperationIdentityV2 } from "./analysis-operations-v2.js";

export const analysisReadToolSchemaV2=z.discriminatedUnion("name",[
  z.object({name:z.literal("read_check_result"),args:z.object({criterionId:businessIdSchema.optional(),caseId:businessIdSchema.optional()}).strict()}).strict(),
  z.object({name:z.literal("read_source_excerpt"),args:z.object({path:z.string().min(1).max(240),startLine:z.number().int().min(1).max(20000),lineCount:z.number().int().min(1).max(100)}).strict()}).strict(),
  z.object({name:z.literal("read_console_evidence"),args:z.object({evidenceId:uuidSchema}).strict()}).strict(),
  z.object({name:z.literal("inspect_page_evidence"),args:z.object({caseId:businessIdSchema.optional(),evidenceId:uuidSchema.optional()}).strict().refine(v=>Boolean(v.caseId)!==Boolean(v.evidenceId),"Provide exactly one indexed case or evidence")} ).strict(),
  z.object({name:z.literal("compare_submission"),args:z.object({caseId:businessIdSchema.optional()}).strict()}).strict(),
]);
const MAX_TEXT=12*1024;
export function boundedAnalysisToolResultV2(tool:string,data:unknown) {
  const result={tool,trust:"untrusted_data",truncated:false,data};
  if(Buffer.byteLength(canonicalJson(result),"utf8")<=MAX_TEXT) return result;
  const serialized=canonicalJson(data);
  let low=0,high=serialized.length;
  while(low<high) {
    const middle=Math.ceil((low+high)/2);
    const sample={tool,trust:"untrusted_data",truncated:true,dataText:serialized.slice(0,middle),note:"内容按 UTF-8 字节上限截断；dataText 不是完整 JSON。"};
    if(Buffer.byteLength(canonicalJson(sample),"utf8")<=MAX_TEXT) low=middle; else high=middle-1;
  }
  return {tool,trust:"untrusted_data",truncated:true,dataText:serialized.slice(0,low),note:"内容按 UTF-8 字节上限截断；dataText 不是完整 JSON。"};
}

/** All identities come from the service. No model-supplied run, user, URL or shell parameter. */
export async function runAnalysisReadToolV2(input:AnalysisOperationIdentityV2 & {call:unknown;artifacts:Pick<ArtifactStore,"storeManifest"|"readEvidence">}) {
  const call=analysisReadToolSchemaV2.parse(input.call);
  // Tool text is charged as part of the next model input, including the complete retained transcript.
  const reservation=await reserveAnalysisOperationV2({...input,kind:call.name,request:call,budget:{toolCalls:1}});
  if(!reservation.created) {
    const prior=(await input.db.query(`SELECT p.response,o.response_hash FROM analysis_private_io p JOIN analysis_operations o USING(analysis_attempt_id,operation_id)
      WHERE p.analysis_attempt_id=$1 AND p.operation_id=$2`,[input.analysisAttemptId,input.operationId])).rows[0];
    if(prior?.response && await sha256(prior.response)===prior.response_hash) return JSON.parse(prior.response);
    return {tool:call.name,state:reservation.operation.state,replayed:true};
  }
  if(!await sendAnalysisOperationV2(input)) return {tool:call.name,state:"sent",replayed:true};
  let data:unknown,manifest:ArtifactManifest|undefined;
  try {
    const row=(await input.db.query(`SELECT a.run_id,s.files,s.source_manifest_sha256,c.teacher_id
      FROM analysis_attempts a JOIN runs r ON r.id=a.run_id JOIN submissions s ON s.id=r.submission_id
      JOIN tasks t ON t.id=s.task_id JOIN classes c ON c.id=t.class_id WHERE a.id=$1`,[input.analysisAttemptId])).rows[0];
    if(!row) throw new Error("ANALYSIS_NOT_FOUND");
    const {context}=await analysisContextV2(input.db,row.run_id);
    const evidence=[context.baseManifest,...context.supplementalManifests].flatMap(m=>m.evidence).filter(e=>e.phase!=="diagnostic");
    const indexed=(id:string)=>{
      const item=evidence.find(e=>e.evidenceId===id);
      if(!item) throw new Error("EVIDENCE_NOT_ALLOWED");
      return item;
    };
    const allowedCase=(id:string)=>{
      if(!context.rule.requiredCaseIds.includes(id)) throw new Error("CASE_NOT_ALLOWED");
    };
    const ref=(e:Evidence)=>({scope:"current",manifestId:e.manifestId,evidenceId:e.evidenceId});
    switch(call.name) {
      case "read_check_result": {
        if(call.args.caseId) allowedCase(call.args.caseId);
        if(call.args.criterionId && !context.rule.enabledCriterionIds.includes(call.args.criterionId)) throw new Error("CRITERION_NOT_ALLOWED");
        const cases=context.baseResults.filter(c=>(!call.args.caseId || c.caseId===call.args.caseId) && (!call.args.criterionId || c.criterionId===call.args.criterionId));
        if(call.args.caseId && !cases.length) throw new Error("CASE_CRITERION_MISMATCH");
        const criterionId=call.args.criterionId ?? (call.args.caseId ? cases[0].criterionId:undefined);
        data={cases,aggregates:aggregateResults(context.rule,context.baseResults).filter(c=>!criterionId || c.criterionId===criterionId)};
        break;
      }
      case "read_source_excerpt": {
        const {path,startLine,lineCount}=call.args;
        if(!/^(src|public)\/.+\.(vue|[cm]?[jt]sx?|css|scss|sass|less|html|json|md|txt)$/.test(path)) throw new Error("SOURCE_PATH_NOT_ALLOWED");
        const files=Object.fromEntries(Object.entries(row.files as Record<string,string>).filter(([name])=>name.startsWith("src/") || name.startsWith("public/")));
        const source=await createSourceManifest(files);
        if(source.sourceManifestSha256!==context.baseManifest.context.sourceManifestSha256 || source.sourceManifestSha256!==row.source_manifest_sha256) throw new Error("SOURCE_HASH_MISMATCH");
        const file=source.files.find(f=>f.path===path);
        if(!file) throw new Error("SOURCE_PATH_NOT_ALLOWED");
        const bytes=validateSourceFiles(files).decodedFiles[path];
        const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
        if(text.includes("\0")) throw new Error("SOURCE_NOT_TEXT");
        const lines=text.split(/\r\n|\n|\r/);
        if(startLine>lines.length) throw new Error("SOURCE_LINE_OUT_OF_RANGE");
        const selected=lines.slice(startLine-1,startLine-1+lineCount);
        const excerpt={path,fileSha256:file.sha256,startLine,endLine:startLine+selected.length-1,totalLines:lines.length,text:selected.join("\n"),truncated:false};
        // Bound the actual excerpt evidence, not merely its UI representation. Whole lines are preferred.
        while(Buffer.byteLength(canonicalJson(excerpt))>8000 && selected.length>1) {
          selected.pop();excerpt.text=selected.join("\n");excerpt.endLine=startLine+selected.length-1;excerpt.truncated=true;
        }
        while(Buffer.byteLength(canonicalJson(excerpt))>8000) {
          excerpt.text=excerpt.text.slice(0,Math.max(0,excerpt.text.length-256));excerpt.truncated=true;
        }
        const manifestId=randomUUID(),evidenceId=randomUUID(),payload=Buffer.from(canonicalJson(excerpt));
        const ctx=context.baseManifest.context;
        const item:Evidence={evidenceId,manifestId,runId:ctx.runId,submissionId:ctx.submissionId,originalZipSha256:ctx.originalZipSha256,
          sourceManifestSha256:ctx.sourceManifestSha256,executionAttemptId:ctx.executionAttemptId,analysisAttemptId:input.analysisAttemptId,operationId:input.operationId,
          scope:"run",criterionId:null,caseId:null,phase:"source_excerpt",collector:"business_extractor",contentOrigin:"student_source",ruleHash:ctx.ruleHash,
          packManifestHash:ctx.packManifestHash,sha256:await sha256(payload),byteSize:payload.length,mediaType:"application/json",
          storageKey:`runs/${ctx.runId}/${manifestId}/${evidenceId}.json`,capturedAt:new Date().toISOString()};
        manifest=await createArtifactManifest({manifestId,context:ctx,source:"supplemental",analysisAttemptId:input.analysisAttemptId,
          operationId:input.operationId,evidence:[item],completeness:excerpt.truncated ? "partial":"complete"});
        await input.artifacts.storeManifest(manifest,[{evidenceId,encoding:"base64",data:payload.toString("base64")}]);
        data={...excerpt,evidenceRef:ref(item),usage:"源码可支持原因分析，不能证明页面已执行或功能通过。"};
        break;
      }
      case "read_console_evidence": {
        const item=indexed(call.args.evidenceId);
        if(item.mediaType==="image/png" || !(item.contentOrigin==="student_console" || item.phase==="build")) throw new Error("NOT_CONSOLE_EVIDENCE");
        data={evidenceRef:ref(item),contentOrigin:item.contentOrigin,text:new TextDecoder().decode(await input.artifacts.readEvidence(item))};
        break;
      }
      case "inspect_page_evidence": {
        if(call.args.caseId) allowedCase(call.args.caseId);
        const items=call.args.evidenceId ? [indexed(call.args.evidenceId)]:evidence.filter(e=>e.caseId===call.args.caseId);
        const pages=items.filter(e=>e.contentOrigin==="rendered_page" || e.contentOrigin==="checker_observation");
        if(!pages.length) throw new Error("PAGE_EVIDENCE_NOT_AVAILABLE");
        const observations=[];
        for(const item of pages) {
          if(item.mediaType==="image/png") observations.push({evidenceRef:ref(item),kind:"screenshot_index",pixelsRead:false});
          else observations.push({evidenceRef:ref(item),kind:"text_observation",text:new TextDecoder().decode(await input.artifacts.readEvidence(item))});
        }
        data={pixelsRead:false,observations};break;
      }
      case "compare_submission": {
        if(call.args.caseId) allowedCase(call.args.caseId);
        const comparison=await getRunComparisonV2(input.db,{runId:row.run_id,actorId:row.teacher_id});
        data={...comparison,caseDiffs:comparison.caseDiffs.filter(c=>!call.args.caseId || c.caseId===call.args.caseId)};
        break;
      }
    }
  } catch(error) {
    const code=error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "TOOL_READ_FAILED";
    const result=boundedAnalysisToolResultV2(call.name,{error:code});
    await finishAnalysisOperationV2({...input,state:"failed",errorCode:code,response:canonicalJson(result)});
    return result;
  }
  const result=boundedAnalysisToolResultV2(call.name,data);
  await finishAnalysisOperationV2({...input,state:"completed",response:canonicalJson(result),supplementalManifest:manifest});
  return result;
}
