import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import type { OwnerKey, PlannedResource } from "./durable-store.js";
import type { ObservedResource, ResourceAdapter } from "./resource-reaper.js";
const exec = promisify(execFile);
const dockerId = /^[0-9a-f]{64}$/;

/** The production reaper always addresses the dedicated local Linux daemon. */
export class DockerResourceAdapter implements ResourceAdapter {
  private readonly deadline: number;
  constructor(budgetMs = 25000) {
    this.deadline = performance.now() + budgetMs;
  }
  private async run(args: string[]): Promise<string> {
    const remaining = Math.floor(this.deadline - performance.now());
    if (remaining <= 0) throw new Error("REAPER_BUDGET_EXHAUSTED");
    return (
      await exec("docker", ["--host=unix:///var/run/docker.sock", ...args], {
        encoding: "utf8",
        timeout: Math.max(1, Math.min(5000, remaining)),
        maxBuffer: 512 * 1024,
        windowsHide: true,
      })
    ).stdout;
  }
  async inspect(
    kind: PlannedResource["kind"],
    nameOrId: string,
  ): Promise<ObservedResource | null> {
    if (
      !dockerId.test(nameOrId) &&
      !/^codelab-v2-(execution|analysis)-[a-f0-9-]{36}-(build|web|check|probe|network)$/.test(
        nameOrId,
      )
    )
      throw new Error("UNSAFE_DOCKER_TARGET");
    let output: string;
    try {
      output = await this.run(
        kind === "network"
          ? ["network", "inspect", nameOrId]
          : ["container", "inspect", nameOrId],
      );
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      if (
        typeof stderr === "string" &&
        /(?:Error response from daemon:|Error:) (?:No such (?:object|container|network):|network .* not found)/i.test(
          stderr,
        )
      )
        return null;
      throw error;
    }
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length !== 1)
      throw new Error("DOCKER_INSPECTION_INVALID");
    const value = parsed[0],
      id = value.Id ?? value.ID;
    const name =
      typeof value.Name === "string" ? value.Name.replace(/^\//, "") : "";
    const labels =
      (kind === "network" ? value.Labels : value.Config?.Labels) ?? {};
    if (
      typeof id !== "string" ||
      !dockerId.test(id) ||
      !name ||
      typeof labels !== "object" ||
      Array.isArray(labels) ||
      Object.values(labels).some((label) => typeof label !== "string")
    )
      throw new Error("DOCKER_INSPECTION_INVALID");
    return { kind, id, name, labels };
  }
  async listOwned(
    storeId: string,
    owner: OwnerKey,
  ): Promise<ObservedResource[]> {
    return this.list([
      `codelab.store=${storeId}`,
      `codelab.owner=${owner.ownerId}`,
      `codelab.owner-kind=${owner.ownerKind}`,
      `codelab.run=${owner.runId}`,
      "codelab.protocol=2",
      "codelab.managed=true",
    ]);
  }
  async listManaged(): Promise<ObservedResource[]> {
    return this.list(["codelab.managed=true"]);
  }
  private async list(labels: string[]): Promise<ObservedResource[]> {
    const filters = labels.flatMap((label) => ["--filter", `label=${label}`]);
    const results: ObservedResource[] = [];
    for (const kind of ["container", "network"] as const) {
      const output = await this.run(
        kind === "container"
          ? ["ps", "--all", "--quiet", "--no-trunc", ...filters]
          : ["network", "ls", "--quiet", "--no-trunc", ...filters],
      );
      const ids = output.trim().split(/\s+/).filter(Boolean);
      if (ids.length > 50 || ids.some((id) => !dockerId.test(id)))
        throw new Error("DOCKER_RESOURCE_LIST_INVALID");
      for (const id of ids) {
        const resource = await this.inspect(kind, id);
        if (resource) results.push(resource);
      }
    }
    return results;
  }
  async remove(kind: PlannedResource["kind"], id: string): Promise<void> {
    if (!dockerId.test(id)) throw new Error("UNSAFE_DOCKER_TARGET");
    await this.run(
      kind === "container"
        ? ["container", "rm", "--force", id]
        : ["network", "rm", id],
    );
  }
}
