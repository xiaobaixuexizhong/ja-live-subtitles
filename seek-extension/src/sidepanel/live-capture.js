const FuguangLiveCapture = (() => {
  const SAMPLE_RATE = 16000;
  // End a window at a natural pause when possible. A hard maximum keeps the
  // live path bounded if music or background noise prevents silence detection.
  const MIN_CHUNK_SECONDS = 2;
  // Submit a short first window after startup/seek so the first subtitle does
  // not wait for a full continuous-speech window.
  const FAST_CHUNK_SECONDS = 3;
  const MAX_CHUNK_SECONDS = 6;
  const OVERLAP_SECONDS = 0.6;
  const SILENCE_SECONDS = 0.5;
  const QUIET_RMS = 250;
  const MIN_RMS = 30;
  const MAX_PENDING_CHUNKS = 4;
  const MAX_PENDING_TRANSLATIONS = 12;
  const AUDIO_STALL_MS = 3000;

  function wavFromPcm(parts, sampleCount) {
    const output = new Uint8Array(44 + sampleCount * 2);
    const view = new DataView(output.buffer);
    const label = (offset, value) => {
      for (let index = 0; index < value.length; index += 1) output[offset + index] = value.charCodeAt(index);
    };
    label(0, "RIFF");
    view.setUint32(4, output.length - 8, true);
    label(8, "WAVE");
    label(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    label(36, "data");
    view.setUint32(40, sampleCount * 2, true);
    let offset = 44;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return Array.from(output);
  }

  function trailingPcm(parts, maxSamples) {
    const tail = [];
    let remaining = maxSamples;
    for (let index = parts.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const part = parts[index];
      const samples = Math.min(remaining, part.byteLength / 2);
      tail.unshift(part.slice(part.byteLength - samples * 2));
      remaining -= samples;
    }
    return { parts: tail, sampleCount: maxSamples - remaining };
  }

  function shouldRefinePrevious(previous, current) {
    const oldSegment = previous?.source?.[0];
    const newSegment = current?.source?.[0];
    if (!oldSegment || !newSegment || previous.chunk.generation !== current.chunk.generation) return false;
    if (/[。！？.!?…]$/u.test(String(oldSegment.text || "").trim())) return false;
    const gap = Number(newSegment.start) - Number(oldSegment.end);
    return Number.isFinite(gap) && gap >= -1 && gap <= 1.5;
  }

  class Capture {
    constructor(options) {
      this.options = options;
      this.active = false;
      this.parts = [];
      this.sampleCount = 0;
      this.pending = [];
      this.translationPending = [];
      this.chunkIndex = 0;
      this.quietSamples = 0;
      this.lastState = null;
      this.generation = 0;
      this.fastFlushPending = true;
      this.overlapSampleCount = 0;
      this.lastRecognized = null;
      this.processing = false;
      this.translating = false;
      this.stopping = false;
      this.audioMuted = false;
      this.captureSampleRate = SAMPLE_RATE;
      this.lastPcmAt = 0;
      this.audioStallReported = false;
      this.resetPromise = Promise.resolve();
    }

    async start(mode, tabId, language, jobId) {
      if (this.active) throw new Error("采集正在运行。");
      if (!["tab", "system"].includes(mode)) throw new Error("无效的采集方式。");
      this.mode = mode;
      this.tabId = tabId;
      this.language = language;
      this.jobId = jobId;
      this.stopping = false;
      this.audioMuted = false;
      this.lastPcmAt = performance.now();
      this.audioStallReported = false;
      let stream;
      if (mode === "tab") {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
          video: false
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "monitor" },
          audio: true,
          systemAudio: "include",
          monitorTypeSurfaces: "include",
          selfBrowserSurface: "exclude"
        });
        if (stream.getVideoTracks()[0]?.getSettings()?.displaySurface !== "monitor") {
          stream.getTracks().forEach(track => track.stop());
          throw new Error("系统声音捕获需选择整个屏幕，并勾选共享系统音频。");
        }
      }
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error("未获取到音频轨，请确认媒体正在播放并允许共享音频。");
      }
      this.stream = stream;
      try {
        const state = await this.options.getVideoState(tabId);
        if (!state || state.synthetic || !Number.isFinite(Number(state.currentTime))) {
          throw new Error("当前标签页没有可同步的播放器。");
        }
        this.lastState = { ...state, observedAt: performance.now() };
        this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
        this.captureSampleRate = Number(this.context.sampleRate) || SAMPLE_RATE;
        if (Math.abs(this.captureSampleRate - SAMPLE_RATE) > 1) {
          this.options.onEvent(
            "capture_sample_rate",
            "info",
            `浏览器采样率 ${this.captureSampleRate}Hz，已重采样到 ${SAMPLE_RATE}Hz`
          );
        }
        await this.context.audioWorklet.addModule(chrome.runtime.getURL("src/sidepanel/capture-worklet.js"));
        this.source = this.context.createMediaStreamSource(stream);
        this.processor = new AudioWorkletNode(this.context, "fuguang-capture");
        this.silent = this.context.createGain();
        this.silent.gain.value = 0;
        this.source.connect(this.processor);
        this.processor.connect(this.silent);
        this.silent.connect(this.context.destination);
        this.processor.port.onmessage = event => this.receivePcm(event.data);
        if (mode === "tab") {
          this.playbackContext = new AudioContext();
          this.playbackContext.createMediaStreamSource(stream).connect(this.playbackContext.destination);
          await this.playbackContext.resume();
        }
        this.active = true;
        this.lastPcmAt = performance.now();
        this.audioStallReported = false;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener("ended", () => { void this.stop("音频共享已结束"); }, { once: true });
          track.addEventListener("mute", () => {
            this.audioMuted = true;
            this.options.onEvent("capture_audio_muted", "warning", "系统音频轨暂时静音，等待恢复。");
          });
          track.addEventListener("unmute", () => {
            this.audioMuted = false;
            this.fastFlushPending = true;
            this.options.onEvent("capture_audio_unmuted", "info", "系统音频轨已恢复。");
          });
        }
        if (mode === "system") {
          stream.getVideoTracks()[0]?.addEventListener("ended", () => { void this.stop("屏幕共享已结束"); }, { once: true });
        }
        await this.context.resume();
        this.pollTimer = window.setInterval(() => this.pollVideoState(), 350);
        this.options.onEvent("capture_started", "info", `${mode}, ${language}`);
      } catch (error) {
        await this.closeMedia();
        throw error;
      }
    }

    receivePcm(buffer) {
      if (!this.active || !(buffer instanceof ArrayBuffer)) return;
      this.lastPcmAt = performance.now();
      this.audioStallReported = false;
      if (this.lastState?.paused) return;
      const part = new Uint8Array(buffer);
      const pcm = new Int16Array(part.buffer, part.byteOffset, part.byteLength / 2);
      let energy = 0;
      for (let index = 0; index < pcm.length; index += 1) energy += pcm[index] * pcm[index];
      const frameRms = Math.sqrt(energy / Math.max(1, pcm.length));
      this.parts.push(part);
      this.sampleCount += pcm.length;
      this.quietSamples = frameRms < QUIET_RMS ? this.quietSamples + pcm.length : 0;
      const duration = this.sampleCount / SAMPLE_RATE;
      const targetSeconds = this.fastFlushPending ? FAST_CHUNK_SECONDS : MAX_CHUNK_SECONDS;
      if (
        duration >= targetSeconds ||
        (duration >= MIN_CHUNK_SECONDS && this.quietSamples >= SILENCE_SECONDS * SAMPLE_RATE)
      ) {
        this.flushChunk();
      }
    }

    async pollVideoState() {
      if (!this.active || this.polling) return;
      this.polling = true;
      try {
        await this.resumeAudioContext();
        const audioStalled = !this.audioMuted
          && this.lastPcmAt > 0
          && performance.now() - this.lastPcmAt >= AUDIO_STALL_MS;
        if (audioStalled && !this.audioStallReported) {
          this.audioStallReported = true;
          this.options.onEvent("capture_audio_stalled", "warning", "共享音频轨暂时没有送出音频帧，正在尝试恢复。");
          await this.resumeAudioContext();
        }
        const state = await this.options.getVideoState(this.tabId);
        if (!state || state.synthetic || !Number.isFinite(Number(state.currentTime))) {
          this.stop("播放器已离开当前页面");
          return;
        }
        const now = performance.now();
        const previous = this.lastState;
        const rate = Number(previous?.playbackRate) || 1;
        const expected = Number(previous?.currentTime) + (previous?.paused ? 0 : (now - previous.observedAt) / 1000 * rate);
        const seeked = previous && Math.abs(Number(state.currentTime) - expected) > 1.3;
        if (seeked || (previous && Math.abs((Number(state.playbackRate) || 1) - rate) > 0.01)) {
          this.parts = [];
          this.sampleCount = 0;
          this.overlapSampleCount = 0;
          this.quietSamples = 0;
          this.generation += 1;
          const dropped = this.pending.length;
          const droppedTranslations = this.translationPending.length;
          this.pending = [];
          this.translationPending = [];
          this.fastFlushPending = true;
          this.lastRecognized = null;
          if (dropped) {
            this.options.onEvent("capture_queue_reset", "info", `已丢弃拖动前待处理片段: ${dropped}`);
          }
          if (droppedTranslations) {
            this.options.onEvent("capture_translation_queue_reset", "info", `已丢弃拖动前待翻译片段: ${droppedTranslations}`);
          }
          this.resetPromise = Promise.resolve(
            this.options.onEvent("capture_seek_reset", "info", `video=${Number(state.currentTime).toFixed(2)}s`)
          ).catch(() => {});
        } else if (state.paused && previous && !previous.paused && this.sampleCount >= SAMPLE_RATE) {
          this.flushChunk();
        } else if (state.paused) {
          this.parts = [];
          this.sampleCount = 0;
          this.overlapSampleCount = 0;
          this.quietSamples = 0;
        }
        this.lastState = { ...state, observedAt: now };
      } catch (error) {
        this.options.onEvent("capture_state_error", "warning", error?.message || String(error));
      } finally {
        this.polling = false;
      }
    }

    async resumeAudioContext() {
      if (!this.context || this.context.state === "closed" || this.context.state === "running") return;
      try {
        await this.context.resume();
        this.options.onEvent("capture_context_resumed", "info", "音频处理上下文已恢复。");
      } catch (error) {
        this.options.onEvent("capture_context_resume_failed", "warning", error?.message || String(error));
      }
    }

    async flushChunk() {
      if (!this.sampleCount) return;
      const parts = this.parts;
      const sampleCount = this.sampleCount;
      const overlapSampleCount = this.overlapSampleCount;
      const generation = this.generation;
      const carry = trailingPcm(parts, Math.min(sampleCount, Math.round(OVERLAP_SECONDS * SAMPLE_RATE)));
      this.parts = carry.parts;
      this.sampleCount = carry.sampleCount;
      this.overlapSampleCount = carry.sampleCount;
      this.quietSamples = 0;
      this.fastFlushPending = false;
      const duration = sampleCount / SAMPLE_RATE;
      if (duration < 0.8) return;
      const state = await this.options.getVideoState(this.tabId).catch(() => null);
      if (!state || generation !== this.generation || !Number.isFinite(Number(state.currentTime))) return;
      const rate = Number(state.playbackRate) || 1;
      const videoStart = Math.max(0, Number(state.currentTime) - duration * rate);
      const energy = parts.reduce((sum, part) => {
        const pcm = new Int16Array(part.buffer, part.byteOffset, part.byteLength / 2);
        for (let index = 0; index < pcm.length; index += 1) sum += pcm[index] * pcm[index];
        return sum;
      }, 0);
      const rms = Math.sqrt(energy / sampleCount);
      if (rms < MIN_RMS) {
        this.options.onEvent(
          "capture_chunk_skipped",
          "info",
          `低音量片段已跳过: rms=${rms.toFixed(1)}, duration=${duration.toFixed(2)}s`
        );
        return;
      }
      if (this.pending.length >= MAX_PENDING_CHUNKS) {
        this.pending.shift();
        this.options.onEvent("capture_queue_overflow", "warning", "识别速度低于播放速度，已跳过最早的待处理片段。",
          { queueDepth: this.pending.length, droppedChunks: 1 });
      }
      this.pending.push({
        jobId: this.jobId,
        tabId: this.tabId,
        captureMode: this.mode,
        sourceLanguage: this.language,
        chunkIndex: this.chunkIndex++,
        generation,
        queuedAt: Date.now(),
        audioDuration: duration,
        overlapSeconds: overlapSampleCount / SAMPLE_RATE,
        videoStart,
        playbackRate: rate,
        audioBytes: wavFromPcm(parts, sampleCount)
      });
      this.processQueue();
    }

    async processQueue() {
      if (this.processing) return;
      this.processing = true;
      while (this.pending.length) {
        await this.resetPromise;
        if (!this.pending.length) break;
        const chunk = this.pending.shift();
        if (chunk.generation !== this.generation) {
          this.options.onEvent("capture_chunk_stale", "info", `已跳过拖动前片段 #${chunk.chunkIndex}`);
          continue;
        }
        this.options.onEvent("capture_chunk_processing", "info", `#${chunk.chunkIndex}, ${chunk.videoStart.toFixed(2)}s`);
        try {
          const result = await this.options.processChunk(chunk);
          if (chunk.generation !== this.generation) {
            this.options.onEvent("capture_chunk_stale", "info", `已丢弃拖动前结果 #${chunk.chunkIndex}`);
            continue;
          }
          if (result?.ok && result.source?.length) {
            try {
              await this.options.onResult(result, chunk);
            } catch (error) {
              this.options.onEvent("capture_source_display_failed", "warning", error?.message || String(error));
            }
            if (chunk.generation === this.generation) {
              this.enqueueTranslation(chunk, result.source);
              const current = { chunk, source: result.source };
              if (this.translationPending.length <= 1 && shouldRefinePrevious(this.lastRecognized, current)) {
                this.enqueueTranslation(this.lastRecognized.chunk, this.lastRecognized.source,
                  String(result.source[0].text || "").slice(0, 500));
              }
              this.lastRecognized = current;
            }
          } else if (!result?.ok) {
            this.options.onEvent("capture_chunk_failed", "error", result?.error || "识别请求失败");
          }
        } catch (error) {
          if (chunk.generation !== this.generation) {
            this.options.onEvent("capture_chunk_stale", "info", `已取消拖动前片段 #${chunk.chunkIndex}`);
            continue;
          }
          this.options.onEvent("capture_chunk_failed", "error", error?.message || String(error));
        }
      }
      this.processing = false;
    }

    enqueueTranslation(chunk, source, nextSource = "") {
      if (typeof this.options.translateChunk !== "function") return;
      if (this.translationPending.length >= MAX_PENDING_TRANSLATIONS) {
        const skipped = this.translationPending.shift();
        this.options.onEvent("capture_translation_queue_overflow", "warning",
          `翻译积压，片段 #${skipped.chunk.chunkIndex} 暂时只显示原文。`,
          { queueDepth: this.translationPending.length, droppedChunks: 1 });
      }
      this.translationPending.push({ chunk, source, nextSource, queuedAt: Date.now() });
      void this.processTranslationQueue();
    }

    async processTranslationQueue() {
      if (this.translating) return;
      this.translating = true;
      try {
        while (this.translationPending.length) {
          await this.resetPromise;
          if (!this.translationPending.length) break;
          const { chunk, source, nextSource, queuedAt } = this.translationPending.shift();
          if (chunk.generation !== this.generation) continue;
          try {
            const result = await this.options.translateChunk({
              jobId: chunk.jobId,
              chunkIndex: chunk.chunkIndex,
              captureMode: chunk.captureMode,
              sourceLanguage: chunk.sourceLanguage,
              audioDuration: chunk.audioDuration,
              source,
              nextSource,
              translationQueuedAt: queuedAt
            });
            if (chunk.generation !== this.generation) continue;
            if (result?.ok && result.translated?.length) {
              await this.options.onTranslation?.(
                { ...result, refinement: Boolean(nextSource) },
                nextSource ? { ...chunk, queuedAt } : chunk
              );
            } else if (!result?.ok || result?.translationFailed) {
              this.options.onEvent("capture_translation_failed", "warning", result?.error || "翻译失败，保留原文。");
            }
          } catch (error) {
            if (chunk.generation === this.generation) {
              this.options.onEvent("capture_translation_failed", "warning", error?.message || String(error));
            }
          }
        }
      } finally {
        this.translating = false;
      }
    }

    async stop(reason = "采集已停止") {
      if (!this.active || this.stopping) return;
      this.stopping = true;
      try {
        if (this.sampleCount >= SAMPLE_RATE) await this.flushChunk();
        this.active = false;
        this.generation += 1;
        this.translationPending = [];
        window.clearInterval(this.pollTimer);
        await this.closeMedia();
        this.options.onEvent("capture_stopped", "info", reason);
        this.options.onStop(reason);
      } finally {
        this.stopping = false;
      }
    }

    async closeMedia() {
      this.stream?.getTracks().forEach(track => track.stop());
      await Promise.allSettled([this.context?.close(), this.playbackContext?.close()].filter(Boolean));
      this.stream = null;
      this.context = null;
      this.playbackContext = null;
      this.source = null;
      this.processor = null;
      this.silent = null;
    }
  }

  return { create: options => new Capture(options), wavFromPcm };
})();
