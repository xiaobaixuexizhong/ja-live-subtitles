import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
const start = source.indexOf("function firstFiniteBrowserSeekTime(");
const end = source.indexOf("function closeAsyncQueue(", start);
assert.ok(start >= 0 && end > start);

const context = {
  pickFinite(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number)) {
        return number;
      }
    }
    return null;
  },
  BROWSER_SEEK_PRIORITY_WINDOW_SECONDS: 30,
  BROWSER_SEEK_PRIORITY_OVERLAP_SECONDS: 5,
  BROWSER_PLAYBACK_PRIORITY_STEP_SECONDS: 10,
  formatVttTimestamp(value) {
    return String(value);
  },
  Number,
  Math,
  Date,
  MESSAGE: { OFFSCREEN_WEB_FFMPEG_PRIORITY: "priority" },
  chrome: { runtime: { sendMessage: () => Promise.resolve({ ok: true }) } },
  Set,
  Map
};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.seekApi = { sortBrowserQueueForSeek, browserSeekQueueItemPriority, followBrowserPreloadPlayback };`, context);
const { sortBrowserQueueForSeek, browserSeekQueueItemPriority, followBrowserPreloadPlayback } = context.seekApi;

test("seek priority puts the current and next 30 seconds first", () => {
  const queue = {
    items: [
      { start: 120, end: 135 },
      { start: 12, end: 20 },
      { start: 100, end: 110 },
      { start: 80, end: 90 }
    ]
  };
  sortBrowserQueueForSeek(queue, 105);
  assert.deepEqual(queue.items.map(item => item.start), [100, 120, 80, 12]);
  assert.equal(browserSeekQueueItemPriority({ start: 100, end: 110 }, 105).rank, 0);
  assert.equal(browserSeekQueueItemPriority({ start: 120, end: 135 }, 105).rank, 0);
  assert.equal(browserSeekQueueItemPriority({ start: 80, end: 90 }, 105).rank, 2);
});

test("a chunk overlapping the seek point beats a merely nearby future chunk", () => {
  const queue = {
    items: [
      { chunk: { start: 130, end: 145 } },
      { chunk: { start: 98, end: 108 } }
    ]
  };
  sortBrowserQueueForSeek(queue, 105);
  assert.deepEqual(queue.items.map(item => item.chunk.start), [98, 130]);
});

test("a chunk beginning at zero still counts as covering the seek point", () => {
  const queue = { items: [{ start: 120, end: 135 }, { start: 0, end: 300 }] };
  sortBrowserQueueForSeek(queue, 100);
  assert.equal(queue.items[0].start, 0);
});

test("playback advances the ahead window without reordering on every progress update", () => {
  const events = [];
  const record = {
    job: { id: "media-job", extract: {}, translation: {} },
    browserAsrQueue: { items: [{ start: 80, end: 90 }, { start: 100, end: 110 }] }
  };
  context.findBrowserPreloadRecord = () => record;
  context.isActiveCurrentBrowserPreloadRecord = () => true;
  context.ensureBrowserChunkPipelineState = () => {};
  context.recordBrowserDiagnostic = (_record, event) => events.push(event);
  context.publishBrowserPreloadJob = () => {};
  context.wakeOffscreenBrowserJob = () => Promise.resolve();
  assert.equal(followBrowserPreloadPlayback(1, 80), true);
  assert.deepEqual(record.browserAsrQueue.items.map(item => item.start), [80, 100]);
  assert.equal(followBrowserPreloadPlayback(1, 89), false);
  assert.equal(followBrowserPreloadPlayback(1, 90), true);
  assert.equal(record.seekPriority.time, 90);
  assert.deepEqual(events, ["media_playback_priority", "media_playback_priority"]);
});
