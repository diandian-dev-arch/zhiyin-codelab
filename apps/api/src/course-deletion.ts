import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson,artifactManifestSchema,hashArtifactManifest,publicationSnapshotSchema,hashPublicationSnapshot,type Evidence} from '@codelab/contracts/v2';
import type {DB} from './db.js';
import {withFrozenCourseHistory} from './course-retention-scope.js';
import {assertCourseAuthorization} from './course-retention-authorization.js';
const uuid=z.string().uuid();
const schema=z.object({taskId:uuid,studentId:uuid,authorizationId:uuid,requestId:uuid,
 fingerprint:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal('DELETE_EXACT_COURSE_HISTORY')}).strict();

/** Internal operator service, no HTTP/automatic caller. Does not remove files in this transaction.
 * Local DB owners are trusted. The caller must have reviewed external references and policy.
 */
export async function executeCourseDeletion(db:DB,raw:unknown){
 const input=schema.parse(raw),requestHash=createHash('sha256').update(canonicalJson(input)).digest('hex');
 const replay=async()=>{
  const row=(await db.query('SELECT id,deletion_request_hash FROM course_evidence_cleanup_batches WHERE deletion_request_id=$1',[input.requestId])).rows[0];
  if(!row)return;
  if(row.deletion_request_hash!==requestHash)throw new Error('RETENTION_DELETE_REQUEST_CONFLICT');
  return {batchId:row.id as string,databaseDeleted:true as const,filesCleanup:'pending_or_recorded' as const,replayed:true};
 };
 const previous=await replay();if(previous)return previous;
 try{return await withFrozenCourseHistory(db,{taskId:input.taskId,studentId:input.studentId},async(tx,snapshot)=>{
  await assertCourseAuthorization(tx,snapshot,input.authorizationId);
  const submissions=(await tx.query('SELECT id FROM submissions WHERE task_id=$1 AND user_id=$2 ORDER BY id',[input.taskId,input.studentId])).rows.map(r=>r.id as string);
  const runs=(await tx.query('SELECT id FROM runs WHERE submission_id=ANY($1::uuid[]) ORDER BY id',[submissions])).rows.map(r=>r.id as string);
  const evidence=new Map<string,Evidence>();
  const register=(e:Evidence)=>{
   if(!runs.includes(e.runId)||!submissions.includes(e.submissionId))throw new Error('RETENTION_DELETE_EVIDENCE_OWNER_MISMATCH');
   const ext=e.mediaType==='image/png'?'png':e.mediaType==='application/json'?'json':'txt';
   if(e.storageKey!==`runs/${e.runId}/${e.manifestId}/${e.evidenceId}.${ext}`)throw new Error('RETENTION_DELETE_EVIDENCE_PATH_INVALID');
   const old=evidence.get(e.storageKey);
   if(old&&canonicalJson(old)!==canonicalJson(e))throw new Error('RETENTION_DELETE_EVIDENCE_CONFLICT');
   evidence.set(e.storageKey,e);
   if(evidence.size>10000)throw new Error('RETENTION_DELETE_EVIDENCE_LIMIT');
  };
  const manifests=(await tx.query(`SELECT run_id,base_manifest AS value,id AS execution_id,NULL::uuid AS analysis_id,NULL::uuid AS operation_id FROM execution_attempts WHERE run_id=ANY($1::uuid[]) AND base_manifest IS NOT NULL
   UNION ALL SELECT a.run_id,o.supplemental_manifest,NULL::uuid,a.id,o.operation_id FROM analysis_operations o JOIN analysis_attempts a ON a.id=o.analysis_attempt_id
   WHERE a.run_id=ANY($1::uuid[]) AND o.supplemental_manifest IS NOT NULL`,[runs])).rows;
  for(const row of manifests){
   const m=artifactManifestSchema.parse(row.value);
   if(m.context.runId!==row.run_id||!submissions.includes(m.context.submissionId)||await hashArtifactManifest(m)!==m.contentHash||
     (row.execution_id&&(m.source!=='base'||m.context.executionAttemptId!==row.execution_id))||
     (row.analysis_id&&(m.source!=='supplemental'||m.analysisAttemptId!==row.analysis_id||m.operationId!==row.operation_id)))
    throw new Error('RETENTION_DELETE_MANIFEST_INVALID');
   m.evidence.forEach(register);
  }
  const publications=(await tx.query('SELECT run_id,revision_id,snapshot FROM publications WHERE run_id=ANY($1::uuid[])',[runs])).rows;
  for(const row of publications){
   const p=publicationSnapshotSchema.parse(row.snapshot);
   if(p.baseContext.runId!==row.run_id||p.revision.revisionId!==row.revision_id||await hashPublicationSnapshot(p)!==p.contentHash)
    throw new Error('RETENTION_DELETE_PUBLICATION_INVALID');
   p.publicEvidence.forEach(register);
  }
  // Conservatively detect arbitrary JSON references from other retained course rows.
  // Bound the scan and refuse instead of guessing which outside references are harmless.
  const identities=new Set([...runs,...submissions,...[...evidence.values()].flatMap(e=>[e.manifestId,e.evidenceId])]);
  let outsideRows=0,outsideBytes=0;
  const scanTables=[...['runs','execution_attempts','analysis_attempts','publications','report_revisions','events','reports','revisions','retention_holds'].map(table=>({table,
    where:table==='runs'?'NOT(id=ANY($1::uuid[]))':'NOT(run_id=ANY($1::uuid[]))'})),
    ...['analysis_operations','analysis_private_io','analysis_checkpoints','analysis_checkpoint_writes'].map(table=>({table,
      where:'analysis_attempt_id IN (SELECT id FROM analysis_attempts WHERE NOT(run_id=ANY($1::uuid[])))'}))];
  for(const {table,where} of scanTables){
   const size=(await tx.query(`SELECT count(*)::int AS rows,COALESCE(sum(octet_length(to_jsonb(t)::text)),0)::text AS bytes FROM ${table} t WHERE ${where}`,[runs])).rows[0];
   outsideRows+=size.rows;outsideBytes+=Number(size.bytes);
   if(outsideRows>10000||!Number.isSafeInteger(outsideBytes)||outsideBytes>64*1024*1024)throw new Error('RETENTION_DELETE_REFERENCE_SCAN_LIMIT');
   const outside=(await tx.query(`SELECT to_jsonb(t)::text AS value FROM ${table} t WHERE ${where}`,[runs])).rows;
   if(outside.some(r=>(r.value.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi)??[])
     .some((id:string)=>identities.has(id.toLowerCase()))))throw new Error('RETENTION_DELETE_OUTSIDE_REFERENCE');
  }
  await assertCourseAuthorization(tx,snapshot,input.authorizationId);
  const batchId=randomUUID();
  await tx.query(`INSERT INTO course_evidence_cleanup_batches(id,authorization_id,run_ids,submission_ids,deletion_request_id,deletion_request_hash,deletion_transaction)
   VALUES($1,$2,$3,$4,$5,$6,txid_current())`,[batchId,input.authorizationId,runs,submissions,input.requestId,requestHash]);
  for(const e of evidence.values())await tx.query('INSERT INTO course_evidence_cleanup_files(batch_id,storage_key,evidence) VALUES($1,$2,$3)',[batchId,e.storageKey,JSON.stringify(e)]);
  await tx.exec('SET CONSTRAINTS runs_accepted_attempt_same_run,report_revision_origin_same_run DEFERRED');
  for(const table of ['analysis_private_io','analysis_checkpoint_writes','analysis_checkpoints','analysis_operations'])
   await tx.query(`DELETE FROM ${table} WHERE analysis_attempt_id IN (SELECT id FROM analysis_attempts WHERE run_id=ANY($1::uuid[]))`,[runs]);
  await tx.query('DELETE FROM retention_hold_releases WHERE hold_id IN (SELECT id FROM retention_holds WHERE run_id=ANY($1::uuid[]))',[runs]);
  for(const table of ['retention_holds','analysis_attempts','publications','report_revisions','events','execution_attempts'])
   await tx.query(`DELETE FROM ${table} WHERE run_id=ANY($1::uuid[])`,[runs]);
  await tx.query('DELETE FROM runs WHERE id=ANY($1::uuid[])',[runs]);
  await tx.query('DELETE FROM submissions WHERE id=ANY($1::uuid[])',[submissions]);
  await tx.exec('SET CONSTRAINTS runs_accepted_attempt_same_run,report_revision_origin_same_run IMMEDIATE');
  return {batchId,databaseDeleted:true as const,filesCleanup:'pending_or_recorded' as const,replayed:false};
 },input.fingerprint);}catch(error){
  // A concurrent identical request can finish before this caller acquires the scope lock.
  const completed=await replay();if(completed)return completed;
  throw error;
 }
}
