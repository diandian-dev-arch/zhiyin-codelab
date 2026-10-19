import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out = 'output/login-orb-2026-10-19';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const results = [], errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  for (const theme of ['bronze', 'celadon', 'ochre', 'rose']) {
    await page.addInitScript(t => localStorage.setItem('codelab-theme', t), theme);
    await page.goto('http://localhost:5345/');
    await page.locator('#login-title').waitFor();
    await page.waitForTimeout(3200);
    await page.screenshot({ path: `${out}/${theme}-teacher-desktop.png` });
    const canvas = page.locator('.gl-evidence-core');
    const before = await canvas.evaluate(el => {
      const c = el.getContext('2d'), p = c.getImageData(0, 0, el.width, el.height).data;
      let painted = 0; for (let i = 3; i < p.length; i += 4) if (p[i] > 40) painted++;
      return { painted, image: el.toDataURL() };
    });
    assert(before.painted > 1000, `${theme}: empty sphere canvas`);
    await page.waitForTimeout(400);
    assert.notEqual(await canvas.evaluate(el => el.toDataURL()), before.image, `${theme}: animation is frozen`);
    await page.getByRole('button', { name: '学生', exact: true }).click();
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${out}/${theme}-student-desktop.png` });
    results.push({ theme, painted: before.painted });
  }
  for (const width of [320, 375, 390, 414, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(300);
    const measure = await page.evaluate(() => ({
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      core: document.querySelector('.scene-core').getBoundingClientRect().toJSON(),
      scene: document.querySelector('.login-intro').getBoundingClientRect().toJSON(),
    }));
    assert(measure.documentWidth <= width, `overflow at ${width}`);
    results.push(measure);
    if (width === 390) await page.screenshot({ path: `${out}/student-mobile.png`, fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://localhost:5345/'); await page.locator('#login-title').waitFor();
  const canvas = page.locator('.gl-evidence-core');
  const staticBefore = await canvas.evaluate(el => el.toDataURL());
  await page.waitForTimeout(250);
  assert.equal(await canvas.evaluate(el => el.toDataURL()), staticBefore, 'reduced motion must remain static');
  await page.getByRole('button', { name: '学生', exact: true }).click();
  assert.notEqual(await canvas.evaluate(el => el.toDataURL()), staticBefore, 'static sphere must update its role color');
  const roleImage = await canvas.evaluate(el => el.toDataURL());
  await page.waitForTimeout(250);
  assert.equal(await canvas.evaluate(el => el.toDataURL()), roleImage, 'role change must not start a reduced-motion loop');
  await page.screenshot({ path: `${out}/reduced-mobile.png` });
  await page.getByLabel('密码', { exact: true }).focus();
  assert.notEqual(await page.getByLabel('密码', { exact: true }).evaluate(e => getComputedStyle(e).outlineStyle), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://localhost:5345/'); await page.locator('#login-title').waitFor();
  const performance = await page.evaluate(async () => {
    const tasks = [], frames = [];
    const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => e.duration)));
    observer.observe({ type: 'longtask' });
    await new Promise(resolve => {
      let first, last;
      const frame = now => {
        first ??= now; if (last) frames.push(now - last); last = now;
        if (now - first < 10000) requestAnimationFrame(frame); else resolve();
      }; requestAnimationFrame(frame);
    });
    observer.disconnect(); frames.sort((a, b) => a - b);
    return { longTasks: tasks, p95FrameMs: frames[Math.floor(frames.length * 0.95)] };
  });
  const cycles = [];
  for (let i = 0; i < 5; i++) {
    await page.getByRole('link', { name: '了解 CodeLab →', exact: true }).click();
    await page.locator('.hero-copy h1').waitFor();
    assert.equal(await page.locator('canvas').count(), 2);
    await page.getByRole('link', { name: '进入工作台', exact: true }).click();
    await page.locator('#login-title').waitFor();
    cycles.push(await page.locator('canvas').count());
    assert.equal(cycles.at(-1), 2);
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${out}/results.json`, JSON.stringify({ results, errors, performance, cycles, reducedMotion: 'static, role-responsive', focus: 'visible' }, null, 2));
  console.log(JSON.stringify({ themes: 4, widths: 7, reducedMotion: 'pass', performance, cycles, errors }));
} finally { await browser.close(); }
