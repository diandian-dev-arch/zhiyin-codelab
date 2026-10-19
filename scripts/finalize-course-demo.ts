// Build and verify a local player for successful, chronological course clips.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { root } from "../apps/api/src/template.js";

const id = process.argv[2];
if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw Error("INVALID_DEMO_ID");
const directory = path.join(root, "output/course-demo", id);
const state = JSON.parse(
  await readFile(path.join(directory, "result.json"), "utf8"),
);
if (state.state !== "passed") throw Error("RECORDING_NOT_COMPLETE");
const names = [
  "01-teacher-task",
  "02-student-submit",
  "03-teacher-review-publish",
  "04-student-report",
];
const titles = [
  "教师创建任务与规则",
  "学生上传与发起检查",
  "实际执行、复核与发布",
  "学生读取反馈与证据",
];
const clips = names.map((name, i) => {
  const segment = state.segments.findLast(
    (s: any) => s.name === name && s.state === "passed",
  );
  if (!segment || !/^[a-z0-9-]+\.webm$/.test(segment.filename))
    throw Error("MISSING_CLIP");
  return { ...segment, title: titles[i] };
});
// An earlier review recording contains the actual execution wait. Keep it as
// an explicitly interrupted recording, then continue with the successful review.
const waiting = state.segments.find(
  (s: any) =>
    s.name === names[2] &&
    s.state === "failed" &&
    s.chapters.some((c: any) => c.caption.startsWith("真实等待")),
);
if (waiting)
  clips.splice(2, 0, {
    ...waiting,
    title: "真实执行与 Agent 等待（录制中断）",
  });
