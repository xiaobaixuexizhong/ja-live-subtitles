import assert from "node:assert/strict";
import test from "node:test";
import { FuguangLiveCaptureContext as context } from "../src/background/live-capture-context.js";

test("live context keeps recent source even when translation fails", () => {
  let history = [];
  for (let index = 0; index < 10; index += 1) {
    history = context.recordSource(history, {
      chunkIndex: index,
      videoEnd: index * 6 + 6,
      source: `source-${index}`
    });
    if (index !== 9) {
      history = context.recordTranslation(history, index, `translation-${index}`);
    }
  }
  const preceding = context.precedingContext(history, 10, 60);
  assert.equal(history.length, 8);
  assert.match(preceding.previousSource, /source-9/);
  assert.doesNotMatch(preceding.previousSource, /source-1/);
  assert.match(preceding.previousTranslation, /translation-8/);
  assert.doesNotMatch(preceding.previousTranslation, /translation-9/);
});

test("live context excludes old and future video positions", () => {
  const history = [
    { chunkIndex: 0, videoEnd: 10, source: "old", translation: "old" },
    { chunkIndex: 1, videoEnd: 60, source: "near", translation: "near" },
    { chunkIndex: 3, videoEnd: 80, source: "future", translation: "future" }
  ];
  const preceding = context.precedingContext(history, 2, 65);
  assert.equal(preceding.previousSource, "near");
  assert.equal(preceding.previousTranslation, "near");
});

test("overlapped ASR text is trimmed only at the adjacent window boundary", () => {
  const history = [{ chunkIndex: 0, videoEnd: 5, source: "今日は皆さん", translation: "" }];
  const segment = { start: 4.6, end: 8, text: "皆さん、元気ですか" };
  const trimmed = context.deduplicateOverlap(history, 1, 4.4, 0.6, [segment]);
  assert.equal(trimmed[0].text, "元気ですか");
  assert.equal(trimmed[0].start, 5);
  assert.equal(context.deduplicateOverlap(history, 1, 4.4, 0.6,
    [{ ...segment, text: "皆さん" }]).length, 0);
  assert.equal(context.deduplicateOverlap(history, 1, 4.4, 0, [segment])[0].text, segment.text);
  assert.equal(context.deduplicateOverlap(history, 1, 10, 0.6, [segment])[0].text, segment.text);
  assert.equal(context.deduplicateOverlap(history, 1, 4.4, 0.6,
    [{ ...segment, start: 5.3 }])[0].text, segment.text);
});
