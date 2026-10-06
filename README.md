# 流声字幕 · 本机版

日语或英语原声、没有字幕的在线视频，可用浏览器扩展生成简体中文字幕。当前扩展位于 `seek-extension/`，本地服务与启动脚本位于仓库根目录；`index.html` 和 `extension/` 是早期方案。项目基于 [流声字幕](https://github.com/Liu-Bot24/liusheng-subtitles) 修改，原始源码可从上游单独获取，本仓库不重复收录 `liusheng-source/` 检出。

## 首次安装

本项目在 Windows PowerShell、Chrome/Edge 和本机模型服务上开发。源码仓库**不包含**模型权重、Whisper 可执行文件、ChickenRice AMD/HIP 运行包或本机 API 密钥。

1. 安装 Python 3.10 至 3.12、Node.js 22+（运行测试时使用）、[Ollama](https://ollama.com/) 和 Chrome/Edge。用 `python -m pip install -r requirements.txt` 安装翻译桥依赖。
2. 从 [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 获取 Windows 版 `whisper-server.exe`，放到 `bin/whisper-1.8.4-windows-x64/`。将多语版 `ggml-small.bin` 放到 `models/`；英语可选 `ggml-small.en.bin`。下载模型时核对来源和校验值。
3. 在 Ollama 中自行准备 `hy-mt2:7b-q6_k`，英语翻译可选 `hy-mt2-fixed:1.8b-q8_0`。脚本只检查并预热已安装模型，不会下载模型。若使用其他模型，需要同步调整 `model-translation.ps1`、`app.py` 和扩展中的本地模型档案。
4. 在仓库根目录运行 `& .\start.ps1`，分别启动日语 Whisper ASR、翻译桥并预热日语翻译模型。首次启动前先确保 Ollama 可访问。脚本出错时查看 `logs/` 下对应的 `.err.log`。
5. 在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，指向本仓库的 `seek-extension/`。打开视频页面后点击扩展图标，在侧边栏选择媒体抽取或捕获方式并开始任务。

只使用在线 ASR/翻译时，无需启动对应本地模型；在扩展“设置”中配置服务地址、模型名和密钥。密钥保存在本机扩展存储，不应写入源码或提交到仓库。更详细的本地模型组合和限制见下文。

## 音频获取

侧边栏“音频获取方式”可选：

| 方式 | 工作过程 | 拖动后的行为 | 适用范围 |
| --- | --- | --- | --- |
| 媒体抽取 | 优先读取独立音轨；HLS、带时间戳的 DASH 和支持 HTTP Range 的直连媒体按时间窗逐段提取、识别及翻译 | 当前播放位置附近的尚未抽取片段优先处理；正常播放每推进约 10 秒更新优先窗口 | 媒体源可获取、未受 DRM 保护且片段时间戳可靠 |
| 标签页捕获 | 使用 Chrome `tabCapture` 采集当前标签页声音，按播放器时间生成字幕 | 丢弃拖动时未完成的音频窗口，从新位置继续识别 | 网站拒绝媒体抽取，但当前标签页可以播放音频 |
| 系统声音捕获 | Chrome 屏幕共享选“整个屏幕”和“共享系统音频” | 与标签页捕获相同 | 标签页捕获不可用，且浏览器提供系统音频轨 |

两种捕获模式边播放边处理，实时窗口优先在连续约 0.5 秒静音处提交，最短 2 秒；启动或拖动后首段约 3 秒提交，连续播放时最长 6 秒。相邻窗口保留约 0.6 秒音频重叠，并对边界重复识别的文字去重。浏览器实际音频上下文不是 16 kHz 时，AudioWorklet 会先重采样到 16 kHz 再生成 WAV，避免把 48 kHz 音频错误标记成 16 kHz。采集中的 AudioContext 被浏览器挂起时会自动尝试恢复；共享音频轨静音、恢复、停止和没有音频帧的停滞都会写入诊断日志。识别完成后先显示原文，翻译在独立队列中运行，完成后按片段编号更新同一条字幕；翻译失败时保留原文。翻译请求参考最近 45 秒内最多 8 个已识别窗口的原文及已完成译文，并传入设置中的术语表。使用本地翻译档案时，上一段未形成完整句子且下一段紧接，会用下一段原文修订上一条译文，不延迟首次显示；在线翻译不自动增加修订请求。背景噪声导致无法检测停顿时仍会按对应上限提交。检测到拖动后会清空旧位置的待识别与待翻译片段，并取消仍在执行的旧请求，丢弃拖动前返回的结果。待识别队列最多保留 4 段，待翻译队列最多保留 12 段；积压时保留已识别原文并记录跳过的译文。播放器暂停时停止收集；拖动或倍速改变时重置未提交音频。已完成字幕按视频时间保留，拖回旧位置可再次显示。捕获由侧边栏持有，关闭侧边栏会结束采集，但已生成字幕保留在浏览器缓存中。系统模式采集的是共享屏幕的混合系统声音，其他应用发声会干扰识别；Chrome 不提供音频轨时会明确报错。

媒体抽取任务会监听播放器的时间轴跳变。连续播放的正常时间推进（包括倍速播放）不会触发 seek；检测到约 3 秒且明显超出正常推进量的跳变后，任务会重新排序尚未开始的下载、抽取、ASR 与翻译窗口。正常播放每推进约 10 秒也会更新优先窗口；正在执行的请求会完成当前窗口后再切换位置。日志分别记录 `media_seek_priority` 和 `media_playback_priority`。识别窗口保持约 30～60 秒及媒体时间戳，避免把网络小切片当作独立短句识别。直连服务器不支持有效的 `206 Content-Range` 或音轨无法按范围定位时会明确报错，可改用标签页捕获；DASH 片段缺少可靠时间戳时仍使用原来的完整装配路径。若从同页媒体抽取切换到标签页或系统声音捕获，已完成且匹配当前媒体源的译文会先按原时间轴显示；捕获继续补未覆盖的片段。切换会停止原媒体任务，以免与实时捕获争用本地模型。

## 本地模型与脚本

默认配置按原声语言分别选模型；已在 RX 6800M、32 GB 内存的机器上测试：

| 原声 | ASR | 翻译 |
| --- | --- | --- |
| 日语 | Whisper small 多语版，`127.0.0.1:8766` | Hy-MT2 7B Q6_K，`127.0.0.1:8765` 翻译桥 |
| 英语 | Whisper small.en，`127.0.0.1:8768` | Hy-MT2 1.8B Q8_0，`127.0.0.1:8765` 翻译桥 |

`models/ggml-small.en.bin` 来自 [whisper.cpp 官方模型仓库](https://huggingface.co/ggerganov/whisper.cpp)，已按 SHA-256 `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` 校验。旧备选 `Itbanque/whisper-ja-zh-base` 在 `127.0.0.1:8767`，属于日语语音翻译模型，直接输出中文；仅支持日语且质量不稳定。

所有本地模型放在仓库的 `models/`，扩展和服务通过本机端口引用模型，不会把模型复制到 `seek-extension/`。`models/`、下载的运行包、日志和本机备份均被 Git 忽略。

### ChickenRice 模型分类

[ChickenRice 项目](https://github.com/TransWithAI/Faster-Whisper-TransWithAI-ChickenRice)包含不同用途的模型，不能把识别模型和语音翻译模型混为一谈：

| 类别 | 已安装模型 | 本机用途 |
| --- | --- | --- |
| 日语语音识别 | [TransWithAI/whisper-ja-1.5B-ct2](https://huggingface.co/TransWithAI/whisper-ja-1.5B-ct2) | 日语音频 → 日语文字；经 Hy-MT2 文本翻译成中文。API `127.0.0.1:8770` |
| 日语语音翻译 | [chickenrice0721/whisper-large-v2-translate-zh-v0.2-st-ct2](https://huggingface.co/chickenrice0721/whisper-large-v2-translate-zh-v0.2-st-ct2) | 日语音频 → 中文文字；调用 Whisper `translate` 任务，不再调用文本翻译模型。API `127.0.0.1:8771` |
| 日语文本翻译 | 已有 Hy-MT2 7B Q6_K | 仅用于“识别后文本翻译”路线 |
| 可选音声优化 VAD | [TransWithAI/Whisper-Vad-EncDec-ASMR-onnx](https://huggingface.co/TransWithAI/Whisper-Vad-EncDec-ASMR-onnx) | 独立判断语音片段，减少静音/音乐误识别；它不识别文字，也不翻译 |

模型分别保存在 `models/chickenrice-ja-asr`、`models/chickenrice-ja-audio-translation` 和 `models/chickenrice-vad`。下载模型后应按发布页校验主文件。ChickenRice 两个 API 依赖另行安装的 AMD/HIP 运行包；在启动前把 `$env:CHICKENRICE_RUNTIME_DIR` 设为其 `_internal` 目录。未设置时，脚本尝试仓库同级的 `Faster-Whisper-TransWithAI-ChickenRice/_internal`。该可选路线还需要 Python 3.10、`uvicorn`、`python-multipart`，以及与运行包匹配的 `faster-whisper`、NumPy 和 ONNX Runtime；具体安装方式以 [ChickenRice 项目](https://github.com/TransWithAI/Faster-Whisper-TransWithAI-ChickenRice) 为准。VAD 使用 CPU，随选中的 ChickenRice API 按需加载，没有独立服务。

侧边栏原声选“日语”后，“日语处理路线”可选：

1. “识别后文本翻译”：在设置中将“日语识别模型”选为“ChickenRice 日语原文识别 1.5B”，文本翻译模型仍选择 Hy-MT2 或在线翻译。先启动 `start-chickenrice-asr.ps1`，以及所选文本翻译服务。
2. “ChickenRice 语音翻译”：直接使用 8771 的语音翻译模型生成中文字幕。先启动 `start-chickenrice-translation.ps1`，无需启动日语文本翻译模型。英语继续沿用英语识别 + 文本翻译路线。

“音声优化 VAD”复选框仅在日语任务选用 ChickenRice 识别或语音翻译时可用。勾选后，API 先用独立 VAD 模型定位语音，再识别/翻译并恢复原视频时间戳；关闭时把原音频直接送入模型。VAD 可能漏掉短句或很轻的语音，遇到漏识别时可关闭后重新 ASR。两条路线都支持媒体抽取、标签页捕获和系统声音捕获，拖动行为遵循上面的音频获取规则。

| 服务 | 启动脚本 | 关闭脚本 |
| --- | --- | --- |
| 日语 ASR | `start-asr-ja.ps1` | `stop-asr-ja.ps1` |
| 英语 ASR | `start-asr-en.ps1` | `stop-asr-en.ps1` |
| ChickenRice 日语识别 | `start-chickenrice-asr.ps1` | `stop-chickenrice-asr.ps1` |
| ChickenRice 日语语音翻译 | `start-chickenrice-translation.ps1` | `stop-chickenrice-translation.ps1` |
| 日语直译备选 | `start-optional-direct.ps1` | `stop-optional-direct.ps1` |
| 日语翻译模型 | `start-translation-ja.ps1` | `stop-translation-ja.ps1` |
| 英语翻译模型 | `start-translation-en.ps1` | `stop-translation-en.ps1` |
| 翻译 API 桥 | `start-bridge.ps1` | `stop-bridge.ps1` |

在仓库根目录的 PowerShell 执行脚本，例如 `& .\start-chickenrice-asr.ps1`。`start.ps1` 启动日语 Whisper ASR、翻译桥和日语文本翻译模型；ChickenRice 两项按需单独启动，建议一次只加载其中一个，以免同时占用显存。使用英语再执行 `start-asr-en.ps1` 与 `start-translation-en.ps1`。执行翻译脚本前请先启动 Ollama；脚本只连接本机 Ollama，不会创建隐藏子进程，也不会自动下载模型。默认地址是 `http://127.0.0.1:11434`；使用自定义端口时，在启动脚本和翻译桥前设置 `$env:OLLAMA_BASE_URL = 'http://127.0.0.1:11500'`。关闭单个模型不会停止 Ollama 服务。翻译桥会检查 Ollama 是否可达，运行中的本机翻译请求遇到连接、超时或 5xx 会唤醒模型并自动重试两次。ASR 和翻译桥的日志写在 `logs/`，ChickenRice 服务分别写在 `logs/chickenrice-asr.*.log` 和 `logs/chickenrice-translation.*.log`；脚本只停止自己记录的进程。

## 扩展安装与使用

1. 在 Chrome/Edge 扩展页开启开发者模式，加载仓库中的 `seek-extension/`。已有该目录的扩展，点击“重新加载”以应用新权限和脚本。
2. 打开网页视频，播放几秒，点击扩展图标打开侧边栏。选择原音频“日语”或“英语”，目标固定“中文”。
3. 在“音频获取方式”选模式；日语可选处理路线并决定是否启用 VAD，然后点“开始”。媒体抽取需要先选媒体源；标签页捕获直接采集当前标签页。切换到其他网站后，如提示未授权，请在播放视频的标签页重新点击扩展图标，再点“开始采集”；`chrome://` 等 Chrome 内部页无法进行标签页捕获。系统声音捕获需要在共享窗口选整个屏幕并允许系统音频。
4. 继续用原网页播放器暂停、播放或拖动。侧边栏可切换译文/原文/双语、编辑时间和文字、导出 SRT。

“设置”中可新增或编辑 ASR 与翻译模型档案，再在“按语言选择模型”分别指定日语/英语所用档案。地址为 `127.0.0.1` 的档案使用本地模型；配置在线 OpenAI/Anthropic 兼容地址和密钥后，也可以单独为某种语言选择在线 ASR 或在线翻译。模型设置和 API 密钥保存在本机浏览器扩展存储中。媒体抽取与两种实时捕获使用相同档案。

## 日志与限制

侧边栏“导出日志”下载当前任务的 JSON 诊断日志，包含采集开始/停止、拖动重置、片段处理、ASR、翻译和失败事件。扩展只保留最近 2000 条；日志中的媒体 URL 参数与常见密钥在保存前会遮盖。查看本地服务错误可读 `logs/*.err.log`；ChickenRice 日志还记录 VAD 保留片段数、原音频时长和处理耗时。如需排查字幕遗漏，同时提供导出的日志、网站、时间点、处理路线及 VAD 开关状态。

DRM、加密媒体与网站跨域限制可能阻止媒体抽取；标签页/系统捕获可能仍可用，但受浏览器音频共享权限限制。系统声音模式只能跟随当前标签页的播放器时间，无法识别其他应用的播放进度。字幕准确率受音乐、人声重叠、专有名词和本地模型能力影响。当前方案的模型选择偏向本机已验证的响应速度；[Qwen3-ASR](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) 是更新的英日语候选，但尚未在此 Windows/AMD 机器上验证端到端延迟，故未设为默认。

## 测试、源码与许可

在仓库根目录运行 `node --test seek-extension/tests/*.test.mjs` 和 `python -m unittest discover -s tests -p test_translation_context.py`，分别检查扩展与翻译桥逻辑。可选的端到端测试 `test_pipeline.py` 需要先安装 `requirements-dev.txt`、在根目录自行提供 16 kHz 单声道的 `sample-ja.wav`，并启动本地 ASR、翻译桥及翻译模型。浏览器交互测试需要另行安装 Playwright 和浏览器；本机的 `seek-extension/tests/playwright-extension.config.json` 含绝对路径，因此不纳入仓库。

本仓库自有代码和从流声字幕改编的代码采用 [MIT 许可](LICENSE)；`seek-extension/LICENSE` 保留了上游版权声明。上游检出 `liusheng-source/` 仅用于本机参考，本仓库不收录。随扩展分发的第三方代码有各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 项目来源与致谢

- [流声字幕 / liusheng-subtitles](https://github.com/Liu-Bot24/liusheng-subtitles)：当前浏览器扩展的上游项目；`seek-extension/` 在其源码基础上修改，保留原项目的 MIT 版权声明。
- [Faster-Whisper-TransWithAI-ChickenRice](https://github.com/TransWithAI/Faster-Whisper-TransWithAI-ChickenRice)：可选日语识别、语音翻译和 VAD 路线使用其单独安装的运行包；本仓库只提供本地 API 适配代码，不分发该项目的运行包和模型。
- [MaiSubtitle](https://github.com/OatmeaILL/MaiSubtitle)：感谢其公开的 Windows 实时字幕、本地识别与翻译实践；本仓库没有包含其源码。
- [sherpa-live-sub](https://github.com/does00/sherpa-live-sub)：感谢其公开的系统音频采集与低延迟实时字幕实践；本仓库没有包含其源码，也不依赖其 sherpa-onnx 模型。
