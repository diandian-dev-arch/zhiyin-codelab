<!--
  GlEvidenceTree · 随滚动生长的证据树（首页「工作方式」分区）
  -------------------------------------------------------------
  progress（0–1）由父组件根据滚动计算后传入；组件内部做平滑插值。
  五个阶段各用一个色相：提交 c1 → 执行 c5 → 整理 c2 → 复核 c4 → 复提 c1，
  树干渐变从下到上依次经过这些颜色。
    <GlEvidenceTree :progress="p" @active="i => step = i" />
  文案为示意内容（首页属于展示页），工作台内不要使用。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { prefersReducedMotion, perfTier } from "../../glass/theme";

const props = defineProps<{ progress: number }>();
const emit = defineEmits<{ active: [index: number]; percent: [value: number] }>();

const STAGES: [string, string][] = [
  ["提交", "SUBMIT · ZIP"],
  ["执行", "EXECUTE · 8 CASES"],
  ["整理", "AGENT · 6 TOOLS"],
  ["复核", "TEACHER REVIEW"],
  ["复提", "COMPARE · v2"],
];
const HUES = [1, 5, 2, 4, 1];
const FRACS = [0.1, 0.3, 0.5, 0.7, 0.93];
const TRUNK = "M300 700 C 300 620, 262 560, 286 470 S 336 330, 304 250 S 268 120, 300 54";
const SVG = "http://www.w3.org/2000/svg";
const uid = `gltree-${Math.random().toString(36).slice(2, 8)}`;

const svg = ref<SVGSVGElement | null>(null);
let raf = 0;

