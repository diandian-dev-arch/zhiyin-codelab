<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ArrowRight, ShieldCheck, Files, MonitorCheck, KeyRound, Clock3, Code2, Check, AlertCircle } from 'lucide-vue-next';
import GlLiquid from '../components/glass/GlLiquid.vue';
import GlEvidenceCore from '../components/glass/GlEvidenceCore.vue';
import GlEvidenceTree from '../components/glass/GlEvidenceTree.vue';
import { prefersReducedMotion } from '../glass/theme';
const coreEl=ref<HTMLElement|null>(null),copyEl=ref<HTMLElement|null>(null),flowEl=ref<HTMLElement|null>(null);
const liquid=ref<InstanceType<typeof GlLiquid>|null>(null);
const flowProgress=ref(0),active=ref(0),percent=ref(0),reading=ref(0),hideNav=ref(false),currentSection=ref('hero');
const parallax=ref({x:0,y:0});
const cases=[
  {id:'E-01',name:'路由跳转',code:'expect(url).toBe("/list")',warn:false},
  {id:'E-02',name:'列表渲染',code:'v-for · :key 唯一',warn:false},
  {id:'E-03',name:'详情页参数',code:'useRoute().params.id',warn:false},
  {id:'E-04',name:'空列表状态',code:'screenshot · 1280×800',warn:true},
  {id:'E-05',name:'加载态提示',code:'aria-busy="true"',warn:false},
  {id:'E-06',name:'表单校验',code:'src/views/Form.vue:42',warn:false},
  {id:'E-07',name:'组件通信',code:"emit('update')",warn:false},
  {id:'E-08',name:'构建产物',code:'npm run build',warn:false},
];
const slots=ref([0,3,5]),selectedCase=ref(0);
const caseLabel=computed(()=>`case ${String(selectedCase.value+1).padStart(2,'0')}/08`);
let slot=0;
function onEmit(){liquid.value?.pulse();selectedCase.value=(selectedCase.value+1)%cases.length;slots.value[slot]=selectedCase.value;slot=(slot+1)%slots.value.length;}
const steps=[
  ['提交','Submit','学生上传 ZIP，或从片段、文件夹、Gitee、GitHub 固定一次课程成果快照。提交即留档，不依赖模型。'],
  ['执行','Execute','固定 Vue 模板在隔离环境里构建、启动，驱动真实浏览器，八个独立案例留下截图与日志。'],
  ['整理','Agent','受限 Agent 使用六种工具阅读证据，整理出可追溯到源码行的反馈候选。'],
  ['复核','Review','教师逐条采用、修改或驳回。模型只给候选，发布权始终在教师手里。'],
  ['复提','Compare','学生按反馈修改后再次提交，两次证据并排比较，看清修改带来的变化。'],
];
const hues=[1,5,2,4,1];
const features=[
  {icon:Files,title:'固定成果快照',text:'片段、文件、文件夹、ZIP、Gitee、GitHub，确认后成为不可变版本。',hue:2},
  {icon:MonitorCheck,title:'真实浏览器证据',text:'固定模板的受控执行留下截图与日志；源码解读则明确保持静态阅读边界。',hue:5},
  {icon:KeyRound,title:'个人模型，个人计费',text:'每个账号保存自己的 API Key，不回退共享密钥；不配置也能完成基础检查。',hue:4},
  {icon:Clock3,title:'任务化版本',text:'独立或连续任务、团队拆分，截止时间统一按北京时间解释。',hue:1},
];
let lastY=0,observer:IntersectionObserver|undefined;
function syncScroll(){const y=scrollY;if(y>lastY+2&&y>240)hideNav.value=true;else if(y<lastY-2||y<240)hideNav.value=false;lastY=y;reading.value=y/Math.max(1,document.documentElement.scrollHeight-innerHeight);const f=flowEl.value;if(f)flowProgress.value=Math.min(1,Math.max(0,-f.getBoundingClientRect().top/Math.max(1,f.offsetHeight-innerHeight)));}
function moveReport(event:PointerEvent){if(prefersReducedMotion()||event.pointerType!=='mouse')return;const r=(event.currentTarget as HTMLElement).getBoundingClientRect();parallax.value={x:(event.clientX-r.left)/r.width-.5,y:(event.clientY-r.top)/r.height-.5};}
onMounted(()=>{syncScroll();addEventListener('scroll',syncScroll,{passive:true});addEventListener('resize',syncScroll,{passive:true});observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting)currentSection.value=e.target.id;},{rootMargin:'-35% 0px -45% 0px'});for(const id of ['hero','flow','report','features','roles']){const e=document.getElementById(id);if(e)observer.observe(e);}});
onBeforeUnmount(()=>{removeEventListener('scroll',syncScroll);removeEventListener('resize',syncScroll);observer?.disconnect();});
</script>
<template>
<div class="landing-page">
  <header class="landing-nav gl-glass" :class="{'is-hidden':hideNav}">
    <a href="#hero" class="landing-brand"><span class="brand-mark" aria-hidden="true"></span><span>知因 <b>CodeLab</b></span></a>
    <nav aria-label="主导航"><a v-for="[id,label] in [['flow','工作方式'],['report','证据报告'],['features','能力'],['roles','师生']]" :key="id" :href="`#${id}`" :aria-current="currentSection===id?'location':undefined">{{label}}</a></nav>
    <RouterLink to="/" class="gl-btn gl-btn--primary">登录工作台 <ArrowRight :size="17" aria-hidden="true" /></RouterLink>
    <span class="reading-progress" :style="{transform:`scaleX(${reading})`}" aria-hidden="true"></span>
  </header>
  <main id="main-content" tabindex="-1">
    <section id="hero" class="hero">
      <GlLiquid ref="liquid" :anchor="coreEl" /><div class="hero-shade" aria-hidden="true"></div><GlEvidenceCore :anchor="coreEl" :avoid="copyEl" @emit="onEmit" />
      <div class="hero-inner"><div ref="copyEl" class="hero-copy">
        <p class="gl-eyebrow">Vue 实训 · 证据驱动验收平台</p><h1 v-gl-split="450">让每一次提交<br />都有<em>证据</em>可循</h1><p class="hero-en gl-serif">Evidence, not guesses.</p>
        <p class="hero-lede">教师定义检查要求，学生提交 ZIP；执行侧在隔离环境里构建、驱动真实浏览器并留下证据，Agent 整理成可追溯到源码行的反馈，教师逐条复核后发布，再看清下一次提交进步在哪里。</p>
        <div class="hero-actions"><RouterLink to="/" class="gl-btn gl-btn--primary gl-btn--lg">进入工作台 <ArrowRight :size="18" aria-hidden="true" /></RouterLink><a href="#flow" class="gl-btn gl-btn--ghost">看它如何工作</a></div>
        <ul class="hero-meta"><li><b>8</b><span>独立检查案例</span></li><li><b>5</b><span>项核心要求</span></li><li><b>0</b><span>条自动发布</span></li></ul>
      </div><div class="hero-visual" aria-label="检查核心与证据卡示意"><div ref="coreEl" class="core-anchor" aria-hidden="true"></div><p class="core-label gl-mono">示意 · {{caseLabel}}</p>
        <article v-for="(index,i) in slots" :key="i" class="ev-card gl-glass" :class="`ev-${i}`"><header><span class="gl-chip" :class="cases[index].warn?'gl-chip--warning':'gl-chip--success'">{{cases[index].warn?'需关注':'通过'}}</span><span class="gl-mono">{{cases[index].id}}</span></header><h3>{{cases[index].name}}</h3><code>{{cases[index].code}}</code></article>
      </div></div><a class="scroll-hint" href="#flow" aria-label="向下滚动"><span>SCROLL</span><ArrowRight :size="18" aria-hidden="true" /></a>
    </section>
    <section id="flow" ref="flowEl" class="flow"><div class="flow-sticky"><div class="flow-copy"><p class="gl-eyebrow">How it works</p><h2>一次提交，<br />长成一棵<span>证据树</span></h2><ol class="steps"><li v-for="(step,i) in steps" :key="i" :class="{on:active===i,done:active>i}" :style="{'--step':`var(--gl-c${hues[i]}-rgb)`}"><span class="step-number">{{String(i+1).padStart(2,'0')}}</span><div><h3>{{step[0]}} <small class="gl-serif">{{step[1]}}</small></h3><p>{{step[2]}}</p></div></li></ol></div><div class="flow-visual"><GlEvidenceTree :progress="flowProgress" @active="active=$event" @percent="percent=$event" /><div class="flow-percent gl-mono" aria-hidden="true"><span>{{percent}}</span>%</div></div></div></section>
    <section id="report" class="report-section"><div v-gl-reveal class="section-head"><p class="gl-eyebrow">Evidence report</p><h2>一份报告，<span>三层</span>视角</h2><p>源码、证据与复核结论，连起同一次提交。</p></div>
      <div id="stage" class="report-stage" @pointermove="moveReport" @pointerleave="parallax={x:0,y:0}"><div class="stage-inner" :style="{transform:`rotateX(${-parallax.y*5}deg) rotateY(${parallax.x*8}deg)`}">
        <div v-gl-reveal class="report-layer layer-code gl-glass"><p class="gl-mono">示意 · src/views/List.vue</p><pre>38  const items = ref([])
