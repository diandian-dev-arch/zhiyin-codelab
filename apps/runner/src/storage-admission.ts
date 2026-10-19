import { statfs } from 'node:fs/promises';
import path from 'node:path';

export class StorageAdmissionError extends Error {
  readonly statusCode = 503;
  constructor(readonly code: 'STORAGE_CAPACITY_LOW' | 'STORAGE_CAPACITY_UNKNOWN') {
    super(code === 'STORAGE_CAPACITY_LOW' ? '存储空间不足，已暂停新增提交和执行；已有报告仍可读取' : '暂时无法核验存储容量，请稍后重试');
  }
}
export const STORAGE_WORK_BYTES = 128 * 1024 ** 2;
export type StorageAdmission = (requiredBytes?: number) => Promise<void>;
/** Capacity snapshot including caller's logical reservations, not a filesystem quota. */
export function assertStorageHeadroom(total: number, available: number, requiredBytes = STORAGE_WORK_BYTES) {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(available) || total <= 0 || available < 0 || available > total)
    throw new StorageAdmissionError('STORAGE_CAPACITY_UNKNOWN');
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new StorageAdmissionError('STORAGE_CAPACITY_UNKNOWN');
  if (available - requiredBytes <= Math.max(2 * 1024 ** 3, total * 0.05))
    throw new StorageAdmissionError('STORAGE_CAPACITY_LOW');
}
export function createStorageAdmission(directory: string): StorageAdmission {
  return async (requiredBytes = STORAGE_WORK_BYTES) => {
    let current = path.resolve(directory);
    try {
      // A first run may not have created the evidence directory yet. Its nearest
      // existing parent determines the target filesystem; other errors fail closed.
      for (;;) {
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const info = await Promise.race([
            statfs(current),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StorageAdmissionError('STORAGE_CAPACITY_UNKNOWN')), 2000); }),
          ]).finally(() => { if (timer) clearTimeout(timer); });
          assertStorageHeadroom(info.blocks * info.bsize, info.bavail * info.bsize, requiredBytes);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw error;
          current = path.dirname(current);
        }
      }
    } catch (error) {
      if (error instanceof StorageAdmissionError) throw error;
      throw new StorageAdmissionError('STORAGE_CAPACITY_UNKNOWN');
    }
  };
}
