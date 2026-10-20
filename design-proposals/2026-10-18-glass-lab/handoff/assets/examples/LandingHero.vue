<!--
  参考实现 · 首页首屏 + 工作方式（证据树）
  -------------------------------------------------------------
  演示 GlLiquid / GlEvidenceCore / GlEvidenceTree 如何组合与联动：
  · 核心爆发（@emit）→ 液体从核心荡开一圈波 + 证据卡轮换到下一个案例
  · 工作方式分区高 420vh，内部 sticky；滚动进度驱动证据树生长
  完整视觉（文案、其余分区）以 prototype/index.html 为准。
  文案为展示用示意，正式页面中的数字（8 个案例、5 项要求等）须与产品事实一致。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import GlLiquid from "../src/components/glass/GlLiquid.vue";
import GlEvidenceCore from "../src/components/glass/GlEvidenceCore.vue";
import GlEvidenceTree from "../src/components/glass/GlEvidenceTree.vue";

const CASES = [
  { k: "pass", id: "E-01", name: "路由跳转", code: 'expect(url).toBe("/list")' },
  { k: "pass", id: "E-02", name: "列表渲染", code: "v-for · :key 唯一" },
  { k: "pass", id: "E-03", name: "详情页参数", code: "useRoute().params.id" },
  { k: "warn", id: "E-04", name: "空列表状态", code: "screenshot · 1280×800" },
  { k: "pass", id: "E-05", name: "加载态提示", code: 'aria-busy="true"' },
  { k: "pass", id: "E-06", name: "表单校验", code: "src/views/Form.vue:42" },
  { k: "pass", id: "E-07", name: "组件通信", code: "emit('update') × 3" },
  { k: "pass", id: "E-08", name: "构建产物", code: "npm run build · 0 error" },
];
const STEPS = [
  ["提交", "Submit", "学生上传 ZIP，或从片段、文件夹、Gitee、GitHub 固定一次成果快照。提交即留档，不依赖模型。"],
  ["执行", "Execute", "Docker 隔离环境里构建、启动、驱动真实浏览器，八个独立案例逐一留下截图与日志。"],
  ["整理", "Agent", "受限 Agent 只用六种工具阅读证据，把发现整理成能定位到源码行的反馈候选。"],
  ["复核", "Review", "教师逐条采用、修改或驳回。模型只给候选，发布权始终在教师手里。"],
  ["复提", "Compare", "学生按反馈修改后再次提交，两次证据并排比较，每一处进步都看得见。"],
];

const coreEl = ref<HTMLElement | null>(null);
const copyEl = ref<HTMLElement | null>(null);
const liquid = ref<InstanceType<typeof GlLiquid> | null>(null);

// 三张证据卡各自显示的案例索引
const slots = ref([0, 3, 5]);
const lit = ref(-1);
let next = 0,
  caseIdx = 0;
const caseLabel = computed(() => `case ${String(caseIdx + 1).padStart(2, "0")}/08`);
function onEmit() {
  liquid.value?.pulse();
  caseIdx = (caseIdx + 1) % CASES.length;
  const s = next;
  next = (next + 1) % 3;
  slots.value[s] = caseIdx;
  lit.value = s;
  setTimeout(() => lit.value === s && (lit.value = -1), 2600);
}

// 工作方式：滚动进度 → 证据树
const flowEl = ref<HTMLElement | null>(null);
const progress = ref(0);
const active = ref(0);
const percent = ref(0);
function onScroll() {
  const el = flowEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  progress.value = Math.min(1, Math.max(0, -r.top / (r.height - innerHeight)));
}
onMounted(() => {
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
});
onBeforeUnmount(() => removeEventListener("scroll", onScroll));
</script>