39  onMounted(async () =&gt; {
40    items.value = await fetchList()
41    // 缺少空数据兜底
42  })</pre></div>
        <div v-gl-reveal class="report-layer layer-main gl-glass"><p class="gl-mono">示意报告 · 第 2 次提交</p><h3>待办清单 · 示例同学</h3><ul class="sample-requirements"><li v-for="(text,i) in ['页面路由与导航','列表渲染与 key','空状态与加载态','表单校验与提示','组件拆分与通信']" :key="text"><span>{{text}}</span><AlertCircle v-if="i===2" class="warning" :size="18" aria-hidden="true" /><Check v-else class="success" :size="18" aria-hidden="true" /></li></ul></div>
        <div v-gl-reveal class="report-layer layer-review gl-glass"><ShieldCheck :size="28" aria-hidden="true" /><div><b>教师已复核</b><small>示意 · 采用 4 条，修改 1 条</small></div></div><div v-gl-reveal class="report-layer layer-compare gl-glass"><small>对比上次 · 示意</small><b>+3 项通过</b></div>
      </div></div>
    </section>
    <section id="features" class="features-section"><div v-gl-reveal class="section-head"><p class="gl-eyebrow">Capabilities</p><h2>认真对待<span>每一行</span>代码</h2></div><div class="bento">
      <article v-gl-reveal v-gl-spotlight class="feature-card feature-main gl-card"><ShieldCheck :size="30" aria-hidden="true" /><h3>发布权，<br />永远在教师手里</h3><p>模型结果只是可选择采用的候选。教师逐项复核、修改、发布，不会自动推送结论给学生。</p><div class="big-zero" aria-hidden="true">0<small>auto-publish</small></div></article>
      <article v-for="f in features" :key="f.title" v-gl-reveal v-gl-spotlight class="feature-card gl-card" :style="{'--feature-color':`var(--gl-c${f.hue})`}"><component :is="f.icon" :size="25" aria-hidden="true" /><h3>{{f.title}}</h3><p>{{f.text}}</p></article>
      <article v-gl-reveal class="feature-card feature-wide gl-card"><div><Code2 :size="26" aria-hidden="true" /><h3>源码行并排引用</h3><p>反馈定位到固定版本的源码行：桌面并排阅读，手机弹窗查看。</p></div><pre aria-label="源码引用示意">40 │ items.value = await fetchList()
