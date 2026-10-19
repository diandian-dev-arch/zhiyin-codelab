import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { realpathSync,mkdirSync,writeFileSync } from 'node:fs';
const a=createRequire(import.meta.url),b=createRequire(realpathSync(a.resolve('@playwright/test'))),c=createRequire(realpathSync(b.resolve('playwright'))),d=createRequire(realpathSync(c.resolve('playwright-core'))),{PNG}=d('./lib/utilsBundle.js');
const out='output/glass-lab/performance';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:false});
const results=[];
try {
const page=await browser.newPage({viewport:{width:1440,height:900}}),cdp=await page.context().newCDPSession(page);
for(const [name,path,ready] of [['login','/','#login-title'],['welcome','/welcome','.hero-copy h1']]){
  await page.goto('http://localhost:5345'+path);await page.locator(ready).waitFor();await page.waitForTimeout(2800);
  await cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing',transferMode:'ReturnAsStream'});
  const timing=await page.evaluate(async()=>{
    const frames=[],long=[];const observer=new PerformanceObserver(list=>long.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask'});
    await new Promise(resolve=>{let first=performance.now(),last=first;function frame(now){frames.push(now-last);last=now;if(now-first<10000)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});observer.disconnect();frames.sort((a,b)=>a-b);return{frames:frames.length,fps:frames.length/10,p95:frames[Math.floor(frames.length*.95)],longTasks:long};
  });
  const done=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await done;let trace='';for(;;){const r=await cdp.send('IO.read',{handle:stream});trace+=r.base64Encoded?Buffer.from(r.data,'base64').toString():r.data;if(r.eof)break;}await cdp.send('IO.close',{handle:stream});writeFileSync(`${out}/${name}-trace.json`,trace);
  const canvas=page.locator('canvas.gl-liquid');const before=await canvas.screenshot();await page.mouse.click(name==='login'?500:1100,320);await page.waitForTimeout(350);const after=await canvas.screenshot();
  const p=PNG.sync.read(before),q=PNG.sync.read(after);let min=255,max=0,changed=0;for(let i=0;i<p.data.length;i+=4){min=Math.min(min,p.data[i],p.data[i+1],p.data[i+2]);max=Math.max(max,p.data[i],p.data[i+1],p.data[i+2]);if(Math.abs(p.data[i]-q.data[i])+Math.abs(p.data[i+1]-q.data[i+1])+Math.abs(p.data[i+2]-q.data[i+2])>6)changed++;}
  writeFileSync(`${out}/${name}-water.png`,after);results.push({name,timing,pixels:{width:p.width,height:p.height,min,max,changed,total:p.width*p.height}});
}
writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
