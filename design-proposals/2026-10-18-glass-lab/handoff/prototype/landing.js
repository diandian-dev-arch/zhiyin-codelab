/* ==========================================================
   Glass Lab · 首页交互
   ========================================================== */
(function () {
  "use strict";
  GL.init();
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const SVG = "http://www.w3.org/2000/svg";
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

  /* ---------- 首屏：标题逐字 + 场景 + 证据卡轮换 ---------- */
  GL.split($("#heroTitle"), 450);

  const CASES = [
    ["pass", "E-01", "路由跳转", 'expect(url).toBe("/list")'],
    ["pass", "E-02", "列表渲染", "v-for · :key 唯一"],
    ["pass", "E-03", "详情页参数", "useRoute().params.id"],
    ["warn", "E-04", "空列表状态", "screenshot · 1280×800"],
    ["pass", "E-05", "加载态提示", 'aria-busy="true"'],
    ["pass", "E-06", "表单校验", "src/views/Form.vue:42"],
    ["pass", "E-07", "组件通信", "emit('update') × 3"],
    ["pass", "E-08", "构建产物", "npm run build · 0 error"],
  ];
  const cards = $$(".ev-card");
  const tpl = ([k, id, name, code]) =>
    `<div class="body"><header><span class="chip ${k}">${k === "pass" ? "通过" : "需关注"}</span><span class="mono id">${id}</span></header><h3>${name}</h3><code>${code}</code></div>`;
  // 初始三张对应 E-01 / E-04 / E-06
  [0, 3, 5].forEach((ci, i) => (cards[i].innerHTML = tpl(CASES[ci])));
  let caseIdx = 0;
  let slot = 0;
  const coreCount = $("#coreCount");

  const liquid = GL.createLiquid($(".hero-liquid"), { anchor: $("#coreAnchor") });
  const scene = GL.createScene($(".hero-canvas"), {
    anchor: $("#coreAnchor"),
    dots: false,
    avoid: $(".hero-copy"),
    onEmit() {
      liquid.pulse();
      caseIdx = (caseIdx + 1) % CASES.length;
      coreCount.textContent = `case ${String(caseIdx + 1).padStart(2, "0")}/08`;
      const card = cards[slot];
      slot = (slot + 1) % cards.length;
      card.classList.add("swap");
      setTimeout(() => {
        card.innerHTML = tpl(CASES[caseIdx]);
        card.classList.add("swap");
        requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("swap")));
        cards.forEach((c) => c.classList.toggle("lit", c === card));
        setTimeout(() => card.classList.remove("lit"), 2600);
      }, 560);
    },
  });
  // 首屏开场先蓄一点能量，让第一次爆发更快到来
  scene.boost(0.55);

  // 证据卡随指针做景深视差
  if (GL.finePointer && !GL.reduced) {
    const depth = [26, -18, 14];
    (function loop() {
      const nx = GL.pointer.x / innerWidth - 0.5;
      const ny = GL.pointer.y / innerHeight - 0.5;
      cards.forEach((c, i) => {
        c.style.setProperty("--px", (nx * depth[i]).toFixed(1) + "px");
        c.style.setProperty("--py", (ny * depth[i]).toFixed(1) + "px");
      });
      requestAnimationFrame(loop);
    })();
  }

  /* ---------- 导航：滚动隐藏 / 进度 / 当前分区 ---------- */
  const nav = $("#nav");
  let lastY = scrollY;
  addEventListener(
    "scroll",
    () => {
      const y = scrollY;
      nav.classList.toggle("hide", y > 240 && y > lastY + 2);
      if (y < lastY - 2) nav.classList.remove("hide");
      lastY = y;
      const max = document.documentElement.scrollHeight - innerHeight;
      nav.style.setProperty("--progress", (y / max).toFixed(4));
    },
    { passive: true }
  );
  const links = $$(".nav-links a");
  const secIO = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        if (!e.isIntersecting) return;
        links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id));
      }),
    { rootMargin: "-45% 0px -50% 0px" }
  );
  ["hero", "flow", "report", "features", "roles"].forEach((id) => secIO.observe(document.getElementById(id)));

  /* ---------- 证据树 ---------- */
  const tree = $("#tree");
  const trunk = $("#trunk");
  const trunkD =
    "M300 700 C 300 620, 262 560, 286 470 S 336 330, 304 250 S 268 120, 300 54";
  trunk.setAttribute("d", trunkD);
  $("#trunkShadow").setAttribute("d", trunkD);
  const trunkLen = trunk.getTotalLength();
  trunk.style.strokeDasharray = trunkLen;
  $("#trunkShadow").style.strokeDasharray = trunkLen;

  const ground = document.createElementNS(SVG, "ellipse");
  Object.entries({ cx: 300, cy: 704, rx: 170, ry: 16, class: "ground" }).forEach(([k, v]) => ground.setAttribute(k, v));
  $("#treeGround").appendChild(ground);

  const STAGES = [
    ["提交", "SUBMIT · ZIP"],
    ["执行", "EXECUTE · 8 CASES"],
    ["整理", "AGENT · 6 TOOLS"],
    ["复核", "TEACHER REVIEW"],
    ["复提", "COMPARE · v2"],
  ];
  const FRACS = [0.1, 0.3, 0.5, 0.7, 0.93];
  const nodes = [];
  const branchesG = $("#branches");
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(SVG, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    parent && parent.appendChild(n);
    return n;
  };

  FRACS.forEach((f, i) => {
    const p = trunk.getPointAtLength(trunkLen * f);
    const side = i === 4 ? 0 : i % 2 ? 1 : -1;
    const nx = i === 4 ? p.x : p.x + side * 150;
    const ny = i === 4 ? p.y - 4 : p.y - 46;
    const g = el("g", { class: "node" }, branchesG);
    // 每个阶段一个色相：提交 主色 → 执行 冷 → 整理 绿 → 复核 暖 → 复提 主色
    g.style.setProperty("--sc", `var(--c${[1, 5, 2, 4, 1][i]})`);
    let branch = null,
      bLen = 0;
    if (i !== 4) {
      branch = el(
        "path",
        { class: "branch", d: `M${p.x} ${p.y} Q ${p.x + side * 40} ${p.y - 50}, ${nx} ${ny}` },
        g
      );
      bLen = branch.getTotalLength();
      branch.style.strokeDasharray = bLen;
      branch.style.strokeDashoffset = bLen;
    }
    // 第二阶段：一根细枝挂着八片证据叶
    const leaves = [];
    if (i === 1) {
      const tx = nx + side * 46,
        ty = ny - 150;
      const twig = el("path", { class: "twig", d: `M${nx} ${ny - 22} Q ${nx - side * 18} ${ny - 90}, ${tx} ${ty}` }, g);
      const tl = twig.getTotalLength();
      twig.style.strokeDasharray = tl;
      twig.style.strokeDashoffset = tl;
      for (let k = 0; k < 8; k++) {
        const pt = twig.getPointAtLength(tl * (0.18 + k * 0.1));
        const up = k % 2 ? -1 : 1;
        leaves.push(
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
      g._twig = { el: twig, len: tl };
    }
    el("circle", { class: "node-halo", cx: nx, cy: ny, r: 54 }, g);
    const petals = el("g", { class: "petals", style: `transform-origin:${nx}px ${ny}px` }, g);
    for (let k = 0; k < 6; k++)
      el(
        "ellipse",
        {
          class: "petal" + (k % 2 ? " alt" : ""),
          cx: nx,
          cy: ny - 17,
          rx: 6.5,
          ry: 12,
          transform: `rotate(${k * 60} ${nx} ${ny})`,
        },
        petals
      );
    el("circle", { class: "node-pulse", cx: nx, cy: ny, r: 9 }, g);
    el("circle", { class: "node-core", cx: nx, cy: ny, r: 9 }, g);
    const lx = side === 0 ? nx + 40 : side > 0 ? nx + 36 : nx - 36;
    const anchor = side < 0 ? "end" : "start";
    const lab = el("text", { class: "node-label", x: lx, y: ny - 2, "text-anchor": anchor }, g);
    lab.textContent = STAGES[i][0];
    const sub = el("text", { class: "node-sub", x: lx, y: ny + 16, "text-anchor": anchor }, g);
    sub.textContent = STAGES[i][1];
    nodes.push({ g, f, branch, bLen, leaves, x: nx, y: ny });
  });

  // 复提回环：从顶端节点画一条虚线回到起点，表示两次证据对比
  const n0 = nodes[0],
    n4 = nodes[4];
  const loop = el(
    "path",
    {
      d: `M${n4.x + 14} ${n4.y + 10} C ${n4.x + 230} ${n4.y + 140}, ${n0.x + 420} ${n0.y - 160}, ${n0.x + 12} ${n0.y + 8}`,
      fill: "none",
      stroke: "var(--c2)",
      "stroke-width": 1.5,
      "stroke-dasharray": "3 7",
      opacity: 0,
    },
    branchesG
  );

  // 生长点的上升光尘
  const sparkG = $("#sparkles");
  const motes = Array.from({ length: GL.tier >= 2 ? 16 : 8 }, () => ({
    c: el("circle", { class: "sparkle", r: 1.6 }, sparkG),
    x: 0,
    y: 0,
    life: Math.random(),
    dx: 0,
  }));

  const steps = $$("#steps li");
  const pct = $("#flowPct");
  const flow = $("#flow");
  let sp = 0;
  let flowVisible = false;
  new IntersectionObserver((es) => (flowVisible = es[0].isIntersecting)).observe(flow);

  function flowFrame() {
    requestAnimationFrame(flowFrame);
    if (!flowVisible && sp > 0) return;
    const r = flow.getBoundingClientRect();
    const p = GL.reduced ? 1 : clamp(-r.top / (r.height - innerHeight));
    sp += (p - sp) * 0.06;
    if (Math.abs(p - sp) < 0.0005) sp = p;
    const g = clamp(sp / 0.96);
    const off = trunkLen * (1 - g);
    trunk.style.strokeDashoffset = off;
    $("#trunkShadow").style.strokeDashoffset = off;
    pct.textContent = String(Math.round(g * 100)).padStart(2, "0");

    let active = 0;
    nodes.forEach((n, i) => {
      const local = clamp((g - n.f) / 0.07);
      if (n.branch) n.branch.style.strokeDashoffset = n.bLen * (1 - local);
      const on = local >= 0.98 || (i === 4 && g >= n.f);
      n.g.classList.toggle("on", on);
      n.g.classList.toggle("bud", local > 0.5 || on);
      if (on) active = i;
      if (n.leaves.length) {
        const leafP = clamp((g - n.f - 0.05) / 0.13);
        n.g._twig.el.style.strokeDashoffset = n.g._twig.len * (1 - leafP);
        n.leaves.forEach((lf, k) => lf.classList.toggle("on", leafP > (k + 1) / 9));
      }
    });
    loop.setAttribute("opacity", g > 0.97 ? 0.8 : 0);
    loop.style.strokeDashoffset = -performance.now() / 60;
    steps.forEach((s, i) => {
      s.classList.toggle("on", i === active);
      s.classList.toggle("done", i < active);
    });

    // 光尘从当前生长尖端升起
    const tip = trunk.getPointAtLength(trunkLen * Math.max(0.01, g));
    motes.forEach((m) => {
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
    });
  }
  requestAnimationFrame(flowFrame);

  /* ---------- 空间浮层：指针视差 + 滚动入场角度 ---------- */
  const stage = $("#stage");
  const inner = $("#stageInner");
  let rx = 16,
    ry = -18,
    stageOn = false;
  new IntersectionObserver(
    (es) => {
      stageOn = es[0].isIntersecting;
      if (stageOn) stage.classList.add("in");
    },
    { threshold: 0.25 }
  ).observe(stage);
  (function stageFrame() {
    requestAnimationFrame(stageFrame);
    if (!stageOn) return;
    const r = stage.getBoundingClientRect();
    // 进入视口时从倾斜状态“摆正”
    const enter = clamp(1 - (r.top + r.height / 2 - innerHeight / 2) / innerHeight, 0, 1);
    let tx = (1 - enter) * 22,
      ty = -(1 - enter) * 16;
    if (GL.finePointer && !GL.reduced) {
      tx += (0.5 - (GL.pointer.y - r.top) / r.height) * 12;
      ty += ((GL.pointer.x - r.left) / r.width - 0.5) * 20;
    }
    if (GL.reduced) (tx = 0), (ty = 0);
    rx += (clamp(tx, -20, 26) - rx) * 0.045;
    ry += (clamp(ty, -24, 24) - ry) * 0.045;
    inner.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
  })();
})();
