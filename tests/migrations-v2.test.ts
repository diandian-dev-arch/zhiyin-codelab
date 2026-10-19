import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../apps/api/src/db.js";
import { loadMigrations } from "../apps/api/src/migrations.js";
import { isolatedTestDB, type IsolatedTestDatabase } from "./isolated-db.js";

let db: IsolatedTestDatabase;
const postgresUrl = process.env.CODELAB_TEST_POSTGRES_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
beforeEach(async () => {
  db = await isolatedTestDB();
});
afterEach(async () => {
  await db?.close();
});

async function seed(version: 1 | 2 = 2) {
  const teacher = randomUUID(),
    student = randomUUID(),
    classId = randomUUID(),
    task = randomUUID();
  const rule = randomUUID(),
    submission = randomUUID(),
    run = randomUUID();
  await db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Teacher','teacher','hash'),($3,$4,'Student','student','hash')",
    [teacher, `${teacher}@test.local`, student, `${student}@test.local`],
  );
  await db.query(
    "INSERT INTO classes(id,name,teacher_id) VALUES($1,'Class',$2)",
    [classId, teacher],
  );
  await db.query(
    "INSERT INTO tasks(id,class_id,title,description) VALUES($1,$2,'Task','Task')",
    [task, classId],
  );
  if (version === 1) {
    await db.query(
      "INSERT INTO rules(id,task_id,version,template_version,criteria) VALUES($1,$2,1,'vue-board-v1','[]')",
      [rule, task],
    );
    await db.query(
      "INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id) VALUES($1::uuid,$2,$3,$4,$5,'{}',$1::text)",
      [submission, task, student, rule, "a".repeat(64)],
    );
    await db.query(
      "INSERT INTO runs(id,submission_id,status,execution_config,request_id) VALUES($1::uuid,$2,'review','{}',$1::text)",
      [run, submission],
    );
  } else {
    await db.query(
      "INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash) VALUES($1::uuid,$2,1,'vue-board-v1','[]',2,'{\"version\":2}',$1::text,'rule-hash')",
      [rule, task],
    );
    await db.query(
      "INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256) VALUES($1::uuid,$2,$3,$4,$5,'{}',$1::text,2,'{\"version\":1,\"files\":[]}',$5)",
      [submission, task, student, rule, "a".repeat(64)],
    );
    await db.query(
      "INSERT INTO runs(id,submission_id,rule_id,status,execution_config,request_id,contract_version,idempotency_key,request_hash) VALUES($1::uuid,$2,$3,'queued','{}',$1::text,2,$1::text,'request-hash')",
      [run, submission, rule],
    );
  }
  return { teacher, student, task, rule, submission, run };
}

