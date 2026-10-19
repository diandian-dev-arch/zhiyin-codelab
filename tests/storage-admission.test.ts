import { expect, it, vi, afterEach } from 'vitest';
import { statfs } from 'node:fs/promises';
import { assertStorageHeadroom, createStorageAdmission } from '../apps/runner/src/storage-admission';
vi.mock('node:fs/promises', () => ({ statfs: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it('leaves fixed recovery headroom and enforces a proportional floor', () => {
  const G = 1024 ** 3;
  expect(() => assertStorageHeadroom(100 * G, 20 * G)).not.toThrow();
  expect(() => assertStorageHeadroom(100 * G, 5 * G)).toThrow('存储空间不足');
  expect(() => assertStorageHeadroom(10 * G, 2 * G)).toThrow('存储空间不足');
  expect(() => assertStorageHeadroom(NaN, 10)).toThrow('无法核验');
});
it('accounts for all reserved future writes instead of a single request', () => {
  const G = 1024 ** 3;
  expect(() => assertStorageHeadroom(100 * G, 5.2 * G, 128 * 1024 ** 2)).toThrow('无法核验'); // fractional byte measurements rejected
  const available = 5 * G + 200 * 1024 ** 2;
  expect(() => assertStorageHeadroom(100 * G, available, 128 * 1024 ** 2)).not.toThrow();
  expect(() => assertStorageHeadroom(100 * G, available, 256 * 1024 ** 2)).toThrow('存储空间不足');
  expect(() => assertStorageHeadroom(100 * G, available, -1)).toThrow('无法核验');
});
it('checks existing parent for a first-run directory', async () => {
  vi.mocked(statfs).mockRejectedValueOnce(Object.assign(new Error(), { code: 'ENOENT' }))
    .mockResolvedValue({ blocks: 100000, bavail: 50000, bsize: 1024 ** 2 } as any);
  await expect(createStorageAdmission('/store/new')()).resolves.toBeUndefined();
  expect(statfs).toHaveBeenCalledTimes(2);
});
it('fails closed on measurement errors without exposing paths or system errors', async () => {
  vi.mocked(statfs).mockRejectedValue(Object.assign(new Error('private path'), { code: 'EACCES' }));
  await expect(createStorageAdmission('/store')()).rejects.toMatchObject({ code: 'STORAGE_CAPACITY_UNKNOWN', statusCode: 503 });
});
