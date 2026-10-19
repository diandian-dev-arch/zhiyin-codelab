import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createDriver, measuredEnvironment } from "./check-v2.mjs";
import { runFilterOrderProbe, validateFilterProbe } from "./v2-filter-probe.mjs";
import { PROJECT_ORIGIN } from "./v2-new-case.mjs";
import { captureProbeStep } from './v2-probe-capture.mjs';

async function main() {
  if (process.argv.length !== 2) throw new Error("PROBE_ARGUMENT_INVALID");
  const filename = "/artifacts/probe-request.json";
  const info = await stat(filename);
  if (!info.isFile() || info.size > 65536) throw new Error("PROBE_INPUT_INVALID");
  const bytes = await readFile(filename);
  if (bytes.length > 65536) throw new Error("PROBE_INPUT_INVALID");
  const input = JSON.parse(bytes.toString("utf8"));
  if (Object.keys(input).some(key => !["definition","parameters","remainingWorkMs"].includes(key)) ||
      !Number.isSafeInteger(input.remainingWorkMs) || input.remainingWorkMs < 1 || input.remainingWorkMs > 20_000)
    throw new Error("PROBE_INPUT_INVALID");
  validateFilterProbe(input.definition,input.parameters);
  const require = createRequire(import.meta.url);
  const version = require("playwright/package.json").version;
  if (version !== "1.58.2") throw new Error("PROBE_PLAYWRIGHT_MISMATCH");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "chromium", headless: true, chromiumSandbox: true,
    args: ["--disable-dev-shm-usage","--disable-background-networking",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", `--unsafely-treat-insecure-origin-as-secure=${PROJECT_ORIGIN}`] });
  try {
    const measurement = await measuredEnvironment(browser,version);
    const captures = [];
    const observation = await runFilterOrderProbe(input.definition,input.parameters,()=>createDriver(browser),input.remainingWorkMs,async (driver, identity) => {
      const captured = await captureProbeStep(driver, identity);
      if (captured.png) {
        const filename = `probe-${identity.pathId}-${captures.length}.png`;
        try {
          await writeFile(`/artifacts/${filename}`,captured.png,{flag:'wx'});
          captured.record.screenshot.filename = filename;
        } catch {
          captured.record.screenshot = {status:'unavailable',reason:'SCREENSHOT_UNAVAILABLE'};
        }
      }
      captures.push(captured.record);
    });
    observation.captures = captures;
    const output = JSON.stringify({ observation, ...measurement });
    if (Buffer.byteLength(output)>65536) throw new Error("PROBE_OUTPUT_TOO_LARGE");
    await writeFile("/artifacts/probe-result.json",output,{flag:"wx"});
  } finally { await browser.close(); }
}
main().catch(error => {
  process.stderr.write(JSON.stringify({error:"PROBE_FAILED",kind:error instanceof Error ? error.name : "UnknownError"})+"\n");
  process.exitCode=1;
});
