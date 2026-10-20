(()=>{
 const styles=document.createElement('link');styles.rel='stylesheet';styles.href='extras.css';document.head.append(styles);
 const icon=document.createElement('link');icon.rel='icon';icon.href='data:,';document.head.append(icon);
 document.querySelector('.wordmark').href='index.html#cover';document.querySelector('.back').href='overview.html';document.querySelector('.back').textContent='全稿总览 ↗';
 const frame=document.querySelector('#slide'),{slides}=window.deckManifest,key='codelab-complete-v1',reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')}catch{}
 const hashIndex=slides.findIndex(s=>s.id===location.hash.slice(1));
 let index=hashIndex>=0?hashIndex:Math.max(0,Math.min(slides.length-1,Number(saved.index)||0));
 let palette=['cobalt','ink','azure'].includes(saved.palette)?saved.palette:'cobalt',motion=!reduced.matches&&saved.motion!==false,ready=false,playing=false;
 const nav=document.querySelector('#nav'),focus=document.querySelector('#focus'),status=document.querySelector('#status');
 const description=document.createElement('p');description.id='focus-description';description.setAttribute('aria-live','polite');document.querySelector('.guide').after(description);
 const notes=document.createElement('details');notes.className='speaker-notes';notes.innerHTML='<summary>讲述提纲与来源</summary><p></p>';description.after(notes);
 const overview=document.createElement('a');overview.href='overview.html';overview.textContent='全稿总览 ↗';overview.className='overview-link';document.querySelector('.settings').prepend(overview);
 slides.forEach((s,i)=>{const b=document.createElement('button');b.textContent=String(i+1).padStart(2,'0')+' '+s.label;b.dataset.index=i;b.onclick=()=>go(i);nav.append(b)});
 function send(action,extra={}){if(ready)frame.contentWindow.postMessage({channel:'codelab-complete',action,...extra},'*')}
 function save(){try{localStorage.setItem(key,JSON.stringify({index,palette,motion}));history.replaceState(null,'','#'+slides[index].id)}catch{}}
 function setupFocus(){focus.replaceChildren();[['全貌',''],...slides[index].focus].forEach((item,i)=>{const b=document.createElement('button');b.textContent=item[0];b.dataset.focus=i-1;b.setAttribute('aria-pressed',String(i===0));b.onclick=()=>send('focus',{index:i-1});focus.append(b)})}
 function go(i){index=Math.max(0,Math.min(slides.length-1,i));ready=false;frame.src='slides/'+slides[index].id+'.html';frame.title='知因 CodeLab · '+slides[index].label;document.querySelectorAll('#nav button').forEach((b,j)=>b.setAttribute('aria-pressed',String(j===index)));document.querySelector('#count').textContent=String(index+1).padStart(2,'0')+' / '+slides.length;document.querySelector('#prev').disabled=index===0;document.querySelector('#next').disabled=index===slides.length-1;setupFocus();description.textContent='';notes.querySelector('p').textContent=slides[index].notes;notes.open=false;save()}
 function configure(replay=false){document.querySelector('#palette').value=palette;document.querySelector('#motion').textContent='动效 '+(motion?'开':'关');document.querySelector('#motion').setAttribute('aria-pressed',String(motion));send('configure',{palette,motion,replay});save()}
 function next(delta){const n=Math.max(0,Math.min(slides.length-1,index+delta));if(n!==index)go(n)}
 window.addEventListener('message',e=>{
  if(e.source!==frame.contentWindow||e.data?.channel!=='codelab-complete')return;const d=e.data;
  if(d.type==='ready'){ready=true;configure(true);if(motion&&!reduced.matches)frame.animate([{opacity:.78,transform:'translateX(12px)'},{opacity:1,transform:'translateX(0)'}],{duration:420,easing:'cubic-bezier(.16,1,.3,1)'})}
  if(d.type==='state'){playing=d.playing;document.querySelector('#play').textContent=playing?'暂停':'播放';document.querySelector('#play').setAttribute('aria-label',playing?'暂停入场动效':'播放入场动效');document.querySelector('#play').disabled=!d.enabled;document.querySelector('#replay').disabled=!d.enabled;document.querySelector('#timeline').value=d.time;document.querySelector('#timeline').disabled=!d.enabled;document.querySelector('#time').textContent=(d.time/1000).toFixed(1)+' / 2.6s';document.querySelectorAll('#focus button').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.focus)===d.selected)));description.textContent=d.description}
  if(d.type==='navigate')next(d.delta);if(d.type==='fullscreen')document.querySelector('#fullscreen').click();if(d.type==='escape'&&document.fullscreenElement)document.exitFullscreen();
 });
 document.querySelector('#prev').onclick=()=>next(-1);document.querySelector('#next').onclick=()=>next(1);
 document.querySelector('#palette').onchange=e=>{palette=e.target.value;configure()};document.querySelector('#motion').onclick=()=>{motion=!motion;configure(motion)};document.querySelector('#play').onclick=()=>send('toggle');document.querySelector('#replay').onclick=()=>send('replay');document.querySelector('#timeline').oninput=e=>send('seek',{time:Number(e.target.value)});
 document.querySelector('#fullscreen').onclick=async()=>{try{await document.querySelector('#player').requestFullscreen()}catch{status.textContent='浏览器未进入全屏，可用浏览器全屏快捷键继续查看。'}};document.querySelector('#exit-fullscreen').onclick=()=>document.exitFullscreen();
 document.addEventListener('keydown',e=>{if(e.altKey||e.ctrlKey||e.metaKey||['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(['ArrowRight','ArrowLeft','PageDown','PageUp'].includes(e.key)){e.preventDefault();next(['ArrowRight','PageDown'].includes(e.key)?1:-1)}else if(e.code==='Space'&&e.target.tagName!=='BUTTON'){e.preventDefault();send('toggle')}else if(e.key.toLowerCase()==='r')send('replay');else if(e.key.toLowerCase()==='f')document.querySelector('#fullscreen').click();});
 reduced.addEventListener('change',e=>{if(e.matches){motion=false;configure()}});addEventListener('hashchange',()=>{const i=slides.findIndex(s=>s.id===location.hash.slice(1));if(i>=0&&i!==index)go(i)});
 go(index);window.__ready=true;
})();
