// No network, database, model calls or generated teacher verdicts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { courseworkDevelopmentCorpus } from "../eval/coursework-development-corpus.js";
import { courseworkTask } from "../packages/contracts/src/coursework.js";
import { normalizeCourseFiles } from "../apps/api/src/coursework-sources.js";

const output = process.argv[2];
const ids = new Set<string>();
const samples = courseworkDevelopmentCorpus.map((sample) => {
  assert(!ids.has(sample.id), "DUPLICATE_SAMPLE");
  ids.add(sample.id);
  const task = courseworkTask.parse(sample.task);
  const imported = normalizeCourseFiles(
    Object.entries(sample.files).map(([p, content]) => ({ path: p, content })),
  );
  assert.equal(imported.omitted.length, 0);
  for (const expected of sample.review) {
    assert(task.requirements.some((r) => r.id === expected.requirementId));
    for (const citation of expected.evidence) {
      assert(Object.hasOwn(imported.files, citation.path));
      assert(
        citation.start > 0 &&
          citation.end >= citation.start &&
          citation.end <= imported.files[citation.path].split("\n").length,
      );
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(imported.files).sort(([a], [b]) => a.localeCompare(b, "en")),
  );
  return {
    id: sample.id,
    category: sample.category,
    source: "authored-synthetic-development",
    partition: "development",
    sha256: createHash("sha256")
      .update(
        JSON.stringify({
          task,
          files: sorted,
          level: sample.level,
          question: sample.question,
          review: sample.review,
          prohibitedClaims: sample.prohibitedClaims,
        }),
      )
      .digest("hex"),
    files: Object.keys(sorted),
    level: sample.level,
    allowCode: task.allowCode,
    modelCalls: 0,
    teacherReview: "not-performed",
    semanticResult: "not-evaluated",
  };
});
const result = {
  generatedAt: new Date().toISOString(),
  passed: true,
  scope:
    "development-input-schema-source-and-expected-citation-preparation-only",
  externalModelCalls: 0,
  teacherReviews: 0,
  heldOutSamples: 0,
  semanticQualityPassed: false,
  samples,
};
if (output) {
  const target = path.resolve(output);
  // Only a new evidence file may be created; never overwrite an earlier freeze.
  assert(
    target.startsWith(path.resolve("docs/verification") + path.sep),
    "OUTPUT_OUTSIDE_VERIFICATION",
  );
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(result, null, 2), { flag: "wx" });
}
console.log(JSON.stringify(result, null, 2));
