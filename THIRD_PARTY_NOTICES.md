# Third-party components

The repository license does not replace the licenses of bundled third-party components.

| Component | Location | License and source |
| --- | --- | --- |
| Original Liusheng Subtitles code | `seek-extension/` (excluding separately listed vendor code) | [MIT](seek-extension/LICENSE), [upstream](https://github.com/Liu-Bot24/liusheng-subtitles) |
| Mediabunny | `seek-extension/src/vendor/mediabunny/` | [MPL-2.0](seek-extension/src/vendor/mediabunny/LICENSE), [source](https://github.com/Vanilagy/mediabunny) |
| ffmpeg.wasm JavaScript wrapper | `seek-extension/web-ffmpeg/vendor/@ffmpeg/ffmpeg/` | [MIT](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/LICENSE), [source](https://github.com/ffmpegwasm/ffmpeg.wasm) |
| FFmpeg WebAssembly core 0.12.10 | `seek-extension/web-ffmpeg/vendor/@ffmpeg/core/` | [GPL-2.0-or-later package metadata](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v12.15/packages/core/package.json), [corresponding source and build scripts](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15) |

The bundled `ffmpeg-core.wasm` has SHA-256 `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7`, matching the official `@ffmpeg/core@0.12.10` ESM package. The bundled core JavaScript has the same content with different line endings. The FFmpeg WebAssembly core contains compiled FFmpeg code; its GPL license and corresponding source requirements also apply when redistributing a packaged extension. Downloaded Whisper, ChickenRice, Ollama model weights and machine-specific runtime binaries are not included in this repository; obtain them from their respective publishers under their own terms.

The optional `chickenrice_server.py` adapter imports `faster_whisper_transwithai_chickenrice` from the separately installed [Faster-Whisper-TransWithAI-ChickenRice](https://github.com/TransWithAI/Faster-Whisper-TransWithAI-ChickenRice) runtime. Its source and runtime are not bundled here. [MaiSubtitle](https://github.com/OatmeaILL/MaiSubtitle) and [sherpa-live-sub](https://github.com/does00/sherpa-live-sub) are acknowledged in the README as references; no source files from those projects are included in this repository.
