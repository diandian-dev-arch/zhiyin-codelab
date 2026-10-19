import { postgres } from "./db.js";
import { createApp } from "./app.js";
import { readApiConfig } from "./config.js";
import { ArtifactStore } from "./artifacts-v2.js";
import path from "node:path";
import { root } from "./template.js";
import { loadRuntimeCatalogV2 } from "./runtime-catalog-v2.js";
import { createStorageAdmission } from '../../runner/src/storage-admission.js';
import { readInitialAnalysisModeV2 } from './analysis-mode-v2.js';
import { createUserModelService, loadModelVaultKey } from './user-model-settings.js';
const config = readApiConfig();
const runtimeFile = process.env.CODELAB_V2_RUNTIME_FILE;
const runtime = runtimeFile
  ? await loadRuntimeCatalogV2(runtimeFile)
  : undefined;
const db = postgres(config.DATABASE_URL);
const artifacts = new ArtifactStore({
  root: path.join(
    process.env.DATA_DIR ?? path.join(root, ".data"),
    "evidence-v2",
  ),
});
const app = await createApp(db, {
  initialAnalysisMode: readInitialAnalysisModeV2(),
  storageAdmission: createStorageAdmission(artifacts.root),
  origin: config.APP_ORIGIN,
  secure: config.COOKIE_SECURE,
  executionApproved: config.EXECUTION_APPROVED,
  businessVersion: config.BUSINESS_API_VERSION,
  model: config.MODEL_NAME,
  userModels: createUserModelService(db, await loadModelVaultKey(db, process.env.DATA_DIR)),
  image: config.EXECUTION_IMAGE,
  evidenceReader: (evidence) => artifacts.readEvidence(evidence),
  packs: runtime?.packs,
  approvedFingerprint: runtime?.approvedFingerprint,
});
await app.listen({
  port: config.API_PORT,
  host: config.API_HOST,
});
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
