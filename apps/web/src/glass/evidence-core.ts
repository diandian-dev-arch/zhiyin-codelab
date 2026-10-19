/**
 * Glass Lab · 检查核心与代码粒子（Canvas 2D）
 * ---------------------------------------------------------------
 * 代码字符粒子沿螺旋缓慢汇入「检查核心」，能量充满后爆发证据（圆环 + 火花），
 * 并回调 onEmit —— 页面用它轮换证据卡片、让液体背景从核心荡开一圈波。
 *
 *   const core = createEvidenceCore(canvas, { anchor, avoid, onEmit });
 *   core.setAccent(1);   // 主色向 c2 过渡（学生身份）
 *   core.boost(0.5);     // 预充能，让第一次爆发早点到来
 *   core.destroy();
 *
 * 画布需铺满父容器（position:absolute; inset:0），anchor 为核心定位元素。
 * 仅用于首页首屏与登录页左侧场景；工作台内不使用（见规范 §5.3）。
 */
import { readPalette, onThemeChange, prefersReducedMotion, rgba, mix, type Palette, type RGB } from "./theme";
import { canvasLoop } from "./canvas-loop";
import { drawGlassOrb } from './glass-orb';

export interface EvidenceCoreOptions {
  anchor?: HTMLElement | null;
  /** 正文区域：粒子经过时淡出，保证阅读 */
  avoid?: HTMLElement | null;
  particles?: boolean;
  appearance?: 'radar' | 'glass';
  onEmit?: () => void;
}

export interface EvidenceCoreHandle {
  setAccent(v: number): void;
  burst(): void;
  boost(v: number): void;
  setAnchor(el: HTMLElement | null): void;
  setAvoid(el: HTMLElement | null): void;
  destroy(): void;
}

const TAU = Math.PI * 2;
const TOKENS = [
  "<template>", "v-if", "v-for", "router.push", "ref()", "computed", "props",
  "emit()", "=>", "{{ }}", "const", "await", "onMounted", "v-model", "<form>",
  "export", "fetch()", "useRoute", "watch", ":key", "@click", "return", "</div>",
  "defineProps", "import", "async", "filter()", "[ ]", "{ }", "npm run build",
];

interface Particle {
  a: number;
  r: number;
  far: number;
  txt: string;
  age: number;
  spin: number;
  speed: number;
  hue: number;
}

