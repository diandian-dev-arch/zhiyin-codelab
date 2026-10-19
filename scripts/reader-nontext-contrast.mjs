// A bounded companion to the text audit: opaque dark strokes/markers on lighter
// backgrounds. Black/white masks locate painted pixels, including thin outlines.
export async function auditNonTextContrast(page, target, kind) {
  if (!['stroke', 'outline', 'border', 'before', 'after'].includes(kind)) throw new Error('Unknown non-text contrast kind');
  const data = await target.evaluate((element, kind) => {
    const pseudo = kind === 'before' || kind === 'after' ? `::${kind}` : null;
    const css = getComputedStyle(element, pseudo);
    const reasons = new Set();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const parse = color => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const check = style => {
      if (Number(style.opacity) !== 1) reasons.add('opacity');
      if (style.filter !== 'none' || style.backdropFilter !== 'none') reasons.add('filter');
      if (style.mixBlendMode !== 'normal') reasons.add('blend-mode');
      if (style.clipPath !== 'none') reasons.add('clip-path');
      if (style.visibility !== 'visible' || style.display === 'none') reasons.add('not-visible');
    };
    const chain = [];
    for (let node = element; node; node = node.parentElement) {
      chain.unshift(`${node.tagName.toLowerCase()}:nth-child(${[...node.parentNode.children].indexOf(node) + 1})`);
      check(getComputedStyle(node));
      if (node.tagName === 'DETAILS' && !node.querySelector(':scope > summary')?.contains(element)) {
        if (!node.open) reasons.add('closed-disclosure');
        else if (Number(getComputedStyle(node, '::details-content').opacity) !== 1) reasons.add('details-content-opacity');
      }
    }
    const selector = chain.join(' > ');
    const overlays = ['::before', '::after'].map(pseudo => {
      const style = getComputedStyle(document.body, pseudo);
      return { pseudo, content: style.content, blend: style.mixBlendMode, filter: style.filter, backdropFilter: style.backdropFilter };
    }).filter(item => item.content !== 'none' && item.content !== 'normal');
    if (overlays.some(item => item.blend !== 'multiply' || item.filter !== 'none' || item.backdropFilter !== 'none')) reasons.add('unsupported-body-overlay');
    let colors = [], property, paintSelector = selector;
    if (kind === 'stroke') {
      if (element.tagName.toLowerCase() !== 'svg') reasons.add('not-svg');
      const shapes = [...element.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')];
      if (!shapes.length) reasons.add('no-svg-shapes');
      for (const shape of shapes) {
        const style = getComputedStyle(shape);
        check(style);
        if (style.fill !== 'none' || style.stroke === 'none' || !(parseFloat(style.strokeWidth) > 0)
          || Number(style.strokeOpacity) !== 1) reasons.add('unsupported-svg-paint');
        else colors.push(parse(style.stroke));
      }
      paintSelector = `${selector} :is(path,line,polyline,polygon,rect,circle,ellipse)`;
      property = 'stroke';
    } else if (kind === 'outline') {
      if (css.outlineStyle === 'none' || !(parseFloat(css.outlineWidth) > 0)) reasons.add('no-outline');
      colors = [parse(css.outlineColor)];
      property = 'outline-color';
    } else if (kind === 'border') {
      for (const edge of ['Top', 'Right', 'Bottom', 'Left']) {
        if (css[`border${edge}Style`] !== 'none' && parseFloat(css[`border${edge}Width`]) > 0) colors.push(parse(css[`border${edge}Color`]));
      }
      if (!colors.length || css.borderImageSource !== 'none') reasons.add('unsupported-border');
      property = 'border-color';
    } else {
      check(css);
      if (css.content === 'none' || css.content === 'normal' || css.backgroundImage !== 'none') reasons.add('unsupported-marker');
      colors = [parse(css.backgroundColor)];
      property = 'background-color';
      paintSelector += pseudo;
    }
    if (colors.some(color => color[3] !== 255)) reasons.add('transparent-paint');
    if (new Set(colors.map(color => color.join(','))).size !== 1) reasons.add('multicolor-paint');
    const box = element.getBoundingClientRect();
    const padding = kind === 'outline' ? Math.max(0, parseFloat(css.outlineOffset)) + parseFloat(css.outlineWidth) + 2 : 2;
    return { kind, selector, paintSelector, property, fill: colors[0], reasons: [...reasons], overlays,
      outline: kind === 'outline' ? { style: css.outlineStyle, width: css.outlineWidth, offset: css.outlineOffset } : undefined,
      bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
      rect: { left: box.left - padding, top: box.top - padding, right: box.right + padding, bottom: box.bottom + padding } };
  }, kind);
  if (data.reasons.length) return { ...data, state: 'unsupported', minimumRatio: null };
  const maskStyle = color => `${data.paintSelector} { ${data.property}: ${color} !important; }`;
  const temporary = await page.addStyleTag({ content: maskStyle('transparent') });
  let background, black, white;
  try {
    background = await page.screenshot({ scale: 'css', animations: 'disabled' });
    await temporary.evaluate((element, css) => { element.textContent = css; }, maskStyle('#000'));
    black = await page.screenshot({ scale: 'css', animations: 'disabled' });
    await temporary.evaluate((element, css) => { element.textContent = css; }, maskStyle('#fff'));
    white = await page.screenshot({ scale: 'css', animations: 'disabled' });
    const after = await target.boundingBox();
    if (!after || Object.keys(data.bounds).some(key => Math.abs(data.bounds[key] - after[key]) > .1)) throw new Error('Non-text target moved during measurement');
  } finally { await temporary.evaluate(element => element.remove()); }
  return page.evaluate(async ({ data, images }) => {
    const decode = async encoded => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const [background, black, white] = await Promise.all(images.map(decode));
    if ([black, white].some(image => image.width !== background.width || image.height !== background.height)) throw new Error('Non-text mask dimensions changed');
    const linear = n => n / 255 <= .04045 ? n / 255 / 12.92 : ((n / 255 + .055) / 1.055) ** 2.4;
    const luminance = rgb => .2126 * linear(rgb[0]) + .7152 * linear(rgb[1]) + .0722 * linear(rgb[2]);
    const foreground = luminance(data.fill);
    let minimumRatio = Infinity, minimumPixel = null, sampledPixels = 0, reversed = false;
    let paintedBounds = null, outsidePixels = 0;
    // Pseudo markers can be positioned against the wrong ancestor. Sampling only
    // the target rectangle would miss paint that escaped it entirely.
    if (data.kind === 'before' || data.kind === 'after') {
      for (let y = 0; y < background.height; y++) {
        for (let x = 0; x < background.width; x++) {
          const index = (y * background.width + x) * 4;
          if ([0, 1, 2].reduce((sum, channel) => sum + Math.abs(black.pixels[index + channel] - white.pixels[index + channel]), 0) < 3) continue;
          if (!paintedBounds) paintedBounds = { left: x, top: y, right: x + 1, bottom: y + 1 };
          else {
            paintedBounds.left = Math.min(paintedBounds.left, x); paintedBounds.top = Math.min(paintedBounds.top, y);
            paintedBounds.right = Math.max(paintedBounds.right, x + 1); paintedBounds.bottom = Math.max(paintedBounds.bottom, y + 1);
          }
          if (x < Math.floor(data.rect.left) || x >= Math.ceil(data.rect.right)
            || y < Math.floor(data.rect.top) || y >= Math.ceil(data.rect.bottom)) outsidePixels++;
        }
      }
    }
    for (let y = Math.max(0, Math.floor(data.rect.top)); y < Math.min(background.height, Math.ceil(data.rect.bottom)); y++) {
      for (let x = Math.max(0, Math.floor(data.rect.left)); x < Math.min(background.width, Math.ceil(data.rect.right)); x++) {
        const index = (y * background.width + x) * 4;
        if ([0, 1, 2].reduce((sum, channel) => sum + Math.abs(black.pixels[index + channel] - white.pixels[index + channel]), 0) < 3) continue;
        const rgb = [...background.pixels.slice(index, index + 3)], backdrop = luminance(rgb);
        if (backdrop <= foreground) reversed = true;
        const ratio = (Math.max(backdrop, foreground) + .05) / (Math.min(backdrop, foreground) + .05);
        if (ratio < minimumRatio) { minimumRatio = ratio; minimumPixel = { x, y, background: rgb }; }
        sampledPixels++;
      }
    }
    return { ...data, method: 'opaque-dark-paint-vs-composited-background-with-paint-mask', threshold: 3,
      scope: 'visible painted pixels only; anti-aliasing excluded from the foreground color as for WCAG text; not full control or accessibility certification',
      sampledPixels, minimumPixel, paintedBounds, outsidePixels, minimumRatio: sampledPixels ? minimumRatio : null,
      state: outsidePixels ? 'unsupported' : !sampledPixels ? 'excluded' : reversed ? 'unsupported' : minimumRatio >= 3 ? 'passed' : 'below-threshold',
      reasons: outsidePixels ? ['paint-outside-target-bounds'] : !sampledPixels ? ['no-visible-painted-pixels'] : reversed ? ['foreground-not-darker-than-background'] : [] };
  }, { data, images: [background, black, white].map(image => image.toString('base64')) });
}
