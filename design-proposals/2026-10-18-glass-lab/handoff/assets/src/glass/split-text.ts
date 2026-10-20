/**
 * Glass Lab · 逐字拆分
 * 把元素内的文字拆成 <span class="gl-ch">，保留 <em>/<br> 等结构，
 * 并把原文写入 aria-label，读屏器仍读整句。
 * 注意：拆分后不要再用响应式数据改写该元素的文字（Vue 会覆盖拆分结果）；
 * 文字需要变化时，用 :key 让元素重建后再拆分。
 */
export function splitText(el: HTMLElement, baseDelayMs = 0): number {
  let i = 0;
  const label = el.textContent ?? "";
  const walk = (node: Node) => {
    [...node.childNodes].forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const c of n.textContent ?? "") {
          if (c === " " || c === "\n") {
            frag.appendChild(document.createTextNode(c));
            continue;
          }
          const s = document.createElement("span");
          s.className = "gl-ch";
          s.setAttribute("aria-hidden", "true");
          s.style.setProperty("--i", String(i++));
          s.textContent = c;
          frag.appendChild(s);
        }
        n.parentNode?.replaceChild(frag, n);
      } else if (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName !== "BR") {
        walk(n);
      }
    });
  };
  walk(el);
  el.style.setProperty("--base", `${baseDelayMs}ms`);
  el.classList.add("gl-split");
  el.setAttribute("aria-label", label);
  return i;
}
