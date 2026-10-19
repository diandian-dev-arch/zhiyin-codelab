import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,writeFile,mkdir,lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { zipSync,unzipSync,strToU8 } from 'fflate';
import { redactSource,importSourceZip } from '../apps/api/src/source-zip.js';
import { root } from '../apps/api/src/template.js';
const source='C:/Users/Jie/Documents/博物馆';
const destination=path.join(root,'output/museum-source-analysis');
const {stdout}=await promisify(execFile)('git',['-C',source,'ls-files','--cached','--others','--exclude-standard','-z'],{maxBuffer:8*1024*1024,windowsHide:true});
const included:Record<string,Uint8Array>={},omitted:{path:string;reason:string}[]=[],redacted:string[]=[];
for(const relative of [...new Set(stdout.split('\0').filter(Boolean))].sort()){
 const parts=relative.split('/');
 const runtime=/^(frontend\/|backend\/|deploy\/|scripts\/|loadtest\/)/.test(relative)||/^(README\.md|PRODUCT\.md|Dockerfile|docker-compose\.yml|docker-entrypoint\.sh)$/.test(relative)||/^docs\/(?:0[1-9]-|1[0-9]-|decisions\/)/.test(relative);
 const extension=/\.(vue|svelte|[cm]?[jt]sx?|py|java|go|rs|c|cpp|h|cs|php|rb|swift|kt|sql|graphql|proto|html|css|scss|json|ya?ml|toml|xml|md|txt|sh|properties)$/i.test(relative)||/(^|\/)Dockerfile$/.test(relative);
 const secret=parts.some(p=>/^\.env(?:\.|$)|^\.npmrc$|^\.pypirc$|credential|secret|^id_rsa/i.test(p));
 if(!runtime||!extension||secret||parts.some(p=>/^(node_modules|target|dist|build|coverage|backups|uploads|test-results|playwright-report|artifacts)$/.test(p))||/(lock\.json|lock\.yaml|\.lock)$/.test(relative)){omitted.push({path:relative,reason:'非分析源码、敏感配置或生成产物'});continue;}
 const absolute=path.resolve(source,relative);if(!absolute.startsWith(path.resolve(source)+path.sep))throw new Error('SOURCE_PATH_ESCAPE');
 const stat=await lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink()){omitted.push({path:relative,reason:'不是普通文件'});continue;}
 if(stat.size>256*1024){omitted.push({path:relative,reason:'单文件大于256KiB'});continue;}
 const text=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(absolute));
 const clean=redactSource(text);if(clean!==text)redacted.push(relative);
 included['heluo-museum/'+relative]=strToU8(clean);
}
const bytes=zipSync(included,{level:6});const parsed=await importSourceZip(Buffer.from(bytes));
if(Object.keys(parsed.files).length!==Object.keys(included).length)throw new Error('PACKAGE_IMPORT_OMITTED_SOURCE');
if(Object.keys(unzipSync(bytes)).length!==Object.keys(included).length)throw new Error('ZIP_ROUNDTRIP_FAILED');
await mkdir(destination,{recursive:true});
const zipPath=path.join(destination,'河洛数字博物馆_源码分析.zip');await writeFile(zipPath,bytes);
const summary={source,zipPath,files:Object.keys(included).length,zipBytes:bytes.length,sourceBytes:Object.values(included).reduce((n,b)=>n+b.length,0),sha256:createHash('sha256').update(bytes).digest('hex'),redactedFiles:redacted,omittedFiles:omitted,scope:'Current working tree source and architecture documents. Not a deployable full archive. No original file changed.'};
await writeFile(path.join(destination,'package-manifest.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({zipPath,files:summary.files,zipBytes:bytes.length,sourceBytes:summary.sourceBytes,redactedFiles:redacted.length,omittedFiles:omitted.length,sha256:summary.sha256}));
