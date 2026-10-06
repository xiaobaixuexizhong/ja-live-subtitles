import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import vm from "node:vm";
import * as mediabunny from "../src/vendor/mediabunny/mediabunny.min.mjs";

const offscreen = readFileSync(new URL("../src/offscreen/offscreen.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
function sourceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

const mediaFetchOptionsMetadata = new WeakMap();
const scheduler = { AbortController, mediaFetchOptionsMetadata };
vm.runInNewContext(`${sourceBetween(offscreen, "function nextMediaWindowIndex(",
  "chrome.runtime.onMessage.addListener")}
  globalThis.nextWindow = nextMediaWindowIndex;
  globalThis.newPrefetch = createMediaWindowPrefetch;`, scheduler);

test("media extraction starts at playback and follows a later seek", () => {
  const windows = Array.from({ length: 5 }, (_, index) => ({
    start: index * 60, end: (index + 1) * 60
  }));
  const completed = new Set();
  const priority = { time: 125 };
  assert.equal(scheduler.nextWindow(windows, completed, priority), 2);
  completed.add(2);
  assert.equal(scheduler.nextWindow(windows, completed, priority), 3);
  priority.time = 15;
  assert.equal(scheduler.nextWindow(windows, completed, priority), 0);
});

test("media prefetch keeps one window and cancels stale seek downloads", async () => {
  const parent = new AbortController();
  const options = { signal: parent.signal };
  const metadata = { origin: "https://example.com" };
  mediaFetchOptionsMetadata.set(options, metadata);
  const prefetch = scheduler.newPrefetch(options);
  let staleSignal;
  prefetch.start(1, scoped => {
    staleSignal = scoped.signal;
    assert.equal(mediaFetchOptionsMetadata.get(scoped), metadata);
    return new Promise(() => {});
  });
  await Promise.resolve();
  prefetch.start(3, scoped => {
    assert.equal(mediaFetchOptionsMetadata.get(scoped), metadata);
    return "new position";
  });
  assert.equal(staleSignal.aborted, true);
  assert.equal(prefetch.take(1), null);
  const fetched = await prefetch.take(3);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.result, "new position");
  prefetch.start(4, scoped => new Promise(resolve => {
    scoped.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
  }));
  await Promise.resolve();
  parent.abort();
  assert.equal((await prefetch.take(4)).result, "cancelled");
});

const dash = {};
vm.runInNewContext(`${sourceBetween(offscreen, "function buildDashAudioWindowGroups(",
  "async function extractDashAudioWindows(")}
  globalThis.groupDash = buildDashAudioWindowGroups;`, dash);

test("DASH groups retain stable core times and adjacent context", () => {
  const fragments = Array.from({ length: 6 }, (_, index) => ({
    start: index * 10, end: (index + 1) * 10, url: `segment-${index}`
  }));
  const groups = dash.groupDash(fragments, 42);
  assert.equal(groups.length, 2);
  assert.deepEqual(Array.from(groups, group => [group.coreStart, group.coreEnd]), [[0, 30], [30, 60]]);
  assert.deepEqual(Array.from(groups, group => [group.start, group.end]), [[0, 40], [20, 60]]);
  assert.equal(dash.groupDash([{ start: 0, end: 0 }], 42).length, 0);
  assert.equal(dash.groupDash([{ start: 0, end: 10 }, { start: 12, end: 22 }], 42).length, 0);
});

const range = {
  mediaFetchOptionsForUrl: options => options,
  createMediaFetchHttpError: status => Object.assign(new Error(`HTTP ${status}`), { status }),
  isRetryableMediaFetchError: error => [408, 425, 429, 500, 502, 503, 504].includes(error.status),
  buildFetchOptionsWithByteRange: (options, byteRange) => ({ ...options, byteRange,
    headers: { ...options.headers,
      Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` } }),
  parseContentRangeHeader: value => {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
    return match && { offset: Number(match[1]), endExclusive: Number(match[2]) + 1,
      total: Number(match[3]) };
  }
};
vm.runInNewContext(`${sourceBetween(offscreen, "async function fetchStrictHttpMediaRange(",
  "function isRecoverableWebFfmpegRuntimeError(")}
  globalThis.readRange = fetchStrictHttpMediaRange;`, range);

test("HTTP Range requires 206 and never reads a whole-file 200 response", async () => {
  let readFullBody = false;
  range.fetch = async () => ({ status: 200, body: { cancel: async () => {} },
    arrayBuffer: async () => { readFullBody = true; return new ArrayBuffer(1000); } });
  await assert.rejects(range.readRange("https://example.com/media.mp4", {}, 0, 1), /不支持按范围读取/);
  assert.equal(readFullBody, false);
  range.fetch = async (_url, options) => ({
    status: 206,
    headers: { get: name => name === "content-range" ? "bytes 10-19/1000" : "v1" },
    arrayBuffer: async () => new Uint8Array(options.byteRange.length).buffer
  });
  const result = await range.readRange("https://example.com/media.mp4", {}, 10, 20, 1000, "v1");
  assert.equal(result.bytes.length, 10);
  await assert.rejects(range.readRange("https://example.com/media.mp4", {}, 10, 20, 999),
    /Content-Range/);
  range.fetch = async () => ({ status: 503, body: { cancel: async () => {} } });
  await assert.rejects(range.readRange("https://example.com/media.mp4", {}, 0, 1),
    error => error.status === 503);
  range.fetch = async () => ({ status: 403, body: { cancel: async () => {} } });
  await assert.rejects(range.readRange("https://example.com/media.mp4", {}, 0, 1),
    /媒体地址可能过期/);
});

const retry = {
  WEB_FFMPEG_HLS_FETCH_RETRY_ATTEMPTS: 3,
  throwIfOffscreenJobAborted: () => {},
  isRetryableMediaFetchError: error => /Failed to fetch/.test(error.message),
  describeMediaFetchError: (label, error) => new Error(`${label}：${error.message}`),
  waitForMediaFetchRetry: async () => {}
};
vm.runInNewContext(`${sourceBetween(offscreen, "async function withMediaFetchRetry(",
  "function createMediaFetchHttpError(")}
  globalThis.retryMedia = withMediaFetchRetry;`, retry);

test("a transient Range network failure is retried before failing the task", async () => {
  let attempts = 0;
  const result = await retry.retryMedia("直连媒体音频范围读取失败", async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("Failed to fetch");
    return "audio";
  });
  assert.equal(result, "audio");
  assert.equal(attempts, 3);
});

test("HTTP Range demux can seek to a later audio packet", async () => {
  const media = readFileSync(new URL("../../tests/seek-sample.webm", import.meta.url));
  const server = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range || ""));
    if (!match) {
      response.writeHead(400).end();
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), media.length - 1);
    response.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${media.length}`,
      "Content-Length": end - start + 1 });
    response.end(media.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/sample.webm`;
  range.fetch = fetch;
  const input = new mediabunny.Input({
    formats: mediabunny.ALL_FORMATS,
    source: new mediabunny.CustomSource({
      getSize: () => media.length,
      read: async (start, end) => new Uint8Array(
        (await range.readRange(url, {}, start, end, media.length)).bytes),
      maxCacheSize: 16 * 1024 * 1024,
      prefetchProfile: "fileSystem"
    })
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    assert.ok(track);
    const packet = await new mediabunny.EncodedPacketSink(track).getPacket(10);
    assert.ok(packet);
    assert.ok(packet.timestamp >= 9 && packet.timestamp <= 11);
  } finally {
    input.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});

test("direct media publishes the playback window before processing the rest", async () => {
  const events = [];
  const extractor = {
    selectLocalMediaAudioOutputSpec: () => ({ extension: "aac" }),
    resolveLocalMediaAudioDuration: async () => 180,
    normalizeLocalMediaLogicalChunkSeconds: () => 60,
    buildLocalMediaLogicalChunkSpecs: () => Array.from({ length: 3 }, (_, index) => ({
      index, start: index * 60, end: (index + 1) * 60,
      coreStart: index * 60, coreEnd: (index + 1) * 60
    })),
    muxLocalMediaAudioWindow: async (_media, _sink, _codec, _config, _output, spec) => {
      events.push(`mux:${spec.index}`);
      return { buffer: new ArrayBuffer(2) };
    },
    extractLocalMediaAudioWindowWithWebFfmpegWithRetry: async (_message, _policy, _encoded, spec) => ({
      index: spec.index, ...spec, bytes: 2, file: { cacheUrl: `audio-${spec.index}` }
    })
  };
  const context = {
    buildMediaFetchOptions: () => ({}),
    withMediaFetchRetry: (_label, operation) => operation(),
    fetchStrictHttpMediaRange: async () => ({ bytes: new Uint8Array(1), size: 180_000_000, etag: "v1" }),
    loadMediabunny: async () => ({
      CustomSource: class {},
      Input: class {
        getPrimaryAudioTrack() { return Promise.resolve({
          getCodec: async () => "aac", getDecoderConfig: async () => ({})
        }); }
        dispose() {}
      },
      EncodedPacketSink: class {},
      ALL_FORMATS: []
    }),
    getLocalMediaExtractor: () => extractor,
    isLongFileAsrMode: () => false,
    createHlsWebFfmpegRecyclePolicy: () => ({ shouldRecycleBefore: () => false }),
    throwIfOffscreenJobAborted: () => {},
    nextMediaWindowIndex: scheduler.nextWindow,
    reportWebFfmpegChunkReady: async (_message, chunk) => { events.push(`ready:${chunk.index}`); },
    reportWebFfmpegExtractionProgress: () => {}
  };
  vm.runInNewContext(`${sourceBetween(offscreen, "async function extractHttpRangeAudioWithWebFfmpeg(",
    "async function fetchStrictHttpMediaRange(")}
    globalThis.extractRange = extractHttpRangeAudioWithWebFfmpeg;`, context);
  const result = await context.extractRange({ sourceUrl: "https://example.com/media.mp4",
    priority: { time: 125 } });
  assert.deepEqual(events.slice(0, 4), ["mux:2", "ready:2", "mux:1", "ready:1"]);
  assert.equal(result.chunks.length, 3);
  assert.ok(result.chunks.every(chunk => chunk.logical && chunk.sparseExtraction));
});

test("direct media does not silently mark a missing audio window complete", async () => {
  const context = {
    buildMediaFetchOptions: () => ({}),
    withMediaFetchRetry: (_label, operation) => operation(),
    fetchStrictHttpMediaRange: async () => ({ bytes: new Uint8Array(1), size: 180_000_000, etag: "v1" }),
    loadMediabunny: async () => ({
      CustomSource: class {},
      Input: class {
        getPrimaryAudioTrack() { return Promise.resolve({
          getCodec: async () => "aac", getDecoderConfig: async () => ({})
        }); }
        dispose() {}
      },
      EncodedPacketSink: class {},
      ALL_FORMATS: []
    }),
    getLocalMediaExtractor: () => ({
      selectLocalMediaAudioOutputSpec: () => ({ extension: "aac" }),
      resolveLocalMediaAudioDuration: async () => 60,
      normalizeLocalMediaLogicalChunkSeconds: () => 60,
      buildLocalMediaLogicalChunkSpecs: () => [{ index: 0, start: 0, end: 60, coreStart: 0, coreEnd: 60 }],
      muxLocalMediaAudioWindow: async () => ({ buffer: new ArrayBuffer(2) }),
      extractLocalMediaAudioWindowWithWebFfmpegWithRetry: async () => null
    }),
    isLongFileAsrMode: () => false,
    createHlsWebFfmpegRecyclePolicy: () => ({ shouldRecycleBefore: () => false }),
    throwIfOffscreenJobAborted: () => {},
    nextMediaWindowIndex: scheduler.nextWindow
  };
  vm.runInNewContext(`${sourceBetween(offscreen, "async function extractHttpRangeAudioWithWebFfmpeg(",
    "async function fetchStrictHttpMediaRange(")}
    globalThis.extractRange = extractHttpRangeAudioWithWebFfmpeg;`, context);
  await assert.rejects(context.extractRange({ sourceUrl: "https://example.com/media.mp4" }),
    /音频窗口没有生成结果/);
});

test("DASH downloads the next timed audio group while converting the current one", async () => {
  const events = [];
  const fragments = Array.from({ length: 6 }, (_, index) => ({
    start: index * 10, end: (index + 1) * 10, url: `segment-${index}`
  }));
  const groups = dash.groupDash(fragments, 42);
  const context = {
    updateMediaHeaderRuleDomains: async () => {},
    downloadMseFragmentBuffers: async items => {
      events.push(`download:${items[0].url}`);
      return items.map(fragment => ({ fragment, buffer: new Uint8Array([1]).buffer }));
    },
    concatenateArrayBuffers: buffers => new Uint8Array(buffers.length).buffer,
    requestWebFfmpegForJob: async () => {
      events.push("convert");
      return { file: { buffer: new Uint8Array([1]).buffer } };
    },
    persistWebFfmpegAudioResult: async (_result, key) => ({
      file: { cacheUrl: key, bytes: 1 }, bytes: 1
    }),
    nextMediaWindowIndex: scheduler.nextWindow,
    createMediaWindowPrefetch: scheduler.newPrefetch,
    throwIfOffscreenJobAborted: () => {},
    reportWebFfmpegChunkReady: async (_message, chunk) => { events.push(`ready:${chunk.index}`); },
    reportWebFfmpegExtractionProgress: () => {},
    offsetSpeechIntervals: () => [],
    WEB_FFMPEG_APP: "test"
  };
  vm.runInNewContext(`${sourceBetween(offscreen, "async function extractDashAudioWindows(",
    "async function downloadMseFragmentBuffers(")}
    globalThis.extractDash = extractDashAudioWindows;`, context);
  const result = await context.extractDash({ cacheNamespace: "job", priority: { time: 45 } },
    "https://example.com/manifest.mpd", {}, [{ url: "init" }], groups, 60, 42);
  assert.deepEqual(events.slice(0, 6), ["download:init", "download:segment-2", "convert",
    "download:segment-0", "ready:1", "convert"]);
  assert.equal(result.chunks[0].coreStart, 30);
  assert.ok(result.chunks.every(chunk => chunk.logical && chunk.sparseExtraction));
});

test("DASH seek cancels the old prefetched group during conversion", async () => {
  const events = [];
  const groups = Array.from({ length: 4 }, (_, index) => ({
    start: index * 10, end: (index + 1) * 10,
    coreStart: index * 10, coreEnd: (index + 1) * 10,
    fragments: [{ url: `segment-${index}` }]
  }));
  let releaseConversion;
  const firstConversion = new Promise(resolve => { releaseConversion = resolve; });
  let segment2Calls = 0;
  let conversions = 0;
  const context = {
    updateMediaHeaderRuleDomains: async () => {},
    downloadMseFragmentBuffers: async (items, options) => {
      const name = items[0].url;
      events.push(`download:${name}`);
      if (name === "segment-2" && segment2Calls++ === 0) {
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            events.push("abort:segment-2");
            reject(new Error("seek cancelled prefetch"));
          }, { once: true });
        });
      }
      return items.map(fragment => ({ fragment, buffer: new Uint8Array([1]).buffer }));
    },
    concatenateArrayBuffers: buffers => new Uint8Array(buffers.length).buffer,
    requestWebFfmpegForJob: async () => {
      if (conversions++ === 0) await firstConversion;
      return { file: { buffer: new Uint8Array([1]).buffer } };
    },
    persistWebFfmpegAudioResult: async (_result, key) => ({
      file: { cacheUrl: key, bytes: 1 }, bytes: 1
    }),
    nextMediaWindowIndex: scheduler.nextWindow,
    createMediaWindowPrefetch: scheduler.newPrefetch,
    throwIfOffscreenJobAborted: () => {},
    reportWebFfmpegChunkReady: async (_message, chunk) => { events.push(`ready:${chunk.index}`); },
    reportWebFfmpegExtractionProgress: () => {},
    offsetSpeechIntervals: () => [],
    WEB_FFMPEG_APP: "test"
  };
  vm.runInNewContext(`${sourceBetween(offscreen, "async function extractDashAudioWindows(",
    "async function downloadMseFragmentBuffers(")}
    globalThis.extractDash = extractDashAudioWindows;`, context);
  const priority = { time: 15 };
  const extraction = context.extractDash({ cacheNamespace: "seek", priority },
    "https://example.com/manifest.mpd", {}, [{ url: "init" }], groups, 40, 10);
  for (let attempt = 0; !events.includes("download:segment-2") && attempt < 20; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(events.includes("download:segment-2"));
  priority.time = 35;
  priority.onChange();
  for (let attempt = 0; !events.includes("download:segment-3") && attempt < 20; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(events.includes("abort:segment-2"));
  assert.ok(events.includes("download:segment-3"));
  releaseConversion();
  const result = await extraction;
  assert.equal(result.chunks.length, 4);
  assert.ok(events.indexOf("ready:1") < events.indexOf("ready:3"));
});

const coverage = {
  browserTranslationSegmentSeconds: () => 60,
  browserAudioChunkCoreStart: chunk => chunk.coreStart,
  browserAudioChunkCoreEnd: chunk => chunk.coreEnd,
  pickFinite: (...values) => values.find(value => Number.isFinite(Number(value))),
  maybeFinalizeBrowserTranslationGroup: (_record, group) => {
    if (group.closed && group.completed >= group.total) group.translationQueued = true;
  }
};
vm.runInNewContext(`${sourceBetween(worker, "function closeBrowserTranslationGroupIfChunkCompletesWindow(",
  "function browserTranslationGroupIndex(")}
  globalThis.hasCoverage = browserTranslationGroupHasFullCoverage;
  globalThis.closeCovered = closeCoveredBrowserTranslationGroupsForAudioChunk;`, coverage);

test("translation group waits for missing earlier audio even when its last chunk arrives first", () => {
  const group = { index: 2, chunks: [{ coreStart: 150, coreEnd: 180 }] };
  assert.equal(coverage.hasCoverage({}, group, 180), false);
  group.chunks.unshift({ coreStart: 120, coreEnd: 150 });
  assert.equal(coverage.hasCoverage({}, group, 180), true);
});

test("translation coverage includes a chunk that starts in the preceding group", () => {
  const group = { index: 1, chunks: [{ coreStart: 85, coreEnd: 120 }] };
  const record = { audioChunks: [
    { coreStart: 0, coreEnd: 55 },
    { coreStart: 55, coreEnd: 85 },
    ...group.chunks
  ] };
  assert.equal(coverage.hasCoverage(record, group, 120), true);
  record.audioChunks.splice(1, 1);
  assert.equal(coverage.hasCoverage(record, group, 120), false);
});

test("late preceding audio unlocks an already recognized sparse translation group", () => {
  const later = { index: 10, coreStart: 450, coreEnd: 495 };
  const preceding = { index: 9, coreStart: 405, coreEnd: 450 };
  const group = { index: 7, targetEnd: 480, completed: 1, total: 1,
    closed: false, translationQueued: false };
  const record = { sparseExtraction: true, audioChunks: [later],
    browserTranslationGroups: new Map([[7, group]]) };
  coverage.closeCovered(record, later);
  assert.equal(group.closed, false);
  record.audioChunks.unshift(preceding);
  coverage.closeCovered(record, preceding);
  assert.equal(group.closed, true);
  assert.equal(group.translationQueued, true);
});

test("recognized source is published before the translation group closes", () => {
  const group = { index: 0, completed: 0, failed: 0, empty: 0, sourceSegments: [], errors: [],
    total: 2, closed: false };
  let published = 0;
  const context = {
    getBrowserTranslationGroupForAudioChunk: () => group,
    normalizeBrowserSourceSegmentsForTranslation: segments => segments,
    recordBrowserDiagnostic: () => {},
    browserAsrChunkTimeRangeText: () => "00:00:00 - 00:00:30",
    updateChunkStatus: () => {},
    publishBrowserSubtitle: () => { published += 1; },
    maybeFinalizeBrowserTranslationGroup: () => false,
    browserAsrGroupProgressMessage: () => "识别完成"
  };
  vm.runInNewContext(`${sourceBetween(worker, "function completeBrowserAsrChunkForGroup(",
    "function browserAsrChunkTimeRangeText(")}
    globalThis.completeAsr = completeBrowserAsrChunkForGroup;`, context);
  const record = { startedAt: Date.now(), sourceSegmentsByChunk: new Map(),
    job: { translation: { chunkStatuses: [{ attempts: 1 }] } } };
  context.completeAsr(record, { index: 0 }, [{ start: 0, end: 3, text: "原文" }]);
  assert.equal(published, 1);
  assert.equal(record.sourceSegmentsByChunk.get(0).length, 1);
  assert.equal(group.closed, false);
});

const mediaContext = {
  URL,
  optionalBrowserFrameId: value => value == null || value === "" ? null : Number(value),
  normalizeDocumentId: value => String(value || "")
};
vm.runInNewContext(`${sourceBetween(worker, "function browserPreloadContextMatchesSelectedMedia(",
  "function pickNonNegativeFinite(")}
  globalThis.matchesMedia = browserPreloadContextMatchesSelectedMedia;`, mediaContext);

test("another media element cannot redirect extraction away from the selected video", () => {
  const record = {
    selectedCandidate: { url: "https://example.com/video.mp4?token=1" },
    presentationBinding: { frameId: 2, documentId: "video-doc" }
  };
  assert.equal(mediaContext.matchesMedia(record, {
    hasMedia: true, currentSrc: "https://example.com/video.mp4?token=1"
  }, 2, "video-doc"), true);
  assert.equal(mediaContext.matchesMedia(record, {
    hasMedia: true, currentSrc: "https://example.com/preview.mp4"
  }, 2, "video-doc"), false);
  assert.equal(mediaContext.matchesMedia(record, {
    hasMedia: true, currentSrc: "blob:https://example.com/playback"
  }, 0, "main-doc"), false);
});
