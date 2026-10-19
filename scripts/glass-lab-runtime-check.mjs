import { chromium } from '@playwright/test';
import { mkdirSync,writeFileSync } from 'node:fs';
const out='output/glass-lab/runtime';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome'});
try {
const context=await browser.newContext({viewport:{width:1440,height:900}});
await context.addInitScript(()=>{
  const original=HTMLCanvasElement.prototype.getContext;
  window.__contexts=[];
  HTMLCanvasElement.prototype.getContext=function(type,...args){const r=original.call(this,type,...args);if(r&&/webgl/.test(type))window.__contexts.push(type);return r;};
});
const page=await context.newPage(),base='http://localhost:5345';const errors=[],warnings=[],cycles=[],themes=[],preferences=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='warning'&&/webgl|context|gpu/i.test(m.text()))warnings.push(m.text());});
await page.goto(base+'/');await page.locator('#login-title').waitFor();
const perf=await page.evaluate(async()=>{
  const durations=[],long=[];const observer=new PerformanceObserver(list=>long.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask',buffered:false});
  await new Promise(resolve=>{let last=performance.now(),start=last;function frame(now){durations.push(now-last);last=now;if(now-start<10000)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});observer.disconnect();
  durations.sort((a,b)=>a-b);return{frames:durations.length,fps:durations.length/10,p95FrameMs:durations[Math.floor(durations.length*.95)],longTasks:long,contexts:window.__contexts,canvas:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height,hidden:c.getAttribute('aria-hidden')}))};
});
await page.getByRole('button',{name:'学生',exact:true}).click();
const studentPreview=await page.evaluate(()=>({role:document.body.dataset.role,accent:getComputedStyle(document.body).getPropertyValue('--accent'),roleRGB:getComputedStyle(document.body).getPropertyValue('--gl-role-rgb')}));
await page.getByLabel('邮箱',{exact:true}).fill('teacher@codelab.local');await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
const loginRequest=page.waitForRequest(r=>r.method()==='POST'&&r.url().includes('/login'));await page.getByRole('button',{name:'登录',exact:true}).click();const loginBody=(await loginRequest).postDataJSON();await page.locator('.workspace').waitFor();
await page.goto(base+'/settings');await page.locator('.gl-theme-list').waitFor();
for(const [id,name] of [['bronze','石墨·铜金'],['celadon','墨色·青瓷'],['ochre','炭灰·赭石'],['rose','烟墨·灰玫']]){
  await page.getByRole('radio',{name,exact:true}).click();await page.waitForTimeout(900);await page.reload();await page.locator('.gl-theme-list').waitFor();
  themes.push(await page.evaluate(()=>({theme:document.documentElement.dataset.theme,saved:localStorage.getItem('codelab-theme'),role:document.body.dataset.role,accent:getComputedStyle(document.body).getPropertyValue('--accent')})));
}
await page.getByRole('radio',{name:'石墨·铜金',exact:true}).click();await page.waitForTimeout(900);
for(let i=0;i<10;i++){
  await page.waitForTimeout(6500);
  await page.goto(base+'/welcome');await page.locator('.hero-copy h1').waitFor();await page.getByRole('link',{name:'进入工作台',exact:true}).click();await page.locator('.workspace').waitFor();await page.waitForTimeout(900);
  cycles.push(await page.evaluate(()=>({canvas:document.querySelectorAll('canvas').length,webglCalls:window.__contexts.length})));await page.goBack();await page.locator('.hero-copy h1').waitFor();
  await page.getByRole('link',{name:'进入工作台',exact:true}).click();await page.locator('.workspace').waitFor();
  await page.getByRole('button',{name:'退出登录',exact:true}).filter({visible:true}).click();await page.locator('#login-title').waitFor();
  cycles.push(await page.evaluate(()=>({canvas:document.querySelectorAll('canvas').length,webglCalls:window.__contexts.length})));
  await page.getByRole('link',{name:'了解 CodeLab →',exact:true}).click();await page.locator('.hero-copy h1').waitFor();
  await page.getByRole('link',{name:'进入工作台',exact:true}).click();await page.locator('#login-title').waitFor();
  await page.getByLabel('邮箱',{exact:true}).fill('teacher@codelab.local');await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.workspace').waitFor();
}
for(const mode of ['reduce','contrast','forced']){
  await page.emulateMedia({reducedMotion:mode==='reduce'?'reduce':'no-preference',contrast:mode==='contrast'?'more':'no-preference',forcedColors:mode==='forced'?'active':'none'});
  await page.goto(base+'/settings');await page.locator('.gl-theme-list').waitFor();
  preferences.push({mode,...await page.getByRole('button',{name:'模型设置',exact:true}).evaluate(e=>({outline:getComputedStyle(e).outlineStyle,transition:getComputedStyle(e).transitionDuration,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}))});await page.screenshot({path:`${out}/${mode}.png`});
}
await page.emulateMedia({reducedMotion:'reduce',contrast:'no-preference',forcedColors:'none'});await page.goto(base+'/welcome');await page.locator('.hero-copy h1').waitFor();
const reduced=await page.evaluate(()=>({animations:document.getAnimations().filter(a=>a.playState==='running').length,hidden:[...document.querySelectorAll('.gl-reveal')].filter(e=>getComputedStyle(e).opacity==='0').length}));
await page.screenshot({path:`${out}/welcome-reduced.png`});
const result={perf,studentPreview,loginKeys:Object.keys(loginBody),themes,cycles,preferences,reduced,errors,warnings};writeFileSync(`${out}/results.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally { await browser.close(); }