for (const clip of clips) {
  const bytes = await readFile(path.join(directory, clip.filename));
  if (
    bytes.length !== clip.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== clip.sha256
  )
    throw Error("VIDEO_HASH_MISMATCH");
}
const data = JSON.stringify(clips).replace(/</g, "\\u003c");
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>知因 CodeLab · 课程完整流程回放</title>
<style>
:root{color-scheme:dark;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#14212a;color:#eeeae1}
*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:32px}
header{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:24px}
h1{font-size:clamp(24px,3vw,36px);margin:6px 0 12px;letter-spacing:-.04em}p{line-height:1.7;margin:0;color:#c2c8c8}
.eyebrow{color:#8fd0be;font-size:12px;letter-spacing:.16em}.badge{white-space:nowrap;border:1px solid #50615f;border-radius:40px;padding:9px 14px;font-size:13px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:24px}video{display:block;width:100%;background:#000;border-radius:10px;max-height:75vh}
video::cue{font-size:20px;background:#14212ae8;color:white}.caption{min-height:75px;padding:16px 0;font-size:15px;color:#eeeae1}
nav{display:flex;flex-direction:column;gap:10px}button{font:inherit;text-align:left;border:1px solid #41515a;background:#20303b;color:inherit;padding:15px;border-radius:8px;cursor:pointer;line-height:1.5}
button:hover{border-color:#8fd0be}button:focus-visible{outline:3px solid #e6bd7d;outline-offset:3px}button[aria-current=true]{background:#36594f;border-color:#8fd0be}
button small{display:block;color:#b7c6c5;margin-top:5px}.chapters{display:grid;gap:8px;margin-top:12px;max-height:300px;overflow:auto}.chapters button{font-size:12px;padding:10px}
.note{margin-top:24px;padding:20px;border-top:1px solid #41515a;font-size:13px}a{color:#a9dece}h2{font-size:17px;margin:24px 0 8px}
@media(max-width:900px){main{padding:18px}.layout{grid-template-columns:1fr}header{align-items:start;flex-direction:column}.caption{min-height:0}nav{display:grid;grid-template-columns:1fr 1fr}}
</style><main><header><div><p class="eyebrow">CODELAB / RECORDED WORKFLOW</p><h1>从一次提交，到可追溯的反馈。</h1><p>${clips.length} 段真实操作录像 · 教师与学生隔离会话 · 保留实际等待时间</p></div><span class="badge">团队构造样本 / 非独立教师评测</span></header>
<div class="layout"><section><video controls playsinline preload="auto" aria-label="课程流程录像"></video><p class="caption" aria-live="polite"></p><p class="recording-note"></p></section>
<aside><nav aria-label="录像片段"></nav><h2>片段中的步骤</h2><div class="chapters" aria-label="片段章节"></div></aside></div>
<p class="note">样本：filter-defect.zip。检查、模型调用与发布均来自本次实际流程；开发账号操作不代表真实教师质量评价。课程执行使用受控任务包，普通项目 ZIP 的静态源码分析为另一个入口。无配音。实际等待录像因脚本定位条目失败而中断，后续从同一报告续录，没有重复执行或模型调用；失败素材不删除。<br><a href="result.json">查看本次录制与运行记录</a> · <a href="playback-verification.json">查看播放核验</a></p></main>
<script>
const clips=${data};const video=document.querySelector('video');const caption=document.querySelector('.caption');
const nav=document.querySelector('nav');const chapters=document.querySelector('.chapters');
const track=video.addTextTrack('captions','中文字幕','zh');track.mode='showing';let current=0;
function select(index){current=index;const clip=clips[index];video.pause();video.src=clip.filename;
document.querySelector('.recording-note').textContent=clip.state==='failed'?'本段保留真实检查和模型等待。检查已完成，录像脚本随后因条目定位错误中止；下一片接续同一报告的复核发布。':'';
for(const cue of Array.from(track.cues||[]))track.removeCue(cue);
for(const c of clip.chapters)track.addCue(new VTTCue(c.start,c.end,c.caption));
Array.from(nav.children).forEach((button,i)=>button.setAttribute('aria-current',String(i===index)));
chapters.replaceChildren();clip.chapters.forEach((c,i)=>{const button=document.createElement('button');button.textContent=String(i+1).padStart(2,'0')+' · '+c.caption;button.onclick=()=>{video.currentTime=c.start+.1;video.play().catch(()=>{});};chapters.append(button);});
caption.textContent=clip.title;video.load();}
clips.forEach((clip,i)=>{const button=document.createElement('button');const label=document.createElement('span');label.textContent=String(i+1).padStart(2,'0')+' / '+clip.title;const small=document.createElement('small');small.textContent=clip.role==='teacher'?'教师视角':'学生视角';button.append(label,small);button.onclick=()=>select(i);nav.append(button);});
video.addEventListener('timeupdate',()=>{const c=clips[current].chapters.find(c=>video.currentTime>=c.start&&video.currentTime<c.end);caption.textContent=c?c.caption:clips[current].title;});select(0);
</script></html>`;
await writeFile(path.join(directory, "index.html"), html);

const allowed = new Set(["index.html", ...clips.map((c) => c.filename)]);
const server = createServer(async (req, res) => {
  try {
    const name =
      decodeURIComponent(
        new URL(req.url ?? "/", "http://localhost").pathname.slice(1),
      ) || "index.html";
    if (!allowed.has(name)) {
      res.writeHead(404).end();
      return;
    }
    const body = await readFile(path.join(directory, name));
    const type = name.endsWith(".webm")
      ? "video/webm"
      : "text/html; charset=utf-8";
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]),
        end = Math.min(
          range[2] ? Number(range[2]) : body.length - 1,
          body.length - 1,
        );
      if (start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${body.length}` }).end();
        return;
      }
      res
        .writeHead(206, {
          "Content-Type": type,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${body.length}`,
        })
        .end(body.subarray(start, end + 1));
    } else
      res
        .writeHead(200, {
          "Content-Type": type,
          "Content-Length": body.length,
          "Accept-Ranges": "bytes",
        })
        .end(body);
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw Error("SERVER_ADDRESS");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const checks: any[] = [];
try {
  await page.goto(`http://127.0.0.1:${address.port}`);
  for (let i = 0; i < clips.length; i++) {
    await page
      .getByRole("navigation", { name: "录像片段" })
      .getByRole("button")
      .nth(i)
      .click();
    await page.waitForFunction(() => {
      const v = document.querySelector("video")!;
      return v.readyState >= 2 && v.videoWidth > 0;
    });
    const metadata = await page
      .locator("video")
      .evaluate((v: HTMLVideoElement) => ({
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight,
        cues: v.textTracks[0].cues?.length,
      }));
    expect(metadata.width).toBe(1440);
    expect(metadata.height).toBe(1000);
    expect(metadata.cues).toBe(clips[i].chapters.length);
    if (!Number.isFinite(metadata.duration) || metadata.duration <= 0)
      throw Error("INVALID_DURATION");
    for (const [label, fraction] of [
      ["start", 0.12],
      ["middle", 0.5],
      ["end", 0.9],
    ] as const) {
      const time = metadata.duration * fraction;
      await page.locator("video").evaluate(async (v: HTMLVideoElement, t) => {
        v.muted = true;
        await v.play();
        v.currentTime = t;
      }, time);
      await page.waitForFunction((t) => {
        const v = document.querySelector("video")!;
        return !v.seeking && v.readyState >= 3 && v.currentTime >= t + 0.1;
      }, time);
      await page.locator("video").evaluate(async (v: HTMLVideoElement) => {
        await new Promise((resolve) => v.requestVideoFrameCallback(resolve));
        v.pause();
      });
      await page
        .locator("video")
        .screenshot({
          path: path.join(directory, `playback-${i + 1}-${label}.png`),
        });
    }
    await page.locator(".chapters button").first().click();
    await page.waitForFunction(() => !document.querySelector("video")!.paused);
    await expect(page.locator(".caption")).toContainText(
      clips[i].chapters[0].caption,
    );
    const playback = await page
      .locator("video")
      .evaluate((v: HTMLVideoElement) => {
        v.pause();
        return {
          error: v.error?.code ?? null,
          frames: v.getVideoPlaybackQuality().totalVideoFrames,
        };
      });
    expect(playback.error).toBeNull();
    expect(playback.frames).toBeGreaterThan(2);
    checks.push({
      filename: clips[i].filename,
      sha256: clips[i].sha256,
      metadata,
      playback,
      seekChecks: 3,
      chapterAndCaption: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: path.join(directory, "player-mobile.png") });
  expect(errors).toEqual([]);
  const result = {
    state: "passed",
    checkedAt: new Date().toISOString(),
    browser: "Chrome",
    checks,
    errors,
    mobileWidth: 390,
    scope:
      "Actual decoding and presented frames; no model or course calls during playback verification",
  };
  await writeFile(
    path.join(directory, "playback-verification.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
