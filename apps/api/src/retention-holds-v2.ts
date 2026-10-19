import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DB } from './db.js';

const actionSchema = z.object({
  action: z.enum(['hold', 'release']), targetId: z.string().uuid(), requestId: z.string().uuid(),
  reason: z.string().trim().min(3).max(300),
}).strict();
// Shared by hold/release writers; future lifecycle deletion must take this lock too.
const RETENTION_LOCK = 41724;

/** Local operator only; never expose this function as an unauthenticated HTTP handler. */
export async function changeRetentionHoldV2(db: DB, raw: unknown) {
  const input = actionSchema.parse(raw);
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [RETENTION_LOCK]);
    const prior = (await tx.query(`SELECT id,run_id AS target_id,reason,'hold' AS action FROM retention_holds WHERE request_id=$1
      UNION ALL SELECT id,hold_id AS target_id,reason,'release' AS action FROM retention_hold_releases WHERE request_id=$1`, [input.requestId])).rows;
    if (prior.length) {
      const row = prior[0];
      if (prior.length !== 1 || row.action !== input.action || row.target_id !== input.targetId || row.reason !== input.reason)
        throw new Error('RETENTION_REQUEST_CONFLICT');
      return { eventId: row.id as string, action: input.action, replayed: true, deletionAuthorized: false as const };
    }
    const id = randomUUID();
    if (input.action === 'hold') {
      const run = (await tx.query('SELECT id FROM runs WHERE id=$1 AND contract_version=2 FOR KEY SHARE', [input.targetId])).rows[0];
      if (!run) throw new Error('RETENTION_RUN_NOT_FOUND');
      await tx.query('INSERT INTO retention_holds(id,run_id,request_id,reason) VALUES($1,$2,$3,$4)', [id,input.targetId,input.requestId,input.reason]);
    } else {
      const hold = (await tx.query('SELECT id FROM retention_holds WHERE id=$1 FOR KEY SHARE', [input.targetId])).rows[0];
      if (!hold) throw new Error('RETENTION_HOLD_NOT_FOUND');
      if ((await tx.query('SELECT id FROM retention_hold_releases WHERE hold_id=$1', [input.targetId])).rows.length)
        throw new Error('RETENTION_HOLD_ALREADY_RELEASED');
      await tx.query('INSERT INTO retention_hold_releases(id,hold_id,request_id,reason) VALUES($1,$2,$3,$4)', [id,input.targetId,input.requestId,input.reason]);
    }
    return { eventId: id, action: input.action, replayed: false, deletionAuthorized: false as const };
  });
}
