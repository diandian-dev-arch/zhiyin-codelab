// Inventory existing local deliverables only; never uploads or grants publication permission.
import {readFile,readdir,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const root=process.cwd(),directory=path.join(root,'output/delivery-index',randomUUID());
const [sourceId,licenseId,...extra]=process.argv.slice(2);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if(extra.length||!uuid.test(sourceId??'')||!uuid.test(licenseId??''))
 throw new Error('Usage: tsx scripts/index-submission-delivery.ts <verified-source-uuid> <license-uuid>');
const source=`output/reproduction/${sourceId}`;
const license=`output/licensing/${licenseId}`;
const groups=[
 {name:'最新工程源码',scope:'engineering-reproduction',files:[`${source}/codelab-source.zip`,`${source}/result.json`,`${source}/verification.json`]},
 {name:'第三方许可附件',scope:'license-review-incomplete',files:[`${license}/third-party-licenses.zip`,`${license}/inventory.json`,`${license}/MANIFEST.json`,`${license}/README.md`,`${license}/result.json`]},
 {name:'产品陈述稿',scope:'museum-display-permission-required',files:['output/submission-deck/知因CodeLab_产品与工程验证_10页_V2.pptx']},
 {name:'源码分析回放',scope:'museum-display-permission-required',folder:'output/submission-demo/821b57dc-74fa-4bb1-97ca-ab948c9914e9'},
 {name:'课程回归结果导览',scope:'competition-attachment-review-required',folder:'output/workspace-verification/2026-09-28T17-36-40-006Z'},
 {name:'课程接续执行录像',scope:'competition-attachment-review-required',folder:'output/workspace-verification/2026-09-28T17-32-20-586Z'},
];
const entries:{group:string;scope:string;path:string;bytes:number;sha256:string}[]=[];
for(const group of groups){
 let files=group.files??[];
 if(group.folder){
  const stat=await lstat(path.join(root,group.folder));if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('DELIVERY_DIRECTORY_UNSAFE');
  // Keep the exact player assets together; do not recursively sweep output or private data.
  files=(await readdir(path.join(root,group.folder),{withFileTypes:true})).filter(e=>e.isFile()&&/\.(html|webm|vtt|json|png)$/.test(e.name)).map(e=>`${group.folder}/${e.name}`);
  if(!files.some(f=>f.endsWith('/index.html'))||!files.some(f=>f.endsWith('.webm')))throw new Error('DELIVERY_PLAYER_INCOMPLETE');
 }
 for(const file of files){
  const stat=await lstat(path.join(root,file));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('DELIVERY_FILE_UNSAFE');
  const bytes=await readFile(path.join(root,file));
  entries.push({group:group.name,scope:group.scope,path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
}
const packaged=JSON.parse(await readFile(path.join(root,source,'result.json'),'utf8'));
const verified=JSON.parse(await readFile(path.join(root,source,'verification.json'),'utf8'));
if(verified.state!=='passed'||verified.fileCount!==packaged.fileCount||verified.archiveSha256!==packaged.sha256||entries.find(e=>e.path===`${source}/codelab-source.zip`)?.sha256!==packaged.sha256)
 throw new Error('DELIVERY_SOURCE_VERIFICATION_MISMATCH');
const licenses=JSON.parse(await readFile(path.join(root,license,'inventory.json'),'utf8'));
const lockHash=createHash('sha256').update(await readFile(path.join(root,'pnpm-lock.yaml'))).digest('hex');
if(lockHash!==licenses.lockfileSha256)throw new Error('DELIVERY_LICENSE_LOCK_STALE');
const manifest={version:1,createdAt:new Date().toISOString(),scope:'local-review-index-only',publicationAuthorized:false,
 sourceFiles:packaged.fileCount,reproductionTests:verified.tests,unresolvedLicenses:licenses.missingTexts,
 limitations:['Not an official competition submission','Museum presentation permission remains unconfirmed','Same-host reproduction only','Index does not include private databases, credentials or original museum source','Historical demos retain their original UI and interruption boundaries'],files:entries};
await mkdir(directory,{recursive:true});
await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
const link=(file:string)=>path.relative(directory,path.join(root,file)).replaceAll('\\','/');
const lines=['# 知因 CodeLab 本地交付索引','',
 '此索引用于本地审阅与完整性核对，不是已批准的公开提交包。没有复制、上传或公开任何材料。','',
 `最新源码：${packaged.fileCount}文件；新目录专项${verified.tests.passed}/${verified.tests.total}通过。许可附件与当前锁文件一致，仍缺${licenses.missingTexts.length}项发布版许可全文。`,'',
 '包含博物馆源码画面的陈述稿和回放，公开展示许可尚未确认。课程回放保留历史中断/续录边界；赛事格式、署名、配音和独立评测仍待完成。','',
 '| 材料 | 使用边界 | 文件 | 字节 |','| --- | --- | --- | ---: |',
 ...entries.map(e=>`| ${e.group} | ${e.scope} | [${path.basename(e.path)}](${link(e.path)}) | ${e.bytes} |`),'',
 '每个文件的完整SHA-256见[manifest.json](manifest.json)。移动交付材料时保留播放器与同目录资源；此索引的相对链接依赖当前工作区目录结构。',''];
await writeFile(path.join(directory,'README.md'),lines.join('\n'),{flag:'wx'});
console.log(JSON.stringify({directory,fileCount:entries.length,sourceFiles:packaged.fileCount,unresolvedLicenses:licenses.missingTexts.length,publicationAuthorized:false}));
