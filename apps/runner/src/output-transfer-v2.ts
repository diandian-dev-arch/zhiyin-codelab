import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { validateRelativePath } from '@codelab/contracts/v2';
import { dockerCommand } from './environment-v2.js';

/** Only this bounded trusted transfer writes child output into the durable volume. */
export async function transferOutput(id:string,directory:string,mode:'build'|'check'|'probe',timeout:number) {
  const limits=mode==='build'?{bytes:32*1024*1024,count:256}:mode==='check'?{bytes:16*1024*1024,count:64}:{bytes:11*1024*1024,count:11};
  let output;
  try { output=await dockerCommand(['start','--attach',id],timeout,Math.ceil(limits.bytes*4/3)+1024*1024); }
  catch(error) {
    if((error as {killed?:boolean}).killed)throw new Error('OUTPUT_TIME_BUDGET');
    throw error;
  }
  const value=z.object({version:z.literal(1),code:z.number().int().min(0).max(255),log:z.string().max(180000),
    files:z.array(z.object({path:z.string().max(512),data:z.string()}).strict()).max(limits.count),error:z.string().max(80).optional()}).strict().parse(JSON.parse(output.stdout));
  const seen=new Set<string>();let total=0;
  const decoded=value.files.map(file=>{
    validateRelativePath(file.path);
    if(seen.has(file.path) || (mode!=='build' && file.path.includes('/')))throw new Error('OUTPUT_PATH_INVALID');
    seen.add(file.path);
    const bytes=Buffer.from(file.data,'base64');
    if(bytes.toString('base64')!==file.data || (total+=bytes.length)>limits.bytes)throw new Error('OUTPUT_BYTES_INVALID');
    if(mode==='probe') {
      if(!/^(probe-result\.json|probe-[AB]-[0-9]\.png)$/.test(file.path)) throw new Error('OUTPUT_PATH_INVALID');
      if(bytes.length>(file.path.endsWith('.png')?1024*1024:65536)) throw new Error('OUTPUT_BYTES_INVALID');
    }
    return {path:file.path,bytes};
  });
  if(value.code===0 && !value.error)for(const file of decoded){
    const target=path.join(directory,file.path);
    await mkdir(path.dirname(target),{recursive:true,mode:0o755});
    await writeFile(target,file.bytes,{flag:'wx',mode:0o444});
  }
  return {code:value.code,log:value.log,error:value.error};
}
