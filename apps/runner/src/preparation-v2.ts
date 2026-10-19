import { mkdir, chown, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { transferOutput } from './output-transfer-v2.js';
import {
  canonicalJson,
  validateSourceFiles,
  createSourceManifest,
  validatePreparationResponse,
  type RunnerPreparationRequest,
  type RunnerPreparationResponse,
} from "@codelab/contracts/v2";
import { DurableRunnerStore, type PlannedResource } from "./durable-store.js";
import { AmbiguousDockerDispatch } from "./engine-v2.js";
import {
  dockerCommand,
  isolatedNetworkArgs,
  verifyIsolatedNetwork,
  executionFingerprint,
  restrictedContainerArgs,
  type TrustedRunnerEnvironment,
} from "./environment-v2.js";

/** Rebuild only the archived page. Never executes base cases or returns a base manifest. */
export async function prepareProbeV2(
  store: DurableRunnerStore,
  environment: TrustedRunnerEnvironment,
  volumeName: string,
  request: RunnerPreparationRequest,
  dispatchToken: string,
): Promise<RunnerPreparationResponse> {
  if (!/^codelab-[a-z0-9][a-z0-9_-]{0,80}$/.test(volumeName))
    throw new Error("RUNNER_VOLUME_INVALID");
  const { probe } = request,
    owner = probe.owner;
  const actual = executionFingerprint(
    environment,
    probe.context.ruleHash,
    request.ruleSnapshot.parametersHash,
  );
  if (
    canonicalJson(actual) !== canonicalJson(request.approvedFingerprint) ||
    environment.pack.contentHash !== probe.context.packManifestHash
  )
    throw new Error("ACTUAL_ENVIRONMENT_MISMATCH");
  const deadline = Math.min(
    Date.parse(probe.workDeadlineAt),
    store.now() + probe.remainingWorkMs,
  );
  // Leave time for the probe and candidate commit; preparation cannot consume the entire work budget.
  const budget = (maximum: number) => {
    const remaining = Math.floor(deadline - store.now() - 15_000);
    if (remaining <= 0) throw new Error("PREPARATION_TIME_BUDGET");
    return Math.min(maximum, remaining);
  };
  budget(1);
  const workspace = await store.ensureWorkspace(
    owner,
    request.operationId,
    dispatchToken,
  );
  await writeFile(
    path.join(workspace, "execution-context.json"),
    JSON.stringify({
      rule: request.ruleSnapshot,
      context: probe.context,
      analysisAttemptId: probe.analysisAttemptId,
      probeOperationId: probe.operationId,
      actualFingerprint: actual,
    }),
    { flag: "wx", mode: 0o400 },
  );
  for (const name of ["submission", "out"]) {
    await mkdir(path.join(workspace, name), { mode: 0o755 });
    await chown(path.join(workspace, name), 1000, 1000);
  }
  const { decodedFiles } = validateSourceFiles(request.files);
  const materialized: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(decodedFiles)) {
    const target = path.join(workspace, "submission", name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o444 });
    materialized[name] = (await readFile(target)).toString("base64");
  }
  const observed = (await createSourceManifest(materialized))
    .sourceManifestSha256;
  if (observed !== probe.context.sourceManifestSha256)
    throw new Error("SOURCE_MATERIALIZATION_MISMATCH");
  const mount = (name: string, target: string, readonly = false) => [
    "--mount",
    `type=volume,source=${volumeName},volume-subpath=resources/analysis-${owner.ownerId}/${name},target=${target}${readonly ? ",readonly" : ""}`,
  ];
  const create = async (
    kind: PlannedResource["kind"],
    role: PlannedResource["role"],
    args: (resource: PlannedResource) => string[],
  ) => {
    const resource = await store.planResource(
      owner,
      request.operationId,
      dispatchToken,
      kind,
      role,
    );
    const timeout = budget(10_000);
    await store.markResourceCreateStarted(
      owner,
      request.operationId,
      dispatchToken,
      role,
    );
    try {
      const id = (
        await dockerCommand(
          [
            ...(kind === "network"
              ? isolatedNetworkArgs
              : ["container", "create"]),
            ...Object.entries(resource.labels).flatMap(([key, value]) => [
              "--label",
              `${key}=${value}`,
            ]),
            ...args(resource),
          ],
          timeout,
        )
      ).stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("DOCKER_ID_INVALID");
      await store.recordResourceCreated(
        owner,
        request.operationId,
        dispatchToken,
        role,
        id,
      );
      return id;
    } catch {
      throw new AmbiguousDockerDispatch("PREPARATION_CREATE_OUTCOME_UNKNOWN");
    }
  };
  const build = await create("container", "build", (resource) => [
    "--name",
    resource.name,
    "--network",
    "none",
    ...restrictedContainerArgs("1024m"),
    "--tmpfs",
    "/workspace:rw,nosuid,nodev,size=256m,uid=1000,gid=1000",
    ...mount("submission", "/submission", true),
    '--tmpfs','/out:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000',
    '--entrypoint','node',environment.buildImage,'/opt/export-output.mjs','build',
  ]);
  if ((await transferOutput(build,path.join(workspace,'out'),'build',budget(30_000))).code !== 0)
    throw new Error("PREPARATION_BUILD_FAILED");
  const network = await create("network", "network", (resource) => [
    resource.name,
  ]);
  await verifyIsolatedNetwork(network, budget(5000));
  const web = await create("container", "web", (resource) => [
    "--name",
    resource.name,
    "--network",
    network,
    "--network-alias",
    "project",
    ...restrictedContainerArgs("128m"),
    ...mount("out", "/site", true),
    environment.webImage,
  ]);
  await dockerCommand(["start", web], budget(5000));
  await dockerCommand(
    [
      "exec",
      web,
      "node",
      "-e",
      "const end=Date.now()+5000;async function check(){while(Date.now()<end){try{let r=await fetch('http://127.0.0.1:8080');if(r.status===200)return;}catch{}await new Promise(r=>setTimeout(r,100));}process.exit(1)}check()",
    ],
    budget(7000),
  );
  return validatePreparationResponse(
    {
      protocolVersion: 2,
      context: probe.context,
      analysisAttemptId: probe.analysisAttemptId,
      operationId: request.operationId,
      requestHash: request.requestHash,
      observedSourceManifestSha256: observed,
      actualFingerprint: actual,
      state: "ready",
    },
    request,
  );
}
