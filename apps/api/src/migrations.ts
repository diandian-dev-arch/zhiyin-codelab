import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { DB } from "./db.js";

export interface MigrationSource {
  version: number;
  name: string;
  sql: string;
}
export const MIGRATION_LOCK_ID = 41723;
const legacyTables = [
  "users",
  "classes",
  "memberships",
  "sessions",
  "tasks",
  "rules",
  "submissions",
  "runs",
  "reports",
  "revisions",
  "events",
];
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const checksum = (sql: string) =>
  createHash("sha256").update(sql, "utf8").digest("hex");

export async function loadMigrations(): Promise<MigrationSource[]> {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) =>
    /^\d{3,}_[a-z0-9_]+\.sql$/.test(name),
  );
  return Promise.all(
    names.sort().map(async (name) => ({
      version: Number(name.split("_")[0]),
      name,
      sql: await readFile(new URL(name, directory), "utf8"),
    })),
  );
}

async function structure(db: DB, schema: string) {
  const columns = (
    await db.query(
      `
    SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
      pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind='r'
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
      [schema, legacyTables],
    )
  ).rows;
  const constraints = (
    await db.query(
      `
    SELECT t.relname AS table_name, c.conname, c.contype, pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) ORDER BY t.relname,c.conname`,
      [schema, legacyTables],
    )
  ).rows;
  const indexes = (
    await db.query(
      `
    SELECT t.relname AS table_name, i.relname AS index_name, pg_get_indexdef(i.oid) AS definition
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) ORDER BY t.relname,i.relname`,
      [schema, legacyTables],
    )
  ).rows;
  const triggers = (
    await db.query(
      `
    SELECT c.relname AS table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT t.tgisinternal
    ORDER BY c.relname,t.tgname`,
      [schema, legacyTables],
    )
  ).rows;
  const functions = (
    await db.query(
      `
    SELECT p.proname,p.prosrc,l.lanname,p.provolatile,p.proisstrict,p.prosecdef,p.proconfig,
      format_type(p.prorettype,NULL) AS return_type
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND p.proname='immutable_record' AND p.pronargs=0 ORDER BY p.proname`,
      [schema],
    )
  ).rows;
  // Catalog definitions qualify identifiers only when they are outside search_path.
  const normalize = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "string"
        ? item
            .replaceAll(`${quoteIdentifier(schema)}.`, "")
            .replaceAll(`${schema}.`, "")
        : item,
    );
  return Object.fromEntries(
    Object.entries({ columns, constraints, indexes, triggers, functions }).map(
      ([key, value]) => [key, normalize(value)],
    ),
  );
}

async function verifyLegacy(
  db: DB,
  targetSchema: string,
  initial: MigrationSource,
) {
  const found = (
    await db.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind='r'`,
      [targetSchema, legacyTables],
    )
  ).rows;
  if (!found.length) return false;
  if (found.length !== legacyTables.length)
    throw new Error(
      "LEGACY_SCHEMA_MISMATCH: initial tables are incomplete; refusing to register 001",
    );
  const actual = await structure(db, targetSchema);
  const shadow = `codelab_baseline_${randomUUID().replaceAll("-", "")}`;
  // This schema is created in the same transaction and contains no user records.
  await db.exec(`CREATE SCHEMA ${quoteIdentifier(shadow)}`);
  await db.query("SELECT set_config('search_path',$1,true)", [
    `${quoteIdentifier(shadow)},pg_catalog`,
  ]);
  await db.exec(initial.sql);
  const expected = await structure(db, shadow);
  await db.query("SELECT set_config('search_path',$1,true)", [
    `${quoteIdentifier(targetSchema)},pg_catalog`,
  ]);
  await db.exec(`DROP SCHEMA ${quoteIdentifier(shadow)} CASCADE`);
  const difference = Object.keys(expected).find(
    (key) => actual[key] !== expected[key],
  );
  if (difference)
    throw new Error(
      `LEGACY_SCHEMA_MISMATCH: ${difference} differs from 001; refusing to register a historical baseline`,
    );
  return true;
}

export async function runMigrations(
  db: DB,
  input?: readonly MigrationSource[],
) {
  const migrations = [...(input ?? (await loadMigrations()))].sort(
    (a, b) => a.version - b.version,
  );
  if (
    !migrations.length ||
    migrations.some(
      (item, index) =>
        item.version !== index + 1 ||
        !/^\d{3,}_[a-z0-9_]+\.sql$/.test(item.name),
    )
  ) {
    throw new Error(
      "MIGRATION_SEQUENCE_INVALID: numbered migration files must form a contiguous sequence starting at 001",
    );
  }
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    const targetSchema = (await tx.query("SELECT current_schema() AS name"))
      .rows[0]?.name;
    if (typeof targetSchema !== "string" || !targetSchema)
      throw new Error("MIGRATION_SCHEMA_MISSING");
    await tx.query("SELECT set_config('search_path',$1,true)", [
      `${quoteIdentifier(targetSchema)},pg_catalog`,
    ]);
    const ledger = (
      await tx.query("SELECT to_regclass($1) AS relation", [
        `${quoteIdentifier(targetSchema)}.schema_migrations`,
      ])
    ).rows[0]?.relation;
    const legacy =
      !ledger && (await verifyLegacy(tx, targetSchema, migrations[0]!));
    if (!ledger) {
      await tx.exec(`CREATE TABLE schema_migrations(
        version integer PRIMARY KEY CHECK(version>0), name text UNIQUE NOT NULL,
        checksum text NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'), applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      if (legacy)
        await tx.query(
          "INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)",
          [1, migrations[0]!.name, checksum(migrations[0]!.sql)],
        );
    }
    const applied = (
      await tx.query(
        "SELECT version,name,checksum FROM schema_migrations ORDER BY version",
      )
    ).rows;
    for (let index = 0; index < applied.length; index++) {
      const row = applied[index],
        source = migrations[index];
      if (
        !source ||
        row.version !== source.version ||
        row.name !== source.name ||
        row.checksum !== checksum(source.sql)
      ) {
        throw new Error(
          `MIGRATION_HISTORY_MISMATCH: applied migration ${row.version} is missing, reordered, renamed or modified`,
        );
      }
    }
    const newlyApplied: number[] = [];
    for (const source of migrations.slice(applied.length)) {
      await tx.exec(source.sql);
      await tx.query(
        "INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)",
        [source.version, source.name, checksum(source.sql)],
      );
      newlyApplied.push(source.version);
    }
    return { registeredLegacyBaseline: legacy, applied: newlyApplied };
  });
}
