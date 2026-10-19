<script setup lang="ts">
// Hand-drawn harbour chart for AI project reading. Purely decorative (aria-hidden):
// stations are either the reading stages or the project's real module labels, never invented data.
// SMIL animations only render when motion is allowed; CSS animations are switched off globally otherwise.
import { computed, onMounted, ref } from 'vue';

const props = withDefaults(defineProps<{ labels?: string[]; scanning?: boolean; caption?: string }>(), {
  labels: () => ['项目全景', '业务链路', '代码依据'],
  scanning: false,
  caption: '读码航线 / READING ROUTE',
});

const uid = `chart-${Math.random().toString(36).slice(2, 8)}`;
const motion = ref(false);
onMounted(() => { motion.value = !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); });

const rows = [204, 124, 192, 112, 180];
function fit(label: string) {
  let width = 0, out = '';
  for (const char of label) {
    width += /[　-鿿＀-￯]/.test(char) ? 1 : .56;
    if (width > 6.2) return `${out}…`;
    out += char;
  }
  return out;
}
const nodes = computed(() => {
  const list = (props.labels.length ? props.labels : ['项目全景']).slice(0, 5);
  const step = list.length > 1 ? 340 / (list.length - 1) : 0;
  return list.map((label, i) => {
    const x = list.length > 1 ? 92 + i * step : 260, y = rows[i];
    return { x, y, label: fit(label), index: String(i + 1).padStart(2, '0'), high: y < 160, last: i === list.length - 1 };
  });
});
const route = computed(() => nodes.value.map((n, i) => {
  if (!i) return `M${n.x} ${n.y}`;
  const a = nodes.value[i - 1], mid = a.x + (n.x - a.x) / 2;
  return `C${mid} ${a.y} ${mid} ${n.y} ${n.x} ${n.y}`;
}).join(' '));
const routeLength = computed(() => Math.round(nodes.value.reduce((sum, n, i) => i ? sum + Math.hypot(n.x - nodes.value[i - 1].x, n.y - nodes.value[i - 1].y) * 1.18 : sum, 0)) + 40);
</script>

<template>
  <figure class="project-chart" :class="{ scanning }" aria-hidden="true">
    <svg viewBox="0 0 520 300" preserveAspectRatio="xMidYMid meet" focusable="false">
      <defs>
        <filter :id="`${uid}-rough`"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="2" seed="7" /><feDisplacementMap in="SourceGraphic" scale="3.2" /></filter>
        <mask :id="`${uid}-mask`" maskUnits="userSpaceOnUse" x="0" y="0" width="520" height="300">
          <path class="ms-draw route-ink" :d="route" :style="{ '--len': routeLength }" />
        </mask>
        <linearGradient :id="`${uid}-sweep`" x1="0" x2="1">
          <stop offset="0" stop-color="currentColor" stop-opacity="0" />
          <stop offset="1" stop-color="currentColor" stop-opacity=".16" />
        </linearGradient>
      </defs>

      <g class="graticule">
        <path d="M130 0V300M260 0V300M390 0V300M0 100H520M0 200H520" />
      </g>
      <g class="coast" :filter="`url(#${uid}-rough)`">
        <path class="ms-draw" style="--len: 300" d="M300 0C318 22 352 18 372 34S410 64 446 52S496 28 520 40" />
        <path class="ms-draw" style="--len: 340" d="M0 266C36 254 64 274 104 262S170 240 206 258S262 292 296 300" />
        <path class="contour" d="M0 152C70 132 110 172 180 152S300 112 360 140S470 182 520 162" />
      </g>
      <g class="soundings"><path d="M196 56h6m-3-3v6M332 248h6m-3-3v6M470 236h6m-3-3v6M58 128h6m-3-3v6" /></g>

      <g class="lighthouse">
        <path class="beam" d="M492 30 L392 6 L392 54 Z" />
        <path class="tower" d="M488 40 L490 26 H494 L496 40 Z M489 26 H495 M492 26 V22" />
      </g>

      <g class="compass" :filter="`url(#${uid}-rough)`">
        <circle cx="52" cy="56" r="26" />
        <circle cx="52" cy="56" r="19" class="inner" />
        <path class="needle" d="M52 30 L56 56 L52 82 L48 56 Z" />
        <path d="M26 56 H78" />
        <text x="52" y="22" text-anchor="middle">N</text>
      </g>

      <path :id="`${uid}-path`" class="route" :d="route" :mask="`url(#${uid}-mask)`" />

      <g v-if="scanning" class="sweep">
        <rect x="-70" y="0" width="70" height="300" :fill="`url(#${uid}-sweep)`" />
        <line x1="0" y1="0" x2="0" y2="300" />
      </g>

      <g v-for="(n, i) in nodes" :key="i" class="node" :class="{ last: n.last }" :style="{ '--i': i }">
        <circle v-if="n.last && motion" :cx="n.x" :cy="n.y" r="6" class="ring">
          <animate attributeName="r" values="6;24" dur="2.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values=".7;0" dur="2.8s" repeatCount="indefinite" />
        </circle>
        <circle :cx="n.x" :cy="n.y" r="5.5" class="dot" />
        <text :x="n.x" :y="n.high ? n.y - 30 : n.y + 40" class="label" text-anchor="middle">{{ n.label }}</text>
        <text :x="n.x" :y="n.high ? n.y - 14 : n.y + 22" class="index" text-anchor="middle">{{ n.index }}</text>
      </g>

      <g v-if="scanning && motion" class="boat">
        <animateMotion dur="16s" repeatCount="indefinite" rotate="auto"><mpath :href="`#${uid}-path`" /></animateMotion>
        <g class="boat-body"><path d="M-9 0 H9 L5.5 5 H-5.5 Z" /><path class="sail" d="M0 -1 V-15 L8 -3 Z" /></g>
      </g>
    </svg>
    <figcaption v-if="caption"><span class="ms-cap">{{ caption }}</span></figcaption>
  </figure>
