import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { courseworkDevelopmentCorpus as corpus } from "../eval/coursework-development-corpus.js";
import { validateCourseReport } from "../apps/api/src/coursework-agent.js";

// Offline compatibility replay only. No network, login, database or model calls.
const root = "docs/verification/2026-10-18/coursework";
const receiptPath = `${root}/live-d3c896cd-42e3-42a1-992a-7b0dff9dc970/result.json`;
const receiptText = await readFile(receiptPath, "utf8");
const receipt = JSON.parse(receiptText);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const checks = receipt.attempts.map((attempt: any) => {
  if (!attempt.report) {
    assert.equal(attempt.status, "failed");
    return {
      analysisId: attempt.analysisId,
      sampleId: attempt.sampleId,
      result: "not-replayable-original-response-not-retained",
    };
  }
  const sample = corpus.find((s) => s.id === attempt.sampleId);
  assert(sample, "SAMPLE_NOT_FOUND");
  assert.equal(hash(JSON.stringify(sample)), attempt.sampleSha256);
  assert.equal(attempt.report.execution.ran, false);
  const { summary, findings, limitations } = attempt.report;
  validateCourseReport(
    { summary, findings, limitations },
    sample.files,
    sample.task.requirements,
    sample.task.allowCode && attempt.level === 3,
  );
  return {
    analysisId: attempt.analysisId,
    sampleId: attempt.sampleId,
    level: attempt.level,
    result: "structure-and-citations-accepted",
  };
});
assert.equal(
  checks.filter((c: any) => c.result === "structure-and-citations-accepted")
    .length,
  8,
);
const record = {
  at: new Date().toISOString(),
  mode: "offline-saved-report-replay",
  receiptPath,
  receiptSha256: hash(receiptText),
  agentSha256: hash(await readFile("apps/api/src/coursework-agent.ts", "utf8")),
  checks,
  externalModelCalls: 0,
  businessWrites: 0,
  qualityAcceptancePassed: false,
  limitations: [
    "Development samples, not independent held-out data or teacher reviews",
    "Accepted reports retain the documented semantic and teaching-depth issues",
    "Rejected original responses were not retained and cannot be reclassified",
  ],
  passed: true,
};
await writeFile(
  `${root}/offline-report-replay.json`,
  JSON.stringify(record, null, 2),
);
console.log(JSON.stringify(record, null, 2));
