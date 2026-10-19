import { z } from 'zod';
import { evidenceSchema } from '@codelab/contracts/v2';
import type { DB } from './db.js';
import type { ArtifactStore } from './artifacts-v2.js';

/** Internal consumer only. A producer must atomically persist this batch and its exact
 * evidence inventory with authorized course DB deletion. No producer is currently exposed.
 * Expiry/revocation applies before DB deletion; this consumer completes already committed
 * cleanup, so it must not abandon orphaned files when that earlier authorization expires.
 */
export async function cleanNextCourseEvidence(db:DB,store:Pick<ArtifactStore,'removeVerifiedEvidence'>,batchId:string){
  z.string().uuid().parse(batchId);
  return db.transaction(async tx=>{
    await tx.exec("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
    // Same order as course maintenance: protect run identities before taking batch locks.
    // Filesystem work is bounded to one evidence object per transaction (contract size limit).
    await tx.exec('LOCK TABLE submissions,runs IN SHARE ROW EXCLUSIVE MODE');
    const batch=(await tx.query('SELECT * FROM course_evidence_cleanup_batches WHERE id=$1 FOR UPDATE',[batchId])).rows[0];
    if(!batch)throw new Error('RETENTION_CLEANUP_BATCH_NOT_FOUND');
    if((await tx.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM runs WHERE id=ANY($1::uuid[]))
      OR EXISTS(SELECT 1 FROM submissions WHERE id=ANY($2::uuid[]))`,[batch.run_ids,batch.submission_ids])).rows.length)
      throw new Error('RETENTION_CLEANUP_DATABASE_NOT_DELETED');
    const file=(await tx.query(`SELECT storage_key,evidence FROM course_evidence_cleanup_files
      WHERE batch_id=$1 AND state='pending' ORDER BY attempts,storage_key COLLATE "C" LIMIT 1 FOR UPDATE`,[batchId])).rows[0];
    if(!file)return {state:'complete' as const};
    const parsed=evidenceSchema.safeParse(file.evidence);
    let outcome:'removed'|'already_missing'|undefined,errorCode:string|undefined;
    if(!parsed.success||parsed.data.storageKey!==file.storage_key||!batch.run_ids.includes(parsed.data.runId)||
      !batch.submission_ids.includes(parsed.data.submissionId))errorCode='RETENTION_CLEANUP_INVALID_EVIDENCE';
    else{
      try {outcome=await store.removeVerifiedEvidence(parsed.data);}
      catch(error){
        const message=error instanceof Error?error.message:'';
        // Never persist arbitrary filesystem error strings, paths, or source contents.
        errorCode=/^(UNSAFE_ARTIFACT_[A-Z_]+|ARTIFACT_[A-Z_]+|INVALID_ARTIFACT_KEY)$/.test(message)?message:'RETENTION_CLEANUP_STORAGE_FAILED';
      }
    }
    await tx.query(`UPDATE course_evidence_cleanup_files SET attempts=attempts+1,state=$3,last_error=$4,
      finished_at=CASE WHEN $3='pending' THEN NULL ELSE clock_timestamp() END WHERE batch_id=$1 AND storage_key=$2`,
      [batchId,file.storage_key,outcome??'pending',errorCode??null]);
    return outcome?{state:'processed' as const,outcome}:{state:'blocked' as const,errorCode};
  });
}
