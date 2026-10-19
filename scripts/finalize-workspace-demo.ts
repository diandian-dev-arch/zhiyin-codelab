// Local, offline replay of the recorded teacher/student workflow. No application or model API.
// Design: a shared chronological chapter rail beside the evidence frame, instead of
// separate card galleries. Ink #22374a, teal #147d83, mist #f3f5f4, white #fff,
// rule #dbe3ea, amber #986326. Chinese display/body: Microsoft YaHei/system-ui;
// timecodes: Consolas. The rail records actual events, not decorative step numbers.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root } from '../apps/api/src/template.js';

const id = process.argv[2];
assert(id && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(id), 'INVALID_RECORDING_ID');
const directory = path.join(root, 'output/workspace-verification', id);
const state = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
assert.equal(state.state, 'passed');
assert.equal(state.recorded, true);
assert.equal(state.modelAnalysisAttempts, 0);
type Chapter = {start:number;end:number;caption:string};
type Clip = {role:'teacher'|'student';filename:string;bytes:number;sha256:string;chapters:Chapter[]};
const clips: Clip[] = state.videos;
assert.deepEqual(clips.map(c=>c.role).sort(), ['student','teacher']);
for (const clip of clips) {
  assert.equal(clip.filename, `${clip.role}.webm`);
  const bytes = await readFile(path.join(directory,clip.filename));
  assert.equal(bytes.length,clip.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),clip.sha256);
  assert(clip.chapters.length > 0);
  for (const c of clip.chapters) assert(Number.isFinite(c.start) && c.start >= 0 && c.end > c.start && typeof c.caption === 'string');
}
const data=JSON.stringify(clips).replace(/</g,'\\u003c');
const recordingNote=state.reviewOnly?'本段为只读结果导览：回看同一任务已经完成的七次真实检查，不创建新检查、不修改反馈、不调用模型。实际执行与中断记录另行保留。':state.resumedTaskId
  ? '本段为接续录像：前三次检查回看已有结果，后四次现场执行。首轮因工作台原生进程退出而中断；恢复后未重跑前三次检查，原中断录像另存。'
  : '本段记录新任务的七次实际执行。';
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>知因 CodeLab · 修复与回归的完整实录</title>
<style>
:root{color-scheme:light;--ink:#22374a;--teal:#147d83;--mist:#f3f5f4;--rule:#dbe3ea;--amber:#986326;font-family:system-ui,"Microsoft YaHei",sans-serif;background:var(--mist);color:var(--ink)}
*{box-sizing:border-box}body{margin:0}main{max-width:1640px;margin:auto;padding:32px}header{display:flex;gap:24px;align-items:end;justify-content:space-between;margin-bottom:24px}
h1{font-family:"Microsoft YaHei",system-ui,sans-serif;font-size:clamp(25px,3vw,38px);line-height:1.3;letter-spacing:-.045em;margin:8px 0 12px}p{font-size:14px;line-height:1.7;margin:0}.brand{color:var(--teal);font-weight:650}.tag{border-left:3px solid var(--teal);padding:8px 14px;max-width:330px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:24px}video{display:block;width:100%;max-height:74vh;background:var(--ink);border-radius:12px}video::cue{font-family:system-ui;font-size:19px;color:white;background:#22374aeb}
.bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:12px}.roles{display:flex;gap:8px}button{font:inherit;color:inherit;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid var(--amber);outline-offset:3px}.roles button{background:white;border:1px solid var(--rule);padding:10px 18px;border-radius:7px}.roles button[aria-pressed=true]{background:var(--ink);color:white;border-color:var(--ink)}
.caption{font-size:16px;font-weight:600;min-height:64px;padding:16px 2px}.help{font-size:12px;color:#576b77}.timeline{background:white;border:1px solid var(--rule);border-radius:12px;padding:18px;max-height:86vh;overflow:auto}h2{font-size:17px;margin:0 0 8px}.timeline p{font-size:12px;margin-bottom:16px}.chapters{display:grid;gap:0}.chapters button{position:relative;background:none;border:0;border-left:2px solid var(--rule);text-align:left;padding:12px 10px 14px 18px;line-height:1.5;font-size:13px}.chapters button::before{content:"";position:absolute;width:8px;height:8px;border-radius:50%;background:var(--rule);left:-5px;top:18px}.chapters button:hover,.chapters button[aria-current=true]{background:var(--mist);color:var(--teal)}.chapters button[aria-current=true]::before{background:var(--teal)}time{font-family:Consolas,monospace;font-size:11px}.chapters small{display:block;color:#576b77;margin-bottom:4px}
.notes{border-top:1px solid var(--rule);padding-top:18px;margin-top:24px;max-width:1000px}.notes p{font-size:13px;margin-bottom:8px}a{color:var(--teal)}
@media(max-width:1000px){main{padding:18px}.layout{grid-template-columns:1fr}.timeline{max-height:none}header{align-items:start;flex-direction:column}.tag{max-width:none}.bar{align-items:start;flex-direction:column}video{max-height:none}}
</style><main><header><div><p class="brand">知因 CodeLab / 真实流程回放</p><h1>修好了这一处，<br>其他地方还好吗？</h1><p>从首次发布到复提回归、再次修复和构建失败。保留真实执行与等待过程。</p></div><p class="tag">团队构造样本 · 开发账号操作<br>不调用模型 · 无配音 · 非独立教师评测</p></header>
<div class="layout"><section><div class="bar"><div class="roles" role="group" aria-label="录像视角"></div><span class="help">切换视角会保留播放时间</span></div><video controls playsinline preload="auto" aria-label="完整流程录像"></video><p class="caption" aria-live="polite"></p><p class="help">等待期间可点击右侧章节，跳转到实际结果出现的时刻。</p></section><aside class="timeline"><h2>本轮实际发生的步骤</h2><p>点击章节，自动切换到对应角色视角。</p><nav class="chapters" aria-label="流程章节"></nav></aside></div>
<div class="notes"><p>${recordingNote}</p><p>共7次真实Docker检查。教师逐项确认后才发布，学生读取的是发布版本。对比展示新增与筛选修复、保存回归；规则版本改变时拒绝混用变化标签；构建失败保留未完成检查。原始录像未加速，两个视角包含停留在旧页面的等待。</p><p>课程基础检查和普通ZIP静态AI分析为两个入口。本录像关闭AI，不证明模型质量或真实教师节时。登录在录制前完成，密钥和密码不入镜。源码与报告来自团队登记样本。</p><p><a href="result.json">录制与运行记录</a> · <a href="playback-verification.json">播放核验</a></p></div></main>
<script>
const clips=${data};const video=document.querySelector('video'),caption=document.querySelector('.caption'),rail=document.querySelector('.chapters'),roles=document.querySelector('.roles');
const chapters=clips.flatMap((clip,index)=>clip.chapters.map(c=>({...c,index,role:clip.role}))).sort((a,b)=>a.start-b.start);
const track=video.addTextTrack('captions','中文字幕','zh');track.mode='showing';let current=-1,pending=null;
const roleName=role=>role==='teacher'?'教师':'学生';const timecode=t=>Math.floor(t/60).toString().padStart(2,'0')+':'+Math.floor(t%60).toString().padStart(2,'0');
function choose(index,time=0,play=false){pending={time,play};if(index===current){apply();return;}current=index;video.pause();video.src=clips[index].filename;for(const c of Array.from(track.cues||[]))track.removeCue(c);for(const c of clips[index].chapters)track.addCue(new VTTCue(c.start,c.end,c.caption));Array.from(roles.children).forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));caption.textContent=roleName(clips[index].role)+'视角 · 真实流程录像';video.load();}
function apply(){if(!pending||!Number.isFinite(video.duration))return;const p=pending;pending=null;video.currentTime=Math.min(p.time,Math.max(0,video.duration-.3));if(p.play)video.play().catch(()=>{caption.textContent='点击视频播放按钮继续。'});}
video.addEventListener('loadedmetadata',apply);video.addEventListener('error',()=>{caption.textContent='录像加载失败，请保持HTML与两份webm文件在同一文件夹。';});
clips.forEach((clip,index)=>{const b=document.createElement('button');b.textContent=roleName(clip.role)+'视角';b.onclick=()=>choose(index,video.currentTime||0,!video.paused);roles.append(b);});
chapters.forEach((c,i)=>{const b=document.createElement('button'),meta=document.createElement('small'),t=document.createElement('time');t.textContent=timecode(c.start);meta.append(t,' · '+roleName(c.role));b.append(meta,c.caption);b.onclick=()=>choose(c.index,c.start+.15,true);rail.append(b);});
video.addEventListener('timeupdate',()=>{const c=chapters.find(c=>c.index===current&&video.currentTime>=c.start&&video.currentTime<c.end);caption.textContent=c?c.caption:roleName(clips[current].role)+'视角 · 真实执行与等待';Array.from(rail.children).forEach((b,i)=>b.setAttribute('aria-current',String(chapters[i]===c)));});choose(0,clips[0].chapters[0].start+.15);
</script></html>`;
await writeFile(path.join(directory,'index.html'),html);
const allowed=new Set(['index.html','result.json','playback-verification.json',...clips.map(c=>c.filename)]);
const server=createServer(async(req,res)=>{
  try {
    const name=decodeURIComponent(new URL(req.url??'/','http://localhost').pathname.slice(1))||'index.html';
    if(!allowed.has(name)){res.writeHead(404).end();return;}
    const body=await readFile(path.join(directory,name));
    const type=name.endsWith('.webm')?'video/webm':name.endsWith('.json')?'application/json':'text/html; charset=utf-8';
    const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if(range){const start=Number(range[1]),end=Math.min(range[2]?Number(range[2]):body.length-1,body.length-1);
      if(start>end){res.writeHead(416,{'Content-Range':`bytes */${body.length}`}).end();return;}
      res.writeHead(206,{'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${body.length}`}).end(body.subarray(start,end+1));
    }else res.writeHead(200,{'Content-Type':type,'Content-Length':body.length,'Accept-Ranges':'bytes'}).end(body);
  }catch{res.writeHead(500).end();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert(address&&typeof address!=='string');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const checks:unknown[]=[];
try{
  await page.goto(`http://127.0.0.1:${address.port}/`);
  for(let i=0;i<clips.length;i++){
    await page.getByRole('group',{name:'录像视角'}).getByRole('button').nth(i).click();
    await page.waitForFunction(()=>{const v=document.querySelector('video')!;return v.readyState>=2&&v.videoWidth>0;});
    const metadata=await page.locator('video').evaluate((v:HTMLVideoElement)=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight,cues:v.textTracks[0].cues?.length}));
    assert.equal(metadata.width,1440);assert.equal(metadata.height,1000);assert.equal(metadata.cues,clips[i].chapters.length);
    assert(Number.isFinite(metadata.duration)&&metadata.duration>0);
    assert(clips[i].chapters.every(c=>c.end<=metadata.duration+1),'CHAPTER_OUTSIDE_VIDEO');
    for(const fraction of [.12,.5,.9]){
      const time=metadata.duration*fraction;
      await page.locator('video').evaluate(async(v:HTMLVideoElement,t)=>{v.muted=true;await v.play();v.currentTime=t;},time);
      await page.waitForFunction(t=>{const v=document.querySelector('video')!;return !v.seeking&&v.readyState>=3&&v.currentTime>=t+.1;},time);
      await page.locator('video').evaluate(async(v:HTMLVideoElement)=>{await new Promise(r=>v.requestVideoFrameCallback(r));v.pause();});
      await page.locator('video').screenshot({path:path.join(directory,`playback-${clips[i].role}-${fraction}.png`)});
    }
    checks.push({role:clips[i].role,sha256:clips[i].sha256,metadata,seekChecks:3});
  }
  // Verify every chapter changes to the correct video and presents a decoded frame.
  const chapters=clips.flatMap((clip,index)=>clip.chapters.map(c=>({...c,index,role:clip.role}))).sort((a,b)=>a.start-b.start);
  for(let i=0;i<chapters.length;i++){
    const c=chapters[i];await page.getByRole('navigation',{name:'流程章节'}).getByRole('button').nth(i).click();
    await expect(page.locator('.caption')).toHaveText(c.caption);
    await page.waitForFunction(({start,filename})=>{const v=document.querySelector('video')!;return v.currentSrc.endsWith(filename)&&!v.seeking&&v.readyState>=3&&v.currentTime>=start;},{start:c.start,filename:clips[c.index].filename});
    await page.locator('video').evaluate(async(v:HTMLVideoElement)=>{await new Promise(r=>v.requestVideoFrameCallback(r));v.pause();});
    const playback=await page.locator('video').evaluate((v:HTMLVideoElement)=>({error:v.error?.code??null,frames:v.getVideoPlaybackQuality().totalVideoFrames}));
    assert.equal(playback.error,null);assert(playback.frames>0);
    if(/刷新保存出现回归|构建失败保留/.test(c.caption)) await page.screenshot({path:path.join(directory,`chapter-${i+1}.png`)});
  }
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(directory,'player-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  const verification={state:'passed',checkedAt:new Date().toISOString(),checks,chapterChecks:chapters.length,mobileWidth:390,pageErrors:errors,externalModelCalls:0,scope:'Actual Chrome decoding, presented frames, role and chapter navigation; no application API calls.'};
  await writeFile(path.join(directory,'playback-verification.json'),JSON.stringify(verification,null,2));
  console.log(JSON.stringify({directory,...verification}));
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
