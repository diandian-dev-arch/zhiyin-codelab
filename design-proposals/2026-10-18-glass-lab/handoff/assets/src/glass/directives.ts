/**
 * Glass Lab · Vue 指令
 * ---------------------------------------------------------------
 * v-gl-reveal       进入视口时添加 .is-in（配合 .gl-reveal）；可传延迟秒数 v-gl-reveal="0.1"
 * v-gl-spotlight    卡片跟随光标的聚光（写入 --sx/--sy），不移动元素，工作台可用
 * v-gl-tilt         3D 倾斜 + 聚光；会移动元素 —— 只用于首页/登录等展示区，
 *                   工作台禁用（DESIGN.md：悬停不得移动可点击目标）
 * v-gl-magnetic     磁吸按钮（同上，只用于展示区）；可传强度 v-gl-magnetic="0.25"
 * v-gl-count        数字从 0 滚动到绑定值：v-gl-count="917"；值必须来自真实数据
 * v-gl-split        标题逐字上浮：v-gl-split 或 v-gl-split="450"（起始延迟 ms）
 *
 * 所有指令在 prefers-reduced-motion 或触屏设备上自动降级。
 */
import type { Directive } from "vue";
import { hasFinePointer, prefersReducedMotion } from "./theme";
import { splitText } from "./split-text";

type El = HTMLElement & { __gl?: () => void };

function cleanup(el: El) {
  el.__gl?.();
  delete el.__gl;
}

export const vGlReveal: Directive<El, number | undefined> = {
  mounted(el, binding) {
    el.classList.add("gl-reveal");
    if (binding.value) el.style.setProperty("--gl-delay", `${binding.value}s`);
    if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          el.classList.add("is-in");
          io.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -6% 0px" }
    );
    io.observe(el);
    el.__gl = () => io.disconnect();
  },
  unmounted: cleanup,
};

function bindSpot(el: El, withTilt: boolean, max: number) {
  let raf = 0;
  const canTilt = withTilt && hasFinePointer() && !prefersReducedMotion();
  const move = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    el.style.setProperty("--sx", `${px * 100}%`);
    el.style.setProperty("--sy", `${py * 100}%`);
    if (!canTilt) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      el.style.transform = `perspective(900px) rotateX(${(0.5 - py) * max}deg) rotateY(${(px - 0.5) * max}deg)`;
    });
  };
  const leave = () => {
    cancelAnimationFrame(raf);
    if (canTilt) el.style.transform = "";
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerleave", leave);
  el.__gl = () => {
    cancelAnimationFrame(raf);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerleave", leave);
  };
}

export const vGlSpotlight: Directive<El> = {
  mounted(el) {
    bindSpot(el, false, 0);
  },
  unmounted: cleanup,
};

export const vGlTilt: Directive<El, number | undefined> = {
  mounted(el, binding) {
    bindSpot(el, true, binding.value ?? 6);
  },
  unmounted: cleanup,
};

export const vGlMagnetic: Directive<El, number | undefined> = {
  mounted(el, binding) {
    if (!hasFinePointer() || prefersReducedMotion()) return;
    const k = binding.value ?? 0.3;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${(e.clientX - r.left - r.width / 2) * k}px`);
      el.style.setProperty("--my", `${(e.clientY - r.top - r.height / 2) * k}px`);
    };
    const leave = () => {
      el.style.setProperty("--mx", "0px");
      el.style.setProperty("--my", "0px");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    el.__gl = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  },
  unmounted: cleanup,
};

function runCount(el: El, to: number) {
  const fmt = (v: number) => Math.round(v).toLocaleString("zh-CN");
  if (prefersReducedMotion()) {
    el.textContent = fmt(to);
    return;
  }
  const from = Number(el.dataset.glCount ?? 0);
  el.dataset.glCount = String(to);
  const t0 = performance.now();
  const dur = 1800;
  let raf = 0;
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - p, 4)));
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

export const vGlCount: Directive<El, number> = {
  mounted(el, binding) {
    el.textContent = "0";
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const stop = runCount(el, binding.value);
        el.__gl = stop;
      },
      { threshold: 0.6 }
    );
    io.observe(el);
    el.__gl = () => io.disconnect();
  },
  updated(el, binding) {
    if (binding.value !== binding.oldValue && el.dataset.glCount !== undefined) {
      cleanup(el);
      el.__gl = runCount(el, binding.value);
    }
  },
  unmounted: cleanup,
};

export const vGlSplit: Directive<El, number | undefined> = {
  mounted(el, binding) {
    if (prefersReducedMotion()) return;
    splitText(el, binding.value ?? 0);
  },
};
