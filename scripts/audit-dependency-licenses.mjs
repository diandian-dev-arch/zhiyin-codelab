import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { zipSync, unzipSync } from 'fflate';

// Collect actual package texts; a metadata license name is not a substitute for them.
// Does not install, update, execute package scripts or license the application.
// --fetch-missing allows public, version-pinned upstream reads only.
const root = process.cwd();
const arguments_ = process.argv.slice(2);
if (arguments_.length && arguments_.join(' ') !== '--fetch-missing') throw new Error('LICENSE_AUDIT_UNEXPECTED_ARGUMENT');
const fetchMissing = arguments_.includes('--fetch-missing');
// npm metadata for this release has no gitHead. The release tag was resolved
// read-only; validate the manifest at that immutable commit before collecting.
const pinnedReleaseOrigins = {
  'drizzle-orm@0.44.7': { repository:'drizzle-team/drizzle-orm', commit:'11ff664f7fd988e4663dfa2c2622f9b7f8fda8dc', manifestPath:'drizzle-orm/package.json', tag:'0.44.7' },
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inventory = JSON.parse(process.platform === 'win32'
  ? execFileSync('powershell.exe', ['-NoProfile','-Command','pnpm licenses list --json'], { encoding:'utf8', windowsHide:true, timeout:60000, maxBuffer:8*1024**2 })
  : execFileSync('pnpm', ['licenses','list','--json'], { encoding:'utf8', timeout:60000, maxBuffer:8*1024**2 }));
const moduleRoot = realpathSync(path.join(root,'node_modules'));
const entries = [], texts = {}, missingTexts = [], upstreamAttempts = [], supplementalNotices = [];
const licenseName = /^(?:licen[sc]e|notice|copying|copyright(?:notice)?)(?:$|[._-])|^third[-_]party[-_](?:notices|licenses)/i;
const inside = (base, file) => { const r=path.relative(base,file); return r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
function textFile(filename, base) {
  const real = realpathSync(filename);
  if (!inside(base,real) || !statSync(real).isFile()) throw new Error('LICENSE_FILE_OUTSIDE_PACKAGE');
  const bytes=readFileSync(real);
  if (bytes.length > 5*1024**2) throw new Error('LICENSE_TEXT_TOO_LARGE');
  const sha256=hash(bytes), destination=`texts/${sha256}.txt`;
  texts[destination]=new Uint8Array(bytes);
  return { path:path.relative(base,filename).replaceAll('\\','/'), archivePath:destination, bytes:bytes.length, sha256 };
}
for (const group of Object.values(inventory)) for (const pkg of group) for (const directory of pkg.paths) {
  const base=realpathSync(directory);
  if (!inside(moduleRoot,base)) throw new Error('LICENSE_PACKAGE_OUTSIDE_WORKSPACE');
  const manifestBytes=readFileSync(path.join(base,'package.json')), manifest=JSON.parse(manifestBytes);
  if (manifest.name !== pkg.name || !pkg.versions.includes(manifest.version)) throw new Error('LICENSE_PACKAGE_IDENTITY_MISMATCH');
  let visited=0;
  const files=[];
  const walk = directory => {
    for (const entry of readdirSync(directory,{withFileTypes:true})) {
      if (++visited > 30000) throw new Error('LICENSE_SCAN_LIMIT');
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const filename=path.join(directory,entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (licenseName.test(entry.name)) files.push(textFile(filename,base));
    }
  };
  walk(base);
  if (!files.length) for (const entry of readdirSync(base,{withFileTypes:true})) {
    if (!entry.isFile() || !/^readme(?:\.|$)/i.test(entry.name)) continue;
    const filename=path.join(base,entry.name);
    if (statSync(filename).size>1024**2) continue;
    const content=readFileSync(filename,'utf8');
    if (/permission is hereby granted/i.test(content) && /the software is provided.*as is/i.test(content)) {
      files.push({...textFile(filename,base),source:'license-embedded-in-readme'});
    }
  }
  files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const record={name:manifest.name,version:manifest.version,declaredLicense:manifest.license ?? manifest.licenses ?? null,
    pnpmLicense:pkg.license,packageJsonSha256:hash(manifestBytes),files};
  // A vendored file's BSD notice does not replace the package's declared MIT license.
  // Preserve this known inline notice separately, including exact installed source provenance.
  if (manifest.name === 'stackback' && manifest.version === '0.0.2') {
    const filename=realpathSync(path.join(base,'formatstack.js'));
    if (!inside(base,filename) || !statSync(filename).isFile()) throw new Error('INLINE_NOTICE_SOURCE_UNSAFE');
    const source=readFileSync(filename), content=source.toString('utf8');
    const header=content.match(/^(?:\/\/[^\r\n]*(?:\r?\n|$))+/)?.[0];
    if (!header?.startsWith('// Copyright 2012 the V8 project authors.')
      || !header.includes('Redistribution and use in source and binary forms')
      || !header.includes('OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.'))
      throw new Error('INLINE_NOTICE_INCOMPLETE');
    const bytes=Buffer.from(header),sha256=hash(bytes),archivePath=`texts/${sha256}.txt`;
    texts[archivePath]=new Uint8Array(bytes);
    supplementalNotices.push({name:manifest.name,version:manifest.version,path:'formatstack.js',
      source:'installed-source-inline-header',license:'BSD-3-Clause',scope:'V8-derived formatstack.js only',
      sourceFileSha256:hash(source),sha256,bytes:bytes.length,archivePath,
      resolvesPackageLicense:false});
  }
  entries.push(record);
}
entries.sort((a,b)=>`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`,'en'));
if (new Set(entries.map(e=>`${e.name}@${e.version}`)).size !== entries.length) throw new Error('LICENSE_DUPLICATE_PACKAGE');
// Optional public network read. Only use a package-version registry record with
// an exact gitHead or a separately validated immutable release commit; never
// substitute today's default-branch license text.
if (fetchMissing) for (const pkg of entries.filter(e=>!e.files.length)) {
  const attempt={name:pkg.name,version:pkg.version,state:'unresolved'};
  upstreamAttempts.push(attempt);
  try {
    const metadataUrl=`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`;
    const r=await fetch(metadataUrl,{signal:AbortSignal.timeout(12000)});
    if (!r.ok) continue;
    const metadata=await r.json();
    if (metadata.name!==pkg.name || metadata.version!==pkg.version || metadata.license!==pkg.declaredLicense) throw new Error('UPSTREAM_IDENTITY_MISMATCH');
    const repository=(typeof metadata.repository==='string'?metadata.repository:metadata.repository?.url)?.match(/^(?:git\+)?(?:https?|git):\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/)?.[1];
    let commit=metadata.gitHead, origin='registry-version-gitHead';
    const pinned=pinnedReleaseOrigins[`${pkg.name}@${pkg.version}`];
    if(!commit && pinned && repository===pinned.repository) {
      const manifestUrl=`https://raw.githubusercontent.com/${repository}/${pinned.commit}/${pinned.manifestPath}`;
      const response=await fetch(manifestUrl,{signal:AbortSignal.timeout(12000)});
      if(!response.ok) throw new Error('RELEASE_MANIFEST_UNAVAILABLE');
      const bytes=Buffer.from(await response.arrayBuffer()), manifest=JSON.parse(bytes);
      if(manifest.name!==pkg.name || manifest.version!==pkg.version || manifest.license!==pkg.declaredLicense) throw new Error('RELEASE_MANIFEST_MISMATCH');
      commit=pinned.commit; origin='validated-release-manifest-at-pinned-commit';
      Object.assign(attempt,{manifestUrl,manifestSha256:hash(bytes),tag:pinned.tag});
    }
    if (!repository || !/^[a-f0-9]{40}$/.test(commit??'')) {attempt.state='missing-immutable-version-origin';continue;}
    Object.assign(attempt,{metadataUrl,repository,commit,origin});
    const subdir=metadata.repository?.directory;
    const bases=typeof subdir==='string' && /^[a-zA-Z0-9_/-]+$/.test(subdir) && !subdir.includes('..') ? [subdir+'/',''] : [''];
    const candidates=bases.flatMap(base=>['LICENSE','LICENSE.md','LICENSE.txt','license','COPYING','README.md','Readme.md'].map(n=>base+n));
    for (const file of candidates) {
      const url=`https://raw.githubusercontent.com/${repository}/${commit}/${file}`;
      const response=await fetch(url,{signal:AbortSignal.timeout(12000)});
      if (!response.ok) continue;
      const bytes=Buffer.from(await response.arrayBuffer());
      if (bytes.length>1024**2 || bytes.length<50 || !/permission|redistribution|licensed|copyright/i.test(bytes.toString('utf8'))) continue;
      if (/readme/i.test(file) && !(/permission is hereby granted/i.test(bytes.toString('utf8')) && /the software is provided.*as is/i.test(bytes.toString('utf8')))) continue;
      const sha256=hash(bytes),archivePath=`texts/${sha256}.txt`;
      texts[archivePath]=new Uint8Array(bytes);
      pkg.files.push({path:`upstream/${file}`,archivePath,bytes:bytes.length,sha256,sourceUrl:url,metadataUrl,commit,source:origin,...(attempt.manifestUrl?{manifestUrl:attempt.manifestUrl,manifestSha256:attempt.manifestSha256,tag:attempt.tag}:{})});
      attempt.state='pinned-license-collected'; break;
    }
  } catch {attempt.state='lookup-failed';}
}
for(const pkg of entries) if(!pkg.files.length) missingTexts.push(`${pkg.name}@${pkg.version}`);
const lockBytes=readFileSync('pnpm-lock.yaml');
const templateBytes=readFileSync('templates/vue-board-v1/package-lock.json'), template=JSON.parse(templateBytes);
const templatePackages=Object.entries(template.packages).filter(([p])=>p).map(([p,m])=>({path:p,version:m.version,declaredLicense:m.license ?? null,optional:!!m.optional,os:m.os ?? null,cpu:m.cpu ?? null}));
const copiedSources = ['apps/web/THIRD_PARTY_NOTICES.md','deploy/executor/LICENSE.playwright'].map(file=>({source:file,...textFile(path.join(root,file),root)}));
const id=randomUUID();
const limitations=[
  'Installed Windows workspace packages only; unused platform-specific optional packages are not installed or examined.',
  'Template package-lock metadata is inventoried separately; template package license texts are not inferred from workspace versions.',
  'Base images, Chromium, OS libraries and bundled upstream transitive notices need review when redistributing binaries or images.',
  'Metadata and collected texts are evidence, not legal approval, vulnerability scanning or an application license.',
  'Package-root scans include named LICENSE/NOTICE/COPYING/COPYRIGHT files recursively, not every inline source header.'
];
const report={version:1,id,createdAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,
  scope:'installed-workspace-npm-packages',lockfileSha256:hash(lockBytes),packageInstances:entries.length,
  declaredLicenseCounts:entries.reduce((a,e)=>{const l=typeof e.declaredLicense==='string'?e.declaredLicense:JSON.stringify(e.declaredLicense);a[l]=(a[l]??0)+1;return a;},{}),
  missingTexts,upstreamAttempts,packages:entries,supplementalNotices,copiedSources,template:{scope:'lockfile-metadata-only',lockfileSha256:hash(templateBytes),packages:templatePackages},limitations};
const files={...texts,'inventory.json':Buffer.from(JSON.stringify(report,null,2))};
const index=['# CodeLab 第三方依赖许可材料','',
  `生成时间：${report.createdAt}。已安装工作区包实例：${entries.length}。缺少独立许可文本：${missingTexts.length}。`,
  '', '这是锁文件绑定的本机已安装包盘点，不代表应用或所有运行镜像已经获得分发授权。原始文本按SHA-256去重，逐包对应关系见inventory.json。', '',
  '| 包 | 版本 | 声明 | 实际文本 |','| --- | --- | --- | --- |',
  ...entries.map(e=>`| ${e.name} | ${e.version} | ${typeof e.declaredLicense==='string'?e.declaredLicense:JSON.stringify(e.declaredLicense)} | ${e.files.map(f=>`[${f.path}](${f.archivePath})`).join('、')||'待补'} |`),
  '', '## 源文件内嵌补充声明', '', '以下声明仅覆盖对应源文件，不解除所属包本身的许可全文缺口。', '',
  ...supplementalNotices.map(e=>`- ${e.name}@${e.version} [${e.path} / ${e.license}](${e.archivePath})；${e.scope}；原文件SHA-256 ${e.sourceFileSha256}。`),
  '', '## 已采用的源码/配置', '', ...copiedSources.map(s=>`- [${s.source}](${s.archivePath})`),
  '', '## 范围边界', '', ...limitations.map(l=>`- ${l}`),''].join('\n');
files['README.md']=Buffer.from(index);
const manifest=Object.entries(files).sort(([a],[b])=>a.localeCompare(b,'en')).map(([p,b])=>({path:p,bytes:b.length,sha256:hash(b)}));
files['MANIFEST.json']=Buffer.from(JSON.stringify({version:1,files:manifest},null,2));
const archive=zipSync(files,{level:6}), unpacked=unzipSync(archive);
for (const f of manifest) if (unpacked[f.path]?.length!==f.bytes || hash(unpacked[f.path])!==f.sha256) throw new Error('LICENSE_ARCHIVE_MISMATCH');
if (Object.keys(unpacked).length !== manifest.length+1) throw new Error('LICENSE_ARCHIVE_COUNT');
const directory=path.join(root,'output/licensing',id);
mkdirSync(directory,{recursive:true});
for (const [file,bytes] of Object.entries(files)) {const target=path.join(directory,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});}
writeFileSync(path.join(directory,'third-party-licenses.zip'),archive,{flag:'wx'});
const result={state:missingTexts.length?'needs-license-text-review':'collected-and-roundtrip-verified',packageInstances:entries.length,
  missingTexts,uniqueTextFiles:Object.keys(texts).length,templateLockedPackages:templatePackages.length,
  archiveBytes:archive.length,archiveSha256:hash(archive),lockfileSha256:hash(lockBytes),verifiedFiles:manifest.length,
  fullDistributionAuditComplete:false};
writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({...result,directory:path.relative(root,directory)}));
