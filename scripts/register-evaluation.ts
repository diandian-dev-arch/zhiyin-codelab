import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'USAGE: register-evaluation.ts [--check]');
const checkOnly = args[0] === '--check';
const manifests = [
  "fixtures/manifest.json",
  "fixtures/independent-manifest.json",
  "fixtures/independent-defects-manifest.json",
];
const seen = new Set<string>();
const samples: Record<string, unknown>[] = [];
for (const manifestPath of manifests) {
  const manifest = JSON.parse(
    await readFile(path.join(root, manifestPath), "utf8"),
  );
  for (const sample of manifest.samples ?? [manifest]) {
    assert.match(sample.sampleId, /^[a-z0-9-]+$/);
    assert.equal(seen.has(sample.sampleId), false, "DUPLICATE_SAMPLE_ID");
    seen.add(sample.sampleId);
    assert.equal(sample.purpose, "development");
    assert.equal(sample.frozenEvaluationEligible, false);
    assert.ok(sample.implementationFamilyId);
    const archivePath = `fixtures/${sample.sampleId}.zip`;
    if (sample.archivePath) assert.equal(sample.archivePath, archivePath);
    const bytes = await readFile(path.join(root, archivePath));
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(hash, sample.originalZipSha256, "SAMPLE_ZIP_HASH_MISMATCH");
    samples.push({
      sampleId: sample.sampleId,
      familyId: sample.implementationFamilyId,
      partition: "development",
      origin: "team-constructed",
      frozenEvaluationEligible: false,
      containsStudentSubmission: false,
      independentTeacherTruth: "not_collected",
      archivePath,
      zipBytes: bytes.length,
      originalZipSha256: hash,
      expectedCasesSource: manifestPath,
      observedResultsSource:
        "docs/verification/2026-09-28/T07-T08-core-workspace.md",
    });
  }
}
samples.sort((a, b) => String(a.sampleId).localeCompare(String(b.sampleId)));
const registry = {
  version: "development-registry-v1",
  generatedAt: new Date().toISOString(),
  verifiedZipCount: samples.length,
  familyCount: new Set(samples.map((s) => s.familyId)).size,
  partitions: { development: samples.length, validation: 0, frozen: 0 },
  qualityEvaluationCompleted: false,
  samples,
};
if (checkOnly) {
  const saved = JSON.parse(await readFile(path.join(root, 'eval/development-registry.json'), 'utf8'));
  // Ignore only the original registration time; preserve its exact bytes for pinned ledgers.
  assert.ok(typeof saved.generatedAt === 'string' && Number.isFinite(Date.parse(saved.generatedAt)), 'REGISTRY_TIMESTAMP_INVALID');
  assert.deepEqual({ ...saved, generatedAt: registry.generatedAt }, registry, 'REGISTRY_CONTENT_MISMATCH');
} else await writeFile(
  path.join(root, "eval/development-registry.json"),
  JSON.stringify(registry, null, 2) + "\n",
);
console.log(
  `开发样本${checkOnly ? '只读核验' : '登记'}完成：${registry.verifiedZipCount} 份 ZIP，${registry.familyCount} 个家族；冻结集 0，未生成教师或模型评测结果。`,
);
