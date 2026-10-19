<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const canvas = ref<HTMLCanvasElement>();
const isHovered = ref(false);
const isPaused = ref(false);

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  color: Rgb;
  trail: { x: number; y: number; alpha: number }[];
}

interface CodeNode {
  x: number;
  y: number;
  radius: number;
  pulsePhase: number;
  connections: number[];
  type: 'entry' | 'logic' | 'data' | 'output';
  label: string;
  glowIntensity: number;
}

let ctx: CanvasRenderingContext2D | null = null;
let animationId: number;
let particles: Particle[] = [];
let nodes: CodeNode[] = [];
let mouseX = -1000;
let mouseY = -1000;
let time = 0;

// Canvas 不能直接用 CSS 变量：运行时读取站点令牌，保证与全局配色一致。
type Rgb = [number, number, number];
const palette = {
  entry: [201, 168, 108] as Rgb,   // 泥金 --apricot
  logic: [224, 138, 108] as Rgb,   // 朱砂（深底提亮）--accent-on-ink
  data: [94, 160, 168] as Rgb,     // 黛青（深底提亮）
  output: [246, 242, 234] as Rgb,  // 宣纸 --on-ink
  bg: [17, 27, 30] as Rgb,
};
function hexToRgb(value: string): Rgb | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) as Rgb : undefined;
}
function readPalette() {
  if (!canvas.value) return;
  const css = getComputedStyle(canvas.value);
  const pick = (name: string, fallback: Rgb) => hexToRgb(css.getPropertyValue(name)) ?? fallback;
  palette.entry = pick('--apricot', palette.entry);
  palette.logic = pick('--accent-on-ink', palette.logic);
  palette.output = pick('--on-ink', palette.output);
  palette.bg = pick('--spine', palette.bg);
}
const rgba = (c: Rgb, a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const tone = (type: CodeNode['type']) => palette[type];

function initCanvas() {
  if (!canvas.value) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.value.getBoundingClientRect();

  canvas.value.width = rect.width * dpr;
  canvas.value.height = rect.height * dpr;

  ctx = canvas.value.getContext('2d');
  if (!ctx) return;

  ctx.scale(dpr, dpr);

  // 初始化代码节点
  const w = rect.width;
  const h = rect.height;

  nodes = [
    { x: w * 0.15, y: h * 0.5, radius: 24, pulsePhase: 0, connections: [1, 2], type: 'entry', label: '入口', glowIntensity: 0 },
    { x: w * 0.38, y: h * 0.3, radius: 20, pulsePhase: 0.3, connections: [3], type: 'logic', label: '解析', glowIntensity: 0 },
    { x: w * 0.38, y: h * 0.7, radius: 20, pulsePhase: 0.6, connections: [3], type: 'data', label: '数据', glowIntensity: 0 },
    { x: w * 0.62, y: h * 0.5, radius: 22, pulsePhase: 0.9, connections: [4], type: 'logic', label: '分析', glowIntensity: 0 },
    { x: w * 0.85, y: h * 0.5, radius: 24, pulsePhase: 1.2, connections: [], type: 'output', label: '报告', glowIntensity: 0 },
  ];
}

function createParticle(fromNode: CodeNode, toNode: CodeNode) {
  const angle = Math.atan2(toNode.y - fromNode.y, toNode.x - fromNode.x);
  const speed = 1.2 + Math.random() * 0.8;

  particles.push({
    x: fromNode.x,
    y: fromNode.y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    size: 2 + Math.random() * 2,
    life: 1,
    maxLife: 1,
    color: tone(fromNode.type),
    trail: [],
  });
}

function drawNode(node: CodeNode) {
  if (!ctx || !canvas.value) return;

  const pulse = Math.sin(time * 0.003 + node.pulsePhase) * 0.15 + 0.85;
  const radius = node.radius * pulse;
  const color = tone(node.type);

  // 外层光晕
  const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, radius * 2.5);
  gradient.addColorStop(0, rgba(color, 0.26));
  gradient.addColorStop(0.4, rgba(color, 0.1));
  gradient.addColorStop(1, rgba(color, 0));

  ctx.fillStyle = gradient;
  ctx.fillRect(node.x - radius * 2.5, node.y - radius * 2.5, radius * 5, radius * 5);

  // 节点主体
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color, 0.22);
  ctx.fill();

  // 内圈
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color, 0.82 + node.glowIntensity * 0.18);
  ctx.fill();

  // 交互高亮
  if (node.glowIntensity > 0) {
    ctx.strokeStyle = rgba(palette.output, node.glowIntensity * 0.9);
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 标签
  ctx.fillStyle = rgba(palette.bg, 0.95);
  ctx.font = '600 11px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(node.label, node.x, node.y);

  // 渐弱高亮
  node.glowIntensity *= 0.92;
}