onMounted(() => {
  const root = svg.value!;
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element) => {
    const n = document.createElementNS(SVG, tag);
    for (const k in attrs) n.setAttribute(k, String(attrs[k]));
    parent.appendChild(n);
    return n;
  };
  const trunk = root.querySelector<SVGPathElement>(".trunk")!;
  const shadow = root.querySelector<SVGPathElement>(".trunk-shadow")!;
  const branchesG = root.querySelector<SVGGElement>(".branches")!;
  const sparkG = root.querySelector<SVGGElement>(".sparkles")!;
  const len = trunk.getTotalLength();
  trunk.style.strokeDasharray = shadow.style.strokeDasharray = String(len);

  interface Node {
    g: SVGGElement;
    f: number;
    branch: SVGPathElement | null;
    bLen: number;
    leaves: SVGEllipseElement[];
    twig?: { el: SVGPathElement; len: number };
    x: number;
    y: number;
  }
  const nodes: Node[] = FRACS.map((f, i) => {
    const p = trunk.getPointAtLength(len * f);
    const side = i === 4 ? 0 : i % 2 ? 1 : -1;
    const nx = i === 4 ? p.x : p.x + side * 150;
    const ny = i === 4 ? p.y - 4 : p.y - 46;
    const g = el("g", { class: "node" }, branchesG);
    g.style.setProperty("--sc", `var(--gl-c${HUES[i]})`);
    let branch: SVGPathElement | null = null;
    let bLen = 0;
    if (i !== 4) {
      branch = el("path", { class: "branch", d: `M${p.x} ${p.y} Q ${p.x + side * 40} ${p.y - 50}, ${nx} ${ny}` }, g);
      bLen = branch.getTotalLength();
      branch.style.strokeDasharray = branch.style.strokeDashoffset = String(bLen);
    }
    const node: Node = { g, f, branch, bLen, leaves: [], x: nx, y: ny };
    // 「执行」阶段：一根细枝挂着八片证据叶（第 4 片为需关注）
    if (i === 1) {
      const twig = el("path", { class: "twig", d: `M${nx} ${ny - 22} Q ${nx - side * 18} ${ny - 90}, ${nx + side * 46} ${ny - 150}` }, g);
      const tl = twig.getTotalLength();
      twig.style.strokeDasharray = twig.style.strokeDashoffset = String(tl);
      node.twig = { el: twig, len: tl };
      for (let k = 0; k < 8; k++) {
        const pt = twig.getPointAtLength(tl * (0.18 + k * 0.1));
        const up = k % 2 ? -1 : 1;
        node.leaves.push(
          el(
            "ellipse",
            {
              class: "leaf" + (k === 3 ? " warn" : ""),
              cx: pt.x,
              cy: pt.y + up * 8,
              rx: 4.2,
              ry: 7,
              transform: `rotate(${up * 35 * side} ${pt.x} ${pt.y + up * 8})`,
            },
            g
          )
        );
      }
    }
    el("circle", { class: "halo", cx: nx, cy: ny, r: 54, fill: `url(#${uid}-bloom)` }, g);
    const petals = el("g", { class: "petals", style: `transform-origin:${nx}px ${ny}px` }, g);
    for (let k = 0; k < 6; k++)
      el("ellipse", { class: "petal" + (k % 2 ? " alt" : ""), cx: nx, cy: ny - 17, rx: 6.5, ry: 12, transform: `rotate(${k * 60} ${nx} ${ny})` }, petals);
    el("circle", { class: "pulse", cx: nx, cy: ny, r: 9 }, g);
    el("circle", { class: "core", cx: nx, cy: ny, r: 9 }, g);
    const lx = side === 0 ? nx + 40 : side > 0 ? nx + 36 : nx - 36;
    const anchor = side < 0 ? "end" : "start";
    el("text", { class: "label", x: lx, y: ny - 2, "text-anchor": anchor }, g).textContent = STAGES[i][0];
    el("text", { class: "sub", x: lx, y: ny + 16, "text-anchor": anchor }, g).textContent = STAGES[i][1];
    return node;
  });

  // 复提回环：顶端节点画一条虚线回到起点，表示两次证据对比
  const n0 = nodes[0],
    n4 = nodes[4];
  const loop = el(
    "path",
    {
      class: "loop",
      d: `M${n4.x + 14} ${n4.y + 10} C ${n4.x + 230} ${n4.y + 140}, ${n0.x + 420} ${n0.y - 160}, ${n0.x + 12} ${n0.y + 8}`,
    },
    branchesG
  );

  const motes = Array.from({ length: perfTier() >= 2 ? 16 : 8 }, () => ({
    c: el("circle", { class: "mote", r: 1.6 }, sparkG),
    x: 0,
    y: 0,
    life: Math.random(),
    dx: 0,
  }));

  let sp = prefersReducedMotion() ? 1 : 0;
  let lastActive = -1,
    lastPct = -1;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const target = prefersReducedMotion() ? 1 : Math.min(1, Math.max(0, props.progress));
    sp += (target - sp) * 0.06;
    if (Math.abs(target - sp) < 0.0005) sp = target;
    const g = Math.min(1, sp / 0.96);
    const off = String(len * (1 - g));
    trunk.style.strokeDashoffset = shadow.style.strokeDashoffset = off;

    let active = 0;
    nodes.forEach((n, i) => {
      const local = Math.min(1, Math.max(0, (g - n.f) / 0.07));
      if (n.branch) n.branch.style.strokeDashoffset = String(n.bLen * (1 - local));
      const on = local >= 0.98 || (i === 4 && g >= n.f);
      n.g.classList.toggle("on", on);
      n.g.classList.toggle("bud", local > 0.5 || on);
      if (on) active = i;
      if (n.twig) {
        const lp = Math.min(1, Math.max(0, (g - n.f - 0.05) / 0.13));
        n.twig.el.style.strokeDashoffset = String(n.twig.len * (1 - lp));
        n.leaves.forEach((lf, k) => lf.classList.toggle("on", lp > (k + 1) / 9));
      }
    });
    loop.classList.toggle("on", g > 0.97);
    loop.style.strokeDashoffset = String(-performance.now() / 60);

    const tip = trunk.getPointAtLength(len * Math.max(0.01, g));
    for (const m of motes) {
      m.life += 0.007;
      if (m.life > 1) {
        m.life = 0;
        m.x = tip.x + (Math.random() - 0.5) * 50;
        m.y = tip.y + Math.random() * 20;
        m.dx = (Math.random() - 0.5) * 0.6;
      }
      m.x += m.dx;
      m.y -= 0.4;
      m.c.setAttribute("cx", m.x.toFixed(1));
      m.c.setAttribute("cy", m.y.toFixed(1));
      m.c.setAttribute("opacity", (Math.sin(m.life * Math.PI) * 0.85 * (g > 0.01 ? 1 : 0)).toFixed(2));
    }

    if (active !== lastActive) emit("active", (lastActive = active));
    const pct = Math.round(g * 100);
    if (pct !== lastPct) emit("percent", (lastPct = pct));
  };
  raf = requestAnimationFrame(frame);
});

onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <svg ref="svg" class="gl-tree" viewBox="0 0 600 720" role="img" aria-label="证据树：提交、执行、整理、复核、复提五个阶段依次生长">
    <defs>
      <linearGradient :id="`${uid}-trunk`" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="var(--gl-c1)" stop-opacity="0.4" />
        <stop offset="0.3" stop-color="var(--gl-c5)" />
        <stop offset="0.55" stop-color="var(--gl-c2)" />
        <stop offset="0.8" stop-color="var(--gl-c4)" />
        <stop offset="1" stop-color="var(--gl-c1)" />
      </linearGradient>
      <radialGradient :id="`${uid}-bloom`">
        <stop offset="0" stop-color="var(--gl-c1)" stop-opacity="0.7" />
        <stop offset="1" stop-color="var(--gl-c1)" stop-opacity="0" />
      </radialGradient>
    </defs>
    <ellipse class="ground" cx="300" cy="704" rx="170" ry="16" />
    <path class="trunk-shadow" :d="TRUNK" />
    <path class="trunk" :d="TRUNK" :stroke="`url(#${uid}-trunk)`" />
    <g class="branches" />
    <g class="sparkles" />
  </svg>
</template>

<style scoped>
.gl-tree {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.gl-tree :deep(.trunk) {
  fill: none;
  stroke-width: 5;
  stroke-linecap: round;
}
.gl-tree :deep(.trunk-shadow) {
  fill: none;
  stroke: var(--gl-c1);
  stroke-width: 22;
  stroke-linecap: round;
  opacity: 0.08;
}
.gl-tree :deep(.ground) {
  fill: none;
  stroke: rgb(var(--gl-text-rgb) / 0.12);
  stroke-dasharray: 2 6;
}
.gl-tree :deep(.node) {
  opacity: 0;
  transition: opacity 0.5s;
}
.gl-tree :deep(.node.bud) {
  opacity: 1;
}
.gl-tree :deep(.branch) {
  fill: none;
  stroke: var(--sc);
  stroke-width: 2.5;
  stroke-linecap: round;
  opacity: 0.85;
}
.gl-tree :deep(.twig) {
  fill: none;
  stroke: rgb(var(--gl-text-rgb) / 0.35);
  stroke-width: 1.2;
}
.gl-tree :deep(.leaf) {
  fill: var(--gl-c2);
  transform-box: fill-box;
  transform-origin: center;
  scale: 0;
  transition: scale 0.6s var(--gl-ease-spring);
}
.gl-tree :deep(.leaf.warn) {
  fill: var(--gl-c4);
}
.gl-tree :deep(.leaf.on) {
  scale: 1;
}
.gl-tree :deep(.halo) {
  opacity: 0;
  transform-box: fill-box;
  transform-origin: center;
  transform: scale(0.3);
  transition:
    opacity 0.8s,
    transform 1.2s var(--gl-ease-out);
}
.gl-tree :deep(.core) {
  fill: var(--gl-bg);
  stroke: rgb(var(--gl-text-rgb) / 0.25);
  stroke-width: 1.5;
  transition:
    fill 0.6s,
    stroke 0.6s;
}
.gl-tree :deep(.petals) {
  transform-box: view-box;
  transform: scale(0) rotate(-70deg);
  transition: transform 1s var(--gl-ease-spring);
}
.gl-tree :deep(.petal) {
  fill: var(--sc);
  opacity: 0.9;
}
.gl-tree :deep(.petal.alt) {
  fill: var(--gl-c3);
}
.gl-tree :deep(.label) {
  font-family: var(--gl-font-sans);
  font-size: 17px;
  font-weight: 700;
  fill: var(--gl-text);
  opacity: 0;
  transition: opacity 0.6s;
}
.gl-tree :deep(.sub) {
  font-family: var(--gl-font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  fill: var(--gl-muted);
  opacity: 0;
  transition: opacity 0.6s 0.1s;
}
.gl-tree :deep(.pulse) {
  fill: none;
  stroke: var(--sc);
  opacity: 0;
}
.gl-tree :deep(.node.on .halo) {
  opacity: 0.55;
  transform: scale(1);
}
.gl-tree :deep(.node.on .core) {
  fill: var(--sc);
  stroke: var(--sc);
}
.gl-tree :deep(.node.on .petals) {
  transform: none;
}
.gl-tree :deep(.node.on .label),
.gl-tree :deep(.node.on .sub) {
  opacity: 1;
}
.gl-tree :deep(.node.on .pulse) {
  animation: gl-tree-pulse 3.6s var(--gl-ease-out) infinite;
}
@keyframes gl-tree-pulse {
  from {
    r: 9;
    opacity: 0.8;
  }
  to {
    r: 34;
    opacity: 0;
  }
}
.gl-tree :deep(.loop) {
  fill: none;
  stroke: var(--gl-c2);
  stroke-width: 1.5;
  stroke-dasharray: 3 7;
  opacity: 0;
  transition: opacity 0.8s;
}
.gl-tree :deep(.loop.on) {
  opacity: 0.8;
}
.gl-tree :deep(.mote) {
  fill: var(--gl-c3);
}
</style>
