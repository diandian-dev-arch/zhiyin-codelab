import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
export async function claim(db: DB) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(41722)");
    // Interrupted analysis is finalized from persisted deterministic results, never silently re-billed.
    await tx.query(
      "UPDATE runs SET status='review',model_status='interrupted',lease_token=NULL,lease_until=NULL,finished_at=now() WHERE contract_version=1 AND status='analyzing' AND lease_until<now()",
    );
    await tx.query(
      `UPDATE runs r SET status='infra_error',outcome='infra_error',results=(SELECT jsonb_agg(jsonb_build_object('criterionId',c->>'id','status','not_run','observation','执行租约已过期，检查未完成。','steps','[]'::jsonb,'evidenceIds','[]'::jsonb)) FROM submissions s JOIN rules ru ON ru.id=s.rule_id CROSS JOIN LATERAL jsonb_array_elements(ru.criteria) c WHERE s.id=r.submission_id),lease_token=NULL,lease_until=NULL,finished_at=now() WHERE contract_version=1 AND status='building' AND lease_until<now()`,
    );
    if (
      (
        await tx.query(
          `SELECT 1 WHERE EXISTS(SELECT 1 FROM runs WHERE status IN ('building','analyzing'))
            OR EXISTS(SELECT 1 FROM execution_attempts WHERE owner_phase<>'closed')
            OR EXISTS(SELECT 1 FROM analysis_attempts WHERE mode='reanalysis' AND owner_phase IS NOT NULL AND owner_phase<>'closed')`,
        )
      ).rows.length
    )
      return null;
    const next = (
      await tx.query(
        "SELECT id FROM runs WHERE contract_version=1 AND status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!next) return null;
    const lease = randomUUID();
    return (
      await tx.query(
        "UPDATE runs SET status='building',lease_token=$2,lease_until=now()+interval '330 seconds',attempts=attempts+1 WHERE id=$1 RETURNING *",
        [next.id, lease],
      )
    ).rows[0];
  });
}
export async function ownedUpdate(
  db: DB,
  id: string,
  lease: string,
  sql: string,
  values: any[] = [],
) {
  return (
    (
      await db.query(
        `UPDATE runs SET ${sql} WHERE id=$1 AND contract_version=1 AND lease_token=$2 AND lease_until>now() RETURNING id`,
        [id, lease, ...values],
      )
    ).rows.length === 1
  );
}
