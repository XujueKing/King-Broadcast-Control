# 2026-09-09 修复版部署说明

## 播放电脑

交付文件位于 `ui-prototype/src-tauri/target/release/bundle/nsis/`，同次构建也生成 MSI。
安装包包含主程序、mpv、libmpv、KGMA 解码器、人声独立程序及对应许可证。Python 环境和模型不包含在安装包内。

对于 i5-10400F / 8GB / RX550 2GB 的酒吧电脑，使用播放模式和已制作好的 `.kingsong`。该机器不满足本项目的 NVIDIA CUDA 制作路径；本次测试机器为 RTX 5090 Laptop，尚未测量那台酒吧电脑的帧率、内存峰值和现场灯光延迟。

安装后先确认 WebView2 能打开主界面，两个 Deck 均未播放、节目黑屏，再检查本机音频输出设备和显示器识别。启动不再执行 Windows 显示模式切换。
现场 Qu-16、Titan、DP 系列设备的驱动及连接按实际设备和协议逐项确认。本次修复未安装或改动第三方驱动，未改变调音台、主扩或物理灯光设置。

## 有 NVIDIA 的制作电脑

运行环境根目录依次查找：

1. 环境变量 `KING_AUDIO_AI_ROOT`（显式设置后只检查该目录，错误时不会回退到其它环境）。
2. 主程序所在目录的 `ai-runtime`。
3. `%APPDATA%/club.king.broadcast-control/ai-runtime`。
4. 开发机的源码目录，兼容现有开发环境。

环境根下必须存在 `.venv-audio-ai/Scripts/python.exe`、`ai-worker/worker.py`、`ai-worker/pipeline.json`。自动启动 MOSS 还需要该根目录下的 `scripts/start-moss-music.ps1` 和它使用的本机依赖。请在目标电脑重新建立 Python 环境，不能把另一台电脑的 venv 当成已验证的便携环境。

在已配置的环境根运行：

```powershell
.\.venv-audio-ai\Scripts\python.exe ai-worker/worker.py --preflight
```

检查 Python、CUDA、BF16、模块、分离模型、MOSS 服务以及整体 `ok`。界面中的硬件/环境识别只表示这些资源被找到；实际制作就绪以自检和真实任务结果为准。

本机本次自检识别 Python 3.12.10、PyTorch 2.11.0+cu128、RTX 5090 Laptop、CUDA 可用且支持 BF16；分离模型文件存在。MOSS 服务未运行，所以整体 `ok=false`，未把它写成 AI 制作验收通过。

## 现场验证

音乐跟灯的软件链路已增加取消、超时、队列合并及速度传递；物理响应还需在已核验 Show 和 Fixture 42 上使用真实歌曲观察。HTTP 成功和单元测试均不等于灯具实际动作或听感验收。
编排现支持本地静音时间线预览及当前节目监看；现场整曲编排执行、灯光轨执行和未接入的编辑功能仍在界面明确标记，不能作为已完成的现场编排引擎使用。
