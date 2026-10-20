/**
 * Glass Lab · 入口
 *   import { GlassLab } from "./glass";
 *   app.use(GlassLab);              // 注册指令、恢复配色、挂光标光晕
 * 样式需另行引入（顺序见 02-IMPLEMENTATION_PLAN.md §2）。
 */
import type { App } from "vue";
import { initTheme, hasFinePointer, prefersReducedMotion } from "./theme";
import { installPointer, mountCursorGlow } from "./pointer";
import { vGlReveal, vGlSpotlight, vGlTilt, vGlMagnetic, vGlCount, vGlSplit } from "./directives";

export * from "./theme";
export * from "./pointer";
export * from "./liquid";
export * from "./evidence-core";
export * from "./canvas-loop";
export * from "./split-text";
export * from "./directives";

export interface GlassLabOptions {
  /** 是否挂载跟随光标的柔光（默认 true；仅精确指针设备生效） */
  cursorGlow?: boolean;
}

export const GlassLab = {
  install(app: App, opts: GlassLabOptions = {}) {
    if (typeof window === "undefined") return;
    initTheme();
    installPointer();
    if (opts.cursorGlow !== false) mountCursorGlow(hasFinePointer() && !prefersReducedMotion());
    app.directive("gl-reveal", vGlReveal);
    app.directive("gl-spotlight", vGlSpotlight);
    app.directive("gl-tilt", vGlTilt);
    app.directive("gl-magnetic", vGlMagnetic);
    app.directive("gl-count", vGlCount);
    app.directive("gl-split", vGlSplit);
  },
};
