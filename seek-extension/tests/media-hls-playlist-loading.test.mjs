import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/offscreen/offscreen.js", import.meta.url), "utf8");

test("HLS fetch deadline aborts a stalled playlist request", async () => {
  const start = source.indexOf("async function withMediaFetchDeadline(");
  const end = source.indexOf("async function withMediaFetchRetry(", start);
  assert.ok(start >= 0 && end > start);
  const context = {
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  };
  vm.runInNewContext(`${source.slice(start, end)}
    globalThis.fetchWithDeadline = withMediaFetchDeadline;`, context);
  await assert.rejects(
    context.fetchWithDeadline("https://cdn.test/playlist.m3u8", {}, 10, response => response.text()),
    /请求超时/
  );
});

test("a timed-out playlist request is eligible for one bounded retry", () => {
  const start = source.indexOf("function isRetryableMediaFetchError(");
  const end = source.indexOf("async function resolveInitialHlsPlaylist(", start);
  const context = {};
  vm.runInNewContext(`${source.slice(start, end)}
    globalThis.retryable = isRetryableMediaFetchError;`, context);
  assert.equal(context.retryable(new Error("请求超时（12 秒）")), true);
});

test("HLS loading reads the selected playlist before probing audio companions", async () => {
  const start = source.indexOf("async function resolveInitialHlsPlaylist(");
  const end = source.indexOf("async function fetchFirstUsableAudioCompanionPlaylist(", start);
  assert.ok(start >= 0 && end > start);
  const requested = [];
  const context = {
    originalHlsSourceUrl: () => "",
    normalizeHttpUrlList: () => [],
    uniqueHttpUrls: values => values,
    updateMediaHeaderRuleDomains: async () => {},
    fetchText: async url => {
      requested.push(url);
      return "#EXTM3U\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST";
    },
    hlsPlaylistIsClearlyVideoOnly: () => false,
    fetchFirstUsableAudioCompanionPlaylist: () => { throw new Error("unexpected companion fetch"); },
    fetchVideoTwimgPageMasterPlaylist: () => { throw new Error("unexpected fallback fetch"); }
  };
  vm.runInNewContext(`${source.slice(start, end)}
    globalThis.resolve = resolveInitialHlsPlaylist;`, context);
  const url = "https://cdn.test/movie.m3u8";
  const helpers = { buildLikelyAudioCompanionPlaylistUrls: () => ["https://cdn.test/audio.m3u8"] };
  const result = await context.resolve({ sourceUrl: url }, {}, helpers);
  assert.equal(result.url, url);
  assert.deepEqual(requested, [url]);
});

test("a known video-only playlist still falls back to an audio companion", async () => {
  const start = source.indexOf("async function resolveInitialHlsPlaylist(");
  const end = source.indexOf("async function fetchFirstUsableAudioCompanionPlaylist(", start);
  const selectedUrl = "https://cdn.test/video.m3u8";
  const audioUrl = "https://cdn.test/audio.m3u8";
  let companionTried = false;
  const context = {
    originalHlsSourceUrl: () => "",
    normalizeHttpUrlList: () => [],
    uniqueHttpUrls: values => values,
    updateMediaHeaderRuleDomains: async () => {},
    fetchText: async () => "#EXTM3U\n#EXTINF:5,\nvideo.m4s",
    hlsPlaylistIsClearlyVideoOnly: () => true,
    fetchFirstUsableAudioCompanionPlaylist: async () => {
      companionTried = true;
      return { url: audioUrl, text: "#EXTM3U\n#EXTINF:5,\naudio.m4s" };
    },
    fetchVideoTwimgPageMasterPlaylist: () => null
  };
  vm.runInNewContext(`${source.slice(start, end)}
    globalThis.resolve = resolveInitialHlsPlaylist;`, context);
  const helpers = { buildLikelyAudioCompanionPlaylistUrls: () => [audioUrl] };
  const result = await context.resolve({ sourceUrl: selectedUrl }, {}, helpers);
  assert.equal(companionTried, true);
  assert.equal(result.url, audioUrl);
});
