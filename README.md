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

## Windows 桌面开发

```powershell
cd ui-prototype
npm install
npm run setup:mpv
npm run desktop
```

接入第二屏后，软件会自动排除主控屏，将 PGM 窗口铺满物理副屏；只有一块屏幕时不创建可见输出，C1 实时预览继续工作。物理副屏回归测试可在开发版运行时执行：

```powershell
npm run test:desktop-output
```

`setup:mpv` 下载并校验固定版本的 x86-64-v3 播放器，供当前 i7-9750H 开发机持续开发和自动测试。正式酒吧主控机以 x86-64-v4 为采购与部署目标；V4 需要 AVX-512，并需要项目自行构建、固定版本和完成实机校验。V3 与 V4 使用完全相同的应用代码、IPC 和媒体逻辑。

桌面应用自动建立并扫描：

- `%APPDATA%\club.king.broadcast-control\media\videos`
- `%APPDATA%\club.king.broadcast-control\media\audio`
- `%APPDATA%\club.king.broadcast-control\media\images`

生成 Windows 安装包：

```powershell
npm run desktop:build
```

产物位于 `ui-prototype/src-tauri/target/release/bundle/`，MSI 与 NSIS 安装包均包含已校验的 `mpv.exe`。
