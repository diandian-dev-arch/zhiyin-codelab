// Supplement axe with actual composited background pixels, not token-color assumptions.
// Scope: opaque, dark text on a lighter background. Multiplying paper grain can only
// darken that foreground, so the unmodified fill color gives a conservative ratio.
export async function auditRenderedContrast(page, selectors) {
  const collection = await page.evaluate(selectors => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const colorContext = canvas.getContext('2d', { willReadFrequently: true });
    const modal = document.querySelector('dialog:modal');
    const roots = modal ? [modal] : selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
    const seen = new Set();
    const entries = [];
    const overlays = ['::before', '::after'].map(pseudo => {
      const css = getComputedStyle(document.body, pseudo);
      return { pseudo, content: css.content, blend: css.mixBlendMode, opacity: css.opacity,
        filter: css.filter, backdropFilter: css.backdropFilter };
    }).filter(overlay => overlay.content !== 'none' && overlay.content !== 'normal');
    const unsupportedOverlays = overlays.filter(overlay => overlay.blend !== 'multiply'
      || overlay.filter !== 'none' || overlay.backdropFilter !== 'none');
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (seen.has(node) || !node.textContent.trim()) continue;
        seen.add(node);
        const element = node.parentElement;
        if (!element || element.closest('script,style,svg,button:disabled,input:disabled,select:disabled')) continue;
        const style = getComputedStyle(element);
        if (style.visibility !== 'visible' || style.display === 'none') continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        const unsupported = new Set(unsupportedOverlays.length ? ['unsupported-body-overlay'] : []);
        let hiddenDisclosure = false;
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          const css = getComputedStyle(ancestor);
          if (Number(css.opacity) !== 1) unsupported.add('opacity');
          if (css.filter !== 'none') unsupported.add('filter');
          if (css.mixBlendMode !== 'normal') unsupported.add('blend-mode');
          if (css.clipPath !== 'none') unsupported.add('clip-path');
          if (ancestor.tagName === 'DETAILS' && !ancestor.querySelector(':scope > summary')?.contains(element)) {
            if (!ancestor.open) { hiddenDisclosure = true; break; }
            const content = getComputedStyle(ancestor, '::details-content');
            if (content.opacity && Number(content.opacity) !== 1) unsupported.add('details-content-opacity');
          }
          const box = ancestor.getBoundingClientRect();
          if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) {
            left = Math.max(left, box.left + ancestor.clientLeft);
            right = Math.min(right, box.left + ancestor.clientLeft + ancestor.clientWidth);
          }
          if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) {
            top = Math.max(top, box.top + ancestor.clientTop);
            bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight);
          }
        }
        if (hiddenDisclosure) continue;
        if (style.textShadow !== 'none' || parseFloat(style.webkitTextStrokeWidth) > 0) unsupported.add('text-effects');
        colorContext.clearRect(0, 0, 1, 1);
        colorContext.fillStyle = style.webkitTextFillColor || style.color;
        colorContext.fillRect(0, 0, 1, 1);
        const fill = [...colorContext.getImageData(0, 0, 1, 1).data];
        if (fill[3] !== 255) unsupported.add('transparent-fill');
        const selector = element.tagName.toLowerCase() + [...element.classList].map(name => `.${CSS.escape(name)}`).join('');
        const elementPath = [];
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          elementPath.unshift(`${ancestor.tagName.toLowerCase()}:nth-child(${[...ancestor.parentNode.children].indexOf(ancestor) + 1})`);
        }
        for (const box of range.getClientRects()) {
          const rect = { left: Math.max(left, box.left), top: Math.max(top, box.top),
            right: Math.min(right, box.right), bottom: Math.min(bottom, box.bottom) };
          if (rect.right - rect.left < 1 || rect.bottom - rect.top < 1) continue;
          const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
          if (!hit || (!element.contains(hit) && !hit.contains(element))) continue;
          entries.push({ selector, elementPath: elementPath.join(' > '), rect, fill, unsupported: [...unsupported] });
        }
      }
    }
    return { fragments: entries, overlays };
  }, selectors);
  // Preserve layout, backgrounds, pseudo elements, currentColor borders and paper grain.
  const glyphStyle = color => `* { -webkit-text-fill-color: ${color} !important; text-shadow: none !important; text-decoration-color: transparent !important; caret-color: transparent !important; }`;
  const hiding = await page.addStyleTag({ content: glyphStyle('transparent') });
  let background, blackGlyphs, whiteGlyphs;
  try {
    background = await page.screenshot({ scale: 'css', animations: 'disabled' });
    await hiding.evaluate((element, style) => { element.textContent = style; }, glyphStyle('#000'));
    blackGlyphs = await page.screenshot({ scale: 'css', animations: 'disabled' });
    await hiding.evaluate((element, style) => { element.textContent = style; }, glyphStyle('#fff'));
    whiteGlyphs = await page.screenshot({ scale: 'css', animations: 'disabled' });
  }
  finally { await hiding.evaluate(element => element.remove()); }
  return page.evaluate(async ({ png, black, white, fragments, overlays }) => {
    const decode = async encoded => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const backdropImage = await decode(png), blackImage = await decode(black), whiteImage = await decode(white);
    if (backdropImage.width !== blackImage.width || backdropImage.height !== blackImage.height
      || backdropImage.width !== whiteImage.width || backdropImage.height !== whiteImage.height) throw new Error('Contrast mask dimensions changed');
    const { width, height, pixels } = backdropImage;
    const linear = n => (n / 255 <= .04045 ? n / 255 / 12.92 : ((n / 255 + .055) / 1.055) ** 2.4);
    const luminance = rgb => .2126 * linear(rgb[0]) + .7152 * linear(rgb[1]) + .0722 * linear(rgb[2]);
    const observations = fragments.map(fragment => {
      if (fragment.unsupported.length) return { selector: fragment.selector, state: 'unsupported', reasons: fragment.unsupported };
      const element = document.querySelector(fragment.elementPath);
      const foreground = luminance(fragment.fill);
      let ratio = Infinity, minimumPixel = null, sampledPixels = 0, occludedPixels = 0, nonGlyphPixels = 0, reversed = false;
      const { rect } = fragment;
      for (let y = Math.max(0, Math.ceil(rect.top)); y < Math.min(height, Math.floor(rect.bottom)); y++) {
        for (let x = Math.max(0, Math.ceil(rect.left)); x < Math.min(width, Math.floor(rect.right)); x++) {
          const i = (y * width + x) * 4;
          // Black/white fill differences locate painted glyphs, not the surrounding
          // font box, whitespace or an unrelated rule crossing that box.
          const glyphDelta = [0, 1, 2].reduce((sum, channel) => sum + Math.abs(blackImage.pixels[i + channel] - whiteImage.pixels[i + channel]), 0);
          if (glyphDelta < 3) { nonGlyphPixels++; continue; }
          const backdrop = luminance([pixels[i], pixels[i + 1], pixels[i + 2]]);
          const candidate = (Math.max(backdrop, foreground) + .05) / (Math.min(backdrop, foreground) + .05);
          // A partly covered line can cross a sticky header's border even when its
          // center is visible. Only visible text pixels may set the minimum ratio.
          if (candidate < ratio || backdrop <= foreground) {
            const hit = document.elementFromPoint(x + .5, y + .5);
            if (!hit || !element || (!element.contains(hit) && !hit.contains(element))) { occludedPixels++; continue; }
          }
          if (backdrop <= foreground) reversed = true;
          if (candidate < ratio) minimumPixel = { x, y, background: [pixels[i], pixels[i + 1], pixels[i + 2]] };
          ratio = Math.min(ratio, candidate);
          sampledPixels++;
        }
      }
      const reasons = reversed ? ['foreground-not-darker-than-background'] : !sampledPixels ? ['no-visible-glyph-pixels'] : [];
      return { selector: fragment.selector, fill: fragment.fill, rect, sampledPixels, occludedPixels, nonGlyphPixels, minimumPixel,
        minimumRatio: Number.isFinite(ratio) ? ratio : null,
        state: !sampledPixels ? 'excluded' : reasons.length ? 'unsupported' : ratio >= 4.5 ? 'passed' : 'below-threshold', reasons };
    });
    return { method: 'opaque-dark-fill-vs-composited-background-with-glyph-mask', threshold: 4.5, overlays,
      scope: 'currently visible glyph pixels only; disabled controls, occluded/offscreen and glyph-free clipped fragments excluded and recorded',
      fragments: observations.filter(item => item.state !== 'excluded').length, passed: observations.filter(item => item.state === 'passed').length,
      failures: observations.filter(item => item.state === 'below-threshold'),
      unsupported: observations.filter(item => item.state === 'unsupported'),
      excluded: observations.filter(item => item.state === 'excluded'),
      minimumRatio: observations.reduce((min, item) => item.minimumRatio === null || item.minimumRatio === undefined || item.state === 'unsupported' ? min : Math.min(min, item.minimumRatio), Infinity),
      observations };
  }, { png: background.toString('base64'), black: blackGlyphs.toString('base64'), white: whiteGlyphs.toString('base64'), ...collection });
}

