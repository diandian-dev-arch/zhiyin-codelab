// Glass Lab · 参考截图采集
// ---------------------------------------------------------------
// 用法（仓库根目录）：
//   node design-proposals/2026-10-18-glass-lab/handoff/tools/capture-screens.mjs
//   node design-proposals/2026-10-18-glass-lab/handoff/tools/capture-screens.mjs --base http://127.0.0.1:5174 --out output/glass-check
// 不带 --base：截取交付包内的 HTML 原型（file://），输出到 handoff/screenshots/。
// 带 --base：对实现后的 Vue 工作台截取同一组画面（需要已登录态的页面请自行扩展 SHOTS）。
// 依赖仓库已有的 @playwright/test 与已安装的 Chromium。
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), [])
);
const proto = resolve(here, "../prototype");
const out = resolve(args.out ?? resolve(here, "../screenshots"));
mkdirSync(out, { recursive: true });

const fileUrl = (p) => pathToFileURL(resolve(proto, p)).href;
const THEMES = ["bronze", "celadon", "ochre", "rose"];
const W = 1440,
  H = 900;

// 原型用 localStorage「glasslab-theme」记忆配色；Vue 实现用「codelab-theme」
const themeInit = (id) => `try{localStorage.setItem('glasslab-theme','${id}');localStorage.setItem('codelab-theme','${id}')}catch(e){}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name, { url, theme = "bronze", before, settle = 3800, full = false, width = W, height = H }) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(themeInit(theme));
  await page.goto(url, { waitUntil: "load" });
  await wait(1200);
  if (before) await before(page);
  await wait(settle);
  const file = resolve(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  console.log("✓", name);
}

const scrollToFlow = (ratio) => async (page) => {
  await page.evaluate((r) => {
    const f = document.getElementById("flow");
    scrollTo({ top: f.offsetTop + (f.offsetHeight - innerHeight) * r, behavior: "instant" });
  }, ratio);
};
const scrollToEl = (sel, block = "center") => async (page) => {
  await page.evaluate(
    ([s, b]) => document.querySelector(s)?.scrollIntoView({ block: b, behavior: "instant" }),
    [sel, block]
  );
};
// 在水面上点几下，让截图里能看到涟漪
const ripples = async (page) => {
  for (const [x, y] of [
    [0.74, 0.32],
    [0.86, 0.66],
  ]) {
    await page.mouse.click(W * x, H * y);
    await wait(500);
  }
};

// 优先使用 Playwright 自带版本；若与本机已下载的浏览器版本不一致，自动改用本机已有的 Chromium
function localChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = resolve(process.env.LOCALAPPDATA ?? resolve(process.env.HOME ?? "", ".cache"), "ms-playwright");
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs)
    for (const sub of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const f = resolve(root, d, sub);
      if (existsSync(f)) return f;
    }
  return undefined;
}
const launchArgs = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
let browser;
try {
  browser = await chromium.launch({ args: launchArgs });
} catch {
  browser = await chromium.launch({ args: launchArgs, executablePath: localChromium() });
}
const ctx = await browser.newContext({ deviceScaleFactor: 1 });

try {
  if (!args.base) {
    for (const t of THEMES) {
      const page = await ctx.newPage();
      await shot(page, `01-landing-hero-${t}`, { url: fileUrl("index.html"), theme: t, before: ripples, settle: 1600 });
      await page.close();
      const p2 = await ctx.newPage();
      await shot(p2, `05-login-teacher-${t}`, { url: fileUrl("login.html"), theme: t });
      await p2.close();
    }
    const steps = [
      ["02-landing-flow-start", scrollToFlow(0.18)],
      ["02-landing-flow-mid", scrollToFlow(0.62)],
      ["02-landing-flow-full", scrollToFlow(0.995)],
      ["03-landing-report", scrollToEl("#stage")],
      ["04-landing-features", scrollToEl(".bento", "start")],
      ["04-landing-stats-roles", scrollToEl(".stats", "start")],
      ["04-landing-outro", scrollToEl(".outro-card")],
    ];
    for (const [name, before] of steps) {
      const page = await ctx.newPage();
      await shot(page, name, { url: fileUrl("index.html"), before, settle: 4200 });
      await page.close();
    }
    {
      const page = await ctx.newPage();
      await shot(page, "06-login-student-bronze", {
        url: fileUrl("login.html"),
        before: async (p) => p.click('.roles button[data-role="student"]'),
      });
      await page.close();
    }
    {
      const page = await ctx.newPage();
      await shot(page, "07-login-mobile", { url: fileUrl("login.html"), width: 390, height: 844 });
      await page.close();
      const p2 = await ctx.newPage();
      await shot(p2, "07-landing-mobile", { url: fileUrl("index.html"), width: 390, height: 844 });
      await p2.close();
    }
    for (const t of ["bronze", "celadon"]) {
      const page = await ctx.newPage();
      await page.addInitScript(`document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.theme='${t}')`);
      await shot(page, `08-components-gallery-${t}`, {
        url: pathToFileURL(resolve(here, "../assets/gallery.html")).href,
        full: true,
        settle: 1500,
      });
      await page.close();
    }
  } else {
    const base = args.base.replace(/\/$/, "");
    for (const t of THEMES) {
      const page = await ctx.newPage();
      await shot(page, `vue-login-${t}`, { url: `${base}/`, theme: t });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log("输出目录：", out);
