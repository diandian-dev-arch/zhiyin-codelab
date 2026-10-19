import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  hashRuleSnapshot,
  measuredEnvironmentSchema,
  measurementFingerprintSchema,
  taskPackManifestSchema,
  validateRuleSnapshot,
  type MeasurementFingerprint,
  type RuleSnapshot,
} from "../../../packages/contracts/src/v2/index.js";
import { createPackCatalog } from "./catalog-v2.js";

const runtimeCatalogSchema = z
  .object({
    packs: z.array(taskPackManifestSchema).min(1).max(50),
    actualEnvironment: measuredEnvironmentSchema,
  })
  .strict();

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freezeDeep(entry);
    Object.freeze(value);
  }
  return value;
}

/**
 * Trusted startup input, copied from runner /v2/catalog and /v2/capabilities.
 * Parsing verifies consistency; it cannot establish the provenance of a file.
 * A single actualEnvironment approves only its measured pack content hash.
 */
export async function createRuntimeCatalogV2(input: unknown) {
  const parsed = runtimeCatalogSchema.parse(input);
  const catalog = await createPackCatalog(parsed.packs);
  const actualEnvironment = freezeDeep(parsed.actualEnvironment);
  const { values, missingFields } = actualEnvironment;
  if (
    actualEnvironment.completeness !== "partial" ||
    missingFields.length !== 2 ||
    !missingFields.includes("ruleHash") ||
    !missingFields.includes("parametersHash")
  ) {
    throw new Error(
      "RUNTIME_MEASUREMENT_INCOMPLETE: Startup measurement must omit only ruleHash and parametersHash",
    );
  }
  const measuredPack = catalog
    .list()
    .find((pack) => pack.contentHash === values.packManifestHash);
  if (!measuredPack)
    throw new Error(
      "RUNTIME_PACK_NOT_AVAILABLE: Measured pack content hash is not registered",
    );
  for (const field of [
    "templateHash",
    "dependencyLockHash",
    "initializationVersion",
    "aggregationVersion",
  ] as const) {
    if (values[field] !== measuredPack[field])
      throw new Error(`RUNTIME_PACK_MISMATCH: ${field}`);
  }

  async function approvedFingerprint(
    inputRule: RuleSnapshot,
  ): Promise<MeasurementFingerprint> {
    const rule = await validateRuleSnapshot(inputRule);
    const registered = catalog.get(
      rule.packManifest.packId,
      rule.packManifest.packVersion,
    );
    if (!registered || registered.contentHash !== rule.packManifestHash)
      throw new Error(
        "RUNTIME_RULE_PACK_UNAVAILABLE: Saved rule does not match a registered pack",
      );
    if (rule.packManifestHash !== values.packManifestHash)
      throw new Error(
        "RUNTIME_RULE_PACK_UNMEASURED: Saved rule pack has no approved runtime measurement",
      );
    return measurementFingerprintSchema.parse({
      ...values,
      ruleHash: await hashRuleSnapshot(rule),
      parametersHash: rule.parametersHash,
    });
  }

  return Object.freeze({
    packs: catalog.list(),
    actualEnvironment,
    approvedFingerprint,
  });
}

/** No network refresh and no implicit enabling of execution. */
export async function loadRuntimeCatalogV2(filePath: string) {
  return createRuntimeCatalogV2(JSON.parse(await readFile(filePath, "utf8")));
}