async function execution(run: string, attemptNo = 1) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO execution_attempts(id,run_id,attempt_no,owner_phase,lease_token,lease_until,heartbeat_at,pipeline_started_at,work_deadline_at,pipeline_deadline_at)
    VALUES($1,$2,$3,'preparing',$4,now()+interval '30 seconds',now(),now(),now()+interval '270 seconds',now()+interval '300 seconds')`,
    [id, run, attemptNo, randomUUID()],
  );
  return id;
}

describe("versioned database migration", () => {
  it("creates an empty database, records checksums, and is unchanged on repeat", async () => {
    expect(await migrate(db)).toEqual({
      registeredLegacyBaseline: false,
      applied: (await loadMigrations()).map(m => m.version),
    });
    const history = (
      await db.query("SELECT * FROM schema_migrations ORDER BY version")
    ).rows;
    expect(history.map((row) => row.version)).toEqual((await loadMigrations()).map(m => m.version));
    expect(history.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(
      true,
    );
    expect(await migrate(db)).toEqual({
      registeredLegacyBaseline: false,
      applied: [],
    });
    expect(
      (await db.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(history);
    const legacy = await seed(1);
    expect(
      (
        await db.query(
          "SELECT contract_version,accepted_execution_attempt_id FROM runs WHERE id=$1",
          [legacy.run],
        )
      ).rows[0],
    ).toEqual({ contract_version: 1, accepted_execution_attempt_id: null });
  });

  it("verifies the initial schema before registering legacy data and preserves old reports", async () => {
    const sources = await loadMigrations();
    await db.exec(sources[0]!.sql);
    const data = await seed(1),
      report = randomUUID();
    await db.query(
      "INSERT INTO reports(id,run_id,snapshot,published_by) VALUES($1,$2,'{\"legacy\":true}',$3)",
      [report, data.run, data.teacher],
    );
    const before = (
      await db.query("SELECT * FROM reports WHERE id=$1", [report])
    ).rows[0];
    expect(await migrate(db)).toEqual({
      registeredLegacyBaseline: true,
      applied: sources.slice(1).map(m => m.version),
    });
    expect(
      (await db.query("SELECT * FROM reports WHERE id=$1", [report])).rows[0],
    ).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT contract_version,rule_snapshot FROM rules WHERE id=$1",
          [data.rule],
        )
      ).rows[0],
    ).toEqual({ contract_version: 1, rule_snapshot: null });
    await expect(
      db.query("UPDATE reports SET snapshot='{}' WHERE id=$1", [report]),
    ).rejects.toThrow("immutable record");
  });

  it.each([
    "ALTER TABLE rules ADD COLUMN unexpected text",
    "DROP TRIGGER rules_immutable ON rules",
    "ALTER TABLE users DROP CONSTRAINT users_role_check",
    "CREATE OR REPLACE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$",
  ])(
    "rejects a mismatching legacy schema without stamping a baseline: %s",
    async (change) => {
      await db.exec((await loadMigrations())[0]!.sql);
      await db.exec(change);
      await expect(migrate(db)).rejects.toThrow("LEGACY_SCHEMA_MISMATCH");
      expect(
        (await db.query("SELECT to_regclass('schema_migrations') AS relation"))
          .rows[0].relation,
      ).toBeNull();
      expect(
        (
          await db.query(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'codelab_baseline_%'",
          )
        ).rows,
      ).toEqual([]);
    },
  );

  it("rejects modified applied SQL and does not rewrite its checksum", async () => {
    await migrate(db);
    const sources = await loadMigrations();
    sources[0] = { ...sources[0]!, sql: sources[0]!.sql + "\n-- changed" };
    await expect(migrate(db, sources)).rejects.toThrow(
      "MIGRATION_HISTORY_MISMATCH",
    );
    expect(
      (await db.query("SELECT count(*)::int AS total FROM schema_migrations"))
        .rows[0].total,
    ).toBe(sources.length);
  });

  it("rolls failed DDL and its history back, then permits a corrected unapplied migration", async () => {
    await migrate(db);
    const sources = await loadMigrations();
    await expect(
      migrate(db, [
        ...sources,
        {
          version: sources.length + 1,
          name: `${String(sources.length + 1).padStart(3, '0')}_failure.sql`,
          sql: "CREATE TABLE migration_probe(id int); SELECT no_such_column;",
        },
      ]),
    ).rejects.toThrow("no_such_column");
    expect(
      (await db.query("SELECT to_regclass('migration_probe') AS relation"))
        .rows[0].relation,
    ).toBeNull();
    expect(
      (await db.query("SELECT count(*)::int AS total FROM schema_migrations"))
        .rows[0].total,
    ).toBe(sources.length);
    expect(
      (
        await migrate(db, [
          ...sources,
          {
            version: sources.length + 1,
            name: `${String(sources.length + 1).padStart(3, '0')}_failure.sql`,
            sql: "CREATE TABLE migration_probe(id int);",
          },
        ])
      ).applied,
    ).toEqual([sources.length + 1]);
  });

  it.each(["lowercase", "Mixed Case"])(
    "uses current_schema with %s identifiers and preserves the surrounding schema",
    async (style) => {
      const original = (await db.query("SELECT current_schema() AS name"))
        .rows[0].name;
      const nested = `codelab_test_${style}_${randomUUID().replaceAll("-", "")}`;
      await db.transaction(async (tx) => {
        await tx.exec(
          `CREATE TABLE sentinel(id int); CREATE SCHEMA ${quote(nested)}`,
        );
        await tx.query("SELECT set_config('search_path',$1,true)", [
          `${quote(nested)},pg_catalog`,
        ]);
        await tx.exec((await loadMigrations())[0]!.sql);
        expect((await migrate(tx)).registeredLegacyBaseline).toBe(true);
        expect(
          (
            await tx.query("SELECT to_regclass($1) AS relation", [
              `${quote(nested)}.execution_attempts`,
            ])
          ).rows[0].relation,
        ).not.toBeNull();
        expect(
          (
            await tx.query("SELECT to_regclass($1) AS relation", [
              `${quote(original)}.execution_attempts`,
            ])
          ).rows[0].relation,
        ).toBeNull();
        expect(
          (await tx.query(`SELECT * FROM ${quote(original)}.sentinel`)).rows,
        ).toEqual([]);
        await tx.query("SELECT set_config('search_path',$1,true)", [
          `${quote(original)},pg_catalog`,
        ]);
        await tx.exec(`DROP SCHEMA ${quote(nested)} CASCADE`);
      });
    },
  );

  it.skipIf(!postgresUrl)(
    "serializes two real PostgreSQL connections migrating the same fresh schema",
    async () => {
      const second = db.connectPeer();
      try {
        const outcomes = await Promise.all([migrate(db), migrate(second)]);
        expect(
          outcomes.map((outcome) => outcome.applied.length).sort(),
        ).toEqual([0, (await loadMigrations()).length]);
        expect(
          (
            await db.query(
              "SELECT version FROM schema_migrations ORDER BY version",
            )
          ).rows,
        ).toEqual([
          { version: 1 },
          { version: 2 },
          { version: 3 },
          { version: 4 },
          { version: 5 },
          { version: 6 },
          { version: 7 },
          { version: 8 },
          { version: 9 },
          { version: 10 },
          { version: 11 },
          { version: 12 },
          { version: 13 },
          { version: 14 },
          { version: 15 },
          { version: 16 },
          { version: 17 },
          { version: 18 },
          { version: 19 },
          { version: 20 },
          { version: 21 },
          { version: 22 },
        ]);
      } finally {
        await second.close();
      }
    },
  );

  it("keeps nested transactions in the outer rollback boundary", async () => {
    await migrate(db);
    await expect(
      db.transaction(async (outer) => {
        await outer.transaction(async (inner) => {
          await inner.query(
            "INSERT INTO users VALUES($1,'nested@test.local','N','teacher','hash')",
            [randomUUID()],
          );
        });
        throw new Error("outer rollback");
      }),
    ).rejects.toThrow("outer rollback");
    expect(
      (await db.query("SELECT id FROM users WHERE email='nested@test.local'"))
        .rows,
    ).toEqual([]);
  });

  it("upgrades an applied v2 schema without rewriting revisions or migration history", async () => {
    const sources = await loadMigrations();
    await migrate(db, sources.slice(0, 2));
    const data = await seed(),
      revision = randomUUID();
    await db.query(
      "INSERT INTO report_revisions(id,run_id,revision_no,base_manifest_id,source,idempotency_key,request_hash) VALUES($1::uuid,$2,1,$3,'base',$1::text,'hash')",
      [revision, data.run, randomUUID()],
    );
    const before = (
      await db.query("SELECT * FROM report_revisions WHERE id=$1", [revision])
    ).rows[0];
    const history = (
      await db.query("SELECT * FROM schema_migrations ORDER BY version")
    ).rows;
    expect((await migrate(db)).applied).toEqual(sources.slice(2).map(m => m.version));
    expect(
      (await db.query("SELECT * FROM report_revisions WHERE id=$1", [revision]))
        .rows[0],
    ).toEqual({ ...before, origin_publication_id: null });
    expect(
      (
        await db.query(
          "SELECT * FROM schema_migrations WHERE version<=2 ORDER BY version",
        )
      ).rows,
    ).toEqual(history);
  });
});

describe("v2 stored fact and resource boundaries", () => {
  beforeEach(async () => {
    await migrate(db);
  });

  it("stores task request identity per class and rejects incomplete identities", async () => {
    const data = await seed();
    const classId = (
      await db.query("SELECT class_id FROM tasks WHERE id=$1", [data.task])
    ).rows[0].class_id;
    const id = randomUUID();
    await db.query(
      "INSERT INTO tasks(id,class_id,title,description,idempotency_key,request_hash) VALUES($1,$2,'New task','Description','create-task-1','hash')",
      [id, classId],
    );
    await expect(
      db.query(
        "INSERT INTO tasks(id,class_id,title,description,idempotency_key,request_hash) VALUES($1,$2,'Duplicate','Description','create-task-1','hash')",
        [randomUUID(), classId],
      ),
    ).rejects.toThrow("tasks_creation_idempotency");
    await expect(
      db.query(
        "INSERT INTO tasks(id,class_id,title,description,idempotency_key) VALUES($1,$2,'Partial','Description','partial-key')",
        [randomUUID(), classId],
      ),
    ).rejects.toThrow("task_creation_identity_complete");
    await expect(
      db.query(
        "INSERT INTO tasks(id,class_id,title,description,request_hash) VALUES($1,$2,'Partial','Description','hash')",
        [randomUUID(), classId],
      ),
    ).rejects.toThrow("task_creation_identity_complete");
    const otherClass = randomUUID();
    await db.query(
      "INSERT INTO classes(id,name,teacher_id) VALUES($1,'Other class',$2)",
      [otherClass, data.teacher],
    );
    await db.query(
      "INSERT INTO tasks(id,class_id,title,description,idempotency_key,request_hash) VALUES($1,$2,'Independent','Description','create-task-1','hash')",
      [randomUUID(), otherClass],
    );
    expect(
      (
        await db.query(
          "SELECT idempotency_key,request_hash FROM tasks WHERE id=$1",
          [data.task],
        )
      ).rows[0],
    ).toEqual({ idempotency_key: null, request_hash: null });
  });

  it("seals baseline once while allowing heartbeat and verified cleanup metadata", async () => {
    const data = await seed(),
      attempt = await execution(data.run);
    await db.query(
      'UPDATE execution_attempts SET base_sealed_at=now(),base_manifest=\'{"completeness":"partial"}\',actual_fingerprint=\'{"completeness":"unknown"}\' WHERE id=$1',
      [attempt],
    );
    await expect(
      db.query(
        'UPDATE execution_attempts SET base_results=\'[{"status":"passed"}]\' WHERE id=$1',
        [attempt],
      ),
    ).rejects.toThrow("sealed base is immutable");
    await expect(
      db.query(
        "UPDATE execution_attempts SET base_sealed_at=NULL WHERE id=$1",
        [attempt],
      ),
    ).rejects.toThrow("sealed base is immutable");
    await db.query(
      "UPDATE execution_attempts SET heartbeat_at=now(),owner_phase='cleaning',cleanup_state='cleaning' WHERE id=$1",
      [attempt],
    );
    await expect(
      db.query(
        "UPDATE execution_attempts SET owner_phase='closed',cleanup_state='clean' WHERE id=$1",
        [attempt],
      ),
    ).rejects.toThrow();
    await db.query(
      "UPDATE execution_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{\"status\":\"clean\"}' WHERE id=$1",
      [attempt],
    );
    await expect(
      db.query(
        "UPDATE execution_attempts SET owner_phase='preparing' WHERE id=$1",
        [attempt],
      ),
    ).rejects.toThrow("cannot reopen");
    await db.query(
      "UPDATE runs SET accepted_execution_attempt_id=$2,status='completed' WHERE id=$1",
      [data.run, attempt],
    );
    await expect(
      db.query("UPDATE runs SET status='queued' WHERE id=$1", [data.run]),
    ).rejects.toThrow("terminal run cannot reopen");
    const next = await execution(data.run, 2);
    await expect(
      db.query(
        "UPDATE execution_attempts SET base_sealed_at=now(),base_manifest='{}',actual_fingerprint='{}' WHERE id=$1",
        [next],
      ),
    ).rejects.toThrow();
    await expect(
      db.query("UPDATE runs SET accepted_execution_attempt_id=$2 WHERE id=$1", [
        data.run,
        next,
      ]),
    ).rejects.toThrow("cannot change");
  });

  it("allows one queued/running analysis and keeps completed analysis resources occupied until clean", async () => {
    const data = await seed(),
      first = randomUUID();
    await db.query(
      "INSERT INTO analysis_attempts(id,run_id,mode,status) VALUES($1,$2,'reanalysis','queued')",
      [first, data.run],
    );
    await expect(
      db.query(
        "INSERT INTO analysis_attempts(id,run_id,mode,status) VALUES($1,$2,'reanalysis','queued')",
        [randomUUID(), data.run],
      ),
    ).rejects.toThrow();
    await db.query(
      "UPDATE analysis_attempts SET status='succeeded',owner_phase='cleanup_pending',cleanup_state='cleanup_pending',work_deadline_at=now()+interval '60 seconds',hard_deadline_at=now()+interval '90 seconds' WHERE id=$1",
      [first],
    );
    expect(
      (
        await db.query(
          "SELECT id FROM analysis_attempts WHERE mode='reanalysis' AND owner_phase IS NOT NULL AND owner_phase<>'closed'",
        )
      ).rows,
    ).toEqual([{ id: first }]);
    await expect(
      db.query(
        "UPDATE analysis_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{}' WHERE id=$1",
        [first],
      ),
    ).rejects.toThrow();
    await db.query(
      "UPDATE analysis_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{\"status\":\"clean\"}' WHERE id=$1",
      [first],
    );
    const parent = await execution(data.run);
    await expect(
      db.query(
        "INSERT INTO analysis_attempts(id,run_id,mode,status,owner_execution_attempt_id,lease_token) VALUES($1,$2,'initial','running',$3,$4)",
        [randomUUID(), data.run, parent, randomUUID()],
      ),
    ).rejects.toThrow();
    await db.query(
      "INSERT INTO analysis_attempts(id,run_id,mode,status,owner_execution_attempt_id) VALUES($1,$2,'initial','running',$3)",
      [randomUUID(), data.run, parent],
    );
  });

  it("keeps revisions and publications immutable and rejects cross-run references", async () => {
    const data = await seed(),
      revision = randomUUID(),
      publication = randomUUID();
    await db.query(
      "INSERT INTO report_revisions(id,run_id,revision_no,base_manifest_id,source,idempotency_key,request_hash) VALUES($1::uuid,$2,1,$3,'base',$1::text,'revision-hash')",
      [revision, data.run, randomUUID()],
    );
    await db.query(
      "INSERT INTO publications(id,run_id,publication_no,revision_id,purpose,snapshot,published_by,idempotency_key,request_hash) VALUES($1::uuid,$2,1,$3,'latest','{}',$4,$1::text,'publication-hash')",
      [publication, data.run, revision, data.teacher],
    );
    await expect(
      db.query("UPDATE report_revisions SET feedback='[]' WHERE id=$1", [
        revision,
      ]),
    ).rejects.toThrow("immutable record");
    await expect(
      db.query("DELETE FROM publications WHERE id=$1", [publication]),
    ).rejects.toThrow("immutable record");
    const correctionRevision = randomUUID();
    await db.query(
      "INSERT INTO report_revisions(id,run_id,revision_no,parent_revision_id,base_manifest_id,source,origin_publication_id,idempotency_key,request_hash) VALUES($1::uuid,$2,2,$3,$4,'historical_correction',$5,$1::text,'correction-hash')",
      [correctionRevision, data.run, revision, randomUUID(), publication],
    );
    expect(
      (
        await db.query(
          "SELECT origin_publication_id FROM report_revisions WHERE id=$1",
          [correctionRevision],
        )
      ).rows[0]?.origin_publication_id,
    ).toBe(publication);
    await expect(
      db.query(
        "UPDATE report_revisions SET origin_publication_id=NULL WHERE id=$1",
        [correctionRevision],
      ),
    ).rejects.toThrow("immutable record");
    const other = await seed();
    await expect(
      db.query(
        "INSERT INTO report_revisions(id,run_id,revision_no,base_manifest_id,source,origin_publication_id,idempotency_key,request_hash) VALUES($1::uuid,$2,1,$3,'historical_correction',$4,$1::text,'cross-run-origin')",
        [randomUUID(), other.run, randomUUID(), publication],
      ),
    ).rejects.toThrow("report_revision_origin_same_run");
    await expect(
      db.query(
        "INSERT INTO publications(id,run_id,publication_no,revision_id,purpose,snapshot,published_by,idempotency_key,request_hash) VALUES($1::uuid,$2,1,$3,'latest','{}',$4,$1::text,'hash')",
        [randomUUID(), other.run, revision, other.teacher],
      ),
    ).rejects.toThrow();
  });
});
