import { describe, expect, it } from "vitest";
import {
  courseExecutionClaimDiagnostic,
  courseHelpPolicyDiagnostic,
  validateCourseReport,
} from "../apps/api/src/coursework-agent.js";

function validate(summary: string) {
  return validateCourseReport(
    { summary, findings: [], limitations: ["未运行代码"] },
    {},
    [],
    true,
  );
}

describe("static coursework execution claims", () => {
  it.each([
    "未运行代码，不能确认测试通过。",
    "尚未运行，因此不能声称测试通过。",
    "请自行验证，确认是否测试通过。",
    "尚未确认构建成功。",
    "这不代表编译通过。",
    "如果测试通过，再检查其他输入。",
    "No code was executed. I cannot claim that all tests passed.",
    "There is no evidence that tests passed.",
    "Check whether the build succeeded.",
    "If all tests pass, check the remaining cases.",
  ])("accepts an explicit non-claim: %s", (text) => {
    expect(() => validate(text)).not.toThrow();
  });

  it.each([
    "测试通过。",
    "运行已经成功。",
    "构建结果为通过。",
    "all tests passed",
    "The build succeeded.",
    "未运行代码，但测试通过。",
    "不能确认测试通过，但构建成功。",
    "不能确认测试通过，测试通过。",
    "如果测试通过，则运行成功。",
    "No code was executed, but all tests passed.",
    "I cannot claim that tests passed. The build succeeded.",
    "There is no evidence that tests passed, yet tests passed.",
    "Whether tests passed is unknown, but the build succeeded.",
    "并非不能确认测试通过。",
    "不是无法确认测试通过。",
    "It is false that there is no evidence that tests passed.",
    "I do not mean I cannot claim that tests passed.",
    "如果测试通过但编译通过。",
  ])("rejects a factual claim, including mixed clauses: %s", (text) => {
    expect(() => validate(text)).toThrow("静态报告不能宣称运行通过");
  });

  it("checks every text field independently without retaining private text", () => {
    const raw = {
      summary: "不能确认测试通过",
      limitations: ["未运行代码", "PRIVATE_MARKER：构建成功"],
      findings: [
        {
          explanation: "请确认是否测试通过",
          impact: "测试通过",
          suggestion: "不能确认测试通过，但测试通过",
          verification: "tests passed",
        },
      ],
    };
    const diagnostic = courseExecutionClaimDiagnostic(raw);
    expect(diagnostic).toEqual([
      { field: "limitations.1", rule: "unsupported-execution-success" },
      { field: "findings.0.impact", rule: "unsupported-execution-success" },
      { field: "findings.0.suggestion", rule: "unsupported-execution-success" },
      {
        field: "findings.0.verification",
        rule: "unsupported-execution-success",
      },
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_MARKER");
    expect(courseExecutionClaimDiagnostic(null)).toEqual([]);
    expect(courseExecutionClaimDiagnostic({ findings: [null] })).toEqual([]);
  });
});

describe("L3 auxiliary code stays in the suggestion field", () => {
  const report = {
    summary: "仅静态阅读",
    findings: [
      {
        requirementId: "R1",
        verdict: "unknown",
        explanation: "尚需验证",
        impact: "未知",
        evidence: [],
        suggestion: "const local = [];",
        verification: "自行核对边界",
      },
    ],
    limitations: ["未运行代码"],
  };
  function check(value: unknown, allowCode: boolean) {
    return validateCourseReport(value, {}, [{ id: "R1" }], allowCode);
  }

  it("permits code only in an authorized suggestion", () => {
    expect(() => check(report, true)).not.toThrow();
    expect(() => check(report, false)).toThrow("提示包含不允许的代码形式");
    expect(courseHelpPolicyDiagnostic(report, true)).toEqual([]);
  });

  it.each(["summary", "explanation", "impact", "verification", "limitations"])(
    "rejects code in %s even with L3 authorization",
    (field) => {
      const value = structuredClone(report);
      if (field === "summary") value.summary = "const PRIVATE_CODE = [];";
      else if (field === "limitations")
        value.limitations = ["const PRIVATE_CODE = [];"];
      else (value.findings[0] as any)[field] = "const PRIVATE_CODE = [];";
      expect(() => check(value, true)).toThrow("提示包含不允许的代码形式");
      const diagnostic = courseHelpPolicyDiagnostic(value, true);
      expect(diagnostic).toHaveLength(2);
      expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_CODE");
    },
  );
});
