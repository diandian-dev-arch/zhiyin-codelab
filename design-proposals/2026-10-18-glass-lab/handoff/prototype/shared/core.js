/* ==========================================================
   Glass Lab · 共享交互核心（无依赖，file:// 可直接运行）
   暴露 window.GL：主题、调色板读取、性能分级、通用动效
   ========================================================== */
(function () {
  "use strict";

  // s: [底色, 主色, 绿, 暖伴色, 冷伴色]
  const THEMES = [
    { id: "bronze", name: "石墨·铜金", s: ["#0d0c0b", "#cda578", "#92b28e", "#d4907e", "#82acb2"] },
    { id: "celadon", name: "墨色·青瓷", s: ["#0a0f0f", "#8fbcaa", "#d2b680", "#d69682", "#94aac8"] },
    { id: "ochre", name: "炭灰·赭石", s: ["#110e0c", "#d28e6a", "#a6b27e", "#ce929e", "#80aca4"] },
    { id: "rose", name: "烟墨·灰玫", s: ["#100e10", "#ce9ea4", "#9cb69e", "#d8ba8c", "#96acc0"] },
  ];
  const KEY = "glasslab-theme";
  const root = document.documentElement;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

  // 性能分级：低端设备减少粒子与像素比
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8;
  let tier = cores <= 4 || mem <= 4 ? 1 : 2;
  if (!finePointer) tier = Math.min(tier, 1);

  const saved = (() => {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  })();
  root.dataset.theme = THEMES.some((t) => t.id === saved) ? saved : "bronze";

  /* ---------- 调色板（供 Canvas） ---------- */
  function rgbVar(name) {
    const v = getComputedStyle(root).getPropertyValue(name).trim().split(/\s+/).map(Number);
    return v.length === 3 ? v : [255, 255, 255];
  }
  let palette = null;
  function hexVar(name) {
    const h = getComputedStyle(root).getPropertyValue(name).trim().replace("#", "");
    return h.length === 6 ? [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) : [12, 12, 12];
  }
  function readPalette() {
    palette = {
      bg: hexVar("--bg"),
      c1: rgbVar("--c1-rgb"),
      c2: rgbVar("--c2-rgb"),
      c3: rgbVar("--c3-rgb"),
      c4: rgbVar("--c4-rgb"),
      c5: rgbVar("--c5-rgb"),
      text: rgbVar("--text-rgb"),
      muted: rgbVar("--muted-rgb"),
      surface: rgbVar("--surface-rgb"),
    };
    return palette;
  }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const mix = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];

  /* ---------- 主题切换：从点击处圆形揭示 ---------- */
  function setTheme(id, origin) {
    if (id === root.dataset.theme) return;
    const apply = () => {
      root.dataset.theme = id;
      try {
        localStorage.setItem(KEY, id);
      } catch (e) {}
      readPalette();
      syncDock();
      window.dispatchEvent(new CustomEvent("gl:theme", { detail: palette }));
    };
    if (!document.startViewTransition || reduced) return apply();
    const x = origin ? origin.x : innerWidth / 2;
    const y = origin ? origin.y : innerHeight / 2;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 900, easing: "cubic-bezier(0.65,0,0.35,1)", pseudoElement: "::view-transition-new(root)" }
      );
    });
  }

  let dock;
  function buildDock() {
    dock = document.createElement("div");
    dock.className = "theme-dock glass";
    dock.setAttribute("role", "group");
    dock.setAttribute("aria-label", "切换配色方案");
    dock.innerHTML =
      `<span class="label">配色 · <b></b></span>` +
      THEMES.map(
        (t) =>
          `<button class="swatch" data-id="${t.id}" aria-label="${t.name}" aria-pressed="false"
            style="--sb:${t.s[0]};--s1:${t.s[1]};--s2:${t.s[3]};--s3:${t.s[2]};--s4:${t.s[4]}"><span class="tip">${t.name}</span></button>`
      ).join("");
    dock.addEventListener("click", (e) => {
      const b = e.target.closest(".swatch");
      if (!b) return;
      const rect = b.getBoundingClientRect();
      setTheme(b.dataset.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    });
    document.body.appendChild(dock);
    syncDock();
  }
  function syncDock() {
    if (!dock) return;
    const cur = THEMES.find((t) => t.id === root.dataset.theme);
    dock.querySelector(".label b").textContent = cur.name;
    dock.querySelectorAll(".swatch").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.id === cur.id))
    );
  }

  /* ---------- 共享指针（所有动效读同一份） ---------- */
  const pointer = { x: innerWidth / 2, y: innerHeight / 2, active: false, vx: 0, vy: 0 };
  addEventListener(
    "pointermove",
    (e) => {
      pointer.vx = e.clientX - pointer.x;
      pointer.vy = e.clientY - pointer.y;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.active = true;
    },
    { passive: true }
  );
  document.addEventListener("pointerleave", () => (pointer.active = false));

  /* ---------- 光标光晕 ---------- */
  function cursorGlow() {
    if (!finePointer || reduced) return;
    const el = document.createElement("div");
    el.className = "cursor-glow";
    document.body.appendChild(el);
    let x = pointer.x,
      y = pointer.y;
    (function loop() {
      x += (pointer.x - x) * 0.07;
      y += (pointer.y - y) * 0.07;
      el.style.transform = `translate3d(${x}px,${y}px,0)`;
      el.classList.toggle("on", pointer.active);
      requestAnimationFrame(loop);
    })();
  }

  /* ---------- 磁吸按钮 ---------- */
  function magnetic(sel = "[data-magnetic]") {
    if (!finePointer || reduced) return;
    document.querySelectorAll(sel).forEach((el) => {
      const strength = parseFloat(el.dataset.magnetic) || 0.3;
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", (e.clientX - r.left - r.width / 2) * strength + "px");
        el.style.setProperty("--my", (e.clientY - r.top - r.height / 2) * strength + "px");
      });
      el.addEventListener("pointerleave", () => {
        el.style.setProperty("--mx", "0px");
        el.style.setProperty("--my", "0px");
      });
    });
  }

  /* ---------- 卡片 3D 倾斜 + 聚光 ---------- */
  function tilt(sel = "[data-tilt]") {
    document.querySelectorAll(sel).forEach((el) => {
      const max = parseFloat(el.dataset.tilt) || 8;
      let raf = 0;
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        el.style.setProperty("--sx", px * 100 + "%");
        el.style.setProperty("--sy", py * 100 + "%");
        if (!finePointer || reduced) return;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          el.style.transform = `perspective(900px) rotateX(${(0.5 - py) * max}deg) rotateY(${(px - 0.5) * max}deg) translateZ(0)`;
        });
      });
      el.addEventListener("pointerleave", () => {
        cancelAnimationFrame(raf);
        el.style.transform = "";
      });
    });
  }

  /* ---------- 入场显现 ---------- */
  function reveal(sel = ".reveal") {
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.15, rootMargin: "0px 0px -6% 0px" }
    );
    document.querySelectorAll(sel).forEach((el) => io.observe(el));
  }

  /* ---------- 逐字拆分（保留 <em>/<br> 等结构） ---------- */
  function split(el, base = 0) {
    let i = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((n) => {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          [...n.textContent].forEach((c) => {
            if (c === " " || c === "\n") return frag.appendChild(document.createTextNode(c));
            const s = document.createElement("span");
            s.className = "ch";
            s.style.setProperty("--i", i++);
            s.textContent = c;
            frag.appendChild(s);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1 && n.tagName !== "BR") walk(n);
      });
    };
    walk(el);
    el.style.setProperty("--base", base + "ms");
    el.classList.add("split");
    el.setAttribute("aria-label", el.textContent);
    return i;
  }

  /* ---------- 数字滚动 ---------- */
  function countUp(sel = "[data-count]") {
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (!e.isIntersecting) return;
          io.unobserve(e.target);
          const el = e.target;
          const to = parseFloat(el.dataset.count);
          const dur = reduced ? 1 : 1800;
          const t0 = performance.now();
          (function step(t) {
            const p = Math.min(1, (t - t0) / dur);
            const v = 1 - Math.pow(1 - p, 4);
            el.textContent = Math.round(to * v).toLocaleString("zh-CN");
            if (p < 1) requestAnimationFrame(step);
          })(t0);
        }),
      { threshold: 0.6 }
    );
    document.querySelectorAll(sel).forEach((el) => io.observe(el));
  }

  /* ---------- Canvas 辅助：DPR、可见性暂停、自适应降级 ---------- */
  function canvasLoop(canvas, { onResize, onFrame }) {
    const ctx = canvas.getContext("2d");
    let w = 0,
      h = 0,
      dpr = 1,
      running = false,
      visible = true,
      raf = 0,
      last = 0,
      slow = 0,
      frames = 0;
    const st = { ctx, get w() { return w; }, get h() { return h; }, quality: tier };
    function resize() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(devicePixelRatio || 1, st.quality >= 2 ? 2 : 1.5);
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      onResize && onResize(st);
      if (reduced) onFrame(st, 8, 0);
    }
    function frame(t) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      // 连续掉帧则降级一次
      if (dt > 0.024) slow++;
      if (++frames % 90 === 0) {
        if (slow > 45 && st.quality > 0) {
          st.quality--;
          resize();
        }
        slow = 0;
      }
      onFrame(st, t / 1000, dt);
    }
    function sync() {
      const should = visible && !document.hidden;
      if (should && !running) {
        running = true;
        last = 0;
        raf = requestAnimationFrame(frame);
      } else if (!should && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    }
    new ResizeObserver(resize).observe(canvas);
    new IntersectionObserver((es) => {
      visible = es[0].isIntersecting;
      sync();
    }).observe(canvas);
    document.addEventListener("visibilitychange", sync);
    resize();
    if (!reduced) sync();
    return st;
  }

  window.GL = {
    THEMES,
    reduced,
    finePointer,
    tier,
    pointer,
    get palette() {
      return palette || readPalette();
    },
    rgba,
    mix,
    setTheme,
    split,
    canvasLoop,
    init() {
      readPalette();
      buildDock();
      cursorGlow();
      magnetic();
      tilt();
      reveal();
      countUp();
    },
  };
})();