export async function auditScrollableContrast(page, selectors) {
  const modal = await page.locator('dialog:modal').count();
  const handles = modal ? [] : [await page.evaluateHandle(() => document.scrollingElement)];
  const nested = await page.evaluateHandle(selectors => {
    const modal = document.querySelector('dialog:modal');
    const roots = modal ? [modal] : selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
    return [...new Set(roots.flatMap(root => [root, ...root.querySelectorAll('*')]))].filter(element => {
      const css = getComputedStyle(element);
      return element.clientWidth > 0 && element.clientHeight > 0
        && ((/(auto|scroll)/.test(css.overflowX) && element.scrollWidth > element.clientWidth)
          || (/(auto|scroll)/.test(css.overflowY) && element.scrollHeight > element.clientHeight));
    });
  }, selectors);
  const properties = await nested.getProperties();
  for (const [key, handle] of properties) {
    if (/^\d+$/.test(key) && handle.asElement()) handles.push(handle.asElement());
    else await handle.dispose();
  }
  await nested.dispose();
  const originals = await Promise.all(handles.map(handle => handle.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }))));
  const restore = async () => {
    // Restore nested scrollers first, then the outer document.
    for (let i = handles.length - 1; i >= 0; i--) await handles[i].evaluate((element, position) => {
      element.scrollLeft = position.x;
      element.scrollTop = position.y;
    }, originals[i]);
  };
  const positions = (extent, visible) => {
    const max = Math.max(0, extent - visible);
    const steps = [];
    for (let value = 0; value < max; value += Math.max(1, Math.floor(visible * .75))) steps.push(value);
    steps.push(max);
    return steps;
  };
  const samples = [], scrollers = [];
  try {
    for (let i = 0; i < handles.length; i++) {
      await restore();
      const handle = handles[i];
      const size = await handle.evaluate(element => {
        if (element !== document.scrollingElement) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        return { tag: element.tagName, width: element.clientWidth, height: element.clientHeight,
          scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight };
      });
      if (!size.width || !size.height) continue;
      const offsets = [];
      for (const y of positions(size.scrollHeight, size.height)) {
        for (const x of positions(size.scrollWidth, size.width)) {
          const actual = await handle.evaluate((element, offset) => {
            element.scrollTop = offset.y;
            element.scrollLeft = offset.x;
            return { x: element.scrollLeft, y: element.scrollTop };
          }, { x, y });
          offsets.push(actual);
          samples.push({ scroller: i, offset: actual, ...await auditRenderedContrast(page, selectors) });
        }
      }
      scrollers.push({ index: i, ...size, originalPosition: originals[i], offsets });
    }
    return { scrollers, samples };
  } finally {
    try {
      await restore();
      for (let i = 0; i < handles.length; i++) {
        const actual = await handles[i].evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
        if (Math.abs(actual.x - originals[i].x) > .5 || Math.abs(actual.y - originals[i].y) > .5) throw new Error('Contrast audit did not restore a reading position');
      }
    }
    finally { await Promise.all(handles.map(handle => handle.dispose())); }
  }
}
