import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@codelab/contracts/v2';
import type { DB } from './db.js';
import { withFrozenCourseHistory, type FrozenCourseHistory } from './course-retention-scope.js';

const uuid=z.string().uuid(), text=z.string().trim().min(3).max(300);
const authorizeSchema=z.object({taskId:uuid,studentId:uuid,requestId:uuid,
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),reason:text,
  policyReference:text,authorizationReference:text,externalReferencesReviewed:z.literal(true),
  ttlSeconds:z.number().int().min(1).max(86400),
  confirm:z.literal('AUTHORIZE_EXACT_COURSE_HISTORY'),
}).strict();
const revokeSchema=z.object({authorizationId:uuid,requestId:uuid,reason:text}).strict();
const hash=(input:unknown)=>createHash('sha256').update(canonicalJson(input)).digest('hex');
// Acquired AFTER course table locks when both are needed. Revocation takes only this lock.
async function lock(tx:DB){
  await tx.exec("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
  await tx.query('SELECT pg_advisory_xact_lock($1)',[41725]);
}
async function state(tx:DB,id:string){
  const row=(await tx.query(`SELECT a.id,a.task_id,a.student_id,a.fingerprint,a.expires_at,
    clock_timestamp() >= a.expires_at AS expired,
    EXISTS(SELECT 1 FROM course_retention_revocations r WHERE r.authorization_id=a.id) AS revoked
    FROM course_retention_authorizations a WHERE a.id=$1`,[id])).rows[0];
  if(!row)throw new Error('RETENTION_AUTHORIZATION_NOT_FOUND');
  return row;
}
function receipt(row:any,replayed:boolean){
  return {authorizationId:row.id as string,expiresAt:row.expires_at,
    status:row.revoked?'revoked':row.expired?'expired':'recorded',replayed,
    deletionAuthorized:false as const,deletionExecutorAvailable:false as const};
}
function checkImpact(snapshot:FrozenCourseHistory){
  const outstanding=snapshot.impact.blockers.filter(b=>!['COURSE_RETENTION_POLICY_REQUIRED',
    'EXTERNAL_REFERENCES_REVIEW_REQUIRED','COURSE_DELETE_EXECUTOR_NOT_IMPLEMENTED'].includes(b));
  if(outstanding.length)throw new Error(`RETENTION_AUTHORIZATION_BLOCKED_${outstanding.join('_')}`);
}

/** Records a local operator's assertion, not verified teacher identity or legal policy validity.
 * No route/automatic registration/deletion. Requires a fresh exact frozen preview fingerprint.
 */
export async function recordCourseAuthorization(db:DB,raw:unknown){
  const input=authorizeSchema.parse(raw),requestHash=hash(input);
  return withFrozenCourseHistory(db,{taskId:input.taskId,studentId:input.studentId},async(tx,snapshot)=>{
    await lock(tx);
    const existing=(await tx.query('SELECT id,request_hash FROM course_retention_authorizations WHERE request_id=$1',[input.requestId])).rows[0];
    if(existing){
      if(existing.request_hash!==requestHash)throw new Error('RETENTION_AUTHORIZATION_REQUEST_CONFLICT');
      return receipt(await state(tx,existing.id),true);
    }
    checkImpact(snapshot);
    const id=randomUUID();
    await tx.query(`INSERT INTO course_retention_authorizations
      (id,request_id,request_hash,task_id,student_id,fingerprint,reason,policy_reference,
       authorization_reference,external_references_reviewed,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,true,stamp,stamp+($10::int * interval '1 second')
      FROM (SELECT clock_timestamp() AS stamp) t`,[id,input.requestId,requestHash,input.taskId,
      input.studentId,input.fingerprint,input.reason,input.policyReference,input.authorizationReference,input.ttlSeconds]);
    return receipt(await state(tx,id),false);
  },input.fingerprint);
}

/** Revocation remains available while course work is active. Repeating it cannot renew authorization. */
export async function revokeCourseAuthorization(db:DB,raw:unknown){
  const input=revokeSchema.parse(raw),requestHash=hash(input);
  return db.transaction(async tx=>{
    await lock(tx);
    const existing=(await tx.query('SELECT id,request_hash FROM course_retention_revocations WHERE request_id=$1',[input.requestId])).rows[0];
    if(existing){
      if(existing.request_hash!==requestHash)throw new Error('RETENTION_AUTHORIZATION_REQUEST_CONFLICT');
      return {eventId:existing.id,replayed:true};
    }
    const current=await state(tx,input.authorizationId);
    if(current.revoked)throw new Error('RETENTION_AUTHORIZATION_ALREADY_REVOKED');
    const id=randomUUID();
    await tx.query('INSERT INTO course_retention_revocations(id,authorization_id,request_id,request_hash,reason) VALUES($1,$2,$3,$4,$5)',
      [id,input.authorizationId,input.requestId,requestHash,input.reason]);
    return {eventId:id,replayed:false};
  });
}

/** Internal future-executor guard: call INSIDE withFrozenCourseHistory with its tx/snapshot.
 * Holds the ledger lock until the enclosing transaction completes. Passing this guard does not
 * provide trigger bypass or filesystem cleanup; those protocols are still required.
 */
export async function assertCourseAuthorization(tx:DB,snapshot:FrozenCourseHistory,authorizationId:string){
  uuid.parse(authorizationId);
  await lock(tx);
  const row=await state(tx,authorizationId);
  if(row.revoked)throw new Error('RETENTION_AUTHORIZATION_REVOKED');
  if(row.expired)throw new Error('RETENTION_AUTHORIZATION_EXPIRED');
  if(row.task_id!==snapshot.target.taskId||row.student_id!==snapshot.target.studentId||row.fingerprint!==snapshot.fingerprint)
    throw new Error('RETENTION_AUTHORIZATION_SCOPE_CHANGED');
  checkImpact(snapshot);
}
