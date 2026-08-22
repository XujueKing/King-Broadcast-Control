# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

Runtime output rule: PGM and PVW are separate states. Only confirmed PGM content may be emitted to the `output` window. The Windows output target must exclude the monitor containing the `main` control window. When only one logical display is detected, keep the output window hidden and use C1 as the live operator preview; when a second display is detected, keep C1 visible while opening the independent output fullscreen. The output window starts from safe black. The current WebView output is a screen-routing milestone and will later be replaced by mpv without changing this safety rule.

Runtime media milestone: the desktop app owns `%APPDATA%/club.king.broadcast-control/media/videos`, `media/audio`, and `media/images`. It rescans local video/audio folders while running. Until the bundled mpv sidecar replaces it, real MP4 playback uses the WebView2 media element in PGM/output; PVW and the operator-side PGM monitor must stay muted to prevent duplicate venue audio. The output window alone may emit the video's own audio, controlled by the independent R1 video-audio toggle.

Deck runtime milestone: when local audio files exist, Deck 1 and Deck 2 use independent real audio elements with their own play/pause/seek state. The Crossfader applies equal-power volume to those two audio instances and must never auto-switch merely because a track is loaded. The hard-coded demo tracks remain only as a no-media visual fallback and must not be presented as real playback.

Second-screen deployment is plug-and-play: the desktop app retries detection while running, keeps the preloaded output window hidden while only one logical display exists, and reuses it when an independent LED display appears. It must not force Windows display-mode changes. Hot-plug recovery must re-read monitor bounds and resolution, restore the current PGM without operator assistance, hide output immediately on disconnect, and never move visible output onto the main control display.

R1 图片素材使用独立的 8:9 缩略图网格，每行 4 个。第一项永远是固定黑屏，不可移动、不可删除；其余图片由桌面端扫描应用图片库目录生成，不得把视频缩略图混入图片列表。

R1 视频自身音轨由标题栏右侧的独立开关控制，默认静音。该开关不得改变 L 区任一 Deck、Crossfader 或调音台的播放与音量状态。

视频音轨与 C2 两个 Deck 是可同时输出的独立音源。视频声音开启时不得自动暂停或压低 Deck；C2 音乐只能由操作员手动暂停，Crossfader 不控制视频音轨。

R1 的视频、图片、文字不得单击后立即上屏。三类素材统一使用悬停预览、单击锁定、C1 明确确认上屏的 Preview/Take 流程；预览状态不得改变现场输出或视频音轨。

C1 右侧第一个按钮固定为“预览”开关。开启时中央区域动画扩宽为并列的 PGM/PVW 两个 8:9 屏幕，L/R 同步收窄；PGM 为当前输出，PVW 只显示候选素材。其余右侧 3 个位置保留给可配置监控机位。

双屏模式收窄 R 区时启用紧凑布局：视频、图片、文字每行 2 个，灯光预设隐藏中文名称；内部面板和网格必须自适应可用宽度且不得横向溢出。恢复单屏后回到原列数与完整名称。

R1 视频网格始终从顶部紧凑排列，grid-auto-rows 使用内容高度，行距必须与列间距相同，禁止纵向拉伸分散各行。

PVW 使用完整 8:9 矩形画布并以 cover 满铺视频或图片，不应用 T 形遮罩；T 形 LED 实际可见范围只用红色轮廓叠加标示，轮廓外也必须显示素材，以便判断裁切。

PVW 锁定视频或图片后允许直接拖动位置，并提供自由拉伸、等比缩放、锁宽同比、锁高同比和重置。红色 T 形线固定不动，素材变换参数随确认上屏应用到 PGM。

C2 每个 Deck 的底部控制为两行、每行 5 个等分按钮。第一行第 5 个是独立歌词开关“词”，第二行第 5 个是独立“原唱/伴唱”切换；Deck 1/2 状态互不影响。

当前 PGM 素材也能重新进入 PVW 调节。调节期间 PGM 保持原参数；确认后只热更新变换参数，严禁重新加载媒体、重置播放进度、暂停声音或出现黑帧。

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
