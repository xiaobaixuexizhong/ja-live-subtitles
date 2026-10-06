import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const outputSource = readFileSync(new URL("../src/sidepanel/subtitle-output.js", import.meta.url), "utf8");
const sidepanelSource = readFileSync(new URL("../src/sidepanel/sidepanel.js", import.meta.url), "utf8");
const start = sidepanelSource.indexOf("function preparedMediaTranscriptForCapture(");
const end = sidepanelSource.indexOf("async function appendLiveCaptureSubtitles(", start);
assert.ok(start >= 0 && end > start);

const context = { normalizeCacheUrl: value => String(value || "").split("#")[0] };
vm.runInNewContext(outputSource, context);
vm.runInNewContext(`${sidepanelSource.slice(start, end)}
  globalThis.handoff = { preparedMediaTranscriptForCapture, filterCapturedSourceWithPrepared };`, context);
const { preparedMediaTranscriptForCapture: prepare, filterCapturedSourceWithPrepared: filter } = context.handoff;

const transcript = {
  metadata: { pageUrl: "https://example.com/watch", sourceUrl: "https://cdn.example.com/audio.m3u8",
    originalSourceUrl: "https://cdn.example.com/video.m3u8" },
  source: [
    { chunkIndex: 2, segmentIndex: 0, start: 10, end: 13, text: "今日はいい天気です" },
    { chunkIndex: 3, segmentIndex: 0, start: 14, end: 17, text: "次の文です" }
  ],
  translated: [
    { chunkIndex: 2, segmentIndex: 0, start: 10, end: 13, text: "今天天气很好" }
  ]
};
const job = {
  id: "media-1", pipeline: "browser", sourceUrl: transcript.metadata.sourceUrl,
  originalSourceUrl: transcript.metadata.originalSourceUrl,
  metadata: transcript.metadata,
  translation: { transcript }
};

test("prepared translations retain media time and use IDs distinct from capture", () => {
  const prepared = prepare(job, transcript, transcript.metadata.pageUrl, job.id, null,
    transcript.metadata.originalSourceUrl);
  assert.ok(prepared);
  assert.deepEqual(Array.from(prepared.translated, item => item.chunkIndex), [-1]);
  assert.deepEqual(Array.from(prepared.source, item => item.chunkIndex), [-1, -2]);
  assert.deepEqual(Array.from(prepared.translated, item => item.start), [10]);
  const cues = context.cuesFromTranscript({
    source: [...prepared.source, { chunkIndex: 0, segmentIndex: 0, start: 18, end: 20, text: "新しい文" }],
    translated: prepared.translated
  });
  assert.deepEqual(Array.from(cues, cue => cue.start), [10, 14, 18]);
  assert.equal(cues[0].text, "今天天气很好");
  assert.equal(cues[1].sourceOnly, true);
  const vtt = context.cuesToVtt(cues, "translated", { allowSourceFallbackWithTranslated: true });
  assert.match(vtt, /今天天气很好/);
  assert.match(vtt, /次の文です/);
});

test("matching captured speech skips duplicate translation but gaps remain", () => {
  const prepared = prepare(job, transcript, transcript.metadata.pageUrl, job.id);
  const captured = [
    { start: 10.1, end: 12.9, text: "今日はいい天気です。" },
    { start: 18, end: 20, text: "新しい文" }
  ];
  assert.deepEqual(Array.from(filter(captured, prepared.cues), item => item.text), ["新しい文"]);
  assert.deepEqual(Array.from(filter([{ start: 30, end: 32, text: "今日はいい天気です" }], prepared.cues)),
    [{ start: 30, end: 32, text: "今日はいい天気です" }]);
  const cueAtBoundary = { start: 12.8, end: 13.3, sourceText: "次の文です", sourceOnly: false };
  assert.equal(filter([{ start: 10, end: 13, text: "今日はいい天気です" }],
    [...prepared.cues, cueAtBoundary]).length, 0);
});

test("prepared subtitles never cross page or media source", () => {
  assert.equal(prepare(job, transcript, "https://example.com/other", job.id), null);
  assert.equal(prepare(job, transcript, transcript.metadata.pageUrl, job.id, null,
    "https://cdn.example.com/other.m3u8"), null);
  assert.equal(prepare({ ...job, subtitleCleared: true }, transcript, transcript.metadata.pageUrl, job.id), null);
});

test("saved media cache can seed capture only with matching source", () => {
  const entry = {
    origin: "media", jobId: job.id, pageUrl: transcript.metadata.pageUrl,
    sourceUrl: transcript.metadata.sourceUrl, transcript
  };
  assert.ok(prepare(null, transcript, transcript.metadata.pageUrl, job.id, entry,
    transcript.metadata.originalSourceUrl));
  assert.ok(prepare(null, transcript, transcript.metadata.pageUrl, job.id,
    { ...entry, origin: undefined }, transcript.metadata.originalSourceUrl));
  assert.equal(prepare(null, transcript, transcript.metadata.pageUrl, job.id,
    { ...entry, origin: "import" }, transcript.metadata.originalSourceUrl), null);
  assert.equal(prepare(null, transcript, transcript.metadata.pageUrl, job.id, entry,
    "https://cdn.example.com/other.m3u8"), null);
});