<template>
  <section class="hero">
    <GlLiquid ref="liquid" :anchor="coreEl" />
    <div class="hero-shade" aria-hidden="true" />
    <GlEvidenceCore :anchor="coreEl" :avoid="copyEl" @emit="onEmit" />

    <div class="hero-inner">
      <div ref="copyEl" class="hero-copy">
        <p class="gl-eyebrow gl-anim-fade-up" style="--gl-delay: 0.3s">Vue 实训 · 证据驱动验收平台</p>
        <h1 v-gl-split="450" class="gl-display hero-title">让每一次提交<br />都有<em>证据</em>可循</h1>
        <p class="gl-serif hero-en gl-anim-fade-up" style="--gl-delay: 0.9s">Evidence, not guesses.</p>
        <p class="gl-lede hero-lede gl-anim-fade-up" style="--gl-delay: 1.05s">
          教师定义检查要求，学生提交 ZIP；执行侧在隔离环境里构建、驱动真实浏览器并留下证据，Agent
          整理成可追溯到源码行的反馈，教师逐条复核后发布。
        </p>
        <div class="gl-btn-group gl-anim-fade-up" style="--gl-delay: 1.2s; margin-top: 34px">
          <a v-gl-magnetic class="gl-btn gl-btn--primary gl-btn--lg" href="#/login">进入工作台 <span class="gl-btn__arrow">→</span></a>
          <a v-gl-magnetic class="gl-btn gl-btn--ghost gl-btn--lg" href="#flow">看它如何工作</a>
        </div>
      </div>

      <div class="hero-visual">
        <div ref="coreEl" class="core-anchor" aria-hidden="true" />
        <div class="core-label gl-mono" aria-hidden="true"><span class="dot" /> RUNNING · {{ caseLabel }}</div>
        <article
          v-for="(ci, i) in slots"
          :key="i"
          class="ev-card gl-glass"
          :class="[`ev-${i}`, { 'is-lit': lit === i }]"
        >
          <Transition name="gl-fade" mode="out-in">
            <div :key="ci">
              <header>
                <span class="gl-chip" :class="CASES[ci].k === 'pass' ? 'gl-chip--success' : 'gl-chip--warning'">
                  {{ CASES[ci].k === "pass" ? "通过" : "需关注" }}
                </span>
                <span class="gl-mono gl-muted id">{{ CASES[ci].id }}</span>
              </header>
              <h3>{{ CASES[ci].name }}</h3>
              <code class="gl-mono">{{ CASES[ci].code }}</code>
            </div>
          </Transition>
        </article>
      </div>
    </div>
  </section>

  <section id="flow" ref="flowEl" class="flow">
    <div class="flow-sticky">
      <div>
        <p class="gl-eyebrow">How it works</p>
        <h2 class="gl-section-title">一次提交，<br />长成一棵<span class="gl-serif gl-accent">证据树</span></h2>
        <ol class="steps">
          <li v-for="(s, i) in STEPS" :key="i" :class="{ on: i === active, done: i < active }" :style="{ '--sc': `var(--gl-c${[1, 5, 2, 4, 1][i]}-rgb)` }">
            <span class="num gl-mono">0{{ i + 1 }}</span>
            <div>
              <h3>{{ s[0] }} <small class="gl-serif">{{ s[1] }}</small></h3>
              <p>{{ s[2] }}</p>
            </div>
          </li>
        </ol>
      </div>
      <div class="flow-visual">
        <GlEvidenceTree :progress="progress" @active="active = $event" @percent="percent = $event" />
        <div class="flow-pct gl-mono" aria-hidden="true"><span class="gl-serif">{{ String(percent).padStart(2, "0") }}</span>%</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  overflow: hidden;
}
.hero-shade {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--gl-bg) 78%, transparent) 0%,
    color-mix(in srgb, var(--gl-bg) 40%, transparent) 38%,
    transparent 62%
  );
}
.hero-inner {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  align-items: center;
  gap: 40px;
  width: min(1240px, calc(100% - 64px));
  margin: 0 auto;
  padding: 120px 0 80px;
  pointer-events: none;
}
.hero-inner a,
.hero-inner .ev-card {
  pointer-events: auto;
}
.hero-title {
  margin-top: 22px;
}
.hero-title em {
  font-style: normal;
  background: linear-gradient(100deg, var(--gl-c3), var(--gl-c1) 45%, var(--gl-c4));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.hero-title :deep(em .gl-ch) {
  background: inherit;
  -webkit-background-clip: text;
  background-clip: text;
}
.hero-en {
  margin: 14px 0 0;
  font-size: clamp(22px, 2.2vw, 30px);
  color: var(--gl-muted);
}
.hero-lede {
  max-width: 520px;
  margin: 22px 0 0;
}
.hero-visual {
  position: relative;
  height: min(620px, 72vh);
}
.core-anchor {
  position: absolute;
  left: 50%;
  top: 48%;
  width: clamp(150px, 15vw, 210px);
  aspect-ratio: 1;
  translate: -50% -50%;
}
.core-label {
  position: absolute;
  left: 50%;
  top: calc(48% + clamp(150px, 15vw, 210px) * 0.85);
  translate: -50% 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid var(--gl-line);
  border-radius: 999px;
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--gl-muted);
  background: rgb(var(--gl-surface-rgb) / 0.5);
  white-space: nowrap;
}
.core-label .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--gl-c2);
  animation: gl-ping 1.8s infinite;
}
.ev-card {
  position: absolute;
  width: 228px;
  padding: 14px 16px 15px;
  border-radius: var(--gl-r-md);
  animation:
    gl-scale-in 1.2s var(--gl-ease-out) both,
    ev-bob 11s ease-in-out infinite;
}
.ev-card.is-lit {
  border-color: rgb(var(--gl-c1-rgb) / 0.55);
  box-shadow: var(--gl-inner-hl), 0 0 0 4px rgb(var(--gl-c1-rgb) / 0.08), 0 24px 60px -18px rgb(var(--gl-c1-rgb) / 0.45);
}
.ev-0 {
  top: 3%;
  right: 0;
  animation-delay: 1.5s, 0s;
}
.ev-1 {
  top: 64%;
  left: -4%;
  animation-delay: 1.7s, -3.6s;
}
.ev-2 {
  bottom: -1%;
  right: -2%;
  animation-delay: 1.9s, -7s;
}
@keyframes ev-bob {
  50% {
    translate: 0 -12px;
  }
}
.ev-card header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ev-card .id {
  font-size: 11px;
}
.ev-card h3 {
  margin: 8px 0 6px;
  font-size: 16px;
}
.ev-card code {
  display: block;
  font-size: 11.5px;
  color: rgb(var(--gl-text-rgb) / 0.6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.flow {
  position: relative;
  height: 420vh;
}
.flow-sticky {
  position: sticky;
  top: 0;
  display: grid;
  grid-template-columns: 1fr 1.05fr;
  align-items: center;
  gap: 40px;
  width: min(1240px, calc(100% - 64px));
  height: 100vh;
  margin: 0 auto;
}
.steps {
  margin: 40px 0 0;
  padding: 0;
  list-style: none;
}
.steps li {
  display: flex;
  gap: 22px;
  padding: 12px 0;
  opacity: 0.32;
  transition: opacity 0.6s var(--gl-ease-out);
}
.steps li.on {
  opacity: 1;
}
.steps li.done {
  opacity: 0.6;
}
.steps .num {
  display: grid;
  place-items: center;
  flex: none;
  width: 31px;
  height: 31px;
  border-radius: 50%;
  font-size: 11px;
  border: 1px solid var(--gl-line-strong);
  transition: 0.5s var(--gl-ease-out);
}
.steps li.on .num,
.steps li.done .num {
  background: rgb(var(--sc));
  color: var(--gl-on-c1);
  border-color: transparent;
  box-shadow: 0 0 0 6px rgb(var(--sc) / 0.16);
}
.steps h3 {
  margin: 2px 0;
  font-size: 20px;
}
.steps h3 small {
  margin-left: 6px;
  font-size: 16px;
  color: var(--gl-muted);
}
.steps p {
  max-width: 440px;
  margin: 0;
  color: var(--gl-muted);
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.7s var(--gl-ease-out);
}
.steps li.on p {
  max-height: 90px;
}
.flow-visual {
  position: relative;
  height: 86vh;
}
.flow-pct {
  position: absolute;
  right: 0;
  bottom: 6%;
  color: var(--gl-muted);
}
.flow-pct span {
  font-size: 56px;
  color: var(--gl-text);
}
@media (max-width: 980px) {
  .hero-inner,
  .flow-sticky {
    grid-template-columns: 1fr;
  }
  .hero-visual {
    height: 480px;
  }
  .steps li:not(.on) {
    display: none;
  }
}
</style>
