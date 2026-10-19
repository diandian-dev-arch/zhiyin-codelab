import type { DB } from './db.js';
import { STORAGE_WORK_BYTES, StorageAdmissionError, type StorageAdmission } from '../../runner/src/storage-admission.js';

/** Caller holds GLOBAL_QUEUE_LOCK_ID through capacity measurement and commit.
 * Durable queue/owner rows ARE the reservation ledger. No TTL can free capacity
 * while a lost owner still holds files; only cancellation/verified cleanup can.
 * Initial analysis shares its execution reservation. Existing bytes may also be
 * reflected in statfs; double counting while active is intentionally conservative.
 */
export async function reservedStorageBytesV2(tx: DB): Promise<number> {
  const { rows } = await tx.query(`SELECT (
    SELECT count(*) FROM runs r WHERE r.contract_version=2 AND
      (r.status='queued' OR EXISTS (SELECT 1 FROM execution_attempts e WHERE e.run_id=r.id AND e.owner_phase<>'closed'))
    ) + (
    SELECT count(*) FROM analysis_attempts WHERE mode='reanalysis' AND
      (status='queued' OR (owner_phase IS NOT NULL AND owner_phase<>'closed'))
    ) AS reservations`);
  const count = Number(rows[0]?.reservations);
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(count * STORAGE_WORK_BYTES))
    throw new StorageAdmissionError('STORAGE_CAPACITY_UNKNOWN');
  return count * STORAGE_WORK_BYTES;
}

export async function admitReservedStorageV2(tx: DB, admission: StorageAdmission | undefined, additionalWork: boolean) {
  if (!admission) return; // Optional injection for library callers; runtime entrypoints supply it.
  const bytes = await reservedStorageBytesV2(tx) + (additionalWork ? STORAGE_WORK_BYTES : 0);
  try { await admission(bytes); }
  catch (error) {
    if (error instanceof StorageAdmissionError) throw error;
    throw new StorageAdmissionError('STORAGE_CAPACITY_UNKNOWN');
  }
}
