import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { auditNonTextContrast } from './reader-nontext-contrast.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>
    body { margin:20px; background:#fff; }
    button { display:block; margin:16px; width:100px; height:44px; background:#fff; border:2px solid #949494; }
    button:focus-visible { outline:2px dashed #949494; outline-offset:3px; }
    .marker { position:relative; border:0; }
    .marker::after { content:''; position:absolute; inset:auto 0 -2px; height:1.5px; background:#949494; }
  </style><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#949494" stroke-width="2"><path d="M6 6 18 18 M6 18 18 6" /></svg>
  <button>Outline</button><button class="marker">Selected</button>`);
  const svg = page.locator('svg'), button = page.locator('button').first(), marker = page.locator('.marker');
  const states = [];
  for (const kind of ['stroke', 'border', 'after', 'outline']) {
    const target = kind === 'stroke' ? svg : kind === 'after' ? marker : button;
    if (kind === 'outline') { await page.keyboard.press('Tab'); await button.focus(); assert.equal(await button.evaluate(el => el.matches(':focus-visible')), true); }
    const result = await auditNonTextContrast(page, target, kind);
    assert.equal(result.state, 'passed', `${kind}: ${JSON.stringify(result.reasons)}`);
    assert.ok(result.minimumRatio > 3 && result.minimumRatio < 3.04);
    assert.ok(result.sampledPixels > 0);
    states.push({ kind, ratio: result.minimumRatio, pixels: result.sampledPixels });
  }
  await page.addStyleTag({ content: 'svg { stroke:#959595; } button { border-color:#959595; } button:focus-visible { outline-color:#959595; } .marker::after { background:#959595; }' });
  for (const kind of ['stroke', 'border', 'after', 'outline']) {
    const result = await auditNonTextContrast(page, kind === 'stroke' ? svg : kind === 'after' ? marker : button, kind);
    assert.equal(result.state, 'below-threshold', `${kind} must detect the 3:1 failure`);
    assert.ok(result.minimumRatio < 3 && result.minimumRatio > 2.99);
  }
  await page.addStyleTag({ content: 'svg { opacity:.5; }' });
  assert.equal((await auditNonTextContrast(page, svg, 'stroke')).state, 'unsupported');
  await page.addStyleTag({ content: 'svg { opacity:1; } body::before { content:""; position:fixed; inset:0; pointer-events:none; background:rgb(92 69 43 / .11); mix-blend-mode:multiply; }' });
  const textured = await auditNonTextContrast(page, marker, 'after');
  assert.equal(textured.state, 'below-threshold');
  assert.ok(textured.minimumRatio < 2.99, 'Actual composited background must affect the result');
  await page.addStyleTag({ content: 'body::before { mix-blend-mode:screen; }' });
  assert.equal((await auditNonTextContrast(page, marker, 'after')).state, 'unsupported');
  await page.addStyleTag({ content: 'body::before { content:none; } button:focus-visible { outline-color:#949494; box-shadow:0 0 0 7px white; }' });
  assert.equal((await auditNonTextContrast(page, button, 'outline')).state, 'passed', 'A solid focus-clearance underlay is part of the rendered background');
  await page.addStyleTag({ content: 'svg { stroke:rgb(0 0 0 / .5); }' });
  assert.ok((await auditNonTextContrast(page, svg, 'stroke')).reasons.includes('transparent-paint'));
  await page.addStyleTag({ content: 'svg { stroke:#000; } .marker::after { opacity:.5; }' });
  assert.ok((await auditNonTextContrast(page, marker, 'after')).reasons.includes('opacity'));
  await page.addStyleTag({ content: '.marker::after { opacity:1; } button { border-top-color:black; }' });
  assert.ok((await auditNonTextContrast(page, button, 'border')).reasons.includes('multicolor-paint'));
  await page.addStyleTag({ content: 'body::before { content:none; } svg { visibility:hidden; }' });
  assert.equal((await auditNonTextContrast(page, svg, 'stroke')).state, 'unsupported');
  const stylesBefore = await page.locator('style').count();
  const paintBefore = await marker.evaluate(el => getComputedStyle(el, '::after').backgroundColor);
  await assert.rejects(auditNonTextContrast({ addStyleTag: page.addStyleTag.bind(page), screenshot: async () => { throw new Error('Injected screenshot failure'); } }, marker, 'after'), /Injected screenshot failure/);
  assert.equal(await page.locator('style').count(), stylesBefore);
  assert.equal(await marker.evaluate(el => getComputedStyle(el, '::after').backgroundColor), paintBefore);
  await page.addStyleTag({ content: '.cover { position:fixed; inset:0; background:white; z-index:100; }' });
  await page.evaluate(() => { const cover = document.createElement('div'); cover.className = 'cover'; document.body.append(cover); });
  assert.equal((await auditNonTextContrast(page, marker, 'after')).state, 'excluded', 'Fully occluded paint must not be called a pass');
  await page.locator('.cover').evaluate(el => el.remove());
  const displaced = await page.addStyleTag({ content: '.marker::after { bottom:100px; }' });
  const escaped = await auditNonTextContrast(page, marker, 'after');
  assert.equal(escaped.state, 'unsupported', 'A detached marker cannot pass by sampling the original target only');
  assert.ok(escaped.outsidePixels > 0);
  assert.ok(escaped.reasons.includes('paint-outside-target-bounds'));
  await displaced.evaluate(el => el.remove());
  await page.addStyleTag({ content: '.marker::after { display:none; }' });
  assert.equal((await auditNonTextContrast(page, marker, 'after')).state, 'unsupported');
  console.log(JSON.stringify({ state: 'passed', states, allFourKindsRejectBelow3: true, transparentAndUnsupportedOverlayRejected: true,
    compositedBackgroundMeasured: true, screenshotFailureRestoresStyle: true, hiddenTargetsNotPassed: true,
    opaqueFocusUnderlayMeasured: true, transparentPaintAndMulticolorRejected: true, fullyOccludedExcluded: true, displacedMarkerRejected: true }));
} finally { await browser.close(); }
