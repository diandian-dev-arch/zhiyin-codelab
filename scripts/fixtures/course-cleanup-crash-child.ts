// Test-only child: configuration arrives over IPC, never command-line credentials.
import {postgres} from '../../apps/api/src/db.js';
import {ArtifactStore} from '../../apps/api/src/artifacts-v2.js';
import {cleanNextCourseEvidence} from '../../apps/api/src/course-evidence-cleanup.js';
process.once('message',async(message:unknown)=>{
  const input=message as {url:string;root:string;batchId:string;point:'before-unlink'|'after-unlink'};
  const url=new URL(input.url);
  if(!process.send||url.hostname!=='127.0.0.1'||url.pathname!=='/source_fixture')process.exit(2);
  const db=postgres(input.url),store=new ArtifactStore({root:input.root});
  try{
    await cleanNextCourseEvidence(db,{removeVerifiedEvidence:async evidence=>{
      if(input.point==='after-unlink')await store.removeVerifiedEvidence(evidence);
      process.send!({checkpoint:input.point});
      // Keep the transaction and process alive until the parent forcibly terminates it.
      await new Promise<void>(()=>{});
      throw new Error('UNREACHABLE');
    }},input.batchId);
    process.exitCode=3;
  }catch{process.send?.({failed:true});process.exitCode=4;}
  finally{await db.close();process.disconnect?.();}
});
