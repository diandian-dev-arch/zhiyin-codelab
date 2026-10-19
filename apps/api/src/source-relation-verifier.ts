import ts from 'typescript';
import type { EvidenceRelationVerifier } from './source-evidence-flow.js';
import { citationWasRead, type SourceRanges } from './source-reader.js';

/** Conservative static binding proof, never execution proof. No module loading or emit. */
export function createSourceRelationVerifier(files: Record<string, string>, ranges: SourceRanges): EvidenceRelationVerifier {
  const cache = new Map<string, { source: ts.SourceFile; checker: ts.TypeChecker }>();
  function parse(path: string) {
    if (cache.has(path)) return cache.get(path)!;
    if (!/\.[cm]?[jt]sx?$/i.test(path) || !Object.hasOwn(files, path)) return undefined;
    const source = ts.createSourceFile(path, files[path], ts.ScriptTarget.Latest, true);
    // Deliberately isolated: no filesystem access, imports, libraries or project execution.
    const host: ts.CompilerHost = {
      getSourceFile: name => name === path ? source : undefined,
      getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '',
      getDirectories: () => [], fileExists: name => name === path,
      readFile: name => name === path ? files[path] : undefined,
      getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    };
    const program = ts.createProgram([path], { noLib: true, noResolve: true, allowJs: true }, host);
    if (program.getSyntacticDiagnostics(source).length) return undefined;
    const parsed = { source, checker: program.getTypeChecker() };
    cache.set(path, parsed);
    return parsed;
  }
  return (edge, flow) => {
    if (edge.relation !== 'call') return false; // Dataflow requires a separate proof strategy.
    const from = flow.steps.find(step => step.id === edge.from);
    const to = flow.steps.find(step => step.id === edge.to);
    if (!from?.symbol || !to?.symbol) return false;
    for (const proof of edge.evidence) {
      if (!citationWasRead(proof, ranges)) continue;
      const parsed = parse(proof.path);
      if (!parsed) continue;
      const { source, checker } = parsed;
      const span = (node: ts.Node) => ({ path: proof.path,
        start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        end: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1 });
      const contained = (node: ts.Node, citations: typeof from.citations) => {
        const location = span(node);
        return citationWasRead(location, ranges) && citations.some(c => c.path === location.path && c.start <= location.start && c.end >= location.end);
      };
      let accepted = false;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && contained(node, [proof])) {
          // Identify the actual enclosing function, not merely a same-named text match.
          let owner: ts.Node | undefined = node.parent;
          while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
          const symbol = checker.getSymbolAtLocation(node.expression);
          const target = symbol?.declarations;
          let rebound = false;
          const inspectWrites = (candidate: ts.Node) => {
            // Dynamic scope/code can invalidate the checker binding. Stay conservative.
            if (ts.isWithStatement(candidate)) rebound = true;
            // Merely checking direct eval() misses aliases and (0, eval)().
            // No alias/effect analysis is available, so references to dynamic
            // code constructors invalidate this isolated binding proof.
            if (ts.isIdentifier(candidate) && ['eval', 'Function'].includes(candidate.text)) rebound = true;
            // In a classic script, top-level declarations can share the global
            // object. Computed property writes, aliases and defineProperty are
            // not tracked by TypeScript's lexical symbol resolution. A global
            // object escape therefore means this proof strategy cannot certify
            // the edge. Module-local bindings do not share that global slot.
            if (!ts.isExternalModule(source) && (candidate.kind === ts.SyntaxKind.ThisKeyword
              || (ts.isIdentifier(candidate) && ['globalThis', 'window', 'self', 'global'].includes(candidate.text)))) rebound = true;
            const inspectTarget = (part: ts.Node) => {
              if (ts.isIdentifier(part) && checker.getSymbolAtLocation(part) === symbol) rebound = true;
              ts.forEachChild(part, inspectTarget);
            };
            if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
              && candidate.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
              inspectTarget(candidate.left);
            }
            if ((ts.isForOfStatement(candidate) || ts.isForInStatement(candidate))
              && !ts.isVariableDeclarationList(candidate.initializer)) inspectTarget(candidate.initializer);
            if ((ts.isPrefixUnaryExpression(candidate) || ts.isPostfixUnaryExpression(candidate))
              && (candidate.operator === ts.SyntaxKind.PlusPlusToken || candidate.operator === ts.SyntaxKind.MinusMinusToken)) inspectTarget(candidate.operand);
            ts.forEachChild(candidate, inspectWrites);
          };
          inspectWrites(source);
          if (owner && ts.isFunctionDeclaration(owner) && owner.name?.text === from.symbol && contained(owner, from.citations)
            && !rebound && target?.length === 1 && ts.isFunctionDeclaration(target[0]) && target[0].body
            && target[0].name?.text === to.symbol && target[0].getSourceFile() === source && contained(target[0], to.citations)) accepted = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (accepted) return true;
    }
    return false;
  };
}
