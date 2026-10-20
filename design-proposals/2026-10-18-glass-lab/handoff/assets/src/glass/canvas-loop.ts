/**
 * Glass Lab · Canvas 2D 渲染循环
 * 处理 DPR、尺寸变化、滚出视口/页面隐藏时暂停、持续掉帧自动降档。
 */
import { perfTier, prefersReducedMotion } from "./theme";

export interface LoopState {
  ctx: CanvasRenderingContext2D;
  readonly w: number;
  readonly h: number;
  /** 0 低 / 1 中 / 2 高；掉帧时会自动下降 */
  quality: 0 | 1 | 2;
}

export interface LoopHandle {
  state: LoopState;
  destroy(): void;
}

export function canvasLoop(
  canvas: HTMLCanvasElement,
  hooks: { onResize?: (s: LoopState) => void; onFrame: (s: LoopState, t: number, dt: number) => void }
): LoopHandle {
  const ctx = canvas.getContext("2d")!;
  const reduced = prefersReducedMotion();
  let w = 0,
    h = 0,
    running = false,
    visible = true,
    raf = 0,
    last = 0,
    slow = 0,
    frames = 0;
  const state: LoopState = {
    ctx,
    get w() {
      return w;
    },
    get h() {
      return h;
    },
    quality: perfTier(),
  };

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, state.quality >= 2 ? 2 : 1.5);
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hooks.onResize?.(state);
    if (reduced) hooks.onFrame(state, 8, 0);
  }
  function frame(t: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    if (dt > 0.024) slow++;
    if (++frames % 90 === 0) {
      if (slow > 45 && state.quality > 0) {
        state.quality = (state.quality - 1) as 0 | 1;
        resize();
      }
      slow = 0;
    }
    hooks.onFrame(state, t / 1000, dt);
  }
  function sync() {
    const should = visible && !document.hidden && !reduced;
    if (should && !running) {
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    } else if (!should && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const io = new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
    sync();
  });
  io.observe(canvas);
  document.addEventListener("visibilitychange", sync);
  resize();
  sync();

  return {
    state,
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    },
  };
}