export function createEvidenceCore(canvas: HTMLCanvasElement, opts: EvidenceCoreOptions = {}): EvidenceCoreHandle {
  const reduced = prefersReducedMotion();
  const glass = opts.appearance === 'glass';
  let anchor = opts.anchor ?? null;
  let avoid = opts.avoid ?? null;
  let pal: Palette = readPalette();
  let rect = canvas.getBoundingClientRect();
  const bursts: { t: number }[] = [];
  const sparks: { x: number; y: number; vx: number; vy: number; life: number; hue: number }[] = [];
  let parts: Particle[] = [];
  let energy = 0,
    pulse = 0,
    accentT = 0,
    accentTarget = 0,
    tNow = 0;
  const core = { x: 0, y: 0, r: 80 };

  const offTheme = onThemeChange((p) => { pal = p; if (reduced && glass) redrawStatic(); });
  const onScroll = () => (rect = canvas.getBoundingClientRect());
  addEventListener("scroll", onScroll, { passive: true });

  function locateCore(w: number, h: number) {
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      core.x = a.left - rect.left + a.width / 2;
      core.y = a.top - rect.top + a.height / 2;
      core.r = Math.max(46, a.width / 2);
    } else {
      core.x = w / 2;
      core.y = h / 2;
      core.r = Math.min(w, h) * 0.16;
    }
  }

  function spawn(p: Partial<Particle>, initial: boolean): Particle {
    const far = Math.hypot(Math.max(core.x, 1), Math.max(core.y, 1)) * 0.95 + core.r;
    p.a = Math.random() * TAU;
    p.r = initial ? core.r * 1.3 + Math.random() * far : far * (0.75 + Math.random() * 0.35);
    p.far = far;
    p.txt = TOKENS[(Math.random() * TOKENS.length) | 0];
    p.age = initial ? 1 : 0;
    p.spin = 0.8 + Math.random() * 0.6;
    p.speed = 0.75 + Math.random() * 0.6;
    p.hue = Math.random();
    return p as Particle;
  }

  function emit() {
    energy = 0;
    pulse = 1;
    bursts.push({ t: tNow });
    const n = glass ? 0 : 18;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random() * 0.3;
      const v = 70 + Math.random() * 90;
      sparks.push({ x: core.x, y: core.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, hue: Math.random() });
    }
    opts.onEmit?.();
  }

  const loop = canvasLoop(canvas, {
    onResize(s) {
      rect = canvas.getBoundingClientRect();
      locateCore(s.w, s.h);
      const n = opts.particles === false || (glass && reduced) ? 0 : (glass ? [12, 20, 30] : [24, 44, 72])[s.quality];
      parts = Array.from({ length: n }, () => spawn({}, true));
    },
    onFrame(s, t, dt) {
      tNow = t;
      const { ctx, w, h } = s;
      locateCore(w, h);
      accentT += (accentTarget - accentT) * Math.min(1, dt * 4);
      const A: RGB = mix(pal.c1, pal.c2, accentT);
      const C3 = pal.c3;
      ctx.clearRect(0, 0, w, h);

      /* ---------- 代码粒子螺旋汇入 ---------- */
      if (parts.length) {
        let av: { l: number; t: number; r: number; b: number } | null = null;
        if (avoid) {
          const a = avoid.getBoundingClientRect();
          av = { l: a.left - rect.left - 30, t: a.top - rect.top - 20, r: a.right - rect.left + 30, b: a.bottom - rect.top + 20 };
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const p of parts) {
          if (dt) {
            p.age += dt;
            p.r -= (16 + 4200 / (p.r + 30)) * p.speed * dt;
            p.a += (0.05 + 30 / (p.r + 40)) * p.spin * dt;
          }
          if (p.r < core.r * 0.42) {
            energy += 0.04;
            spawn(p, false);
            continue;
          }
          const x = core.x + Math.cos(p.a) * p.r;
          const y = core.y + Math.sin(p.a) * p.r * 0.82; // 轻微椭圆，增加纵深感
          const near = Math.min(1, (p.r - core.r * 0.42) / (core.r * 1.1));
          const farFade = Math.min(1, Math.max(0, (p.far - p.r) / (p.far * 0.25)));
          let alpha = Math.min(1, p.age / 0.8) * near * farFade * (glass ? 0.29 : 0.62);
          if (glass) alpha *= Math.min(1, Math.max(0, (y - 85) / 85));
          if (av && x > av.l && x < av.r && y > av.t && y < av.b) {
            const edge = Math.min(x - av.l, av.r - x, y - av.t, av.b - y);
            alpha *= Math.max(0.08, 1 - edge / 60);
          }
          if (alpha < 0.02) continue;
          const size = glass ? 10 + 2 * Math.min(1, p.r / p.far) : 9 + 5 * Math.min(1, p.r / p.far);
          const col = p.hue < 0.42 ? pal.text : p.hue < 0.62 ? A : p.hue < 0.78 ? pal.c4 : p.hue < 0.9 ? pal.c5 : pal.c2;
          ctx.font = `${size.toFixed(1)}px "JetBrains Mono", Consolas, monospace`;
          ctx.fillStyle = rgba(col, alpha);
          if (glass && p.hue > 0.45) {
            ctx.beginPath(); ctx.arc(x, y, 0.8 + p.hue, 0, TAU); ctx.fill();
          } else ctx.fillText(p.txt, x, y);
        }
      }

      /* ---------- 检查核心 ---------- */
      const { x: cx, y: cy, r: R } = core;
      energy = Math.max(0, energy - dt * 0.02);
      if (energy >= 1 && !reduced) emit();
      pulse = Math.max(0, pulse - dt * 0.9);

      if (glass) {
        drawGlassOrb(ctx, pal, cx, cy, R, t, A, pulse);
        for (let i = bursts.length - 1; i >= 0; i--) {
          const age = t - bursts[i].t;
          if (age > 4.2) { bursts.splice(i, 1); continue; }
          const fraction = age / 4.2;
          ctx.strokeStyle = rgba(mix(A, pal.c5, fraction), (1 - fraction) ** 2 * 0.32);
          ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.arc(cx, cy, R * (0.95 + fraction * 1.6), 0, TAU); ctx.stroke();
        }
        return;
      }

      let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2.6);
      g.addColorStop(0, rgba(A, 0.28 + pulse * 0.25));
      g.addColorStop(0.45, rgba(A, 0.07));
      g.addColorStop(1, rgba(A, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 2.6, 0, TAU);
      ctx.fill();

      // 雷达扫描扇面
      const scan = t * 0.55;
      if ("createConicGradient" in ctx) {
        const cg = ctx.createConicGradient(scan, cx, cy);
        cg.addColorStop(0, rgba(A, 0.32));
        cg.addColorStop(0.16, rgba(A, 0));
        cg.addColorStop(1, rgba(A, 0));
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 1.02, 0, TAU);
        ctx.fill();
      }

      ctx.lineCap = "round";
      ctx.strokeStyle = rgba(pal.text, 0.14);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();

      // 刻度环：扫描经过处变亮
      const ticks = 72;
      for (let i = 0; i < ticks; i++) {
        const a = (i / ticks) * TAU;
        const diff = (((scan - a) % TAU) + TAU) % TAU;
        const lit = diff < 1 ? 1 - diff : 0;
        const long = i % 6 === 0;
        const r1 = R * 1.3,
          r2 = R * (long ? 1.4 : 1.35);
        ctx.strokeStyle = rgba(lit > 0 ? A : pal.text, 0.12 + lit * 0.7 + (long ? 0.1 : 0));
        ctx.lineWidth = long ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        ctx.stroke();
      }

      // 虚线旋转环 + 卫星点
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.12);
      ctx.setLineDash([2, 9]);
      ctx.strokeStyle = rgba(A, 0.55);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.16, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + t * 0.28;
        ctx.fillStyle = rgba([C3, pal.c4, pal.c5][i], 0.9);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * R * 1.16, Math.sin(a) * R * 1.16, 3, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      // 反向旋转的三色弧段
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-t * 0.22);
      ctx.lineWidth = 2.5;
      for (let i = 0; i < 3; i++) {
        ctx.strokeStyle = rgba([A, pal.c5, pal.c4][i], 0.75);
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.8, (i / 3) * TAU, (i / 3) * TAU + 1.1 + energy * 0.9);
        ctx.stroke();
      }
      ctx.restore();

      // 能量进度弧
      ctx.strokeStyle = rgba(A, 0.9);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.64, -Math.PI / 2, -Math.PI / 2 + Math.min(1, energy) * TAU);
      ctx.stroke();

      // 内核光球
      const orbR = R * (0.4 + pulse * 0.08 + Math.sin(t * 1.3) * 0.012);
      g = ctx.createRadialGradient(cx - orbR * 0.3, cy - orbR * 0.35, orbR * 0.05, cx, cy, orbR);
      g.addColorStop(0, rgba(mix(C3, [255, 255, 255], 0.35), 1));
      g.addColorStop(0.35, rgba(A, 0.95));
      g.addColorStop(0.75, rgba(mix(A, pal.c4, 0.6), 0.75));
      g.addColorStop(1, rgba(pal.c5, 0.3));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, orbR, 0, TAU);
      ctx.fill();

      // 爆发圆环
      for (let i = bursts.length - 1; i >= 0; i--) {
        const age = t - bursts[i].t;
        if (age > 2.2) {
          bursts.splice(i, 1);
          continue;
        }
        const e = 1 - Math.pow(1 - age / 2.2, 3);
        ctx.strokeStyle = rgba(A, (1 - age / 2.2) * 0.7);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, R * (0.5 + e * 2.2), 0, TAU);
        ctx.stroke();
      }
      // 火花
      for (let i = sparks.length - 1; i >= 0; i--) {
        const sp = sparks[i];
        sp.life -= dt * 0.6;
        if (sp.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        sp.vx *= 0.96;
        sp.vy *= 0.96;
        sp.x += sp.vx * dt;
        sp.y += sp.vy * dt;
        ctx.fillStyle = rgba(sp.hue > 0.66 ? pal.c5 : sp.hue > 0.33 ? pal.c4 : A, sp.life);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 1 + sp.life * 2, 0, TAU);
        ctx.fill();
      }
    },
  });

  function redrawStatic() {
    const s = loop.state;
    locateCore(s.w, s.h);
    s.ctx.clearRect(0, 0, s.w, s.h);
    drawGlassOrb(s.ctx, pal, core.x, core.y, core.r, 8, mix(pal.c1, pal.c2, accentTarget), 0);
  }

  return {
    setAccent(v) {
      accentTarget = v;
      if (reduced && glass) redrawStatic();
    },
    burst() {
      if (!reduced || !glass) emit();
    },
    boost(v) {
      energy += v;
    },
    setAnchor(el) {
      anchor = el;
      if (reduced && glass) redrawStatic();
    },
    setAvoid(el) {
      avoid = el;
    },
    destroy() {
      loop.destroy();
      offTheme();
      removeEventListener("scroll", onScroll);
    },
  };
}
