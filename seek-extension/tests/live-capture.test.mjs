import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/sidepanel/live-capture.js", import.meta.url), "utf8");
const context = {
  ArrayBuffer,
  performance: { now: () => 1000 },
  window: { clearInterval() {} }
};
vm.runInNewContext(`${source}\nglobalThis.captureApi = FuguangLiveCapture;`, context);
const api = context.captureApi;

test("PCM capture produces a valid 16 kHz mono WAV", () => {
  const first = new Uint8Array([0, 0, 255, 127]);
  const second = new Uint8Array([0, 128]);
  const bytes = Uint8Array.from(api.wavFromPcm([first, second], 3));
  const view = new DataView(bytes.buffer);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), "WAVE");
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual([...bytes.slice(44)], [0, 0, 255, 127, 0, 128]);
});

test("a video seek discards an unfinished capture window", async () => {
  const events = [];
  const capture = api.create({
    getVideoState: async () => ({ currentTime: 90, paused: false, playbackRate: 1 }),
    onEvent: (...event) => events.push(event),
    onStop() {}
  });
  capture.active = true;
  capture.tabId = 1;
  capture.lastState = { currentTime: 10, observedAt: 0, paused: false, playbackRate: 1 };
  capture.parts = [new Uint8Array([1, 2])];
  capture.sampleCount = 1;
  await capture.pollVideoState();
  assert.equal(capture.sampleCount, 0);
  assert.equal(capture.overlapSampleCount, 0);
  assert.equal(capture.generation, 1);
  assert.equal(events[0][0], "capture_seek_reset");
});

test("a video seek drops queued old-position chunks", async () => {
  const events = [];
  const capture = api.create({
    getVideoState: async () => ({ currentTime: 90, paused: false, playbackRate: 1 }),
    onEvent: (...event) => events.push(event),
    onStop() {}
  });
  capture.active = true;
  capture.tabId = 1;
  capture.lastState = { currentTime: 10, observedAt: 0, paused: false, playbackRate: 1 };
  capture.pending = [{ chunkIndex: 1 }, { chunkIndex: 2 }];
  await capture.pollVideoState();
  assert.equal(capture.pending.length, 0);
  assert.equal(capture.fastFlushPending, true);
  assert.equal(events.some(event => event[0] === "capture_queue_reset"), true);
});

test("a seek invalidates an in-flight result before it reaches subtitles", async () => {
  let resolveChunk;
  const results = [];
  const capture = api.create({
    processChunk: () => new Promise(resolve => { resolveChunk = resolve; }),
    onResult: result => results.push(result),
    onEvent() {}
  });
  capture.pending.push({ chunkIndex: 0, generation: 0, videoStart: 0 });
  const processing = capture.processQueue();
  await new Promise(resolve => setImmediate(resolve));
  capture.generation = 1;
  resolveChunk({ ok: true, translated: [{}] });
  await processing;
  assert.equal(results.length, 0);
});

test("the first live window uses the fast target", async () => {
  const capture = api.create({ getVideoState: async () => ({ currentTime: 20, playbackRate: 1 }), onEvent() {} });
  capture.active = true;
  capture.processing = true;
  const speech = new Int16Array(2048);
  speech.fill(1000);
  for (let index = 0; index < 28; index += 1) capture.receivePcm(speech.buffer.slice(0));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capture.pending.length, 1);
  assert.ok(capture.pending[0].audioDuration >= 3);
  assert.equal(capture.fastFlushPending, false);
});

test("successive capture windows share a short PCM tail and preserve video time", async () => {
  let currentTime = 102;
  const capture = api.create({
    getVideoState: async () => ({ currentTime, playbackRate: 1 }),
    onEvent() {}
  });
  capture.processing = true;
  const first = new Int16Array(32000);
  first.forEach((_, index) => { first[index] = index < 22400 ? 1000 : 2000; });
  capture.parts = [new Uint8Array(first.buffer)];
  capture.sampleCount = first.length;
  await capture.flushChunk();
  assert.equal(capture.pending[0].overlapSeconds, 0);
  assert.equal(capture.pending[0].videoStart, 100);
  assert.equal(capture.overlapSampleCount, 9600);

  const fresh = new Int16Array(16000);
  fresh.fill(3000);
  capture.parts.push(new Uint8Array(fresh.buffer));
  capture.sampleCount += fresh.length;
  currentTime = 103;
  await capture.flushChunk();
  const second = capture.pending[1];
  assert.equal(second.overlapSeconds, 0.6);
  assert.ok(Math.abs(second.videoStart - 101.4) < 0.001);
  const pcm = new DataView(Uint8Array.from(second.audioBytes).buffer, 44);
  assert.equal(pcm.getInt16(0, true), 2000);
  assert.equal(pcm.getInt16(9600 * 2, true), 3000);
});

test("periodic speech-like audio is not mistaken for silence", async () => {
  const capture = api.create({
    getVideoState: async () => ({ currentTime: 10, playbackRate: 1 }),
    onEvent() {}
  });
  const pcm = new Int16Array(16000);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = Math.round(1000 * Math.sin(2 * Math.PI * index / 64));
  }
  capture.parts = [new Uint8Array(pcm.buffer)];
  capture.sampleCount = pcm.length;
  capture.processing = true;
  capture.tabId = 1;
  await capture.flushChunk();
  assert.equal(capture.pending.length, 1);
});