</template>

<style scoped>
.project-chart { margin: 0; min-width: 0; color: var(--accent); }
.project-chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.graticule path { fill: none; stroke: var(--line); stroke-width: 1; stroke-dasharray: 2 6; }
.coast path { fill: none; stroke: var(--ink); stroke-width: 1.3; stroke-linecap: round; }
.coast .contour { stroke: color-mix(in srgb, var(--sea) 50%, transparent); stroke-width: 1; stroke-dasharray: 5 5; }
.soundings path { fill: none; stroke: color-mix(in srgb, var(--sea) 40%, transparent); stroke-width: 1; }
.route-ink { fill: none; stroke: var(--canvas); stroke-width: 8; stroke-linecap: round; }
.route { fill: none; stroke: var(--accent); stroke-width: 1.6; stroke-dasharray: 7 6; stroke-linecap: round; }
.compass circle { fill: none; stroke: var(--gold); stroke-width: 1; }
.compass .inner { stroke-dasharray: 1 4; }
.compass path { fill: none; stroke: var(--gold); stroke-width: 1; }
.compass .needle { fill: color-mix(in srgb, var(--accent) 18%, transparent); stroke: var(--accent); }
.compass text { font: 600 11px var(--font-display); fill: var(--ink); }
.compass { transform-box: fill-box; transform-origin: center; transition: rotate 1.2s var(--ease-emphasis); }
.project-chart:hover .compass { rotate: -28deg; }
.lighthouse .tower { fill: var(--paper); stroke: var(--ink); stroke-width: 1.1; stroke-linejoin: round; }
.lighthouse .beam { fill: var(--accent); opacity: .1; transform-origin: 492px 30px; animation: chart-beam 9s var(--ease-emphasis) infinite alternate; }
.node { animation: studio-fade .9s var(--ease-out-expo) both; animation-delay: calc(1.2s + var(--i) * .4s); }
.dot { fill: var(--canvas); stroke: var(--ink); stroke-width: 1.4; }
.node.last .dot { fill: var(--accent); stroke: var(--accent); }
.ring { fill: none; stroke: var(--accent); stroke-width: 1; }
.label { font: 600 15px var(--font-display); fill: var(--ink); letter-spacing: .06em; }
.index { font: 10px var(--font-outlier); fill: var(--muted); letter-spacing: .2em; }
.sweep { color: var(--accent); animation: chart-sweep 4.8s var(--ease-emphasis) infinite alternate; }
.sweep line { stroke: var(--accent); stroke-width: 1.2; }
.boat-body path { fill: var(--ink); }
.boat-body .sail { fill: var(--paper); stroke: var(--ink); stroke-width: 1; stroke-linejoin: round; }
.boat-body { animation: studio-bob 6s ease-in-out infinite; }
figcaption { margin-top: var(--space-2xs); border-top: 1px solid var(--line); padding-top: var(--space-2xs); }
@keyframes chart-beam { from { rotate: -14deg; } to { rotate: 16deg; } }
@keyframes chart-sweep { from { translate: 0 0; } to { translate: 520px 0; } }
@media (prefers-reduced-motion: reduce) {
  .compass { transition: none; }
  .project-chart:hover .compass { rotate: none; }
}
</style>
