import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const outputSource = readFileSync(new URL("../src/sidepanel/subtitle-output.js", import.meta.url), "utf8");
const sidepanelSource = readFileSync(new URL("../src/sidepanel/sidepanel.js", import.meta.url), "utf8");
const mergeStart = sidepanelSource.indexOf("function mergeLiveCaptureSegments(");
const mergeEnd = sidepanelSource.indexOf("function renderLiveCaptureStatus(", mergeStart);
assert.ok(mergeStart >= 0 && mergeEnd > mergeStart);
const context = {};
vm.runInNewContext(outputSource, context);
vm.runInNewContext(`${sidepanelSource.slice(mergeStart, mergeEnd)}\nglobalThis.merge = mergeLiveCaptureSegments;`, context);
const fallbackStart = sidepanelSource.indexOf("function isLiveCaptureSubtitleOutput(");
const fallbackEnd = sidepanelSource.indexOf("function visibleSubtitleCueItems(", fallbackStart);
assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart);

test("translated live text replaces its source cue without duplicating the timeline", () => {
  const source = [];
  const translated = [];
  context.merge(source, [
    { chunkIndex: 0, segmentIndex: 0, start: 1, end: 4, text: "原文一" },
    { chunkIndex: 1, segmentIndex: 0, start: 5, end: 8, text: "原文二" }
  ]);
  context.merge(translated, [
    { chunkIndex: 0, segmentIndex: 0, start: 1, end: 4, text: "译文一" }
  ]);
  let cues = context.cuesFromTranscript({ source, translated });
  assert.equal(cues.length, 2);
  assert.equal(cues[1].sourceOnly, true);
  const preview = context.cuesToVtt(cues, "translated", {
    allowSourceFallbackWithTranslated: true
  });
  assert.match(preview, /译文一/);
  assert.match(preview, /原文二/);
  const fallbackSrt = context.cuesToSrt(cues, "translated", {
    allowSourceFallbackWithTranslated: true
  });
  assert.match(fallbackSrt, /译文一/);
  assert.match(fallbackSrt, /原文二/);

  context.merge(translated, [
    { chunkIndex: 1, segmentIndex: 0, start: 5, end: 8, text: "译文二" }
  ]);
  context.merge(translated, [
    { chunkIndex: 1, segmentIndex: 0, start: 5, end: 8, text: "译文二" }
  ]);
  cues = context.cuesFromTranscript({ source, translated });
  assert.equal(cues.length, 2);
  assert.deepEqual(Array.from(cues, cue => cue.text), ["译文一", "译文二"]);
  const srt = context.cuesToSrt(cues, "translated", {
    allowSourceFallbackWithTranslated: true
  });
  assert.match(srt, /译文一/);
  assert.match(srt, /译文二/);
});

test("reloaded capture subtitles retain source fallback beside translations", () => {
  const restored = { renderedSubtitleJobId: "capture-saved", currentSubtitleCacheEntry: null,
    captureSession: null };
  vm.runInNewContext(`${sidepanelSource.slice(fallbackStart, fallbackEnd)}
    globalThis.supportsFallback = isLiveCaptureSubtitleOutput;`, restored);
  assert.equal(restored.supportsFallback(), true);
  const cues = context.cuesFromTranscript({
    source: [
      { chunkIndex: 0, segmentIndex: 0, start: 1, end: 3, text: "原文一" },
      { chunkIndex: 1, segmentIndex: 0, start: 4, end: 6, text: "原文二" }
    ],
    translated: [{ chunkIndex: 0, segmentIndex: 0, start: 1, end: 3, text: "译文一" }]
  });
  const vtt = context.cuesToVtt(cues, "translated", {
    allowSourceFallbackWithTranslated: restored.supportsFallback()
  });
  assert.match(vtt, /译文一/);
  assert.match(vtt, /原文二/);
  restored.renderedSubtitleJobId = "preload-saved";
  assert.equal(restored.supportsFallback(), false);
});

test("media overlay shows recognized source until its translation arrives", () => {
  const start = sidepanelSource.indexOf("function cuesToOverlayVtt(");
  const end = sidepanelSource.indexOf("function vttContentSignature(", start);
  assert.ok(start >= 0 && end > start);
  const output = {};
  vm.runInNewContext(outputSource, output);
  output.setSubtitleOutputRuntimeStateProvider(() => ({ mode: "translated", isRunning: true }));
  const cues = output.cuesFromTranscript({
    source: [
      { chunkIndex: 0, segmentIndex: 0, start: 1, end: 3, text: "原文一" },
      { chunkIndex: 1, segmentIndex: 0, start: 4, end: 6, text: "原文二" }
    ],
    translated: [{ chunkIndex: 0, segmentIndex: 0, start: 1, end: 3, text: "译文一" }]
  });
  const overlay = { subtitleCues: cues, subtitleDisplayMode: "translated",
    cuesToVtt: output.cuesToVtt };
  vm.runInNewContext(`${sidepanelSource.slice(start, end)}
    globalThis.overlayVtt = cuesToOverlayVtt;`, overlay);
  const vtt = overlay.overlayVtt();
  assert.match(vtt, /译文一/);
  assert.match(vtt, /原文二/);
});
