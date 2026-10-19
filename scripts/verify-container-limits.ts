import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { restrictedContainerArgs } from "../apps/runner/src/environment-v2.js";

// Bounded trusted probes. No student code, host mounts, Docker socket, or external requests.
const exec = promisify(execFile),
  id = randomUUID();
const label = `codelab.limit-check=${id}`;
const output = path.join(
  process.cwd(),
  "docs/verification/2026-09-28",
  `limits-${id}`,
);
const docker = async (args: string[], timeout = 30000) =>
  (
    await exec("docker", args, {
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
    })
  ).stdout;
const imageInfo = JSON.parse(
  await docker(["image", "inspect", "codelab-build:v2-desktop"]),
)[0];
assert.equal(imageInfo.Os, "linux");
const results: unknown[] = [];
const resources: string[] = [];
let passed = false;
await mkdir(output, { recursive: true });
async function probe(
  name: string,
  memory: string,
  code: string,
  expectOom = false,
  probeImage = imageInfo.Id,
) {
  const containerName = `codelab-limits-${id}-${name}`;
  resources.push(containerName); // Register before create, including a lost create response.
  await docker([
    "create",
    "--name",
    containerName,
    "--label",
    label,
    "--network",
    "none",
    ...restrictedContainerArgs(memory),
    ...(name === "browser-sandbox-diagnostic" && process.argv.includes("--sandbox-profile") ? ["--security-opt", `seccomp=${path.join(process.cwd(), process.argv.includes("--userns-chroot") ? "deploy/executor/seccomp-chromium-userns.json" : "deploy/executor/seccomp-playwright-1.58.2.json")}`] : []),
    "--entrypoint",
    "node",
    probeImage,
    "-e",
    code,
  ]);
  const configured = JSON.parse(await docker(["inspect", containerName]))[0];
  assert.equal(configured.HostConfig.ReadonlyRootfs, true);
  assert.equal(configured.HostConfig.PidsLimit, 128);
  assert.equal(configured.HostConfig.NetworkMode, "none");
  assert.equal(configured.Config.User, "1000:1000");
  assert.equal(configured.Mounts.length, 0, "UNEXPECTED_HOST_OR_VOLUME_MOUNT");
  await docker(["start", containerName]);
  const exitCode = Number(
    (await docker(["wait", containerName], 45000)).trim(),
  );
  const state = JSON.parse(await docker(["inspect", containerName]))[0].State;
  const logs = await docker(["logs", containerName]);
  if (expectOom) {
    assert.equal(exitCode, 137);
    assert.equal(state.OOMKilled, true);
  } else assert.equal(exitCode, 0, `PROBE_FAILED:${name}:${logs}`);
  results.push({
    name,
    imageId: probeImage,
    exitCode,
    oomKilled: state.OOMKilled,
    observed: logs.trim() ? JSON.parse(logs.trim()) : null,
    limits: {
      memoryBytes: configured.HostConfig.Memory,
      memorySwapBytes: configured.HostConfig.MemorySwap,
      pids: configured.HostConfig.PidsLimit,
      nanoCpus: configured.HostConfig.NanoCpus,
      readonlyRootfs: configured.HostConfig.ReadonlyRootfs,
      capDrop: configured.HostConfig.CapDrop,
      securityOpt: configured.HostConfig.SecurityOpt,
      tmpfs: configured.HostConfig.Tmpfs,
    },
  });
}
try {
  await probe(
    "filesystem",
    "512m",
    `
    const fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
    const status=fs.readFileSync('/proc/self/status','utf8');
    assert.match(status,/NoNewPrivs:\\s+1/); assert.match(status,/Seccomp:\\s+2/); assert.match(status,/CapEff:\\s+0+/);
    assert.equal(process.getuid(),1000); assert.equal(fs.existsSync('/var/run/docker.sock'),false);
    assert.deepEqual(Object.keys(os.networkInterfaces()),['lo']);
    assert.throws(()=>fs.writeFileSync('/opt/forbidden','x'));
    const fd=fs.openSync('/tmp/quota-probe','w'); let bytes=0, quota=false;
    try { for(let i=0;i<34;i++) { const block=Buffer.alloc(4*1024*1024,1); let offset=0; while(offset<block.length) { const n=fs.writeSync(fd,block,offset,block.length-offset); offset+=n; bytes+=n; } } }
    catch(e){if(e.code==='ENOSPC') quota=true; else throw e;} finally {fs.closeSync(fd);fs.unlinkSync('/tmp/quota-probe');}
    assert.equal(quota,true);assert.ok(bytes<=128*1024*1024);
    console.log(JSON.stringify({uid:1000,noNewPrivileges:true,seccompFilter:true,noEffectiveCapabilities:true,noDockerSocket:true,networkInterfaces:['lo'],rootWriteDenied:true,tmpfsQuotaEnforced:true,writtenBytes:bytes}));
  `,
  );
  await probe(
    "pids",
    "512m",
    `
    const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
    (async()=>{const children=[];let blocked=false;
      try {for(let i=0;i<140;i++){const child=spawn('/bin/sleep',['20']);const ok=await new Promise((resolve,reject)=>{child.once('spawn',()=>resolve(true));child.once('error',e=>e.code==='EAGAIN'?resolve(false):reject(e));});if(!ok){blocked=true;break;}children.push(child);}assert.equal(blocked,true);console.log(JSON.stringify({processLimitEnforced:true,childrenStarted:children.length}));}
      finally {for(const child of children)child.kill('SIGKILL');}
    })().catch(()=>{process.exitCode=1;});
  `,
  );
  await probe(
    "memory",
    "128m",
    `
    const blocks=[];for(let i=0;i<128;i++)blocks.push(Buffer.alloc(2*1024*1024,1));
    console.log(JSON.stringify({unexpectedAllocationSuccess:true}));
  `,
    true,
  );
  const browserImage = JSON.parse(
    await docker(["image", "inspect", "codelab-browser:v2-desktop"]),
  )[0].Id;
  await probe(
    "browser-sandbox-diagnostic",
    "1536m",
    `
    const {chromium}=require('/opt/node_modules/playwright');
    (async()=>{let browser;try{browser=await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true,timeout:10000});const page=await browser.newPage();await page.goto('about:blank');console.log(JSON.stringify({sandboxLaunchSupported:true,scope:'trusted-blank-page-no-network'}));}
    catch(e){const message=String(e.message);console.log(JSON.stringify({sandboxLaunchSupported:false,scope:'trusted-blank-page-no-network',reason:message.includes('Operation not permitted')?'KERNEL_OR_SECCOMP_OPERATION_DENIED':message.includes('No usable sandbox')?'NO_USABLE_SANDBOX':'SANDBOX_LAUNCH_FAILED',diagnostic:message.slice(0,6000)}));}
    finally{if(browser)await browser.close();}})().catch(()=>{process.exitCode=1;});
  `,
    false,
    browserImage,
  );
  passed = true;
} catch (error) {
  results.push({
    error: error instanceof Error ? error.message : "LIMIT_CHECK_FAILED",
  });
  process.exitCode = 1;
} finally {
  const cleanup: unknown[] = [];
  for (const name of resources) {
    try {
      const info = JSON.parse(await docker(["inspect", name]))[0];
      assert.equal(info.Config.Labels?.["codelab.limit-check"], id);
      await docker(["rm", "-f", info.Id]);
      cleanup.push({ name, removed: true });
    } catch {
      passed = false;
      process.exitCode = 1;
      cleanup.push({ name, removed: false });
    }
  }
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        id,
        date: new Date().toISOString(),
        passed,
        imageId: imageInfo.Id,
        source: "trusted-bounded-container-probes",
        results,
        cleanup,
        notCovered: [
          "browser-sandbox",
          "browser-network-egress",
          "host-gateway-isolation",
          "cross-task-isolation",
          "writable-output-volume-quota",
          "CPU-timeout-through-worker",
          "production-VM",
        ],
      },
      null,
      2,
    ),
  );
}
console.log(
  `容器限制检查${passed ? "通过" : "失败"}：${path.relative(process.cwd(), output)}`,
);
