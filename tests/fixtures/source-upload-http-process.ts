import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createApp } from "../../apps/api/src/app.js";
import { postgres } from "../../apps/api/src/db.js";
import type { SummaryProviderV2 } from "../../apps/api/src/model-provider-v2.js";

// Real API/socket/worker, but generated source and a local fixed model only.
// Temp storage and database URL are supplied by the isolated test harness.
async function main() {
  if (
    !process.send ||
    !process.env.CODELAB_HTTP_FIXTURE_DB ||
    resolve(tmpdir()) !== resolve(process.argv[2] ?? "")
  )
    throw new Error("ISOLATED_HTTP_FIXTURE_REQUIRED");
  const db = postgres(process.env.CODELAB_HTTP_FIXTURE_DB);
  const citation = { path: "fixture/main.ts", start: 1, end: 1 };
  const section = {
    title: "HTTP恢复夹具",
    body: "仅验证上传恢复。",
    citations: [citation],
  };
  const report = {
    overview: section.body,
    stack: ["TypeScript"],
    modules: [section],
    flows: [section],
    findings: [],
    readingPath: [section],
    limitations: ["固定回复，不代表模型质量。"],
  };
  const sourceProvider: SummaryProviderV2 = {
    configuration: {
      provider: "fixture",
      model: "fixture-no-network",
      endpoint: "http://test.invalid",
    },
    async complete(input) {
      process.send?.({ kind: "model-call" });
      const request = JSON.parse(input.user);
      const answer = request.draft
        ? request.checkShape
          ? { report, checks: [] }
          : { searches: [], reads: [] }
        : request.shape
          ? report
          : { paths: [citation.path] };
      return {
        content: JSON.stringify(answer),
        raw: "fixture",
        requestId: null,
        usage: null,
      };
    },
  };
  const app = await createApp(db, {
    origin: "http://127.0.0.1",
    secure: false,
    executionApproved: false,
    businessVersion: 2,
    model: "fixture-no-network",
    image: "unused",
    sourceProvider,
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  process.on("message", async (message) => {
    if (message !== "close") return;
    await app.close();
    await db.close();
    process.disconnect();
  });
  process.send({ kind: "ready", origin, pid: process.pid });
}
main().catch(() => {
  console.error("SOURCE_HTTP_FIXTURE_FAILED");
  process.exit(1);
});
