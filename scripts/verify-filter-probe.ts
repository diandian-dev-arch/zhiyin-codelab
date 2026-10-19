// Team-owned constructed samples only. This does not certify the Docker sandbox or model quality.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { root, templateFiles } from "../apps/api/src/template.js";
import { createDevelopmentPack, sha256 } from "../packages/contracts/src/v2/index.js";
const checkerModule = "../deploy/executor/check-v2.mjs", probeModule = "../deploy/executor/v2-filter-probe.mjs";
const { createDriver } = await import(checkerModule);
const { runFilterOrderProbe } = await import(probeModule);
const captureModule = '../deploy/executor/v2-probe-capture.mjs';
const { captureProbeStep } = await import(captureModule);
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
const { build } = await import(pathToFileURL(webRequire.resolve("vite")).href);
const { default: vue } = await import(pathToFileURL(webRequire.resolve("@vitejs/plugin-vue")).href);
const output = path.join(root, "output/probe-verification", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const implementationHash = await sha256(await readFile(path.join(root,"deploy/executor/v2-filter-probe.mjs")));
const pack = await createDevelopmentPack("new-filter", { packVersion: "local-probe-development-v1", templateVersion: "vue-board-v1", templateHash: implementationHash,
  dependencyLockHash: implementationHash, initializationVersion: "clean-ui-v1", caseImplementationHashes: { "NEW-01": implementationHash, "FILTER-03": implementationHash },
  probeImplementationHashes: { FILTER_ORDER_CHECK: implementationHash } });
const template = await templateFiles();
const original = template["src/App.vue"].toString("utf8");
const expression = "filter.value==='all'||(filter.value==='done'?t.done:!t.done)";
if (!original.includes(expression)) throw new Error("FIXTURE_ANCHOR_CHANGED");
const cases = [
  { name: "correct", source: original, expected: "same_observed_set" },
  { name: "order-dependent-filter", source: original.replace("const visible=", "const visitedActive=ref(false);watch(filter,value=>{if(value==='active')visitedActive.value=true;});\nconst visible=")
      .replace(expression, "filter.value==='all'||(filter.value==='done'&&!visitedActive.value)|| (filter.value==='done'?t.done:!t.done)"), expected: "different_observed_set" },
  { name: "setup-blocked", source: original.replace('type="checkbox" v-model="t.done"', 'type="checkbox" disabled v-model="t.done"'), expected: "inconclusive" },
];
const results = [];
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: ["--no-proxy-server", "--host-resolver-rules=MAP project 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://project:8080"] });
try {
  for (const sample of cases) {
    const workspace = path.join(output, sample.name);
    await mkdir(workspace, { recursive: true });
    for (const [name, bytes] of Object.entries(template)) {
      if (!name.startsWith("src/") && !["index.html"].includes(name)) continue;
      const target = path.join(workspace, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, name === "src/App.vue" ? sample.source : bytes);
    }
    await build({ configFile: false, root: workspace, plugins: [vue()], logLevel: "error",
      resolve: { alias: { vue: webRequire.resolve("vue/dist/vue.esm-bundler.js") } },
      build: { outDir: "dist", emptyOutDir: false } });
    const files = new Map<string,Buffer>();
    async function collect(directory: string, prefix = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await collect(path.join(directory,entry.name),name);
        else files.set(name,await readFile(path.join(directory,entry.name)));
      }
    }
    await collect(path.join(workspace,"dist"));
    const server = createServer((request,response) => {
      const name = new URL(request.url ?? "/", "http://project:8080").pathname;
      const body = files.get(name === "/" ? "/index.html" : name);
      response.statusCode = body ? 200 : 404;
      response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
      response.end(body ?? "not found");
    });
    try {
      await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(8080,"127.0.0.1",resolve); });
      let pathIndex = 0;
      const captures: any[] = [];
      // route.fetch uses Playwright's Node transport, not Chromium's hostname map.
      // Only this local harness maps the fixed trusted origin to its loopback server.
      const localBrowser = { async newContext(options:any) {
        const context = await browser.newContext(options);
        const register = context.route.bind(context);
        context.route = ((url:any, handler:any) => register(url, route => handler(new Proxy(route, {
          get(target,key) {
            if(key==='fetch') return (options:any)=>target.fetch({...options,url:target.request().url().replace(/^http:\/\/project:8080\//,'http://127.0.0.1:8080/')});
            const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
          },
        })))) as typeof context.route;
        return context;
      } };
      const observation = await runFilterOrderProbe(pack.probes[0], {}, () => {
        const driver = createDriver(localBrowser), index = pathIndex++;
        const close = driver.close;
        driver.close = async () => {
          try { const screenshot = await driver.screenshot(); if (screenshot) await writeFile(path.join(workspace, `path-${index === 0 ? "A" : "B"}.png`),screenshot); }
          finally { await close(); }
        };
        return driver;
      },undefined,async (driver:any, identity:any)=>{
        const capture=await captureProbeStep(driver,identity);
        if(capture.png) {
          const filename=`step-${identity.pathId}-${captures.length}.png`;
          await writeFile(path.join(workspace,filename),capture.png);
          if(await sha256(await readFile(path.join(workspace,filename)))!==capture.record.screenshot.sha256)
            throw new Error('CAPTURE_FILE_HASH_MISMATCH');
          capture.record.screenshot.filename=filename;
        }
        captures.push(capture.record);
      });
      const expectedCaptures=sample.name==='setup-blocked'?4:10;
      await writeFile(path.join(workspace,'capture-check.json'),JSON.stringify({expectedCaptures,captures,observation},null,2));
      if(captures.length!==expectedCaptures || captures.some(c=>c.state.status!=='captured'||c.screenshot.status!=='captured'))
        throw new Error('CAPTURE_COMPLETENESS_FAILED');
      const entry = { sample: sample.name, source: "constructed_execution", runtime: "local Chrome, trusted Vite build; not Docker integration",
        sourceSha256: await sha256(sample.source), implementationHash, expected: sample.expected, actual: observation.comparison,
        passed: observation.comparison === sample.expected, observation, captures };
      results.push(entry);
      await writeFile(path.join(workspace,"result.json"),JSON.stringify(entry,null,2));
      console.log(`${sample.name}: ${entry.actual} (${entry.passed ? "passed" : "FAILED"})`);
      if (!entry.passed) throw new Error("PROBE_EXPECTATION_MISMATCH");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
} finally {
  await browser.close();
  await writeFile(path.join(output,"results.json"),JSON.stringify({ completed: results.length === cases.length && results.every(r=>r.passed), results },null,2));
  console.log(output);
}