test("a natural pause flushes a complete live capture window", async () => {
  const events = [];
  const capture = api.create({
    getVideoState: async () => ({ currentTime: 3, playbackRate: 1, paused: false }),
    processChunk: async () => ({ ok: false, error: "held by test" }),
    onEvent: (...event) => events.push(event)
  });
  capture.active = true;
  capture.tabId = 1;
  capture.lastState = { currentTime: 0, observedAt: 1000, paused: false, playbackRate: 1 };
  capture.processing = true;
  const speech = new Int16Array(2048);
  speech.fill(1000);
  const quiet = new Int16Array(2048);
  for (let index = 0; index < 16; index += 1) {
    capture.receivePcm(speech.buffer.slice(0));
  }
  for (let index = 0; index < 4; index += 1) {
    capture.receivePcm(quiet.buffer.slice(0));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capture.pending.length, 1);
  assert.ok(capture.pending[0].audioDuration >= 2.5);
  assert.equal(events.some(event => event[0] === "capture_chunk_skipped"), false);
});

test("capture waits for the subtitle result handler", async () => {
  let finishResult;
  const capture = api.create({
    processChunk: async () => ({ ok: true, source: [{}] }),
    onResult: () => new Promise(resolve => { finishResult = resolve; }),
    onEvent() {}
  });
  capture.pending.push({ chunkIndex: 0, generation: 0, videoStart: 0 });
  const processing = capture.processQueue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capture.processing, true);
  finishResult();
  await processing;
  assert.equal(capture.processing, false);
});

test("slow translation does not block recognition of the next window", async () => {
  let finishFirstTranslation;
  const recognized = [];
  const published = [];
  const capture = api.create({
    processChunk: async chunk => {
      recognized.push(chunk.chunkIndex);
      return { ok: true, source: [{ chunkIndex: chunk.chunkIndex, segmentIndex: 0 }] };
    },
    onResult: async () => {},
    translateChunk: chunk => chunk.chunkIndex === 0
      ? new Promise(resolve => { finishFirstTranslation = resolve; })
      : Promise.resolve({ ok: true, translated: [{ chunkIndex: 1, segmentIndex: 0 }] }),
    onTranslation: async (_result, chunk) => { published.push(chunk.chunkIndex); },
    onEvent() {}
  });
  capture.pending.push(
    { jobId: "capture-test", chunkIndex: 0, generation: 0, videoStart: 0 },
    { jobId: "capture-test", chunkIndex: 1, generation: 0, videoStart: 5 }
  );
  await capture.processQueue();
  assert.deepEqual(recognized, [0, 1]);
  assert.equal(capture.translationPending.length, 1);
  assert.deepEqual(published, []);
  finishFirstTranslation({ ok: true, translated: [{ chunkIndex: 0, segmentIndex: 0 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(published, [0, 1]);
});

test("an unfinished cue gets a bounded lookahead refinement", async () => {
  const requests = [];
  const capture = api.create({
    processChunk: async chunk => ({ ok: true, source: [{
      chunkIndex: chunk.chunkIndex, segmentIndex: 0,
      start: chunk.videoStart, end: chunk.videoStart + 2,
      text: chunk.chunkIndex === 0 ? "続きます" : "このあとです。"
    }] }),
    onResult: async () => {},
    translateChunk: async request => {
      requests.push(request);
      return { ok: true, translated: [{ text: "译文" }] };
    },
    onTranslation: async () => {},
    onEvent() {}
  });
  capture.pending.push(
    { jobId: "capture-test", chunkIndex: 0, generation: 0, videoStart: 0 },
    { jobId: "capture-test", chunkIndex: 1, generation: 0, videoStart: 2.2 }
  );
  await capture.processQueue();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(request => request.chunkIndex), [0, 1, 0]);
  assert.equal(requests[2].nextSource, "このあとです。");
});

test("translation returned after a seek cannot update old-position subtitles", async () => {
  let finishTranslation;
  const published = [];
  const capture = api.create({
    translateChunk: () => new Promise(resolve => { finishTranslation = resolve; }),
    onTranslation: async result => { published.push(result); },
    onEvent() {}
  });
  capture.enqueueTranslation({ jobId: "capture-test", chunkIndex: 0, generation: 0 }, [{}]);
  await new Promise(resolve => setImmediate(resolve));
  capture.generation = 1;
  finishTranslation({ ok: true, translated: [{}] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published.length, 0);
});

test("new-position recognition waits for old request cancellation", async () => {
  let finishCancellation;
  const processed = [];
  const capture = api.create({
    processChunk: async chunk => {
      processed.push(chunk.chunkIndex);
      return { ok: true, source: [] };
    },
    onEvent() {}
  });
  capture.resetPromise = new Promise(resolve => { finishCancellation = resolve; });
  capture.generation = 1;
  capture.pending.push({ chunkIndex: 2, generation: 1, videoStart: 90 });
  const processing = capture.processQueue();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(processed, []);
  finishCancellation();
  await processing;
  assert.deepEqual(processed, [2]);
});
