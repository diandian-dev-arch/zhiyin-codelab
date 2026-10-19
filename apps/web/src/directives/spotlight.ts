import type { Directive } from 'vue';

// Pointer-follow light for a few primary surfaces. It only writes two CSS variables and
// skips touch / coarse pointers, so the element's layout and semantics never change.
type SpotlightEl = HTMLElement & { __spotlight?: (event: PointerEvent) => void };

export const spotlight: Directive<SpotlightEl> = {
  mounted(el) {
    if (typeof matchMedia === 'function' && !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    el.classList.add('has-spotlight');
    el.__spotlight = (event) => {
      const box = el.getBoundingClientRect();
      el.style.setProperty('--spot-x', `${event.clientX - box.left}px`);
      el.style.setProperty('--spot-y', `${event.clientY - box.top}px`);
    };
    el.addEventListener('pointermove', el.__spotlight, { passive: true });
  },
  beforeUnmount(el) {
    if (el.__spotlight) el.removeEventListener('pointermove', el.__spotlight);
  },
};
