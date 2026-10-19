import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { postgres } from "../apps/api/src/db.js";
import { createApp } from "../apps/api/src/app.js";
import { ArtifactStore } from "../apps/api/src/artifacts-v2.js";
import { auditRetentionV2 } from "../apps/api/src/retention-v2.js";
import { buildSourceCatalog } from "../apps/api/src/source-catalog.js";
import { summarizeSourceUsage } from "../apps/api/src/source-usage.js";

// Read the restored API under its normal limits, including large source projects.
// Only retry explicit throttled GETs; never replay login or other mutations.
async function restoredRead(url: string, init?: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt >= 2) return response;
    const seconds = Number(response.headers.get("retry-after") ?? "1");
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) return response;
    await response.arrayBuffer();
    await delay(Math.max(1000, Math.ceil(seconds * 1000)));
  }
}

/** Runs only against an isolated restored database; login writes stay there. */
export async function checkRestoredHttp(input: {
  databaseUrl: string;
  evidenceRoot: string;
  password: string;
}) {
  const db = postgres(input.databaseUrl);
  const store = new ArtifactStore({ root: input.evidenceRoot });
  const origin = "http://127.0.0.1";
  const app = await createApp(db, {
    origin,
    secure: false,
    executionApproved: false,
    businessVersion: 2,
    model: "unconfigured",
    image: "restore-check",
    evidenceReader: (e) => store.readEvidence(e),
  });
  try {
    // Verify references against the recovered files, including private model
    // material and retention holds, before exercising the HTTP read paths.
    const retention = await auditRetentionV2(db, store);
    assert.equal(retention.complete, true, "RESTORED_RETENTION_INCOMPLETE");
    assert.equal(retention.issues.length, 0, "RESTORED_RETENTION_ISSUES");
    assert.equal(retention.activeRecords, 0, "RESTORED_ACTIVE_OWNER");
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = async (email: string) => {
      const response = await fetch(base + "/api/v1/session/login", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password: input.password }),
      });
      assert.equal(response.status, 200, "RESTORED_LOGIN_FAILED");
      return response.headers.getSetCookie()[0].split(";")[0];
    };
    const teacher = await login("teacher@codelab.local");
    const student = await login("student@codelab.local");
    const sourceProjects = await checkRestoredSourceProjects(db, base, [
      { email: "teacher@codelab.local", cookie: teacher },
      { email: "student@codelab.local", cookie: student },
    ]);
    const publications = (
      await db.query(
        "SELECT id,run_id,snapshot FROM publications ORDER BY published_at,id",
      )
    ).rows;
    assert.ok(publications.length > 0, "NO_RESTORED_PUBLICATIONS_TO_VERIFY");
    let evidenceDownloads = 0;
    for (const publication of publications) {
      const route = `/api/v2/publications/${publication.id}`;
      const response = await restoredRead(base + route, {
        headers: { cookie: student },
      });
      assert.equal(response.status, 200, "RESTORED_STUDENT_REPORT_FAILED");
      const anonymous = await restoredRead(base + route);
      assert.equal(anonymous.status, 401, "RESTORED_REPORT_AUTH_FAILED");
      const review = await restoredRead(
        base + `/api/v2/runs/${publication.run_id}/review`,
        { headers: { cookie: teacher } },
      );
      assert.equal(review.status, 200, "RESTORED_TEACHER_REVIEW_FAILED");
      const privateReview = await restoredRead(
        base + `/api/v2/runs/${publication.run_id}/review`,
        { headers: { cookie: student } },
      );
      assert.equal(privateReview.status, 404, "RESTORED_STUDENT_REVIEW_LEAK");
      for (const evidence of publication.snapshot.publicEvidence) {
        const bytesResponse = await restoredRead(
          base + route + `/evidence/${evidence.evidenceId}`,
          { headers: { cookie: student } },
        );
        assert.equal(
          bytesResponse.status,
          200,
          "RESTORED_EVIDENCE_HTTP_FAILED",
        );
        const bytes = Buffer.from(await bytesResponse.arrayBuffer());
        assert.equal(
          bytes.length,
          evidence.byteSize,
          "RESTORED_EVIDENCE_SIZE_FAILED",
        );
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          evidence.sha256,
          "RESTORED_EVIDENCE_HASH_FAILED",
        );
        evidenceDownloads++;
      }
    }
    assert.ok(evidenceDownloads > 0, "NO_RESTORED_PUBLIC_EVIDENCE_TO_VERIFY");
    return {
      transport: "real-loopback-http",
      publications: publications.length,
      evidenceDownloads,
      teacherLogin: true,
      studentLogin: true,
      anonymousDenied: true,
      studentPrivateReviewDenied: true,
      executionEnabled: false,
      sourceProjects,
      retention: {
        complete: retention.complete,
        counts: retention.counts,
        activeRecords: retention.activeRecords,
        issueCount: retention.issues.length,
      },
    };
  } finally {
    await app.close();
    await db.close();
  }
}

