// Glass Lab · 对比度检查
// 用法：node design-proposals/2026-10-18-glass-lab/handoff/tools/contrast-check.mjs [tokens.css 路径]
// 读取 tokens.css 中四套配色，计算关键前景/背景组合的 WCAG 对比度。
// 标准（来自 apps/web/DESIGN.md）：正文与次级文字 ≥ 4.5:1；控件边框、图标等非文字 ≥ 3:1。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(process.argv[2] ?? resolve(here, "../assets/src/styles/glass/tokens.css"));
const css = readFileSync(file, "utf8");

const blocks = {};
for (const m of css.matchAll(/html\[data-theme="(\w+)"\]\s*\{([^}]*)\}/g)) blocks[m[1]] = m[2];
const rootFirst = css.match(/:root,\s*html\[data-theme="bronze"\]\s*\{([^}]*)\}/);
if (rootFirst) blocks.bronze = rootFirst[1];

const triplet = (body, name) => {
  const m = body.match(new RegExp(`--gl-${name}-rgb:\\s*([\\d\\s]+);`));
  return m ? m[1].trim().split(/\s+/).map(Number) : null;
};
const hex = (body, name) => {
  const m = body.match(new RegExp(`--gl-${name}:\\s*#([0-9a-fA-F]{6})`));
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
};
const lin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const over = (fg, a, bg) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));

let fail = 0;
const row = (theme, label, r, min) => {
  const ok = r >= min;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${theme.padEnd(8)} ${label.padEnd(30)} ${r.toFixed(2).padStart(6)} : 1  (≥ ${min})`);
};

for (const [theme, body] of Object.entries(blocks)) {
  const bg = hex(body, "bg");
  const surface = triplet(body, "surface");
  const text = triplet(body, "text");
  const muted = triplet(body, "muted");
  const glass = over(surface, 0.78, bg); // --gl-glass-strong 叠在底色上
  const control = over(text, 0.4, bg); // --gl-control-line
  const onC1 = hex(body, "on-c1");
  for (const [label, fg, back, min] of [
    ["正文 / 底色", text, bg, 4.5],
    ["次级文字 / 底色", muted, bg, 4.5],
    ["次级文字 / 玻璃面板", muted, glass, 4.5],
    ["主色文字 c1 / 底色", triplet(body, "c1"), bg, 4.5],
    ["绿 c2 / 底色", triplet(body, "c2"), bg, 4.5],
    ["暖 c4 / 底色", triplet(body, "c4"), bg, 4.5],
    ["冷 c5 / 底色", triplet(body, "c5"), bg, 4.5],
    ["主按钮文字 on-c1 / c1", onC1, triplet(body, "c1"), 4.5],
    ["学生主按钮 on-c1 / c2", onC1, triplet(body, "c2"), 4.5],
    ["控件边框 / 底色", control, bg, 3],
  ])
    row(theme, label, ratio(fg, back), min);
  console.log("");
}
console.log(fail ? `✗ ${fail} 项未达标` : "✓ 全部达标");
process.exit(fail ? 1 : 0);
