class AudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0].length;
    const pcm = new ArrayBuffer(length * 2);
    const view = new DataView(pcm);
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    this.port.postMessage(pcm, [pcm]);
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
