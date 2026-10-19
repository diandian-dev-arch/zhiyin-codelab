import assert from 'node:assert/strict';

// Base CSS colors only; does not certify textured overlays, focus or hover states.
export async function checkReaderContrast(page, selectors) {
  const results = await page.evaluate(selectors => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = css => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v);
    };
    const over = (front, back) => front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3])).concat(1);
    const luminance = color => color.slice(0, 3).map(v => {
      const c = v / 255;
      return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    return selectors.map(selector => {
      const element = [...document.querySelectorAll(selector)].find(e => e.checkVisibility());
      if (!element) return { selector, error: 'No visible target' };
      const ancestors = [];
      for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
      let background = [255, 255, 255, 1];
      for (const node of ancestors) {
        const style = getComputedStyle(node);
        if (Number(style.opacity) !== 1 || style.backgroundImage !== 'none' || style.filter !== 'none')
          return { selector, error: 'Unsupported opacity/image/filter: manual review required' };
        background = over(rgba(style.backgroundColor), background);
      }
      const style = getComputedStyle(element);
      const text = over(rgba(style.color), background);
      const a = luminance(text), b = luminance(background);
      return { selector, color: style.color, background: background.slice(0, 3), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  }, selectors);
  for (const result of results) {
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.ok(result.ratio >= 4.5, `Text contrast below 4.5:1: ${JSON.stringify(result)}`);
  }
  console.log('PASS base CSS text contrast (overlays excluded): ' + results.map(r => `${r.selector}=${r.ratio.toFixed(2)}:1`).join(', '));
}
