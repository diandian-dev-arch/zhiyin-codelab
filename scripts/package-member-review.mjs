// Local review artifact only. Never submits, sends, installs or starts services.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {zipSync,unzipSync} from 'fflate';

const root=process.cwd();
const sourceId='36c71293-fd44-4f49-8bdd-659b2aa3b9d4';
const prior='output/preliminary-review-2026-09-29-v2';
const destination='output/preliminary-review-2026-09-29-v3';
const source=`output/reproduction/${sourceId}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=relative=>readFile(path.join(root,relative));
const sourceZip=await read(`${source}/codelab-source.zip`);
const packaged=JSON.parse(await read(`${source}/result.json`));
const verified=JSON.parse(await read(`${source}/verification.json`));
assert.equal(hash(sourceZip),packaged.sha256);
assert.equal(verified.state,'passed');
assert.equal(verified.archiveSha256,packaged.sha256);
assert.equal(verified.fileCount,421);
const oldHash='425ff6236ddb7a4f8921b41f930fb5f085149549a5e6c2defbac48a8c0c20f24';
const files={};
for(const name of ['知因CodeLab_初赛介绍.pptx','知因CodeLab_初赛任务书.md'])files[name]=await read(`${prior}/${name}`);
let workbook=(await read(`${prior}/成员测试执行与回执.md`)).toString('utf8');
workbook=workbook.replaceAll('0137a22a',sourceId).replaceAll(oldHash,packaged.sha256)
  .replace('使用当前源码交接（原工作区记录，未随本包附带）中的','使用本审阅包随附的')
  .replace('该冻结包不含后来新增的本表，不必重打源码包。','本表在源码ZIP外，实际结果请填写在本表中。');
files['成员测试执行与回执.md']=Buffer.from(workbook);
files['prepare-member-source.ps1']=Buffer.from((await read(`${prior}/prepare-member-source.ps1`)).toString('utf8').replace(oldHash,packaged.sha256));
let introduction=(await read(`${prior}/先读说明.md`)).toString('utf8');
introduction=introduction.replace('0137a22a冻结源码，394文件',`${sourceId}冻结源码，421文件`);
introduction+='\n## V3当前版本与验证范围\n\n'+
  '本包替代V2供后续成员测试；V2和旧版补充说明只作历史追溯。新前端已接通真实业务，正式入口为本机启动后的 http://127.0.0.1:5174/projects 。账号以服务端身份为准。旧hash链接可兼容转换。\n\n'+
  '新源码同机新目录通过421文件哈希、安装、类型、构建、274项所选测试；另在该目录用Chrome验证登录/导航9项和ZIP分析1项。ZIP测试仅模型为合成替身，不证明真实模型质量。PPT和任务书保留编写时的历史计数，不作为成员本人测试结果。\n\n'+
  '当前工作区另有716项普通测试通过/32跳过及215项真实PostgreSQL专项通过；这些与解压目录测试有重叠，不相加。详细前端范围见[source/docs/engineering/FRONTEND-REPAIR-ACCEPTANCE.md](source/docs/engineering/FRONTEND-REPAIR-ACCEPTANCE.md)。\n\n'+
  '仍待真实参与者完成：成员异机回执、独立教学评阅、学校报名与匿名口径确认、成果授权。生产隔离、依赖许可全文和Word分页等未验项不因此关闭。本包没有发送给任何人或赛事。\n';
files['先读说明.md']=Buffer.from(introduction);
files['codelab-source.zip']=sourceZip;
const manifest={version:3,createdAt:new Date().toISOString(),sourceId,sourceSha256:packaged.sha256,
  publicationAuthorized:false,independentMemberVerified:false,
  files:Object.entries(files).map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:hash(bytes)}))};
files['manifest.json']=Buffer.from(JSON.stringify(manifest,null,2));
const archive=zipSync(files,{level:6});
const unpacked=unzipSync(archive);
assert.equal(Object.keys(unpacked).length,Object.keys(files).length);
for(const entry of manifest.files){assert.equal(unpacked[entry.path].length,entry.bytes);assert.equal(hash(unpacked[entry.path]),entry.sha256);}
await mkdir(path.join(root,destination));
for(const [name,bytes] of Object.entries(files))await writeFile(path.join(root,destination,name),bytes,{flag:'wx'});
const archivePath='output/知因CodeLab_初赛本地审阅包_V3_2026-09-29.zip';
await writeFile(path.join(root,archivePath),archive,{flag:'wx'});
console.log(JSON.stringify({archivePath,archiveBytes:archive.length,sha256:hash(archive),entries:Object.keys(files).length,sourceId,sourceSha256:packaged.sha256}));
