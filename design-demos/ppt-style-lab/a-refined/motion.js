(() => {
  const root=document.documentElement, slide=document.querySelector('.slide');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const duration=2600, animations=[];
  let time=0, playing=false, frame=0, last=null, enabled=!reduced.matches, selected=-1;
  const isCover=slide.classList.contains('cover');
  const descriptions=isCover?['回到具体源码，查明结论从哪里来。','保留补查与读取过程，让调查可以回看。','对照证据审阅，需要时修订或撤回结论。']:['明确要回答的问题，并结合当前项目的上下文。','根据已有线索补查源码，将引用与结论关联。','对照依据核查结论，发现问题后修订或撤回。'];
  const defaultText=isCover?'源码、过程、反馈，连接成可核查的依据。':'结论连着依据，反馈经过审阅。';
  function fit(){root.style.setProperty('--scale',Math.min(innerWidth/1920,innerHeight/1080));}
  function send(type,extra={}){if(parent!==window)parent.postMessage({channel:'codelab-refined',type,...extra},'*');}
  function state(){send('state',{time,playing,enabled,selected,duration});}
  function render(t){time=Math.max(0,Math.min(duration,t));animations.forEach(a=>a.currentTime=time);}
  function pause(){playing=false;cancelAnimationFrame(frame);last=null;state();}
  function tick(now){if(!playing)return;if(last!==null)render(time+Math.min(now-last,80));last=now;state();if(time>=duration){pause();return;}frame=requestAnimationFrame(tick);}
  function play(){if(!enabled)return;if(time>=duration)render(0);cancelAnimationFrame(frame);playing=true;last=null;frame=requestAnimationFrame(tick);state();}
  function seek(t){pause();render(t);state();}
  function replay(){pause();render(enabled?0:duration);focus(-1);if(enabled)play();}
  function motion(on){enabled=!!on;root.dataset.motion=enabled?'on':'off';if(!enabled)seek(duration);state();}
  function focus(index){selected=Number.isInteger(index)&&index>=0&&index<3?index:-1;document.querySelectorAll('[data-focus]').forEach(el=>el.setAttribute('aria-pressed',String(Number(el.dataset.focus)===selected)));document.querySelector('#focus-description').textContent=selected<0?defaultText:descriptions[selected];const label=document.querySelector('#focus-label');if(label)label.textContent=selected<0?'能力关系示意':['提出问题','调查取证','核查结论'][selected];state();}
  const palettes={cobalt:['#2454db','#173b9f','#eef3fa','#e5edff'],ink:['#254779','#183354','#eff3f7','#e0e9f5'],azure:['#1268c5','#164c89','#edf5fb','#ddebff']};
  function palette(key){const colors=palettes[key]||palettes.cobalt;['--blue','--deep','--ice','--tint'].forEach((name,i)=>root.style.setProperty(name,colors[i]));}
  function handle(action,data={}){if(action==='replay')replay();if(action==='toggle')playing?pause():play();if(action==='seek')seek(data.time);if(action==='focus')focus(data.index);if(action==='configure'){palette(data.palette);motion(data.motion);if(data.replay)replay();}}
  window.addEventListener('message',event=>{if(event.source!==parent||event.data?.channel!=='codelab-refined')return;handle(event.data.action,event.data);});
  document.querySelectorAll('[data-focus]').forEach(el=>el.addEventListener('click',()=>focus(selected===Number(el.dataset.focus)?-1:Number(el.dataset.focus))));
  const dialog=document.querySelector('dialog');
  if(dialog){document.body.append(dialog);document.querySelector('#open-image').onclick=()=>{pause();dialog.showModal();};document.querySelector('#close-image').onclick=()=>dialog.close();dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});dialog.addEventListener('close',()=>document.querySelector('#open-image').focus());}
  document.addEventListener('keydown',e=>{if(dialog?.open)return;if(e.altKey||e.ctrlKey||e.metaKey)return;if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(['ArrowRight','ArrowLeft','PageDown','PageUp'].includes(e.key)){e.preventDefault();send('navigate',{delta:['ArrowRight','PageDown'].includes(e.key)?1:-1});}else if(e.code==='Space'&&e.target.tagName!=='BUTTON'){e.preventDefault();playing?pause():play();}else if(e.key.toLowerCase()==='r')replay();else if(e.key==='Escape'){focus(-1);send('escape');}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  reduced.addEventListener('change',e=>{if(e.matches)motion(false);});
  addEventListener('resize',fit);fit();
  window.__seek=seek;window.__play=play;window.__state=()=>({time,playing,enabled,selected});
  Promise.all([document.fonts.ready,...[...document.images].map(img=>img.decode().catch(()=>{}))]).then(()=>{
    document.querySelectorAll('[data-enter]').forEach(el=>{const a=el.animate([{opacity:0,transform:'translateY(24px)'},{opacity:1,transform:'translateY(0)'}],{duration:780,delay:Number(el.dataset.enter),fill:'both',easing:'cubic-bezier(.16,1,.3,1)'});a.pause();animations.push(a);});
    document.querySelectorAll('[data-draw]').forEach(el=>{const a=el.animate([{clipPath:'inset(0 0 100% 0)'},{clipPath:'inset(0 0 0% 0)'}],{duration:1100,delay:420,fill:'both',easing:'cubic-bezier(.22,1,.36,1)'});a.pause();animations.push(a);});
    document.querySelectorAll('.trace-line').forEach((el,i)=>{const a=el.animate([{transform:'scaleX(0)'},{transform:'scaleX(1)'}],{duration:850,delay:1000+i*220,fill:'both',easing:'cubic-bezier(.22,1,.36,1)'});a.pause();animations.push(a);});
    requestAnimationFrame(()=>{render(enabled?0:duration);window.__ready=true;send('ready');if(enabled)play();else state();});
  });
})();
