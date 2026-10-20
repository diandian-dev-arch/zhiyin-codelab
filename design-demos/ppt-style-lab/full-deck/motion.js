(()=>{
 const root=document.documentElement,config=window.slideConfig,reduced=matchMedia('(prefers-reduced-motion: reduce)'),duration=2600,animations=[];
 let time=0,playing=false,raf=0,last=null,enabled=!reduced.matches,selected=-1;
 const palettes={cobalt:['#2454db','#173b9f','#eef3fa','#e5edff'],ink:['#254779','#183354','#eff3f7','#e0e9f5'],azure:['#1268c5','#164c89','#edf5fb','#ddebff']};
 const send=(type,extra={})=>{if(parent!==window)parent.postMessage({channel:'codelab-complete',type,...extra},'*');};
 const state=()=>({time,playing,enabled,selected,duration,description:selected>=0?config.focus[selected][1]:''});
 const publish=()=>send('state',state());
 function fit(){root.style.setProperty('--scale',Math.min(innerWidth/1920,innerHeight/1080));}
 function render(t){time=Math.max(0,Math.min(duration,t));animations.forEach(a=>a.currentTime=time);}
 function pause(){playing=false;cancelAnimationFrame(raf);last=null;publish();}
 function tick(now){if(!playing)return;if(last!==null)render(time+Math.min(now-last,80));last=now;publish();if(time>=duration){pause();return;}raf=requestAnimationFrame(tick);}
 function play(){if(!enabled)return;if(time>=duration)render(0);cancelAnimationFrame(raf);playing=true;last=null;raf=requestAnimationFrame(tick);publish();}
 function seek(t){pause();render(t);publish();}
 function focus(i){selected=Number.isInteger(i)&&i>=0&&i<config.focus.length?i:-1;document.querySelectorAll('[data-focus]').forEach(el=>el.setAttribute('aria-pressed',String(Number(el.dataset.focus)===selected)));document.querySelectorAll('[data-step]').forEach(el=>{const step=Number(el.dataset.step);el.style.filter=selected>=0&&step>0&&step!==(selected===0?1:2)?'opacity(.32)':'none';});publish();}
 function replay(){pause();focus(-1);render(enabled?0:duration);if(enabled)play();}
 function configure(data){enabled=data.motion!==false&&!reduced.matches;root.dataset.motion=enabled?'on':'off';const colors=palettes[data.palette]||palettes.cobalt;['--blue','--deep','--ice','--tint'].forEach((k,i)=>root.style.setProperty(k,colors[i]));if(!enabled)seek(duration);if(data.replay)replay();publish();}
 window.addEventListener('message',e=>{if(e.source!==parent||e.data?.channel!=='codelab-complete')return;const d=e.data;if(d.action==='configure')configure(d);if(d.action==='seek')seek(d.time);if(d.action==='replay')replay();if(d.action==='toggle')playing?pause():play();if(d.action==='focus')focus(d.index);});
 document.querySelectorAll('[data-focus]').forEach(el=>el.onclick=()=>focus(selected===Number(el.dataset.focus)?-1:Number(el.dataset.focus)));
 const dialog=document.querySelector('dialog');if(dialog){let lastImage;document.querySelectorAll('.image-zoom').forEach(open=>open.onclick=()=>{pause();lastImage=open;dialog.querySelector('img').src=open.dataset.original||open.querySelector('img').src;dialog.showModal();});document.querySelector('#close-image').onclick=()=>dialog.close();dialog.addEventListener('close',()=>lastImage?.focus());}
 document.addEventListener('keydown',e=>{if(dialog?.open||e.altKey||e.ctrlKey||e.metaKey||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;if(['ArrowRight','ArrowLeft','PageDown','PageUp'].includes(e.key)){e.preventDefault();send('navigate',{delta:['ArrowRight','PageDown'].includes(e.key)?1:-1});}else if(e.code==='Space'&&e.target.tagName!=='BUTTON'){e.preventDefault();playing?pause():play();}else if(e.key.toLowerCase()==='r')replay();else if(e.key.toLowerCase()==='f')send('fullscreen');else if(e.key==='Escape'){focus(-1);send('escape');}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});reduced.addEventListener('change',e=>{if(e.matches)configure({motion:false});});addEventListener('resize',fit);fit();
 window.__seek=seek;window.__play=play;window.__state=state;
 Promise.all([document.fonts.ready,...[...document.images].map(img=>img.decode().catch(()=>{}))]).then(()=>{document.querySelectorAll('[data-enter]').forEach(el=>{const a=el.animate([{opacity:0,transform:'translateY(24px)'},{opacity:1,transform:'translateY(0)'}],{duration:780,delay:Number(el.dataset.enter),fill:'both',easing:'cubic-bezier(.16,1,.3,1)'});a.pause();animations.push(a);});document.querySelectorAll('[data-draw]').forEach(el=>{const a=el.animate([{clipPath:'inset(0 0 100% 0)'},{clipPath:'inset(0 0 0% 0)'}],{duration:1100,delay:420,fill:'both',easing:'cubic-bezier(.22,1,.36,1)'});a.pause();animations.push(a);});render(enabled?0:duration);window.__ready=true;send('ready');if(parent===window){enabled?play():seek(duration);}});
})();
