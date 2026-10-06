import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/content/subtitle-overlay.js", import.meta.url), "utf8");
const start = source.indexOf("  function armLiveCue(");
const end = source.indexOf("  function findCueAt(", start);
assert.ok(start >= 0 && end > start);

let now = 0;
const context = {
  performance: { now: () => now },
  LIVE_CAPTION_MAX_LAG_SECONDS: 30,
  LIVE_CAPTION_MAX_HOLD_SECONDS: 10
};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.liveCueApi = { armLiveCue, clearLiveCue };`, context);
const { armLiveCue, clearLiveCue } = context.liveCueApi;

test("a newly translated live cue stays visible after its video interval", () => {
  now = 1000;
  const cue = { start: 100, end: 110, text: "字幕" };
  const controller = { cues: [cue], liveCue: null, liveCueUntil: 0 };
  armLiveCue(controller, { currentTime: 117, paused: false, seeking: false }, true);
  assert.equal(controller.liveCue, cue);
  assert.equal(controller.liveCueUntil, 11000);
});

test("old cues and non-live attachments do not get replayed", () => {
  const cue = { start: 100, end: 110, text: "字幕" };
  const controller = { cues: [cue], liveCue: null, liveCueUntil: 0 };
  armLiveCue(controller, { currentTime: 141, paused: false, seeking: false }, true);
  assert.equal(controller.liveCue, null);
  armLiveCue(controller, { currentTime: 117, paused: false, seeking: false }, false);
  assert.equal(controller.liveCue, null);
});

test("a translated cue can appear when playback was paused for processing", () => {
  now = 2000;
  const cue = { start: 100, end: 110, text: "字幕" };
  const controller = { cues: [cue], liveCue: null, liveCueUntil: 0 };
  armLiveCue(controller, { currentTime: 110, paused: true, seeking: false }, true);
  assert.equal(controller.liveCue, cue);
});

test("new live text after a backward seek uses the current cue, not the timeline's last cue", () => {
  now = 3000;
  const earlier = { start: 170, end: 176, text: "当前译文" };
  const later = { start: 534, end: 540, text: "之前译文" };
  const controller = { cues: [earlier, later], liveCue: null, liveCueUntil: 0 };
  armLiveCue(controller, { currentTime: 177, seeking: false }, true, [later]);
  assert.equal(controller.liveCue, earlier);
  assert.equal(controller.liveCueUntil, 9000);
});

test("reattaching unchanged past text does not replay it after a seek", () => {
  const earlier = { start: 170, end: 176, text: "已有译文" };
  const later = { start: 534, end: 540, text: "后段译文" };
  const controller = { cues: [earlier, later], liveCue: null, liveCueUntil: 0 };
  armLiveCue(controller, { currentTime: 177, seeking: false }, true, [earlier]);
  assert.equal(controller.liveCue, null);
});

test("revising an older cue does not cover a newer live subtitle", () => {
  const revised = { start: 100, end: 105, text: "修订旧句" };
  const newer = { start: 106, end: 110, text: "当前句" };
  const controller = { cues: [revised, newer], liveCue: null, liveCueUntil: 0 };
  armLiveCue(controller, { currentTime: 112, paused: false, seeking: false }, true,
    [{ ...revised, text: "旧译文" }, newer]);
  assert.equal(controller.liveCue, null);
});

test("clearing a live cue removes its temporary fullscreen cue", () => {
  const nativeCue = { text: "字幕" };
  const removed = [];
  const controller = {
    liveCue: { start: 100, end: 110 },
    liveCueUntil: 11000,
    liveNativeCue: nativeCue,
    nativeCues: [nativeCue],
    nativeTrack: { removeCue: cue => removed.push(cue) }
  };
  clearLiveCue(controller);
  assert.deepEqual(removed, [nativeCue]);
  assert.equal(controller.nativeCues.length, 0);
  assert.equal(controller.liveCue, null);
  assert.equal(controller.liveCueUntil, 0);
});
