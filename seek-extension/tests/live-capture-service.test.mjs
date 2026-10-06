import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { FuguangLiveCaptureContext } from "../src/background/live-capture-context.js";

const source = readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
const start = source.indexOf("function beginCapturedAudioRequest(");
const end = source.indexOf("function diagnosticSourceHost(", start);
assert.ok(start >= 0 && end > start);

test("capture service returns source before translating and carries context forward", async () => {
  const events = [];
  const metadata = [];
  const requestPaths = [];
  const context = {
    Uint8Array,
    URL,
    AbortController,
    FuguangLiveCaptureContext,
    liveCaptureRequests: new Map(),
    liveCaptureTranslationContexts: new Map(),
    diagnosticLog: { append: async event => { events.push(event); } },
    getModelConfig: async () => ({ asr: {}, glossary: "人名: 林", translation: { baseUrl: "http://127.0.0.1:8765" } }),
    transcribeBrowserAudioChunk: async () => [{ start: 0, end: 2, text: "こんにちは" }],
    normalizeBrowserSourceSegmentsForTranslation: (segments, chunkIndex) =>
      segments.map((segment, segmentIndex) => ({ ...segment, chunkIndex, segmentIndex })),
    translateBrowserSegments: async (_source, _config, _target, details, options) => {
      metadata.push(details);
      requestPaths.push(options.semanticRequestPath);
      return [{ text: "你好" }];
    },
    isUsableTimedTextSegment: segment => segment.end > segment.start && Boolean(segment.text),
    cleanVttText: value => String(value || "").trim(),
    diagnosticSourceHost: () => "127.0.0.1",
    browserEndpointIsLocal: config => new URL(config.baseUrl).hostname === "127.0.0.1",
    normalizeProviderType: value => value
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.captureApi = { processCapturedAudio, translateCapturedSegments };`, context);
  const { processCapturedAudio, translateCapturedSegments } = context.captureApi;
  const base = {
    jobId: "capture-test", captureMode: "tab", sourceLanguage: "ja",
    audioDuration: 2, playbackRate: 1, audioBytes: Array(44).fill(0)
  };

  const first = await processCapturedAudio({ ...base, chunkIndex: 0, videoStart: 100 });
  assert.equal(first.source.length, 1);
  assert.equal(first.source[0].start, 100);
  assert.equal(metadata.length, 0);
  const firstTranslation = await translateCapturedSegments({
    ...base, chunkIndex: 0, source: first.source, nextSource: "次の文"
  });
  assert.equal(firstTranslation.translated[0].text, "你好");
  assert.equal(metadata[0].previousSource, "");
  assert.equal(metadata[0].glossary, "人名: 林");
  assert.equal(metadata[0].nextSource, "次の文");
  assert.equal(requestPaths[0], "capture/0/translation/refinement");

  const second = await processCapturedAudio({ ...base, chunkIndex: 1, videoStart: 104 });
  await translateCapturedSegments({ ...base, chunkIndex: 1, source: second.source });
  assert.match(metadata[1].previousSource, /こんにちは/);
  assert.match(metadata[1].previousTranslation, /你好/);
  assert.equal(requestPaths[1], "capture/1/translation");

  context.getModelConfig = async () => ({
    asr: {}, glossary: "", translation: { baseUrl: "https://example.com" }
  });
  const skipped = await translateCapturedSegments({
    ...base, chunkIndex: 1, source: second.source, nextSource: "次の文"
  });
  assert.equal(skipped.refinementSkipped, true);
  assert.equal(metadata.length, 2);
  context.getModelConfig = async () => ({
    asr: {}, glossary: "人名: 林", translation: { baseUrl: "http://127.0.0.1:8765" }
  });

  context.translateBrowserSegments = async () => {
    const error = new Error("local translation failed");
    error.status = 502;
    throw error;
  };
  const third = await processCapturedAudio({ ...base, chunkIndex: 2, videoStart: 108 });
  const fallback = await translateCapturedSegments({ ...base, chunkIndex: 2, source: third.source });
  assert.equal(fallback.translationFailed, true);
  assert.equal(fallback.fallback, "source");
  assert.equal(third.source[0].text, "こんにちは");
  const failure = events.find(event => event.event === "capture_translation_fallback");
  assert.equal(failure.details.httpStatus, 502);
  assert.equal(events.some(event => event.event === "capture_asr_completed"), true);
  assert.equal(events.some(event => event.event === "capture_translation_completed"), true);
});
