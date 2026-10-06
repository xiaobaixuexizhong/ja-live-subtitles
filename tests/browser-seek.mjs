import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error("Set PLAYWRIGHT_PACKAGE_PATH to playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const root = path.resolve(import.meta.dirname, "..");
const profile = await mkdtemp(path.join(os.tmpdir(), "ja-seek-test-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM_EXE,
  headless: false,
  args: [
    `--disable-extensions-except=${path.join(root, "seek-extension")}`,
    `--load-extension=${path.join(root, "seek-extension")}`,
    "--mute-audio"
  ]
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 20000 });
  const id = new URL(worker.url()).host;
  const samplePath = path.join(root, "tests", "seek-sample.webm");
  if (!existsSync(samplePath)) {
    const generator = await context.newPage();
    await generator.goto("http://127.0.0.1:8767/");
    const bytes = await generator.evaluate(async () => {
      const response = await fetch("sample-ja.wav");
      const audio = new AudioContext();
      const buffer = await audio.decodeAudioData(await response.arrayBuffer());
      const source = audio.createBufferSource();
      source.buffer = buffer;
      const destination = audio.createMediaStreamDestination();
      source.connect(destination);
      const canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 540;
      const draw = () => {
        const graphics = canvas.getContext("2d");
        graphics.fillStyle = "#26343b";
        graphics.fillRect(0, 0, canvas.width, canvas.height);
        graphics.fillStyle = "#a9cfb9";
        graphics.fillRect(80, 440, 800, 4);
      };
      draw();
      const drawTimer = setInterval(draw, 500);
      const stream = new MediaStream([
        ...canvas.captureStream(2).getVideoTracks(),
        ...destination.stream.getAudioTracks()
      ]);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      await audio.resume();
      recorder.start();
      source.start();
      await new Promise(resolve => setTimeout(resolve, 14500));
      recorder.stop();
      await stopped;
      clearInterval(drawTimer);
      stream.getTracks().forEach(track => track.stop());
      await audio.close();
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    });
    await writeFile(samplePath, Buffer.from(bytes));
    await generator.close();
  }
  const mediaPage = await context.newPage();
  await mediaPage.goto("http://127.0.0.1:8767/tests/seek-fixture.html");
  await mediaPage.locator("video").evaluate(video => video.play());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/src/sidepanel/sidepanel.html`);
  await panel.locator("#asrProfileId").waitFor({ state: "attached" });
  await panel.waitForTimeout(1500);
  const defaults = await panel.evaluate(() => ({
    asr: document.querySelector("#asrProfileId").value,
    llm: document.querySelector("#llmProfileId").value,
    source: document.querySelector("#sourceLanguage").value,
    target: document.querySelector("#targetLanguage").value
  }));
  console.log("defaults", defaults);
  assert.deepEqual(defaults, { asr: "custom_asr", llm: "openai_custom", source: "ja", target: "zh-CN" });
  assert.equal(await panel.locator("#sourceLanguage option").count(), 1);
  assert.equal(await panel.locator("#targetLanguage option").count(), 1);
  const tabId = await worker.evaluate(async url => {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0]?.id;
  }, mediaPage.url());
  assert.ok(tabId);
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
  await panel.locator("#refreshCandidates").click();
  await panel.waitForTimeout(1500);
  console.log("candidates", (await panel.locator("#candidateList").innerText()).slice(0, 1000));
  console.log("start enabled", await panel.locator("#startPreload").isEnabled());
  await panel.locator("#startPreload").click();
  let completed = false;
  for (let i = 0; i < 12; i += 1) {
    await panel.waitForTimeout(5000);
    const status = (await panel.locator("#jobStatus").innerText()).slice(0, 500);
    const subtitles = (await panel.locator("#taskPanel").innerText()).slice(-800);
    console.log("progress", i, status, subtitles);
    if (/已完成|完成任务|任务完成/.test(status)) {
      completed = true;
      break;
    }
  }
  const taskText = await panel.locator("#taskPanel").innerText();
  assert.ok(completed);
  assert.match(taskText, /火车/);
  assert.match(taskText, /拉面/);
  const actualCaption = await mediaPage.locator("#fuguang-caption-overlay-v2 [data-fuguang-caption-text]").textContent();
  console.log("generated overlay", actualCaption);
  assert.match(actualCaption, /火车|拉面/);

  const seekableVideoFile = process.env.SEEKABLE_MP4;
  if (!seekableVideoFile) throw new Error("Set SEEKABLE_MP4 to a local seekable MP4");
  const seekableVideoUrl = "http://127.0.0.1:8767/tests/seekable.mp4";
  await mediaPage.route(seekableVideoUrl, route => route.fulfill({ path: seekableVideoFile, contentType: "video/mp4" }));
  await mediaPage.locator("video").evaluate(async (video, url) => {
    video.pause();
    const file = await fetch(url).then(response => response.blob());
    await new Promise(resolve => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.src = URL.createObjectURL(file);
      video.load();
    });
  }, seekableVideoUrl);
  const attach = await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, {
    type: "FUGUANG_ATTACH_VTT",
    vtt: "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n第一句\n\n00:00:10.000 --> 00:00:13.000\n第二句\n",
    origin: "user-override"
  }), tabId);
  console.log("attach", attach);
  assert.ok(attach.ok);
  for (const [second, expected] of [[2, "第一句"], [11, "第二句"], [2, "第一句"]]) {
    const seekResult = await mediaPage.locator("video").evaluate(async (video, time) => {
      video.pause();
      let afterAssign;
      await new Promise(resolve => {
        video.addEventListener("seeked", resolve, { once: true });
        video.currentTime = time;
        afterAssign = video.currentTime;
      });
      return { requested: time, afterAssign, afterSeek: video.currentTime, seekable: video.seekable.length, seekableEnd: video.seekable.length ? video.seekable.end(0) : null };
    }, second);
    await mediaPage.waitForTimeout(200);
    const state = await mediaPage.evaluate(() => ({
      time: document.querySelector("video").currentTime,
      duration: document.querySelector("video").duration,
      readyState: document.querySelector("video").readyState,
      overlay: document.querySelector("#fuguang-caption-overlay-v2")?.outerHTML
    }));
    const text = await mediaPage.locator("#fuguang-caption-overlay-v2 [data-fuguang-caption-text]").textContent();
    console.log("seek", second, seekResult, text, state);
    assert.ok(text.includes(expected), `Expected ${expected} at ${second}s, got ${text}`);
  }
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
