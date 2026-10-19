import { describe, expect, it } from 'vitest';
import { createSourceRelationVerifier } from '../apps/api/src/source-relation-verifier';
import type { EvidenceFlow } from '../packages/contracts/src/source';
import { validateSourceReport, validateVerifiedSourceReport } from '../apps/api/src/source-agent';

function check(source: string, proofStart = 2, proofEnd = 2) {
  const citation = { path: 'main.ts', start: 1, end: source.split('\n').length };
  const flow: EvidenceFlow = { id: 'f', title: 'test', summary: 'test', gaps: [],
    steps: ['entry', 'service', 'store'].map(id => ({ id, symbol: id, title: id, responsibility: id, citations: [citation] })),
    edges: [{ from: 'entry', to: 'service', relation: 'call', evidence: [{ ...citation, start: proofStart, end: proofEnd }], explanation: 'entry calls service' }] };
  return createSourceRelationVerifier({ 'main.ts': source }, { 'main.ts': [citation] })(flow.edges[0], flow);
}
describe('static relation binding proof', () => {
  it('preserves a proven call through draft and final report validation', () => {
    const path = 'main.ts';
    const files = { [path]: 'function entry() {\n service();\n}\nfunction service() {}\nfunction store() {}' };
    const citation = { path, start: 1, end: 5 };
    const read = { [path]: { start: 1, end: 5 } };
    const ranges = { [path]: [citation] };
    const flow: EvidenceFlow = { id: 'f', title: '业务', summary: '场景', gaps: [],
      steps: ['entry', 'service', 'store'].map(id => ({ id, symbol: id, title: id, responsibility: id, citations: [citation] })),
      edges: [{ from: 'entry', to: 'service', relation: 'call', evidence: [{ path, start: 2, end: 2 }], explanation: '直接调用' }] };
    const section = { title: '用途', body: '用途说明', citations: [citation] };
    const verifier = createSourceRelationVerifier(files, ranges);
    const draft = validateSourceReport({ overview: '用途', stack: [], modules: [section], flows: [section], findings: [], readingPath: [section], limitations: ['未运行'], evidenceFlows: [flow] }, read, ranges, verifier);
    expect(draft.evidenceFlows).toHaveLength(1);
    expect(validateVerifiedSourceReport({ checks: [] }, draft, read, ranges, verifier).evidenceFlows).toEqual([flow]);
    expect(validateVerifiedSourceReport({ checks: [] }, draft, read, ranges).evidenceFlows).toBeUndefined();
  });
  it('accepts a direct call bound to the cited declaration', () => {
    expect(check('function entry() {\n service();\n}\nfunction service() {}')).toBe(true);
  });
  it('rejects comments and strings containing call syntax', () => {
    expect(check('function entry() {\n // service();\n}\nfunction service() {}')).toBe(false);
    expect(check('function entry() {\n const text = "service()";\n}\nfunction service() {}')).toBe(false);
  });
  it('rejects shadowed parameters and properties', () => {
    expect(check('function entry(service: () => void) {\n service();\n}\nfunction service() {}')).toBe(false);
    expect(check('function entry() {\n obj.service();\n}\nfunction service() {}')).toBe(false);
  });
  it('rejects reassigned function bindings', () => {
    expect(check('function entry() {\n service();\n}\nfunction service() {}\nservice = () => {};')).toBe(false);
  });
  it('rejects loop-target and unary writes to a function binding', () => {
    const base = 'function entry() {\n service();\n}\nfunction service() {}\n';
    for (const mutation of ['for (service of replacements) {}', 'for (service in replacements) {}', 'service++', '--service', '[service] = replacements']) {
      expect(check(base + mutation), mutation).toBe(false);
    }
  });
  it('rejects direct eval and dynamic with scope', () => {
    expect(check('function entry() {\n service();\n eval(code);\n}\nfunction service() {}')).toBe(false);
    expect(check('function entry() {\n with (other) { service(); }\n}\nfunction service() {}')).toBe(false);
  });
  it('rejects global-object mutation and aliases in script scope', () => {
    const base = 'function entry() {\n service();\n}\nfunction service() {}\n';
    for (const mutation of [
      'globalThis.service = replacement;',
      'window["service"] = replacement;',
      'const root = globalThis; root.service = replacement;',
      'Object.defineProperty(globalThis, "service", { value: replacement });',
      'this.service = replacement;',
    ]) expect(check(base + mutation), mutation).toBe(false);
  });
  it('rejects indirect eval and dynamic function construction', () => {
    const base = 'function entry() {\n service();\n}\nfunction service() {}\n';
    for (const mutation of ['(0, eval)(code);', 'const run = eval; run(code);', 'new Function(code)();', 'Function(code)();']) {
      expect(check(base + mutation), mutation).toBe(false);
    }
  });
  it('does not confuse a module-local declaration with a global property of the same name', () => {
    expect(check('function entry() {\n service();\n}\nfunction service() {}\nwindow["service"] = replacement;\nexport {};')).toBe(true);
  });
  it('rejects calls outside the supplied evidence or in a nested callback', () => {
    expect(check('function entry() {\n service();\n}\nfunction service() {}', 4, 4)).toBe(false);
    expect(check('function entry() {\n const later = () => service();\n}\nfunction service() {}')).toBe(false);
  });
});
