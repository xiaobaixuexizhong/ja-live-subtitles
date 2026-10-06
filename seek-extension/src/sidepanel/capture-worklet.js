class FuguangCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Int16Array(2048);
    this.length = 0;
    this.targetSampleRate = 16000;
    this.inputSampleRate = typeof sampleRate === "number" && sampleRate > 0
      ? sampleRate
      : this.targetSampleRate;
    this.step = this.inputSampleRate / this.targetSampleRate;
    this.resampleBuffer = [];
    this.resamplePosition = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const frameCount = channels[0]?.length || 0;
    if (!frameCount) return true;
    for (let index = 0; index < frameCount; index += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] / channels.length;
      this.resampleBuffer.push(Math.max(-1, Math.min(1, sample)));
    }
    while (this.resamplePosition + 1 < this.resampleBuffer.length) {
      const index = Math.floor(this.resamplePosition);
      const fraction = this.resamplePosition - index;
      const first = this.resampleBuffer[index];
      const second = this.resampleBuffer[index + 1];
      this.writeSample(first + (second - first) * fraction);
      this.resamplePosition += this.step;
    }
    const consumed = Math.floor(this.resamplePosition);
    if (consumed > 0) {
      this.resampleBuffer = this.resampleBuffer.slice(consumed);
      this.resamplePosition -= consumed;
    }
    return true;
  }

  writeSample(sample) {
    this.pending[this.length++] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
    if (this.length !== this.pending.length) return;
    const data = this.pending.buffer;
    this.port.postMessage(data, [data]);
    this.pending = new Int16Array(2048);
    this.length = 0;
  }
}

registerProcessor("fuguang-capture", FuguangCaptureProcessor);
