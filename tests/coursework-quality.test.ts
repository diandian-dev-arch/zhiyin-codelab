import { describe, expect, it } from "vitest";
import {
  courseAnalysisContext,
  courseCodeDelivery,
} from "../apps/api/src/coursework-quality.js";
import { validateCourseReport } from "../apps/api/src/coursework-agent.js";
import { courseworkQualityRegressionCorpus } from "../eval/coursework-quality-corpus.js";
import { courseworkReviewFocus } from "../eval/coursework-review-rubric.js";

function report(
  suggestion = "先观察一个输入",
  verdict: "unknown" | "unmet" = "unmet",
) {
  return validateCourseReport(
    {
      summary: "只读源码",
      findings: [
        {
          requirementId: "R1",
          verdict,
          explanation: "缺少适配实现，不能判断其行为",
          impact: "尚不能确定",
          evidence: [{ path: "a.ts", start: 1, end: 1 }],
          suggestion,
          verification: "请自行观察输入输出",
        },
      ],
      limitations: ["模型声称没有类型注解"],
    },
    { "a.ts": 'const value: string = "x";' },
    [{ id: "R1" }],
    true,
  );
}

describe("application facts and delivery shape, not semantic acceptance", () => {
  it("derives limitations from actual read coverage without interpreting code or losing unknown reasons", () => {
    const context = courseAnalysisContext(
      { "a.ts": 'const value: string = "x";' },
      ["a.ts", "b.ts"],
      false,
    );
    expect(context).toMatchObject({
      coveredPaths: ["a.ts"],
      unreadPaths: ["b.ts"],
      codeHelpRequested: false,
      execution: { ran: false },
    });
    expect(context.limitations.join(" ")).not.toContain("没有类型注解");
    expect(context.limitations.join(" ")).toContain("1 个");
    expect(report().findings[0].explanation).toContain("缺少适配实现");
    expect(courseAnalysisContext({}, [], false).limitations).toHaveLength(1);
  });

  it("does not retroactively reject old reports or demand code for normal prose", () => {
    const historical = report();
    expect(historical.limitations).toEqual(["模型声称没有类型注解"]);
    expect(courseCodeDelivery(historical, false)).toEqual({
      status: "not-requested",
    });
    expect(() =>
      validateCourseReport(
        {
          ...historical,
          findings: [
            { ...historical.findings[0], suggestion: "const local = [];" },
          ],
        },
        { "a.ts": "x" },
        [{ id: "R1" }],
        false,
      ),
    ).toThrow("提示包含不允许的代码形式");
  });

  it("accepts one bounded snippet only when the business requested auxiliary code", () => {
    expect(
      courseCodeDelivery(
        report(
          "仅供局部参考：\n```ts\nvalue.includes(query)\n```\n其余分支仍需自己处理",
        ),
        true,
      ),
    ).toEqual({ status: "snippet-provided", requirementId: "R1" });
    expect(() => courseCodeDelivery(report(), true)).toThrow(
      "辅助代码未按单个局部片段交付",
    );
    expect(() => courseCodeDelivery(report("```ts\n\n```"), true)).toThrow();
    expect(() =>
      courseCodeDelivery(report("```ts\nx\n```\n```ts\ny\n```"), true),
    ).toThrow();
    expect(() =>
      courseCodeDelivery(report("```ts\n" + "x\n".repeat(13) + "```"), true),
    ).toThrow();
    expect(() =>
      courseCodeDelivery(report("```ts\n" + "x".repeat(801) + "\n```"), true),
    ).toThrow();
  });

  it("does not force fabricated snippets when necessary context is unknown", () => {
    const unknown = report("请先补充适配文件再讨论局部代码", "unknown");
    expect(courseCodeDelivery(unknown, true)).toEqual({
      status: "context-needed",
      requirementIds: ["R1"],
    });
    expect(
      courseCodeDelivery(
        {
          ...unknown,
          findings: [
            ...unknown.findings,
            { ...report().findings[0], requirementId: "R2", verdict: "met" },
          ],
        },
        true,
      ),
    ).toEqual({ status: "context-needed", requirementIds: ["R1"] });
    expect(() =>
      courseCodeDelivery({ ...report(), findings: [] }, true),
    ).toThrow();
    expect(() =>
      courseCodeDelivery(report("```ts\nunterminated", "unknown"), true),
    ).toThrow();
  });

  it("keeps new adversarial examples in the unmeasured development partition", () => {
    expect(courseworkQualityRegressionCorpus).toHaveLength(4);
    for (const sample of courseworkQualityRegressionCorpus)
      expect(sample).toMatchObject({
        partition: "development-not-held-out",
        modelCallsRecorded: 0,
        teacherReviewsRecorded: 0,
        qualityAcceptancePassed: false,
      });
    expect(courseworkReviewFocus("formal", 3, true).codeHelpRequested).toBe(
      false,
    );
    expect(courseworkReviewFocus("self-check", 2, true).codeHelpRequested).toBe(
      false,
    );
    expect(
      courseworkReviewFocus("self-check", 3, false).codeHelpRequested,
    ).toBe(false);
    expect(courseworkReviewFocus("self-check", 3, true).codeHelpRequested).toBe(
      true,
    );
  });
});
