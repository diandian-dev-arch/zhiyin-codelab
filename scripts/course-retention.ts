import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import type {DB} from '../apps/api/src/db.js';
import {ArtifactStore} from '../apps/api/src/artifacts-v2.js';
import {root} from '../apps/api/src/template.js';
import {connectDesktopDatabase} from './desktop-database.js';
import {courseRetentionActions,runCourseRetentionCommand,type CourseRetentionAction} from '../apps/api/src/course-retention-command.js';
let db:DB|undefined;
try{
  const [flag,action,request,...extra]=process.argv.slice(2);
  if(flag!=='--desktop'||!courseRetentionActions.includes(action as CourseRetentionAction)||!request||extra.length)
    throw new Error('RETENTION_ARGUMENTS_INVALID');
  const file=path.resolve(request),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16384)throw new Error('RETENTION_REQUEST_FILE_INVALID');
  const input=JSON.parse(await readFile(file,'utf8'));
  db=await connectDesktopDatabase();
  const store=action==='cleanup'?new ArtifactStore({root:path.join(root,'.data/business-v2/evidence-v2')}):undefined;
  console.log(JSON.stringify(await runCourseRetentionCommand(db,action as CourseRetentionAction,input,store)));
}catch(error){
  console.error(error instanceof Error&&/^RETENTION_[A-Z_]+$/.test(error.message)?error.message:'RETENTION_COURSE_COMMAND_FAILED');
  process.exitCode=1;
}finally{await db?.close();}
