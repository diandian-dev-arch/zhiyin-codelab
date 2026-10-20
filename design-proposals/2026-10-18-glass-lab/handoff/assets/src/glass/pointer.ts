/**
 * Glass Lab · 共享指针
 * 全站只挂一个 pointermove 监听，所有动效读同一份坐标。
 */

export interface PointerState {
  x: number;
  y: number;
  /** 本次移动增量 */
  vx: number;
  vy: number;
  /** 指针是否在窗口内 */
  active: boolean;
}

export const pointer: PointerState = {
  x: typeof window !== "undefined" ? innerWidth / 2 : 0,
  y: typeof window !== "undefined" ? innerHeight / 2 : 0,
  vx: 0,
  vy: 0,
  active: false,
};

let installed = false;

export function installPointer(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
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
}

/**
 * 光标光晕：一个缓慢跟随指针的柔光圆。
 * 返回清理函数。触屏或减少动态效果时不创建。
 */
export function mountCursorGlow(enabled: boolean): () => void {
  if (!enabled) return () => {};
  installPointer();
  const el = document.createElement("div");
  el.className = "gl-cursor-glow";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  let x = pointer.x;
  let y = pointer.y;
  let raf = 0;
  const loop = () => {
    x += (pointer.x - x) * 0.07;
    y += (pointer.y - y) * 0.07;
    el.style.transform = `translate3d(${x}px,${y}px,0)`;
    el.classList.toggle("is-on", pointer.active);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    el.remove();
  };
}
