import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/sidepanel/capture-worklet.js", import.meta.url), "utf8");

function loadProcessor(inputSampleRate) {
  const messages = [];
  class ProcessorBase {
    constructor() {
      this.port = {
        postMessage(buffer) {
          messages.push(buffer);
        }
      };
    }
  }
  const context = {
    sampleRate: inputSampleRate,
    AudioWorkletProcessor: ProcessorBase,
    registerProcessor(name, processor) {
      context.processorName = name;
      context.processor = processor;
    }
  };
  vm.runInNewContext(source, context);
  return { capture: new context.processor(), messages, name: context.processorName };
}

test("capture worklet resamples 48 kHz input to 16 kHz PCM", () => {
  const { capture, messages, name } = loadProcessor(48000);
  assert.equal(name, "fuguang-capture");
  const input = new Float32Array(6144);
  input.fill(0.25);
  assert.equal(capture.process([[input]]), true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].byteLength, 2048 * 2);
  const output = new Int16Array(messages[0]);
  assert.equal(output.length, 2048);
  assert.equal(output[0], Math.round(0.25 * 32767));
});

test("capture worklet keeps fractional resampling state between render quanta", () => {
  const { capture, messages } = loadProcessor(44100);
  const first = new Float32Array(441);
  const second = new Float32Array(441);
  first.fill(0.1);
  second.fill(0.2);
  assert.equal(capture.process([[first]]), true);
  assert.equal(capture.process([[second]]), true);
  const produced = messages.reduce((count, buffer) => count + buffer.byteLength / 2, 0) + capture.length;
  assert.ok(produced >= 318 && produced <= 322);
});
