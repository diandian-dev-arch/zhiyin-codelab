import {z} from 'zod';
import type {DB} from './db.js';
import type {ArtifactStore} from './artifacts-v2.js';
import {planCourseRetention} from './course-retention-plan.js';
import {withFrozenCourseHistory} from './course-retention-scope.js';
import {recordCourseAuthorization,revokeCourseAuthorization} from './course-retention-authorization.js';
import {executeCourseDeletion} from './course-deletion.js';
import {cleanNextCourseEvidence} from './course-evidence-cleanup.js';

export const courseRetentionActions=['plan','freeze','authorize','revoke','delete','status','cleanup'] as const;
export type CourseRetentionAction=typeof courseRetentionActions[number];
const batchSchema=z.object({batchId:z.string().uuid()}).strict();

/** Explicit local operator commands only; never migrates or derives authorization. */
export async function runCourseRetentionCommand(db:DB,action:CourseRetentionAction,input:unknown,
  store?:Pick<ArtifactStore,'removeVerifiedEvidence'>):Promise<unknown>{
  if(!courseRetentionActions.includes(action))throw new Error('RETENTION_ARGUMENTS_INVALID');
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=17')).rows.length)
    throw new Error('RETENTION_MIGRATION_REQUIRED');
  if(action==='plan')return planCourseRetention(db,input);
  if(action==='freeze')return withFrozenCourseHistory(db,input,async(_tx,s)=>s);
  if(action==='authorize')return recordCourseAuthorization(db,input);
  if(action==='revoke')return revokeCourseAuthorization(db,input);
  if(action==='delete')return executeCourseDeletion(db,input);
  if(action==='cleanup'){
    const {batchId}=batchSchema.extend({confirm:z.literal('CLEAN_COMMITTED_COURSE_EVIDENCE')}).strict().parse(input);
    if(!store)throw new Error('RETENTION_STORAGE_REQUIRED');
    // Exactly one item per explicit call, no unbounded automatic retry.
    return {batchId,...await cleanNextCourseEvidence(db,store,batchId)};
  }
  const {batchId}=batchSchema.parse(input);
  return db.transaction(async tx=>{
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY; SET LOCAL statement_timeout='10s'");
    const batch=(await tx.query(`SELECT id,authorization_id,created_at,deletion_request_id,
      cardinality(run_ids) AS runs,cardinality(submission_ids) AS submissions
      FROM course_evidence_cleanup_batches WHERE id=$1`,[batchId])).rows[0];
    if(!batch)throw new Error('RETENTION_CLEANUP_BATCH_NOT_FOUND');
    const files=(await tx.query(`SELECT state,count(*)::int AS files,sum(attempts)::int AS attempts
      FROM course_evidence_cleanup_files WHERE batch_id=$1 GROUP BY state ORDER BY state`,[batchId])).rows;
    return {batch,files,complete:files.every(f=>f.state!=='pending')};
  });
}