/** Compare the restored source API to the restored DB, never the live workspace. */
export async function checkRestoredSourceProjects(
  db: ReturnType<typeof postgres>,
  base: string,
  sessions: { email: string; cookie: string }[],
) {
  const projects = (
    await db.query(
      "SELECT id,owner_id,name,sha256,files,omitted FROM source_projects ORDER BY id",
    )
  ).rows;
  const identities = await Promise.all(
    sessions.map(async (session) => ({
      ...session,
      id: (
        await db.query("SELECT id FROM users WHERE email=$1", [session.email])
      ).rows[0]?.id,
    })),
  );
  const get = (route: string, cookie?: string) =>
    restoredRead(base + route, {
      headers: cookie ? { cookie } : {},
    });
  let filesVerified = 0,
    analysisHistoriesVerified = 0,
    deniedRequests = 0;
  const analysisModes = { historical: 0, quick: 0, deep: 0 };
  let focusedAnalyses = 0;
  for (const identity of identities) {
    const response = await get("/api/v2/projects", identity.cookie);
    assert.equal(response.status, 200, "RESTORED_SOURCE_LIST_FAILED");
    const list = (await response.json()) as {
      available: boolean;
      projects: { id: string }[];
    };
    assert.equal(
      list.available,
      false,
      "RESTORED_SOURCE_MODEL_MUST_BE_DISABLED",
    );
    assert.deepEqual(
      list.projects.map((p) => p.id).sort(),
      projects
        .filter((p) => p.owner_id === identity.id)
        .map((p) => p.id)
        .sort(),
      "RESTORED_SOURCE_LIST_OWNER_MISMATCH",
    );
  }
  for (const project of projects) {
    const owner = identities.find(
      (identity) => identity.id === project.owner_id,
    );
    assert.ok(owner, "RESTORED_SOURCE_OWNER_LOGIN_UNAVAILABLE");
    const other = identities.find(
      (identity) => identity.id !== project.owner_id,
    );
    assert.ok(other, "RESTORED_SOURCE_SECOND_IDENTITY_REQUIRED");
    const route = `/api/v2/projects/${project.id}`;
    const response = await get(route, owner.cookie);
    assert.equal(response.status, 200, "RESTORED_SOURCE_DETAIL_FAILED");
    const detail = (await response.json()) as any;
    assert.equal(
      detail.available,
      false,
      "RESTORED_SOURCE_MODEL_MUST_BE_DISABLED",
    );
    assert.equal(detail.name, project.name, "RESTORED_SOURCE_NAME_MISMATCH");
    assert.equal(
      detail.sha256,
      project.sha256,
      "RESTORED_SOURCE_ARCHIVE_HASH_MISMATCH",
    );
    assert.deepEqual(
      detail.omitted,
      project.omitted,
      "RESTORED_SOURCE_OMISSIONS_MISMATCH",
    );
    assert.deepEqual(detail.modules, buildSourceCatalog(project.files).modules,
      "RESTORED_SOURCE_MODULES_MISMATCH");
    assert.deepEqual(
      Object.fromEntries(
        detail.files.map((f: { path: string; lines: number }) => [
          f.path,
          f.lines,
        ]),
      ),
      Object.fromEntries(
        Object.entries(project.files as Record<string, string>).map(
          ([path, content]) => [path, content.split("\n").length],
        ),
      ),
      "RESTORED_SOURCE_INDEX_MISMATCH",
    );
    const analyses = (
      await db.query(
        "SELECT id,status,events,report,code,analysis_options,execution_snapshot,usage_recording_version FROM source_analyses WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20",
        [project.id],
      )
    ).rows;
    assert.deepEqual(
      detail.analyses.map((a: any) => ({
        id: a.id,
        status: a.status,
        events: a.events,
        report: a.report,
        code: a.code,
        analysis_options: a.analysis_options,
        execution_snapshot: a.execution_snapshot,
        usage_recording_version: a.usage_recording_version,
      })),
      analyses,
      "RESTORED_SOURCE_ANALYSIS_HISTORY_MISMATCH",
    );
    analysisHistoriesVerified += analyses.length;
    for (const analysis of analyses) {
      const calls=(await db.query('SELECT state,usage FROM source_model_calls WHERE analysis_id=$1 ORDER BY call_no',[analysis.id])).rows;
      assert.deepEqual(detail.analyses.find((a:any)=>a.id===analysis.id).modelUsage,summarizeSourceUsage(analysis.usage_recording_version,analysis.status,calls),'RESTORED_SOURCE_USAGE_MISMATCH');
      const options = analysis.analysis_options;
      if (options === null) analysisModes.historical++;
      else {
        assert.ok(options.mode === "quick" || options.mode === "deep", "RESTORED_SOURCE_MODE_INVALID");
        analysisModes[options.mode as "quick" | "deep"]++;
        if (options.modules.length) focusedAnalyses++;
      }
    }
    for (const [path, content] of Object.entries(
      project.files as Record<string, string>,
    )) {
      const source = await get(
        route + `/source?path=${encodeURIComponent(path)}`,
        owner.cookie,
      );
      assert.equal(source.status, 200, "RESTORED_SOURCE_FILE_FAILED");
      const file = (await source.json()) as { path: string; content: string };
      assert.equal(file.path, path, "RESTORED_SOURCE_PATH_MISMATCH");
      assert.equal(
        createHash("sha256").update(file.content).digest("hex"),
        createHash("sha256").update(content).digest("hex"),
        "RESTORED_SOURCE_CONTENT_MISMATCH",
      );
      filesVerified++;
    }
    const firstPath = Object.keys(project.files)[0];
    assert.ok(firstPath, "RESTORED_SOURCE_PROJECT_EMPTY");
    for (const target of [
      route,
      route + `/source?path=${encodeURIComponent(firstPath)}`,
    ]) {
      assert.equal(
        (await get(target)).status,
        401,
        "RESTORED_SOURCE_ANONYMOUS_LEAK",
      );
      assert.equal(
        (await get(target, other.cookie)).status,
        404,
        "RESTORED_SOURCE_OTHER_OWNER_LEAK",
      );
      deniedRequests += 2;
    }
  }
  return {
    projects: projects.length,
    filesVerified,
    analysisHistoriesVerified,
    deniedRequests,
    analysisModes,
    focusedAnalyses,
    scope: "all-restored-project-files-and-latest-20-analyses-per-project",
    modelCallsEnabled: false,
  };
}
