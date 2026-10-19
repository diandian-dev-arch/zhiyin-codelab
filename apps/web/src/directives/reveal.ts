import type { Directive } from 'vue';

// v-reveal: fades an element up once it scrolls into view. The `.rv` class (which hides
// the element) is only added when IntersectionObserver exists and motion is allowed, so
// without JS or with reduced motion the element simply renders in its final state.
// Optional value: delay step 1–3 (maps to .d1/.d2/.d3).
type RevealElement = HTMLElement & { __reveal?: IntersectionObserver };

const allowed = () =>
  typeof IntersectionObserver === 'function'
  && !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

export const reveal: Directive<RevealElement, 1 | 2 | 3 | undefined> = {
  mounted(el, binding) {
    if (!allowed()) return;
    el.classList.add('rv');
    if (binding.value) el.classList.add(`d${binding.value}`);
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        el.classList.add('in');
        observer.disconnect();
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: .08 });
    observer.observe(el);
    el.__reveal = observer;
  },
  unmounted(el) {
    el.__reveal?.disconnect();
  },
};