41 │ // 缺少空数据兜底 ← 反馈 #3
42 │ })</pre></article>
    </div></section>
    <section class="landing-stats" aria-label="产品能力"><div v-for="([n,label],i) in [[8,'个独立检查案例'],[5,'项核心要求'],[6,'种受限 Agent 工具'],[0,'条自动发布']]" :key="label" :style="{'--stat-color':`var(--gl-c${[1,2,5,4][i]})`}"><b>{{n}}</b><span>{{label}}</span></div></section>
    <section id="roles" class="roles-section"><article v-gl-reveal class="role-card teacher-role gl-glass"><p class="gl-eyebrow">For teachers</p><h3>少一些重复批改，<br />多一些<span>真正的指导</span></h3><ul><li>拆分任务与团队，预览学生看到的说明</li><li>证据先行，候选反馈逐条采用或改写</li><li>看清全班进度与待交截止</li></ul></article><article v-gl-reveal class="role-card student-role gl-glass"><p class="gl-eyebrow">For students</p><h3>知道错在哪，<br />更知道<span>怎么变好</span></h3><ul><li>提交前可用个人模型私下自查</li><li>结合截图与源码行阅读反馈，不靠猜</li><li>复提后比较证据，让修改有迹可循</li></ul></article></section>
    <section class="outro"><div class="marquee" aria-hidden="true"><div>Evidence · 证据 · Review · 复核 · Feedback · 反馈 · Progress · 进步 · Evidence · 证据 · Review · 复核 · Feedback · 反馈 · Progress · 进步 ·</div></div><div v-gl-reveal class="outro-card gl-glass"><h2>把下一次提交，<br />变成<span>看得见的进步</span></h2><RouterLink to="/" class="gl-btn gl-btn--primary gl-btn--lg">登录工作台 <ArrowRight :size="18" aria-hidden="true" /></RouterLink></div><footer><span>知因 CodeLab</span><span>以证据，连接教与学。</span></footer></section>
  </main>
</div>
</template>
<style scoped src="../styles/glass/landing.css"></style>
