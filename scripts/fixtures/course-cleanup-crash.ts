import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export async function killCleanupAt(url:string,root:string,batchId:string,point:'before-unlink'|'after-unlink'){
  const child=fork(fileURLToPath(new URL('./course-cleanup-crash-child.ts',import.meta.url)),[],{
    execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,
  });
  let exited=false;
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    await new Promise<void>((resolve,reject)=>{
      timeout=setTimeout(()=>reject(new Error('CLEANUP_CHILD_CHECKPOINT_TIMEOUT')),15000);
      child.once('error',()=>reject(new Error('CLEANUP_CHILD_START_FAILED')));
      child.once('exit',()=>reject(new Error('CLEANUP_CHILD_EXITED_BEFORE_CHECKPOINT')));
      child.once('message',message=>{
        if((message as any).checkpoint===point)resolve();else reject(new Error('CLEANUP_CHILD_CHECKPOINT_FAILED'));
      });
      child.send({url,root,batchId,point});
    });
    clearTimeout(timeout);
    assert(child.kill('SIGKILL'),'CLEANUP_CHILD_KILL_FAILED');
    const termination=await exit;
    assert(termination.signal==='SIGKILL'||(process.platform==='win32'&&termination.code!==0));
    return {point,terminated:true,platform:process.platform,...termination};
  }finally{
    clearTimeout(timeout);
    if(!exited){child.kill('SIGKILL');await exit;}
  }
}
