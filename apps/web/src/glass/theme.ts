/**
 * Glass Lab · 运行环境探测与主题
 * - THEMES：四套配色（与 tokens.css 一一对应）
 * - applyTheme：切换配色，支持从点击点圆形揭示（View Transitions API）
 * - readPalette：从 CSS 变量读取当前配色，供 Canvas / WebGL 使用
 * - onThemeChange：订阅配色变化
 */

export type ThemeId = "bronze" | "celadon" | "ochre" | "rose";
export type RGB = [number, number, number];

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  /** [底色, 主色, 绿, 暖伴色, 冷伴色]，用于配色色板预览 */
  swatch: [string, string, string, string, string];
}

export interface Palette {
  bg: RGB;
  c1: RGB;
  c2: RGB;
  c3: RGB;
  c4: RGB;
  c5: RGB;
  text: RGB;
  muted: RGB;
  surface: RGB;
}

export const THEMES: ThemeMeta[] = [
  { id: "bronze", name: "石墨·铜金", swatch: ["#0d0c0b", "#cda578", "#92b28e", "#d4907e", "#82acb2"] },
  { id: "celadon", name: "墨色·青瓷", swatch: ["#0a0f0f", "#8fbcaa", "#d2b680", "#d69682", "#94aac8"] },
  { id: "ochre", name: "炭灰·赭石", swatch: ["#110e0c", "#d28e6a", "#a6b27e", "#ce929e", "#80aca4"] },
  { id: "rose", name: "烟墨·灰玫", swatch: ["#100e10", "#ce9ea4", "#9cb69e", "#d8ba8c", "#96acc0"] },
];
export const DEFAULT_THEME: ThemeId = "bronze";
const STORAGE_KEY = "codelab-theme";
const EVENT = "gl:theme";

const isBrowser = typeof window !== "undefined";

/** 是否要求减少动态效果 */
export const prefersReducedMotion = (): boolean =>
  isBrowser && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 是否为精确指针（鼠标/触控板）；触屏设备返回 false，关闭倾斜、磁吸等悬停效果 */
export const hasFinePointer = (): boolean =>
  isBrowser && matchMedia("(hover: hover) and (pointer: fine)").matches;

/**
 * 性能分级：0 低 / 1 中 / 2 高。
 * 低端或触屏设备减少粒子数量与渲染分辨率。
 */
export function perfTier(): 0 | 1 | 2 {
  if (!isBrowser) return 1;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8;
  let tier: 0 | 1 | 2 = cores <= 4 || mem <= 4 ? 1 : 2;
  if (!hasFinePointer()) tier = Math.min(tier, 1) as 0 | 1;
  if (cores <= 2) tier = 0;
  return tier;
}

function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

export function getTheme(): ThemeId {
  if (!isBrowser) return DEFAULT_THEME;
  const cur = document.documentElement.dataset.theme;
  return isThemeId(cur) ? cur : DEFAULT_THEME;
}

/** 应用启动时调用一次：恢复用户上次选择的配色 */
export function initTheme(): ThemeId {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* 隐私模式等情况下 localStorage 不可用 */
  }
  const id = isThemeId(saved) ? saved : DEFAULT_THEME;
  document.documentElement.dataset.theme = id;
  return id;
}

function parseTriplet(v: string): RGB {
  const n = v.trim().split(/\s+/).map(Number);
  return n.length === 3 && n.every((x) => !Number.isNaN(x)) ? (n as RGB) : [255, 255, 255];
}
function parseHex(v: string): RGB {
  const h = v.trim().replace("#", "");
  return h.length === 6 ? ([0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB) : [12, 12, 12];
}

export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const t = (name: string) => parseTriplet(cs.getPropertyValue(name));
  return {
    bg: parseHex(cs.getPropertyValue("--gl-bg")),
    c1: t("--gl-c1-rgb"),
    c2: t("--gl-c2-rgb"),
    c3: t("--gl-c3-rgb"),
    c4: t("--gl-c4-rgb"),
    c5: t("--gl-c5-rgb"),
    text: t("--gl-text-rgb"),
    muted: t("--gl-muted-rgb"),
    surface: t("--gl-surface-rgb"),
  };
}

export function onThemeChange(cb: (p: Palette, id: ThemeId) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<{ palette: Palette; id: ThemeId }>).detail;
    cb(d.palette, d.id);
  };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/**
 * 切换配色。传入 origin（通常是点击按钮的中心）时，新配色从该点圆形展开。
 */
export function applyTheme(id: ThemeId, origin?: { x: number; y: number }): void {
  if (id === getTheme()) return;
  const root = document.documentElement;
  const commit = () => {
    root.dataset.theme = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* 忽略 */
    }
    const palette = readPalette();
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { palette, id } }));
  };
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> };
  };
  if (!doc.startViewTransition || prefersReducedMotion()) return commit();
  const x = origin?.x ?? innerWidth / 2;
  const y = origin?.y ?? innerHeight / 2;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = doc.startViewTransition(commit);
  vt.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 900, easing: "cubic-bezier(0.65,0,0.35,1)", pseudoElement: "::view-transition-new(root)" }
    );
  });
}

export const rgba = (c: RGB, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
