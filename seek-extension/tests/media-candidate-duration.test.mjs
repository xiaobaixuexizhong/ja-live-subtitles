import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { FuguangHlsManifestParser } from "../src/background/hls-manifest-parser.js";
import { FuguangBrowserMediaCandidates } from "../src/background/browser-media-candidates.js";

const worker = readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
const mediaCandidates = readFileSync(new URL("../src/background/browser-media-candidates.js", import.meta.url), "utf8");
const start = worker.indexOf("async function probeHlsCandidateDuration(");
const end = worker.indexOf("async function fetchHlsCandidatePlaylist(", start);
assert.ok(start >= 0 && end > start);

const playlists = new Map();
const context = {
  FuguangHlsManifestParser,
  fetchHlsCandidatePlaylist: async url => playlists.get(url) || ""
};
vm.runInNewContext(`${worker.slice(start, end)}
  globalThis.probe = probeHlsCandidateDuration;`, context);

test("HLS candidate duration follows a master playlist to the VOD audio playlist", async () => {
  playlists.set("https://example.test/master.m3u8", `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Japanese",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="audio"
video.m3u8`);
  playlists.set("https://example.test/audio.m3u8", `#EXTM3U
#EXTINF:4.5,
first.ts
#EXTINF:5.5,
second.ts
#EXT-X-ENDLIST`);
  assert.equal(await context.probe({ url: "https://example.test/master.m3u8" }), 10);
});

test("HLS candidate does not present a live playlist window as full duration", async () => {
  playlists.set("https://example.test/live.m3u8", `#EXTM3U
#EXTINF:6,
segment.ts`);
  assert.equal(await context.probe({ url: "https://example.test/live.m3u8" }), null);
});

test("an unrelated short player clip does not set the HLS candidate duration", () => {
  const start = mediaCandidates.indexOf("function shouldInheritPageDuration(");
  const end = mediaCandidates.indexOf("function isLowConfidenceDirectAudioCandidate(", start);
  assert.ok(start >= 0 && end > start);
  const candidateContext = { isIgnoredMediaUrl: () => false };
  vm.runInNewContext(`${mediaCandidates.slice(start, end)}
    globalThis.inheritDuration = shouldInheritPageDuration;`, candidateContext);
  const candidate = { kind: "hls", source: "fetch-body", url: "https://example.test/video.m3u8" };
  assert.equal(candidateContext.inheritDuration(candidate, "", {}, {
    context: { duration: 6, currentSrc: "https://example.test/ad.mp4" }
  }), false);
  assert.equal(candidateContext.inheritDuration(candidate, "", {}, {
    context: { duration: 4095, currentSrc: "https://example.test/video.mp4" }
  }), true);
});

test("candidate list probes a raw HLS source even when page context supplies a duration", () => {
  const start = worker.indexOf("function getDisplayCandidates(");
  const end = worker.indexOf("function setTabStatus(", start);
  assert.ok(start >= 0 && end > start);
  const hlsUrl = "https://example.test/video.m3u8";
  const mp4Url = "https://example.test/ad.mp4";
  const state = {
    candidates: [{ url: hlsUrl }, { url: mp4Url, duration: 6 }],
    noAudioCandidateUrls: new Set([mp4Url])
  };
  const probes = [];
  const candidateContext = {
    getState: () => state,
    getGroupedCandidatesForState: () => [
      { url: hlsUrl, kind: "hls", duration: 6 },
      { url: mp4Url, kind: "video", duration: 6 }
    ],
    stripCandidateRequestHeaders: candidate => candidate,
    scheduleHlsCandidateDurationProbe: (_tabId, _state, candidate) => probes.push(candidate)
  };
  vm.runInNewContext(`${worker.slice(start, end)}
    globalThis.displayCandidates = getDisplayCandidates;`, candidateContext);
  const displayed = candidateContext.displayCandidates(1);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].duration, null);
  assert.equal(displayed[1].noAudioTrack, true);
});

test("a timed HLS variant keeps its family grouped and supplies the displayed duration", () => {
  const state = {
    page: { url: "https://example.test/watch/1", title: "Video" },
    context: { href: "https://example.test/watch/1" },
    candidates: [
      { url: "https://cdn.test/master/movie_160p_blurred.m3u8", kind: "hls", ext: "m3u8", seenAt: 2 },
      { url: "https://cdn.test/master/movie_240p_blurred.m3u8", kind: "hls", ext: "m3u8", duration: 3600, seenAt: 1 }
    ]
  };
  const grouped = FuguangBrowserMediaCandidates.getGroupedCandidatesForState(state);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].duration, 3600);
  assert.equal(grouped[0].hiddenCount, 1);
});

test("the selected source keeps its shown duration when page context changes", () => {
  const start = worker.indexOf("function getDisplayCandidates(");
  const end = worker.indexOf("function setTabStatus(", start);
  const selectedUrl = "https://cdn.test/video.m3u8";
  const otherUrl = "https://cdn.test/other.m3u8";
  const state = {
    candidates: [{ url: selectedUrl }, { url: otherUrl }],
    lastPreloadCandidate: { url: selectedUrl, duration: 3600 },
    noAudioCandidateUrls: new Set()
  };
  const candidateContext = {
    getState: () => state,
    getGroupedCandidatesForState: () => [
      { url: selectedUrl, kind: "hls", duration: null },
      { url: otherUrl, kind: "hls", duration: null }
    ],
    stripCandidateRequestHeaders: candidate => candidate,
    scheduleHlsCandidateDurationProbe: () => {}
  };
  vm.runInNewContext(`${worker.slice(start, end)}
    globalThis.displayCandidates = getDisplayCandidates;`, candidateContext);
  const displayed = candidateContext.displayCandidates(1);
  assert.equal(displayed[0].duration, 3600);
  assert.equal(displayed[1].duration, null);
});
