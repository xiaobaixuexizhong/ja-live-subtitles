import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const serviceWorkerSource = readFileSync(
  new URL("../src/background/service-worker.js", import.meta.url),
  "utf8"
);
const serviceWorkerContext = {
  BROWSER_ASR_UPLOAD_CHUNK_SECONDS: 45,
  BROWSER_ASR_MIN_UPLOAD_CHUNK_SECONDS: 30,
  BROWSER_ASR_MAX_UPLOAD_WINDOW_SECONDS: 60,
  DEFAULT_BROWSER_TRANSLATION_GROUP_SECONDS: 60,
  MIN_BROWSER_TRANSLATION_GROUP_SECONDS: 30,
  MAX_BROWSER_TRANSLATION_GROUP_SECONDS: 90
};
const asrStart = serviceWorkerSource.indexOf("function browserAsrUploadChunkSeconds(");
const asrEnd = serviceWorkerSource.indexOf("async function browserAsrEffectiveUploadChunkSeconds(", asrStart);
const translationStart = serviceWorkerSource.indexOf("function browserTranslationSegmentSeconds(");
const translationEnd = serviceWorkerSource.indexOf("function browserTranslationBatchWorkers(", translationStart);
const workerStart = serviceWorkerSource.indexOf("function browserEndpointIsLocal(");
const workerEnd = serviceWorkerSource.indexOf("function roundTime(", workerStart);
assert.ok(asrStart >= 0 && asrEnd > asrStart);
assert.ok(translationStart >= 0 && translationEnd > translationStart);
assert.ok(workerStart >= 0 && workerEnd > workerStart);
vm.runInNewContext(
  `${serviceWorkerSource.slice(asrStart, asrEnd)}\n${serviceWorkerSource.slice(translationStart, translationEnd)}\nglobalThis.asr = browserAsrUploadChunkSeconds;\nglobalThis.translation = browserTranslationSegmentSeconds;`,
  serviceWorkerContext
);
const workerContext = {
  URL,
  normalizeApiBaseUrl: value => String(value || "").replace(/\/+$/, ""),
  browserFunAsrConcurrency: () => 1
};
vm.runInNewContext(
  `${serviceWorkerSource.slice(workerStart, workerEnd)}\nglobalThis.workerCount = browserAsrWorkerCount;`,
  workerContext
);

test("ASR upload windows stay in the 30-60 second live range", () => {
  assert.equal(serviceWorkerContext.asr({}), 45);
  assert.equal(serviceWorkerContext.asr({ chunkSeconds: 300 }), 45);
  assert.equal(serviceWorkerContext.asr({ asrUploadChunkSeconds: 30 }), 30);
  assert.equal(serviceWorkerContext.asr({ asrUploadChunkSeconds: 90 }), 60);
});

test("translation groups default to 60 seconds and clamp to 30-90 seconds", () => {
  assert.equal(serviceWorkerContext.translation({}), 60);
  assert.equal(serviceWorkerContext.translation({ modelConfig: { chunkSeconds: 45 } }), 45);
  assert.equal(serviceWorkerContext.translation({ modelConfig: { chunkSeconds: 300 } }), 90);
  assert.equal(serviceWorkerContext.translation({ modelConfig: { chunkSeconds: 10 } }), 30);
});

test("remote ASR uses two workers while local ASR stays serialized", () => {
  assert.equal(workerContext.workerCount({ modelConfig: { asr: { baseUrl: "http://127.0.0.1:8766/v1" } } }), 1);
  assert.equal(workerContext.workerCount({ modelConfig: { asr: { baseUrl: "https://api.example.test/v1" } } }), 2);
  assert.equal(workerContext.workerCount({ modelConfig: { asrWorkers: 3, asr: { baseUrl: "https://api.example.test/v1" } } }), 3);
});

const providerSource = readFileSync(
  new URL("../src/background/browser-translation-provider.js", import.meta.url),
  "utf8"
);
const repairableStart = providerSource.indexOf("function browserTranslationHttpErrorIsBatchSizeRepairable(");
const repairableEnd = providerSource.indexOf("function normalizeTimeoutMs(", repairableStart);
assert.ok(repairableStart >= 0 && repairableEnd > repairableStart);
const providerContext = {};
vm.runInNewContext(
  `${providerSource.slice(repairableStart, repairableEnd)}\nglobalThis.repairable = browserTranslationHttpErrorIsBatchSizeRepairable;`,
  providerContext
);

test("HTTP 412 is treated as a batch-size repairable translation error", () => {
  assert.equal(providerContext.repairable(412, "precondition failed"), true);
  assert.equal(providerContext.repairable(413, "payload too large"), true);
  assert.equal(providerContext.repairable(500, "server error"), false);
});