function drawConnection(from: CodeNode, to: CodeNode) {
  if (!ctx) return;

  const flowPhase = (time * 0.002) % 1;
  const color = tone(from.type);

  // 连接线
  ctx.strokeStyle = rgba(color, 0.28);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  // 流动效果
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = 8;

  for (let i = 0; i < steps; i++) {
    const t = (i / steps + flowPhase) % 1;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const alpha = Math.sin(t * Math.PI) * 0.6;

    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, alpha);
    ctx.fill();
  }
}

function updateParticles() {
  if (!ctx || !canvas.value) return;

  particles = particles.filter(p => {
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 0.012;

    // 记录轨迹
    p.trail.unshift({ x: p.x, y: p.y, alpha: p.life });
    if (p.trail.length > 12) p.trail.pop();

    // 绘制轨迹
    p.trail.forEach((t, i) => {
      const size = p.size * (1 - i / p.trail.length) * 0.6;
      const alpha = t.alpha * (1 - i / p.trail.length) * 0.7;

      ctx!.beginPath();
      ctx!.arc(t.x, t.y, size, 0, Math.PI * 2);
      ctx!.fillStyle = rgba(p.color, alpha);
      ctx!.fill();
    });

    // 检测到达节点
    nodes.forEach(node => {
      const dx = node.x - p.x;
      const dy = node.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < node.radius) {
        node.glowIntensity = Math.min(1, node.glowIntensity + 0.3);
        p.life = 0;
      }
    });

    return p.life > 0;
  });
}

function animate() {
  if (!ctx || !canvas.value || isPaused.value) {
    animationId = requestAnimationFrame(animate);
    return;
  }

  const rect = canvas.value.getBoundingClientRect();
  time++;

  // 清空画布，使用深色背景
  ctx.fillStyle = rgba(palette.bg, 0.25);
  ctx.fillRect(0, 0, rect.width, rect.height);

  // 绘制连接
  nodes.forEach((node, i) => {
    node.connections.forEach(targetIdx => {
      drawConnection(node, nodes[targetIdx]);
    });
  });

  // 绘制节点
  nodes.forEach(drawNode);

  // 更新粒子
  updateParticles();

  // 生成新粒子
  if (time % 35 === 0) {
    nodes.forEach((node, i) => {
      if (node.connections.length > 0) {
        node.connections.forEach(targetIdx => {
          createParticle(node, nodes[targetIdx]);
        });
      }
    });
  }

  // 鼠标交互
  if (mouseX > 0 && mouseY > 0) {
    nodes.forEach(node => {
      const dx = node.x - mouseX;
      const dy = node.y - mouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < node.radius * 3) {
        node.glowIntensity = Math.min(1, node.glowIntensity + 0.08);

        // 鼠标附近产生额外粒子
        if (Math.random() < 0.15 && node.connections.length > 0) {
          const targetIdx = node.connections[Math.floor(Math.random() * node.connections.length)];
          createParticle(node, nodes[targetIdx]);
        }
      }
    });
  }

  animationId = requestAnimationFrame(animate);
}

function handleMouseMove(e: MouseEvent) {
  if (!canvas.value) return;
  const rect = canvas.value.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
}

function handleMouseLeave() {
  mouseX = -1000;
  mouseY = -1000;
}

function handleClick() {
  isPaused.value = !isPaused.value;
}

onMounted(() => {
  readPalette();
  initCanvas();
  animate();

  window.addEventListener('resize', initCanvas);
});

onUnmounted(() => {
  cancelAnimationFrame(animationId);
  window.removeEventListener('resize', initCanvas);
});
</script>

<template>
  <div
    class="code-flow-animation"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false; handleMouseLeave()"
  >
    <canvas
      ref="canvas"
      @mousemove="handleMouseMove"
      @click="handleClick"
    />
    <div class="animation-hint" :class="{ visible: isHovered }">
      <span v-if="!isPaused">移动鼠标与代码流交互 · 点击暂停</span>
      <span v-else>已暂停 · 点击继续</span>
    </div>
  </div>
</template>

<style scoped>
.code-flow-animation {
  position: relative;
  width: 100%;
  height: 280px;
  border-radius: var(--radius);
  overflow: hidden;
  background: linear-gradient(135deg, var(--spine) 0%, var(--spine-2) 100%);
  border: 1px solid var(--gold-line);
  cursor: pointer;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.animation-hint {
  position: absolute;
  bottom: 1rem;
  left: 50%;
  transform: translate(-50%, 1rem);
  padding: 0.5rem 1rem;
  background: color-mix(in srgb, var(--spine) 88%, transparent);
  backdrop-filter: blur(8px);
  border: 1px solid var(--gold-line);
  border-radius: 999px;
  font-size: 0.75rem;
  color: var(--gold-on-ink);
  font-weight: 500;
  letter-spacing: 0.015em;
  opacity: 0;
  pointer-events: none;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.animation-hint.visible {
  opacity: 1;
  transform: translate(-50%, 0);
}
</style>
