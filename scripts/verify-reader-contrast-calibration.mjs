import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { auditRenderedContrast, auditScrollableContrast } from './reader-rendered-contrast.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 }, deviceScaleFactor: 1 });
  await page.setContent('<style>body { margin:0; background:#fff; } p { margin:0; font:20px/2 sans-serif; }</style><p class="black" style="color:#000">Contrast calibration</p><p class="pass" style="color:#767676">Contrast calibration</p><p class="fail" style="color:#777">Contrast calibration</p><p class="unsupported" style="color:#000;opacity:.5">Contrast calibration</p>');
  const result = await auditRenderedContrast(page, ['p']);
  const find = selector => result.observations.find(item => item.selector === selector);
  assert.ok(Math.abs(find('p.black').minimumRatio - 21) < .001);
  assert.ok(Math.abs(find('p.pass').minimumRatio - 4.5422249596) < .001);
  assert.equal(find('p.pass').state, 'passed');
  assert.equal(find('p.fail').state, 'below-threshold');
  assert.ok(Math.abs(find('p.fail').minimumRatio - 4.4780894536) < .001);
  assert.equal(find('p.unsupported').state, 'unsupported');
  await page.addStyleTag({ content: 'body::before { content:""; position:fixed; inset:0; pointer-events:none; background:rgb(92 69 43 / .11); mix-blend-mode:multiply; }' });
  const textured = await auditRenderedContrast(page, ['p.black']);
  assert.ok(textured.minimumRatio > 17 && textured.minimumRatio < 21, 'Composite background must differ from plain white');
  await page.addStyleTag({ content: 'body::before { mix-blend-mode:screen; }' });
  const unsupportedOverlay = await auditRenderedContrast(page, ['p.black']);
  assert.equal(unsupportedOverlay.observations[0].state, 'unsupported');
  assert.ok(unsupportedOverlay.observations[0].reasons.includes('unsupported-body-overlay'));
  await page.setContent('<style>body { margin:0; background:#fff; } p { margin:0; font:20px/2 sans-serif; color:#000; } .cover { position:fixed;inset:0 0 auto;height:20px;background:#666; }</style><p class="partly-covered">Partly covered calibration</p><div class="cover"></div>');
  const partlyCovered = await auditRenderedContrast(page, ['p']);
  assert.equal(partlyCovered.failures.length, 0, 'Occluding surfaces are not the text backdrop');
  assert.equal(partlyCovered.unsupported.length, 0);
  assert.ok(partlyCovered.observations[0].nonGlyphPixels > 0);
  assert.equal(partlyCovered.minimumRatio, 21);
  await page.locator('.cover').evaluate(element => element.remove());
  const uncovered = await auditRenderedContrast(page, ['p']);
  assert.ok(partlyCovered.observations[0].sampledPixels < uncovered.observations[0].sampledPixels, 'The fixture must actually cover glyphs, not only font-box whitespace');
  await page.setContent('<style>body { margin:0;background:#fff; } p { margin:0;font:20px/40px Arial;color:#000;background:linear-gradient(#fff 9px,#666 9px 10px,#fff 10px); }</style><p class="rule-outside-glyphs">000000</p>');
  const outsideRule = await auditRenderedContrast(page, ['p']);
  assert.equal(outsideRule.failures.length, 0, 'A rule inside the font box but outside glyphs is not their background');
  assert.equal(outsideRule.minimumRatio, 21);
  await page.setContent('<style>body { margin:0;background:#fff; } p { margin:0;font:20px/40px Arial;color:#000;background:linear-gradient(#fff 16px,#666 16px 20px,#fff 20px); }</style><p>000000</p>');
  const crossingRule = await auditRenderedContrast(page, ['p']);
  assert.equal(crossingRule.failures.length, 1, 'A low-contrast rule crossing painted glyphs must still fail');
  await page.setContent('<style>body { margin:0;background:#fff; } div { height:1px;overflow:hidden;transform:translateY(.25px); } p { position:relative;top:-9px;margin:0;font:20px/40px Arial;color:#000; }</style><div><p>Clipped glyph-free boundary</p></div>');
  const clipped = await auditRenderedContrast(page, ['p']);
  assert.equal(clipped.fragments, 0);
  assert.equal(clipped.unsupported.length, 0);
  assert.equal(clipped.excluded.length, 1, 'Glyph-free clipped slices must be recorded, not called a contrast pass');
  await page.setContent('<style>body { margin:0;background:#fff; } p { margin:0;font:20px/2 sans-serif;color:#000; } details::details-content { opacity:.5; }</style><p class="visible">Visible text</p><details><summary>Closed section</summary><p class="closed">Not painted</p></details><details open><summary>Open section</summary><p class="translucent-content">Painted through a translucent pseudo element</p></details>');
  assert.equal(await page.evaluate(() => CSS.supports('selector(::details-content)')), true, 'Disclosure calibration requires native details-content support');
  const disclosures = await auditRenderedContrast(page, ['p']);
  assert.ok(!disclosures.observations.some(item => item.selector === 'p.closed'), 'Unpainted closed disclosure content is not a contrast sample');
  assert.ok(disclosures.unsupported.some(item => item.selector === 'p.translucent-content' && item.reasons.includes('details-content-opacity')),
    'A translucent disclosure pseudo element must not be mistaken for an opaque ancestor');
  await page.addStyleTag({ content: 'details::details-content { opacity:1; }' });
  const opaqueDisclosure = await auditRenderedContrast(page, ['p.translucent-content']);
  assert.equal(opaqueDisclosure.minimumRatio, 21);
  assert.equal(opaqueDisclosure.unsupported.length, 0);
  assert.deepEqual(opaqueDisclosure.observations[0].minimumPixel.background, [255, 255, 255]);
  await page.setContent('<style>body { margin:0; background:#fff; } p { margin:0; font:20px/2 sans-serif; }</style><p style="color:#000">Top</p><div style="height:800px"></div><p class="offscreen-fail" style="color:#777">Bottom</p><aside class="evidence-pane" style="height:120px;overflow:auto"><pre style="height:80px;width:180px;overflow:auto;color:#000"><span style="display:block;height:400px;width:500px">Scrollable code</span><span class="nested-fail" style="color:#777">Nested bottom</span></pre></aside>');
  await page.evaluate(() => {
    window.scrollTo(0, 40);
    const code = document.querySelector('pre');
    code.scrollTop = 40;
    code.scrollLeft = 23;
  });
  const beforeScroll = await page.evaluate(() => scrollY);
  const readPositions = () => page.evaluate(() => [...document.querySelectorAll('html, aside, pre')].map(element => ({ x: element.scrollLeft, y: element.scrollTop })));
  const beforePositions = await readPositions();
  const scrolling = await auditScrollableContrast(page, ['p', '.evidence-pane']);
  assert.ok(scrolling.samples.some(sample => sample.failures.some(item => item.selector === 'p.offscreen-fail')));
  assert.ok(scrolling.samples.some(sample => sample.failures.some(item => item.selector === 'span.nested-fail')));
  assert.ok(scrolling.scrollers.some(scroller => scroller.offsets.some(offset => offset.x > 0)));
  assert.equal(await page.evaluate(() => scrollY), beforeScroll, 'Scroll audit must restore the initial reading position');
  assert.deepEqual(await readPositions(), beforePositions, 'Nested vertical and horizontal positions must also be restored');
  const stylesBefore = await page.locator('style').count();
  const failingPage = {
    locator: page.locator.bind(page), evaluateHandle: page.evaluateHandle.bind(page),
    evaluate: page.evaluate.bind(page), addStyleTag: page.addStyleTag.bind(page),
    screenshot: async () => { throw new Error('Injected screenshot failure'); },
  };
  await assert.rejects(auditScrollableContrast(failingPage, ['p', '.evidence-pane']), /Injected screenshot failure/);
  assert.deepEqual(await readPositions(), beforePositions, 'A failed measurement must not move the reader');
  assert.equal(await page.locator('style').count(), stylesBefore, 'A failed measurement must remove its temporary fill override');
  console.log(JSON.stringify({ state: 'passed', black: find('p.black').minimumRatio,
    passBoundary: find('p.pass').minimumRatio, failBoundary: find('p.fail').minimumRatio,
    transparentText: find('p.unsupported').state, compositedBlack: textured.minimumRatio,
    unsupportedOverlay: unsupportedOverlay.observations[0].state,
    partialOcclusionExcluded: partlyCovered.observations[0].nonGlyphPixels > 0,
    nonGlyphRuleExcluded: outsideRule.minimumRatio === 21, glyphCrossingRuleFails: crossingRule.failures.length === 1,
    clippedSliceRecorded: clipped.excluded.length === 1,
    closedDisclosureExcluded: true, translucentDisclosureUnsupported: true, opaqueDisclosureRatio: opaqueDisclosure.minimumRatio,
    scrollSamples: scrolling.samples.length, documentAndNestedFailuresFound: true, positionRestored: true,
    failureRestoresPositionsAndStyles: true }));
} finally { await browser.close(); }
