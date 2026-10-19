import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DB } from '../apps/api/src/db.js';
import { root } from '../apps/api/src/template.js';
import { planCourseRetention } from '../apps/api/src/course-retention-plan.js';
import { connectDesktopDatabase } from './desktop-database.js';
let db: DB | undefined;
try {
  const [flag,taskId,studentId,...extra]=process.argv.slice(2);
  if(flag!=='--desktop'||!taskId||!studentId||extra.length)throw new Error('RETENTION_ARGUMENTS_INVALID');
  db=await connectDesktopDatabase();
  const plan=await planCourseRetention(db,{taskId,studentId});
  const directory=path.join(root,'.data/course-retention-plans',randomUUID());
  await mkdir(directory,{recursive:true,mode:0o700});
  const bytes=JSON.stringify(plan,null,2)+'\n';
  await writeFile(path.join(directory,'result.json'),bytes,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({deletionAuthorized:false,counts:plan.counts,blockers:plan.blockers,
    result:path.relative(root,path.join(directory,'result.json')).replaceAll('\\','/'),
    sha256:createHash('sha256').update(bytes).digest('hex')}));
} catch(error) {
  console.error(error instanceof Error&&/^RETENTION_[A-Z_]+$/.test(error.message)?error.message:'RETENTION_COURSE_PLAN_FAILED');
  process.exitCode=1;
} finally {await db?.close();}
