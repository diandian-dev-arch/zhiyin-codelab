import {
  validateTaskPack,
  type TaskPackManifest,
} from "../../../packages/contracts/src/v2/index.js";

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freezeDeep(entry);
    Object.freeze(value);
  }
  return value;
}

/** A trusted startup registry. Schema integrity does not certify checker execution. */
export async function createPackCatalog(
  packs: readonly TaskPackManifest[] = [],
) {
  const entries = new Map<string, TaskPackManifest>();
  for (const input of packs) {
    // Zod parsing clones input: later caller mutations cannot alter registered rules.
    const pack = freezeDeep(await validateTaskPack(input));
    const key = JSON.stringify([pack.packId, pack.packVersion]);
    if (entries.has(key)) {
      throw new Error(
        `DUPLICATE_PACK_VERSION: ${pack.packId}@${pack.packVersion}`,
      );
    }
    entries.set(key, pack);
  }
  const all = Object.freeze([...entries.values()]);
  return Object.freeze({
    get: (packId: string, packVersion: string) =>
      entries.get(JSON.stringify([packId, packVersion])),
    list: () => all,
  });
}
