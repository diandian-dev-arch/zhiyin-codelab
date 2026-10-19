// Fail closed: the earlier draft never reached zoom and two plus presses do not prove 200%.
// Preserve the historical failed artifact; do not launch a browser or work around a UI safety stop.
console.error(JSON.stringify({
  state: 'not_implemented',
  code: 'NATIVE_ZOOM_ACCEPTANCE_PENDING',
  reason: 'The native 200% browser zoom gate requires a supported, authorized UI verification path. Equivalent viewports and root-font changes are not native zoom evidence.',
  previousResult: 'output/reader-v2/live/browser-zoom-result.json',
}));
process.exitCode = 1;
