import assert from "node:assert/strict";
import test from "node:test";
import { FuguangDiagnosticLog } from "../src/background/diagnostic-log.js";
import { FuguangJobContract } from "../src/shared/job-contract.js";

test("a sparse chunk status list can be mirrored", () => {
  const statuses = [];
  statuses[1] = null;
  statuses[2] = { index: 2, stage: "asr", sourceCount: 1 };
  const chunks = FuguangJobContract.createChunkLedgerEntries({
    runToken: "run-1",
    job: { id: "job-1", translation: { chunkStatuses: statuses } }
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 2);
  assert.equal(chunks[0].stage, "asr");
});

test("diagnostic logs are bounded, filterable, and redact media credentials", async () => {
  const log = FuguangDiagnosticLog.createMemory({ maxEntries: 3 });
  await log.append({ jobId: "first", event: "start" });
  await log.append({
    jobId: "second",
    event: "failure",
    message: "GET https://media.example/video.mp4?secure=private-signature Authorization: Bearer secret-token",
    stack: "Error at service-worker.js:3597; api_key=private-key",
    details: { sourceHost: "media.example", unexpectedSecret: "must-not-be-exported" }
  });
  await log.append({ jobId: "second", event: "retry" });
  await log.append({ jobId: "second", event: "done" });

  const events = await log.list();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(event => event.event), ["failure", "retry", "done"]);
  assert.equal((await log.list({ jobId: "first" })).length, 0);
  assert.equal((await log.list({ jobId: "second", limit: 1 }))[0].event, "done");
  const failed = events[0];
  assert.match(failed.message, /media\.example\/\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(failed), /private-signature|secret-token|private-key|must-not-be-exported/);
  assert.match(failed.stack, /service-worker\.js:3597/);
});

test("capture timing details survive diagnostic export", async () => {
  const log = FuguangDiagnosticLog.createMemory();
  await log.append({ jobId: "capture-1", event: "capture_source_published", details: {
    sourceKind: "tab", chunkIndex: 4, queueWaitMs: 170, asrMs: 550,
    sourceDisplayMs: 900, pageScheme: "https", unexpectedSecret: "private"
  } });
  const [event] = await log.list({ jobId: "capture-1" });
  assert.equal(event.details.queueWaitMs, 170);
  assert.equal(event.details.sourceDisplayMs, 900);
  assert.equal(event.details.pageScheme, "https");
  assert.equal(event.details.unexpectedSecret, undefined);
});
