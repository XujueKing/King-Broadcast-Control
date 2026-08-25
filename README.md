# KING CLUB Broadcast Control

KING CLUB 酒吧播控软件。

项目已从高保真界面进入首版媒体播控核心开发。当前 Windows 桌面版已经具备本地媒体扫描、真实 MP4 播放、双 mpv Deck、手动 Crossfader、PGM/PVW 确认和单屏/第二屏安全路由基础。

## 当前阶段

- [x] 首版需求与边界文档
- [x] Rust + Tauri 2 + React/TypeScript + mpv 技术栈
- [x] 首页高保真 UI 第一版
- [x] 本地 MP4/MP3 扫描、真实视频预览和双 Deck 播放基础
- [x] 物理第二屏自动识别、无边框 PGM 输出和断开/重连恢复验证
- [ ] 灯光台/调音台联调和完整功能开发
- [ ] 测试、部署与现场验收

讨论入口见 [docs/README.md](docs/README.md)。

现场 AUDIO/LIGHT/VIDEO 设备链路、Shure SLX4、Qu-16、DP448、Tiger Touch Pro 和 3 台灯光 DSP8 Splitter 的归属及待勘验项目，统一记录在 [现场硬件拓扑基线](docs/hardware/site-topology.md)。

## Windows 桌面开发

```powershell
cd ui-prototype
npm install
npm run setup:mpv
npm run desktop
```

`setup:mpv` 同时安装匹配版本的 `mpv.exe`、`libmpv-2.dll` 和 C 接口头文件；前者承载现有 Deck 音频运行时，后者用于节目视频的单次 GPU 解码、多显示面实时渲染。

### 自动运行版本与 RTX 音频 AI

软件启动时用 `nvidia-smi` 自动识别硬件：检测到 NVIDIA GPU 时进入“全功能版”，自动启动制作 worker 和 MOSS，普通歌曲稳定进入曲库后按内容指纹串行制作；未检测到 NVIDIA 时进入“播放版”，不启动 Python、WSL、Demucs 或 MOSS，只导入和播放已制作歌曲。当前唯一音乐理解模型为 `OpenMOSS-Team/MOSS-Music-8B-Thinking`。Windows Python 工作器用 CUDA Demucs 生成 `vocals`/`no_vocals`，WSL2 SGLang 服务直接用 MOSS 生成歌词和原生时间轴。运行资料固定在内置盘：模型与服务源码位于 `D:\AI-Models`，媒体与分析结果位于 `%APPDATA%\club.king.broadcast-control`，均不依赖移动 E 盘。

```powershell
cd ui-prototype
npm run setup:audio-ai
npm run setup:moss-music
npm run start:moss-music
```

上述 `start:moss-music` 保留为独立诊断入口；正常全功能版由桌面应用按需启动服务并由 worker 等待就绪，不再因模型一分钟加载窗口退出队列。

### 便携歌曲包

完成制作的歌曲可从曲库导出为单个 `.kingsong` 二进制文件。包内包含原唱、伴唱、LRC、原生时间戳、模型来源和 BLAKE3 完整性记录，不包含仅用于制作的人声中间轨。客户机把包复制到软件显示的“收件箱”，启动时或点击“导入包”即可流式校验并解包到本机曲库；播放不依赖原包，也不需要 NVIDIA。导入和导出目录位于 `%APPDATA%\club.king.broadcast-control\song-packages\`。

接入第二屏后，软件会自动排除主控屏，将 PGM 窗口铺满物理副屏；只有一块屏幕时不创建可见输出，C1 实时预览继续工作。物理副屏回归测试可在开发版运行时执行：

```powershell
npm run test:desktop-output
```

`setup:mpv` 下载并校验固定版本的 x86-64-v3 播放器，供当前 i7-9750H 开发机持续开发和自动测试。正式酒吧主控机以 x86-64-v4 为采购与部署目标；V4 需要 AVX-512，并需要项目自行构建、固定版本和完成实机校验。V3 与 V4 使用完全相同的应用代码、IPC 和媒体逻辑。
现在
桌面应用自动建立并扫描：

- `%APPDATA%\club.king.broadcast-control\media\videos`
- `%APPDATA%\club.king.broadcast-control\media\audio`
- `%APPDATA%\club.king.broadcast-control\media\images`

生成 Windows 安装包：

```powershell
npm run desktop:build
```

产物位于 `ui-prototype/src-tauri/target/release/bundle/`，MSI 与 NSIS 安装包均包含已校验的 `mpv.exe`。
