/* ==========================================================
   Glass Lab · 登录页交互
   ========================================================== */
(function () {
  "use strict";
  GL.init();
  const $ = (s) => document.querySelector(s);

  const liquid = GL.createLiquid($(".scene-liquid"), { anchor: $("#sceneCore") });
  const scene = GL.createScene($(".scene-canvas"), {
    anchor: $("#sceneCore"),
    avoid: $(".quote"),
    dots: false,
    onEmit: () => liquid.pulse(),
  });
  scene.boost(0.6);

  const ROLES = {
    teacher: {
      kicker: "For teachers",
      quote: "证据先行，<br /><em>判断</em>留给你。",
      en: "Evidence first. Judgement is yours.",
      word: "课程任务与复核",
      email: "teacher@codelab.local",
      wipe: "正在进入教师工作台…",
    },
    student: {
      kicker: "For students",
      quote: "每一次修改，<br />都<em>看得见</em>。",
      en: "Every revision, made visible.",
      word: "作业提交与证据报告",
      email: "student@codelab.local",
      wipe: "正在进入学生工作台…",
    },
  };

  const form = $("#form");
  const email = $("#email");
  const pwd = $("#password");
  const quote = $(".quote");
  const quoteText = $("#quoteText");
  const roleWord = $("#roleWord");
  let role = "teacher";

  form.addEventListener("animationend", (e) => {
    if (e.animationName === "card-in") form.style.animation = "none";
  });

  /* ---------- 身份切换：表单、场景、文案一起联动 ---------- */
  function setRole(next, focus) {
    if (next === role) return;
    role = next;
    const r = ROLES[role];
    document.body.dataset.role = role;
    document.querySelectorAll(".roles button").forEach((b) => {
      const on = b.dataset.role === role;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    scene.setAccent(role === "student" ? 1 : 0);
    liquid.setAccent(role === "student" ? 1 : 0);
    scene.burst();

    roleWord.classList.add("out");
    quote.classList.add("out");
    setTimeout(() => {
      roleWord.textContent = r.word;
      roleWord.classList.remove("out");
      $("#quoteKicker").textContent = r.kicker;
      $("#quoteEn").textContent = r.en;
      quoteText.innerHTML = r.quote;
      GL.split(quoteText, 0);
      quote.classList.remove("out");
    }, 260);

    // 若邮箱仍是另一身份的演示账号，逐字改写
    const other = ROLES[role === "teacher" ? "student" : "teacher"].email;
    if (!email.value || email.value === other) typeInto(email, r.email);
  }

  let typing = 0;
  function typeInto(input, text) {
    const id = ++typing;
    let cur = input.value;
    const common = (() => {
      let i = 0;
      while (i < cur.length && cur[i] === text[i]) i++;
      return i;
    })();
    (function back() {
      if (id !== typing) return;
      if (cur.length > common) {
        cur = cur.slice(0, -1);
        input.value = cur;
        return setTimeout(back, 14);
      }
      (function fwd() {
        if (id !== typing) return;
        if (cur.length < text.length) {
          cur = text.slice(0, cur.length + 1);
          input.value = cur;
          setTimeout(fwd, 26);
        }
      })();
    })();
  }

  const roleBtns = [...document.querySelectorAll(".roles button")];
  roleBtns.forEach((b) => {
    b.addEventListener("click", () => setRole(b.dataset.role));
    b.addEventListener("keydown", (e) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        setRole(role === "teacher" ? "student" : "teacher", true);
      }
    });
  });
  roleBtns[1].tabIndex = -1;

  /* ---------- 描边高光跟随光标 ---------- */
  addEventListener(
    "pointermove",
    (e) => {
      const r = form.getBoundingClientRect();
      form.style.setProperty("--gx", e.clientX - r.left + "px");
      form.style.setProperty("--gy", e.clientY - r.top + "px");
    },
    { passive: true }
  );

  /* ---------- 显示密码 ---------- */
  const peek = $("#peek");
  peek.addEventListener("click", () => {
    const show = pwd.type === "password";
    pwd.type = show ? "text" : "password";
    peek.setAttribute("aria-pressed", String(show));
    peek.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
    pwd.focus();
  });

  /* ---------- 校验与提交 ---------- */
  function setErr(input, msg) {
    const f = input.closest(".field");
    f.classList.toggle("bad", !!msg);
    f.querySelector(".err").textContent = msg || "";
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  }
  [email, pwd].forEach((i) => i.addEventListener("input", () => setErr(i, "")));

  const submit = $("#submit");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let bad = null;
    if (!email.value.trim()) bad = bad || (setErr(email, "请输入账号邮箱"), email);
    else if (!/^\S+@\S+\.\S+$/.test(email.value)) bad = bad || (setErr(email, "邮箱格式不正确"), email);
    if (pwd.value.length < 12) bad = bad || (setErr(pwd, "密码至少 12 位"), pwd);
    else setErr(pwd, "");
    if (bad) {
      form.classList.remove("shake");
      void form.offsetWidth;
      form.style.animation = "";
      form.classList.add("shake");
      setTimeout(() => {
        form.classList.remove("shake");
        form.style.animation = "none";
      }, 520);
      bad.focus();
      return;
    }

    submit.classList.add("loading");
    // 等待期间持续给核心充能
    const charge = setInterval(() => scene.boost(0.12), 120);
    setTimeout(() => {
      clearInterval(charge);
      submit.classList.remove("loading");
      submit.classList.add("done");
      scene.burst();
      setTimeout(() => {
        const r = submit.getBoundingClientRect();
        const wipe = $("#wipe");
        wipe.style.setProperty("--wx", r.left + r.width / 2 + "px");
        wipe.style.setProperty("--wy", r.top + r.height / 2 + "px");
        $("#wipeText").textContent = ROLES[role].wipe;
        wipe.classList.add("on");
        // 原型：展示完转场后复原，便于反复体验
        setTimeout(() => {
          wipe.classList.remove("on");
          submit.classList.remove("done");
          pwd.value = "";
        }, 2600);
      }, 520);
    }, 1300);
  });

  // 首次进入时标语逐字出现
  GL.split(quoteText, 600);
})();
