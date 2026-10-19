import { expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest, type ClientRequest } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync, strToU8 } from "fflate";
import { isolatedTestDB } from "./isolated-db.js";
import { migrate } from "../apps/api/src/db.js";
import { seed } from "../apps/api/src/seed.js";
import { sourceSpoolPrefix } from "../apps/api/src/source-spool.js";

it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)(
  "recovers a killed API during authenticated HTTP upload without queued analysis and accepts a new upload",
  async () => {
    const db = await isolatedTestDB();
    const temporaryRoot = await mkdtemp(join(tmpdir(), "codelab-http-crash-"));
    const children: ChildProcess[] = [],
      requests: ClientRequest[] = [];
    let fixtureCalls = 0;
    let record: string | undefined;
    const loginPassword = randomUUID();
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const waitFor = async <T>(
      check: () => Promise<T | undefined>,
      timeout = 12000,
    ): Promise<T> => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await check();
        if (value !== undefined) return value;
        await delay(30);
      }
      throw new Error("SOURCE_HTTP_OBSERVATION_TIMEOUT");
    };
    const snapshot = async () => {
      const tables: Record<string, string> = {};
      for (const { tablename } of (
        await db.query(
          "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename <> 'sessions' ORDER BY tablename",
        )
      ).rows) {
        expect(tablename).toMatch(/^[a-z_]+$/);
        tables[tablename] = hash(
          (
            await db.query(
              `SELECT to_jsonb(t) AS v FROM "${tablename}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
            )
          ).rows,
        );
      }
      return tables;
    };
    async function start() {
      const schema = (await db.query("SELECT current_schema() AS name")).rows[0]
        .name;
      const target = new URL(process.env.CODELAB_TEST_POSTGRES_URL!);
      target.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("tests/fixtures/source-upload-http-process.ts"),
          temporaryRoot,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            ...process.env,
            TMP: temporaryRoot,
            TEMP: temporaryRoot,
            TMPDIR: temporaryRoot,
            CODELAB_HTTP_FIXTURE_DB: target.toString(),
          },
        },
      );
      children.push(child);
      const ready = await new Promise<{ origin: string; pid: number }>(
        (resolveReady, reject) => {
          const timer = setTimeout(
            () => reject(new Error("HTTP_CHILD_NOT_READY")),
            15000,
          );
          child.on("message", (message: any) => {
            if (message.kind === "model-call") fixtureCalls++;
            if (message.kind === "ready") {
              clearTimeout(timer);
              resolveReady(message);
            }
          });
          child.once("error", () => {
            clearTimeout(timer);
            reject(new Error("HTTP_CHILD_START_ERROR"));
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("HTTP_CHILD_EARLY_EXIT"));
          });
        },
      );
      expect(ready.pid).toBe(child.pid);
      const response = await fetch(ready.origin + "/api/v1/session/login", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "teacher@codelab.local",
          password: loginPassword,
        }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { csrf: string };
      const headers = {
        origin: "http://127.0.0.1",
        cookie: response.headers.getSetCookie()[0].split(";")[0],
        "x-csrf-token": body.csrf,
      };
      return { child, ...ready, headers };
    }
    try {
      await migrate(db);
      await seed(db, loginPassword);
      const owner = (
        await db.query(
          "SELECT id FROM users WHERE email='teacher@codelab.local'",
        )
      ).rows[0].id;
      const historical = randomUUID();
      await db.query(
        "INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,'已有项目',$3,$4,'[]')",
        [
          historical,
          owner,
          hash("historical"),
          JSON.stringify({ "old/main.ts": "export const old = true;" }),
        ],
      );
      const before = await snapshot();
      const first = await start();
      const boundary = `codelab-${randomUUID()}`;
      const archive = Buffer.from(
        zipSync(
          {
            "fixture/main.ts": strToU8("export const value = 1;\n"),
            "fixture/asset.bin": new Uint8Array(256 * 1024).fill(65),
          },
          { level: 0 },
        ),
      );
      const part = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      );
      const trailer = Buffer.from(`\r\n--${boundary}--\r\n`);
      let responseStatus: number | undefined;
      const uploading = httpRequest(first.origin + "/api/v2/projects", {
        method: "POST",
        headers: {
          ...first.headers,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": part.length + archive.length + trailer.length,
        },
      });
      requests.push(uploading);
      let disconnectCode: string | undefined;
      uploading.on("error", (error: NodeJS.ErrnoException) => {
        disconnectCode = error.code;
      });
      uploading.on("response", (r) => {
        responseStatus = r.statusCode;
        r.resume();
      });
      // Reset is the expected transport outcome of killing the server. events.once
      // would reject on error before the later close observation is awaited.
      const disconnected = new Promise<void>((resolveClosed) =>
        uploading.once("close", resolveClosed),
      );
      uploading.write(part);
      uploading.write(archive.subarray(0, 128 * 1024));
      const spool = await waitFor(async () => {
        const directory = (await readdir(temporaryRoot)).find((name) =>
          name.startsWith(`${sourceSpoolPrefix}${first.pid}-`),
        );
        if (!directory) return;
        const filename = join(temporaryRoot, directory, "upload.zip");
        if ((await stat(filename).catch(() => null))?.size! >= 64 * 1024)
          return { directory: join(temporaryRoot, directory), filename };
      });
      const partial = await readFile(spool.filename);
      expect(partial.length).toBeLessThan(archive.length);
      // Starting another real API must not reclaim an actively uploading owner.
      const observer = await start();
      expect(await readFile(spool.filename)).toEqual(partial);
      expect(await snapshot()).toEqual(before);
      expect(fixtureCalls).toBe(0);
      const exited = once(first.child, "exit");
      expect(first.child.kill("SIGKILL")).toBe(true);
      await exited;
      await disconnected;
      expect(responseStatus).toBeUndefined();
      expect(disconnectCode).toBe("ECONNRESET");
      expect(await readFile(spool.filename)).toEqual(partial);
      expect(await snapshot()).toEqual(before);
      // Normal app startup performs recovery; no direct call to the reaper here.
      const replacement = await start();
      await expect(stat(spool.directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await snapshot()).toEqual(before);
      expect(fixtureCalls).toBe(0);
      const form = new FormData();
      form.append("file", new Blob([archive]), "fixture.zip");
      const upload = await fetch(replacement.origin + "/api/v2/projects", {
        method: "POST",
        headers: replacement.headers,
        body: form,
        signal: AbortSignal.timeout(10000),
      });
      expect(upload.status).toBe(201);
      const { id } = (await upload.json()) as { id: string };
      const analysis = await waitFor(async () => {
        const row = (
          await db.query("SELECT * FROM source_analyses WHERE project_id=$1", [
            id,
          ])
        ).rows[0];
        return row && ["succeeded", "failed"].includes(row.status)
          ? row
          : undefined;
      });
      expect(analysis.status).toBe("succeeded");
      expect(analysis.report.coverage.indexedFiles).toBe(1);
      expect(analysis.report.context.knownInputTokens).toBeNull();
      expect(fixtureCalls).toBe(4);
      expect(
        (await db.query("SELECT count(*)::int AS n FROM source_analyses"))
          .rows[0].n,
      ).toBe(1);
      expect(
        (
          await db.query("SELECT files FROM source_projects WHERE id=$1", [
            historical,
          ])
        ).rows[0].files,
      ).toEqual({ "old/main.ts": "export const old = true;" });
      expect(
        (await readdir(temporaryRoot)).filter((n) =>
          n.startsWith(sourceSpoolPrefix),
        ),
      ).toEqual([]);
      const after = await snapshot();
      // Successful reupload records four fixture calls, all owned by this analysis.
      // The earlier whole-database snapshots still require zero writes on interruption.
      const calls = (await db.query(
        "SELECT analysis_id,call_no,state,usage FROM source_model_calls ORDER BY call_no",
      )).rows;
      expect(calls).toEqual([1, 2, 3, 4].map((call_no) => ({
        analysis_id: analysis.id,
        call_no,
        state: "returned",
        usage: null,
      })));
      for (const table of Object.keys(before).filter(
        (t) => !["source_projects", "source_analyses", "source_model_calls"].includes(t),
      ))
        expect(after[table], `Unexpected mutation in ${table}`).toBe(before[table]);
      record = resolve(
        "docs/verification/2026-09-28",
        `source-http-crash-${randomUUID()}`,
      );
      await mkdir(record, { recursive: true });
      await writeFile(
        join(record, "result.json"),
        JSON.stringify(
          {
            state: "checks-passed-cleanup-pending",
            scenario: "real-authenticated-http-mid-body-api-kill",
            observedPartialBytes: partial.length,
            archiveBytes: archive.length,
            ownerPid: first.pid,
            observerPid: observer.pid,
            replacementPid: replacement.pid,
            liveSpoolPreserved: true,
            killedOwnerSpoolRecoveredOnStartup: true,
            preImportTablesUnchanged: Object.keys(before).length,
            partialUploadCreatedProject: false,
            partialUploadTriggeredModel: false,
            clientSawSuccessBeforeKill: false,
            disconnectCode,
            explicitReupload: {
              status: 201,
              analysis: analysis.status,
              fixtureCalls,
              retainedFiles: 1,
            },
            oldProjectPreserved: true,
            unrelatedTablesUnchanged: true,
            externalModelCalls: 0,
            scope:
              "isolated generated PostgreSQL schema and private temp directory; no live workspace access",
            limitations: [
              "Not host power loss or cross-host recovery",
              "Fixed model; not real model quality",
              "Mid-body kill; other multipart interruption phases are separate cases",
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      for (const request of requests) request.destroy();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      await db.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    expect(record).toBeDefined();
    await expect(stat(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const resultFile = join(record!, "result.json");
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    await writeFile(
      resultFile,
      JSON.stringify(
        {
          ...result,
          state: "passed",
          cleanup: "test-children-schema-and-temp-clean",
          postgresContainerCleanup: "owned by outer test-postgres harness",
        },
        null,
        2,
      ),
    );
  },
  65000,
);
