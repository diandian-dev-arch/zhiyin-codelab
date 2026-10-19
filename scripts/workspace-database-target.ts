import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Local recovery selection; never silently adopt a replacement container.
export async function workspaceDatabaseTarget(root: string) {
  try {
    const value = JSON.parse(await readFile(path.join(root,'.data/workspace-database.json'),'utf8'));
    if (typeof value?.name !== 'string' || typeof value?.id !== 'string' ||
        !/^codelab-[a-z0-9-]+$/.test(value.name) || !/^[a-f0-9]{64}$/.test(value.id))
      throw new Error('INVALID');
    return { name: value.name as string, id: value.id as string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('WORKSPACE_DATABASE_TARGET_INVALID');
    return { name: 'codelab-workspace-postgres-v2', id: undefined };
  }
}

export function assertDatabaseTarget(target: {id?: string}, info: {Id: string}) {
  if (target.id && info.Id !== target.id) throw new Error('WORKSPACE_DATABASE_TARGET_REPLACED');
}
