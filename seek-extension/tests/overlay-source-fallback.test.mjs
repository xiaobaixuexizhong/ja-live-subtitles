import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
const start = source.indexOf("function browserJobAllowsOverlaySourceFallback(");
const end = source.indexOf("function browserVttAttachmentSignature(", start);
assert.ok(start >= 0 && end > start);
const context = {};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.allow = browserJobAllowsOverlaySourceFallback;`, context);

test("running media jobs allow source fallback on the overlay", () => {
  assert.equal(context.allow({ status: "running" }), true);
  assert.equal(context.allow({ status: "completed_with_warnings" }), true);
  assert.equal(context.allow({ status: "queued" }), false);
  assert.equal(context.allow({ status: "cancelled" }), false);
});
