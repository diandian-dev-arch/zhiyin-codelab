/* ==========================================================
   Glass Lab · 场景引擎
   流体网点背景（鼠标波纹）+ 代码粒子螺旋汇入检查核心 + 证据爆发
   GL.createScene(canvas, { anchor, particles, onEmit })
   ========================================================== */
(function () {
  "use strict";
  const { rgba, mix } = GL;
  const TAU = Math.PI * 2;

  const TOKENS = [
    "<template>", "v-if", "v-for", "router.push", "ref()", "computed", "props",
    "emit()", "=>", "{{ }}", "const", "await", "onMounted", "v-model", "<form>",
    "export", "fetch()", "useRoute", "watch", ":key", "@click", "return", "</div>",
    "defineProps", "import", "async", "filter()", "[ ]", "{ }", "npm run build",
  ];

  GL.createScene = function (canvas, opts = {}) {
    const o = Object.assign({ particles: true, dots: true, density: 1, onEmit: null }, opts);
    let pal = GL.palette;
    let dots = new Float32Array(0);
    let spacing = 24;
    let rect = canvas.getBoundingClientRect();
    const ripples = [];
    const bursts = [];
    const sparks = [];
    let parts = [];
    let energy = 0;
    let pulse = 0;
    let accentT = 0; // 0 → c1，1 → c2（登录页身份切换）
    let accentTarget = 0;
    let core = { x: 0, y: 0, r: 80 };
    let lastRipple = 0;
    let tNow = 0;

    // 每帧复用的分桶缓冲（6 个亮度档，减少 fill 调用）
    const BUCKETS = 6;
    let buf = [];

    addEventListener("gl:theme", (e) => (pal = e.detail));
    addEventListener("scroll", () => (rect = canvas.getBoundingClientRect()), { passive: true });

    function locateCore(w, h) {
      if (o.anchor) {
        const a = o.anchor.getBoundingClientRect();
        core.x = a.left - rect.left + a.width / 2;
        core.y = a.top - rect.top + a.height / 2;
        core.r = Math.max(46, a.width / 2);
      } else {
        core.x = w / 2;
        core.y = h / 2;
        core.r = Math.min(w, h) * 0.16;
      }
    }

    function spawn(p, initial) {
      const far = Math.hypot(Math.max(core.x, 1), Math.max(core.y, 1)) * 0.95 + core.r;
      p.a = Math.random() * TAU;
      p.r = initial ? core.r * 1.3 + Math.random() * far : far * (0.75 + Math.random() * 0.35);
      p.far = far;
      p.txt = TOKENS[(Math.random() * TOKENS.length) | 0];
      p.age = initial ? 1 : 0;
      p.spin = 0.8 + Math.random() * 0.6;
      p.speed = 0.75 + Math.random() * 0.6;
      p.hue = Math.random();
      return p;
    }

    const st = GL.canvasLoop(canvas, {
      onResize(s) {
        rect = canvas.getBoundingClientRect();
        spacing = [32, 26, 22][s.quality] / o.density;
        const cols = Math.ceil(s.w / spacing) + 1;
        const rows = Math.ceil(s.h / spacing) + 1;
        dots = new Float32Array(cols * rows * 2);
        let k = 0;
        for (let j = 0; j < rows; j++)
          for (let i = 0; i < cols; i++) {
            // 奇数行错位，形成半调网屏
            dots[k++] = i * spacing + (j % 2 ? spacing / 2 : 0);
            dots[k++] = j * spacing;
          }
        buf = Array.from({ length: BUCKETS }, () => new Float32Array(cols * rows * 3));
        locateCore(s.w, s.h);
        const n = o.particles ? [24, 44, 72][s.quality] : 0;
        parts = Array.from({ length: n }, () => spawn({}, true));
      },
      onFrame: draw,
    });

    // 鼠标划过产生波纹，点击产生大波纹
    canvas.parentElement.addEventListener(
      "pointermove",
      (e) => {
        const now = performance.now();
        if (now - lastRipple < 90 || GL.reduced) return;
        if (Math.abs(GL.pointer.vx) + Math.abs(GL.pointer.vy) < 3) return;
        lastRipple = now;
        ripples.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, t: tNow, amp: 0.55 });
        if (ripples.length > 10) ripples.shift();
      },
      { passive: true }
    );
    canvas.parentElement.addEventListener("pointerdown", (e) => {
      ripples.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, t: tNow, amp: 1.4 });
    });

    function emit() {
      energy = 0;
      pulse = 1;
      bursts.push({ t: tNow });
      const n = 18;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + Math.random() * 0.3;
        const v = 70 + Math.random() * 90;
        sparks.push({ x: core.x, y: core.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, hue: Math.random() });
      }
      o.onEmit && o.onEmit();
    }

    function draw(s, t, dt) {
      tNow = t;
      const { ctx, w, h } = s;
      locateCore(w, h);
      accentT += (accentTarget - accentT) * Math.min(1, dt * 4);
      const A = mix(pal.c1, pal.c2, accentT);
        const C3 = pal.c3;
      ctx.clearRect(0, 0, w, h);

      /* ---------- 1. 流体网点 ---------- */
      const px = GL.pointer.x - rect.left;
      const py = GL.pointer.y - rect.top;
      const hasPtr = GL.pointer.active && px > -100 && py > -100 && px < w + 100 && py < h + 100;
      const counts = new Uint32Array(BUCKETS);
      const maxR = spacing * 0.17;
      for (let k = 0; o.dots && k < dots.length; k += 2) {
        const x = dots[k],
          y = dots[k + 1];
        let v =
          (Math.sin(x * 0.0105 + t * 0.55) +
            Math.sin(y * 0.0128 - t * 0.38) +
            Math.sin((x + y) * 0.0062 + t * 0.27)) /
          3;
        v = 0.18 + 0.22 * v; // 基础呼吸 0~0.4
        // 靠近核心的点更亮，形成引力场
        const dc = Math.hypot(x - core.x, y - core.y);
        if (dc < core.r * 3.2) v += (1 - dc / (core.r * 3.2)) * 0.32 * (1 + pulse);
        if (hasPtr) {
          const d = Math.hypot(x - px, y - py);
          if (d < 170) v += (1 - d / 170) ** 2 * 0.85;
        }
        for (let r = 0; r < ripples.length; r++) {
          const rp = ripples[r];
          const age = t - rp.t;
          const k2 = Math.hypot(x - rp.x, y - rp.y) - age * 380;
          if (k2 > -70 && k2 < 70) v += Math.cos((k2 / 70) * 1.5708) * rp.amp * Math.max(0, 1 - age / 1.8);
        }
        if (v < 0.05) continue;
        const b = Math.min(BUCKETS - 1, (v * BUCKETS) | 0);
        const arr = buf[b];
        const c = counts[b]++ * 3;
        arr[c] = x;
        arr[c + 1] = y;
        arr[c + 2] = Math.min(maxR, 0.5 + v * maxR);
      }
      for (let b = 0; b < BUCKETS; b++) {
        const n = counts[b];
        if (!n) continue;
        const tt = b / (BUCKETS - 1);
        ctx.fillStyle = rgba(mix(pal.muted, A, Math.min(1, tt * 1.3)), 0.16 + tt * 0.62);
        ctx.beginPath();
        const arr = buf[b];
        for (let i = 0; i < n * 3; i += 3) {
          ctx.moveTo(arr[i] + arr[i + 2], arr[i + 1]);
          ctx.arc(arr[i], arr[i + 1], arr[i + 2], 0, TAU);
        }
        ctx.fill();
      }
      for (let i = ripples.length - 1; i >= 0; i--) if (t - ripples[i].t > 1.8) ripples.splice(i, 1);

      /* ---------- 2. 代码粒子螺旋汇入 ---------- */
      if (parts.length) {
        // 避让区（正文）内粒子几乎透明，保证阅读
        let av = null;
        if (o.avoid) {
          const a = o.avoid.getBoundingClientRect();
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
          let alpha = Math.min(1, p.age / 0.8) * near * farFade * 0.62;
          if (av && x > av.l && x < av.r && y > av.t && y < av.b) {
            const edge = Math.min(x - av.l, av.r - x, y - av.t, av.b - y);
            alpha *= Math.max(0.08, 1 - edge / 60);
          }
          if (alpha < 0.02) continue;
          const size = 9 + 5 * Math.min(1, p.r / p.far);
          const col = p.hue < 0.42 ? pal.text : p.hue < 0.62 ? A : p.hue < 0.78 ? pal.c4 : p.hue < 0.9 ? pal.c5 : pal.c2;
          ctx.font = `${size.toFixed(1)}px "JetBrains Mono", Consolas, monospace`;
          ctx.fillStyle = rgba(col, alpha);
          ctx.fillText(p.txt, x, y);
        }
      }

      /* ---------- 3. 检查核心 ---------- */
      const { x: cx, y: cy, r: R } = core;
      energy = Math.max(0, energy - dt * 0.02);
      if (energy >= 1 && !GL.reduced) emit();
      pulse = Math.max(0, pulse - dt * 0.9);

      // 光晕
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
      if (ctx.createConicGradient) {
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
      // 外圈细线
      ctx.strokeStyle = rgba(pal.text, 0.14);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();

      // 刻度环：扫描经过处变亮
      const ticks = 72;
      for (let i = 0; i < ticks; i++) {
        const a = (i / ticks) * TAU;
        let diff = (((scan - a) % TAU) + TAU) % TAU;
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

      // 虚线旋转环
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
      // 卫星点
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + t * 0.28;
        ctx.fillStyle = rgba([C3, pal.c4, pal.c5][i], 0.9);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * R * 1.16, Math.sin(a) * R * 1.16, 3, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      // 反向旋转的弧段
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

      // 能量进度弧（满即爆发证据）
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
    }

    return {
      setAccent(v) {
        accentTarget = v;
      },
      burst() {
        emit();
      },
      boost(v) {
        energy += v;
      },
    };
  };
})();
