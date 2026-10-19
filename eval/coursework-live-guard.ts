import { createHash } from "node:crypto";
import ts from "typescript";

export const liveEvaluationLimits = Object.freeze({
  calls: 10,
  inputTokens: 8000,
  outputTokens: 4000,
  usd: 0.1,
  peakInputUsdPerMillion: 0.3,
  peakOutputUsdPerMillion: 1.2,
});
export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// Bound every possible prompt branch without executing or duplicating application code.
export function coursePromptBound(source: string) {
  const ast = ts.createSourceFile(
    "coursework-agent.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const systems: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === "request" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties)
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText(ast) === "system"
        )
          systems.push(property.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (systems.length !== 1) throw new Error("PROMPT_SHAPE_CHANGED");
  function bytes(node: ts.Expression): number {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return Buffer.byteLength(node.text);
    if (ts.isTemplateExpression(node))
      return (
        Buffer.byteLength(node.head.text) +
        node.templateSpans.reduce(
          (sum, span) =>
            sum + bytes(span.expression) + Buffer.byteLength(span.literal.text),
          0,
        )
      );
    if (ts.isConditionalExpression(node))
      return Math.max(bytes(node.whenTrue), bytes(node.whenFalse));
    if (node.getText(ast) === "job.level") return 1;
    throw new Error("PROMPT_DYNAMIC_VALUE_UNBOUNDED");
  }
  return {
    systemBytesUpperBound: bytes(systems[0]),
    templateSha256: sha256(systems[0].getText(ast)),
  };
}
export function reserveLiveCall(calls: number, inputBytesUpperBound: number) {
  const l = liveEvaluationLimits;
  if (!Number.isSafeInteger(calls) || calls < 0 || calls >= l.calls)
    throw new Error("EVALUATION_CALL_LIMIT");
  if (
    !Number.isSafeInteger(inputBytesUpperBound) ||
    inputBytesUpperBound < 1 ||
    inputBytesUpperBound > l.inputTokens
  )
    throw new Error("EVALUATION_INPUT_LIMIT");
  const batchUpperEstimateUsd =
    (l.calls *
      (l.inputTokens * l.peakInputUsdPerMillion +
        l.outputTokens * l.peakOutputUsdPerMillion)) /
    1e6;
  if (batchUpperEstimateUsd > l.usd) throw new Error("EVALUATION_COST_LIMIT");
  return { call: calls + 1, batchUpperEstimateUsd };
}
