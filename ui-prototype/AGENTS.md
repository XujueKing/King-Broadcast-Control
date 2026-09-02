# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

Runtime output rule: PGM and PVW are separate states. Only confirmed PGM content may be emitted to the `output` window. The Windows output target must exclude the monitor containing the `main` control window. When only one logical display is detected, keep the output window hidden and use C1 as the live operator preview; when a second display is detected, keep C1 visible while opening the independent output fullscreen. The output window starts from safe black. The current WebView output is a screen-routing milestone and will later be replaced by mpv without changing this safety rule.

现场硬件连接默认自动恢复：启动时优先使用持久化的 Titan 与 Qu-16 地址并自动连接；已知地址失效时才扫描该地址所在的 /24 网段。已连接时禁止扫描或建立第二条 Qu-16 控制连接；Titan 候选必须通过已绑定控制台身份校验，Qu-16 扫描结果必须唯一才允许自动改绑。自动发现只恢复连接，不得自动播放歌曲、改推子或触发灯光 Playback。

首页灯光 `0` 固定为现场确认的“暗红加特林”常规模式：仅允许控制 Show `2024.12.28` 中 Group `59` 所选的 Fixture `42/17636`，基础亮度 10%，颜色只取 Colour `70-77` 的已核对白名单。操作员明确启用自动模式后，PGM 主视频的稳定主色决定加特林色板，当前实际占主导声音的 Deck 节拍/BPM 决定受限速度与 10%-12.5% 的短促亮度起伏；黑屏、无稳定色或无有效节拍时保持暗红基线。该模式不得轮换整套 Playback，不得联动 280 光束、三色摇头或 LED 排灯，也不得突破暗场亮度和速度限制。

Runtime media milestone: the desktop app owns `%APPDATA%/club.king.broadcast-control/media/videos`, `media/audio`, and `media/images`. It rescans local video/audio folders while running. Until the bundled mpv sidecar replaces it, real MP4 playback uses the WebView2 media element in PGM/output; PVW and the operator-side PGM monitor must stay muted to prevent duplicate venue audio. The output window alone may emit the video's own audio, controlled by the independent R1 video-audio toggle.

Program-video target architecture is one `libmpv` core with GPU hardware decoding and two real-time render targets for the physical PGM output and C1 confidence monitor. Two independent WebView `<video>` players are only the temporary fallback. A low-frame-rate screenshot/JPEG proxy is not an acceptable live preview and must not be reintroduced.

Deck runtime milestone: when local audio files exist, Deck 1 and Deck 2 use independent real audio elements with their own play/pause/seek state. The Crossfader applies equal-power volume to those two audio instances and must never auto-switch merely because a track is loaded. The hard-coded demo tracks remain only as a no-media visual fallback and must not be presented as real playback.

现场通过 Qu-16 USB-B 播放时，波形拖动和键盘 Seek 禁止在有声状态下直接执行精确跳转。桌面 mpv 必须保存原暂停/音量状态，先软件静音并暂停，执行 Seek 并等待解码状态稳定，再恢复播放并短渐入原音量；任何跳转瞬态都不得直接送入 ST3、DP448、功放或音箱。

Second-screen deployment is plug-and-play: the desktop app retries detection while running, keeps the preloaded output window hidden while only one logical display exists, and reuses it when an independent LED display appears. It must not force Windows display-mode changes. Hot-plug recovery must re-read monitor bounds and resolution, restore the current PGM without operator assistance, hide output immediately on disconnect, and never move visible output onto the main control display.

R1 图片素材使用独立的 8:9 缩略图网格，每行 4 个。第一项永远是固定黑屏，不可移动、不可删除；其余图片由桌面端扫描应用图片库目录生成，不得把视频缩略图混入图片列表。

R1 视频自身音轨由标题栏右侧的独立开关控制，默认静音。该开关不得改变 L 区任一 Deck、Crossfader 或调音台的播放与音量状态。

视频音轨与 C2 两个 Deck 是可同时输出的独立音源。视频声音开启时不得自动暂停或压低 Deck；C2 音乐只能由操作员手动暂停，Crossfader 不控制视频音轨。

R1 的视频、图片、文字不得单击后立即上屏。三类素材统一使用悬停预览、单击锁定、C1 明确确认上屏的 Preview/Take 流程；预览状态不得改变现场输出或视频音轨。

播放曲库必须提供按歌曲名、歌手及目录即时过滤的搜索框并显示结果数量。缺失歌手统一显示为 `--`，网址、下载站域名等来源标签不能当作歌手；所有可能被截断的歌曲名、歌手、标签、制作状态、BPM 和时长必须提供悬停完整提示。AI 制作失败不能统一写成模糊的“制作失败”：MOSS 未返回 transcript 显示“歌词识别失败”，内存分配错误显示“资源不足/未制作”，并在悬停提示中保留底层完整错误。同一媒体路径存在多个管线版本记录时，曲库状态必须采用最新任务，禁止让旧版 `queued` 覆盖新版 `skipped/ready/running`。Worker 只能领取与当前 `pipelineVersion` 完全一致的任务，旧管线的待处理任务不得阻塞当前队列。

C1 右侧第一个按钮固定为“预览”开关。开启时中央区域动画扩宽为并列的 PGM/PVW 两个 8:9 屏幕，L/R 同步收窄；PGM 为当前输出，PVW 只显示候选素材。其余右侧 3 个位置保留给可配置监控机位。

双屏模式收窄 R 区时启用紧凑布局：视频、图片、文字每行 2 个，灯光预设隐藏中文名称；内部面板和网格必须自适应可用宽度且不得横向溢出。恢复单屏后回到原列数与完整名称。

R1 视频网格始终从顶部紧凑排列，grid-auto-rows 使用内容高度，行距必须与列间距相同，禁止纵向拉伸分散各行。

PVW 使用完整 8:9 矩形画布并以 cover 满铺视频或图片，不应用 T 形遮罩；T 形 LED 实际可见范围只用红色轮廓叠加标示，轮廓外也必须显示素材，以便判断裁切。

现场 LED 几何以 2026-08-25 用户确认尺寸为准：总物理尺寸 5120 mm(W) × 5760 mm(H)，外框 8:9。模组为横向 320 × 160 mm / 128 × 64 px；A 区 8 列 × 18 行，对应 2560 × 2880 mm / 1024 × 1152 px；B 区 16 列 × 18 行，对应 5120 × 2880 mm / 2048 × 1152 px。应用创作逻辑画布固定为 2048 × 2304（8:9），不得把 18 行误按 128px 高的方形单元计算成 4608px。现场 DVP 处理器按完整 1920 × 1080 HDMI 输入映射全墙，因此独立输出必须把 8:9 逻辑画面横向预拉伸 2 倍，铺满 1920 × 1080；处理器映射后恢复 8:9。若只发送居中的 960 × 1080，会只占物理宽度 2560 mm，B 区左右各黑 1280 mm。C1/PVW 仍显示未预拉伸的真实 8:9。

PVW 锁定视频或图片后允许直接拖动位置，并提供自由拉伸、等比缩放、锁宽同比、锁高同比和重置。红色 T 形线固定不动，素材变换参数随确认上屏应用到 PGM。

C2 每个 Deck 的底部控制为两行、每行 5 个等分按钮。第一行第 5 个是独立歌词开关“词”，第二行第 5 个是独立“原唱/伴唱”切换；Deck 1/2 状态互不影响。

C2 的 CUE 固定移动到圆形播放/暂停键左侧，使用与播放键相同尺寸和样式的圆形键帽，并留出清晰间距。原矩形 CUE 槽始终显示“补音”按钮：非伴唱模式可见但禁用；每次进入伴唱默认开启，允许操作员独立关闭；Deck 1/2 状态互不影响。补音按钮是明确的有声操作：歌手参考已绑定时必须启动与 Deck 同步的本地 mpv 参考层；CUE 开启时随整个 Deck 去耳机，CUE 关闭时随整个 Deck 去主输出。该操作不得自动武装 Qu-16 实时输入/返回 Vocal Engine 链路。

CUE 是整个 Deck 最终声音的监听路由，不区分原唱、伴奏、修音或补音。开启 CUE 时只撤销 ST3 到 LR 的 Assign 并打开 ST3 PAFL，把完整 Deck 从主扩隔离后送往耳机；关闭时先撤销 PAFL，再恢复开启前捕获的 LR Assign 真值。CUE 永远不得写 ST3 或 LR 主推子。缺少开启前真实 Assign 回读时必须拒绝切换，禁止猜测恢复值。

“补音”采用完全自适应规则：关闭时参考女声为零；打开后，在歌曲参考时间轴的演唱区若没有检测到真人声，自动补入完整目标比例的女声参考；一旦检测到真人演唱，立即使用实时评分连续控制参考混合量，唱得越准补得越少、失准越严重补得越多。间奏保持关闭。CUE 不得改变这套内容逻辑，只改变完整 Deck 声音的监听去向。

当前 PGM 素材也能重新进入 PVW 调节。调节期间 PGM 保持原参数；确认后只热更新变换参数，严禁重新加载媒体、重置播放进度、暂停声音或出现黑帧。

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

Runtime editions are hardware-capability based, not separate source branches. At startup, a detected NVIDIA GPU selects the full production-and-playback mode; no NVIDIA GPU selects the playback-only mode. Playback-only must never start Python, WSL, Demucs, or MOSS and must accept completed `.kingsong` packages.

`.kingsong` is the portable single-song delivery format. It is a versioned `KSG1` binary container carrying the original mix, accompaniment, LRC, native timestamp JSON, model provenance and BLAKE3 integrity records. High-end machines produce and export it; low-end machines verify and unpack it into their local library. Deck playback always reads unpacked local media, never a live package stream.

KGM/KGMA/VPR 必须由独立 `audio_importer` 在曲库扫描阶段识别和本地解码，默认保留用户原文件，将产物统一写入 `media/audio/.king-imported/<源相对目录>/`，音频使用可读的原歌曲名，不得再创建不可读的版本哈希歌曲目录。成功导入后即使用户手工删除源 KGMA，已转换音频和歌词也必须保留；程序不得自动删除用户源文件。KRC/LRC 可晚于歌曲放入，扫描时必须按完全同名或酷狗哈希尾缀自动配对，并在统一产物目录生成与音频完全同名的 UTF-8 LRC。不得把解码逻辑写进 MPV。产物扩展名必须按文件头重新判断，禁止信任解码器的默认 `.mp3`。解码器固定版本和 SHA-256，安装包离线携带；每次曲库扫描不得联网。

KGMA 解码产物不是永久“仅播放”特例：全功能 NVIDIA 机器必须像普通歌曲一样自动进入人声/伴奏制作队列；无 NVIDIA 播放机不得运行 AI，但必须按音频内容指纹复用高性能机器已完成的 vocals/no_vocals，不能因解码产物移动目录而丢失原唱/伴唱绑定。

When LRC data only provides sentence start timestamps, the current lyric must never remain visible indefinitely until the next timestamp. Estimate a natural singing duration from the text: continuous lyrics may remain until the next timestamp, but when the next line is separated by a clear instrumental gap, move the completed line upward, shrink it, and fade it out on the existing 720 ms lyric timeline. Keep the lyric area empty during the gap and introduce the next line only at its own timestamp. The final lyric must expire by the same rule.

Newly produced v6 song assets must also contain a compact 48 kHz/128-frame `reference.json` tied to the source song fingerprint and separator profile. New `.kingsong` exports carry it as `analysis/reference.json`; the field remains optional only so legacy KSG1 packages stay importable. Playback-only machines validate and unpack this file but never regenerate it.

歌词显示采用同步上移的三行时间轴并统一用于主预览和独立输出。静止时当前句为中线略偏下的大字，下一句为同区下方的 50% 透明小字，再下一句在更下方保持同样小字号但完全透明。换句时三条同时上移一格：当前句缩小并完全淡出，下一句放大并完全淡入成为当前句，再下一句保持字号不变并由完全透明变为 50% 透明。禁止给其中任何一行另设延迟或独立入场动画。中文歌词按标点断句但屏幕不显示标点，当前歌词优先使用软件字体目录中的“汉仪清雅体简”。

伴唱制作使用 `BS-RoFormer-Viperx-1297`（`model_bs_roformer_ep_317_sdr_12.9755.ckpt`）直接生成 vocals/instrumental，`htdemucs_ft` 完整四分轨只作为故障回退；不得退回粗糙的 `htdemucs --two-stems vocals`。分离流水线升级时只重制 stems，已有 MOSS 歌词与时间戳必须复用。高端 NVIDIA 机器负责重制，低端播放机继续消费已制作的 `.kingsong`。

顶部品牌标题固定为“AI Broadcast Control 2027”。NVIDIA 全功能版状态使用 NVIDIA 官方完整横版标志，不使用闪电图标或手写 NVIDIA 文字；状态区域保持透明底色。

全功能版 AI 制作采用非破坏性三级调度：正在播放歌曲为 0 级、已装入 Deck 的待播歌曲为 1 级、其余曲库为 2 级。播放开始不得杀死 Worker/MOSS 或暂停整队；Worker 始终保持 Windows Idle 优先级、并发 1，当前任务完成后再按级别领取下一首。

开业播放期间必须允许操作员在“设置”中手动关闭整个 AI 歌曲制作后台。该开关持久化到桌面应用数据；关闭时立即停止并保持停止 MOSS 8B、分轨/歌词 Worker，释放 GPU/显存，但不得影响 mpv、Deck、Qu-16、歌单、已制作伴唱/歌词或 Vocal Engine 播放能力。重启后继续保持关闭，只有操作员明确重新开启才恢复制作。

Windows 主控窗口默认使用无边框真全屏并覆盖任务栏。C2 Crossfader 下方固定放置一行四等分调音推子：总声音、耳机音量、麦克风 1、麦克风 2；该行与 Crossfader 行等高，不显示通道文字或新增麦克风按钮，每格只显示通道图标、图标旁数值、等距小刻度和统一横向推子。麦克风 1 使用紫色，作为专业麦克风组一次批量控制 Qu-16 联动的 CH1+CH2；麦克风 2 使用暖橙色，独立控制现场确认的 GS VS-88 / CH6。图标、数值和推子进度同步区分。两个麦克风推子只有在 Qu-16 完成 End Sync 且取得对应 Fader 真值后才允许操作；写入后以真机回读为准，CH1/CH2 回读不一致时不得伪装为已经同步。总声音实际乘入两个 Deck 的输出增益；麦克风控制只改变 Qu-16 Fader，不自动打开 Mute、LR、PAFL、48V 或 Vocal Engine 输入/返回，避免现场啸叫。

点击底部“调音台”后使用 300ms 同步场景动画：L 区向左退出，R 区向右退出，C 区在 L 区收缩时平移至最左侧，右侧展开独立调音台工作区。切换过程不得卸载 Deck、重置播放状态或打断音频；返回首页时执行反向动画。

调音台按可扩展“型号包”加载。首个型号包固定为 Allen & Heath Qu-16，数字孪生 UI 必须保留实物的 SuperStrip、触屏/处理区、16 路通道推子、独立 LR 主推子和 Mix Select 分区，并使用真实可操作控件而不是整图背景。型号包同时声明 UI renderer、通道能力、MIDI/NRPN 控制协议和 Windows 驱动供应策略；设置中选择型号后持久化并切换对应 UI。厂商驱动若受 EULA 或网页验证保护，不得绕过授权静默下载：应自动检测已安装驱动，未安装时进入一次性官方授权流程，授权完成后自动识别。

Qu-16 的现场接线固定为两条独立链路：声音使用后面板 USB-B 2.0 传输并由 Qu Windows ASIO/WDM 驱动提供多通道音频；软件控制使用 Network 口的以太网 MIDI over TCP，默认端口 51325，同一时刻只建立一个 TCP 控制连接并遵守 Active Sense 保活。不得把 USB MIDI 当作本项目的默认控制线。软件中的圆形旋钮必须支持鼠标滚轮微调，Shift + 滚轮可粗调；每个 Mute、Sel、PAFL、Mix Select、SuperStrip 和系统键的提示与行为以 Qu Reference Guide AP9372 iss.10 和 Qu MIDI Protocol V1.9 为准。

Qu-16 官方 PDF 必须原样长期保存在仓库 `docs/hardware/allen-heath-qu16/official/`，并由同目录 `README.md` 提供中文页码索引。调音台 UI 的面板顺序、区域分割线和按钮形状以 AP9372 第 21 页总览及第 28 页处理面板为视觉基准；至少保留 Preamp/HPF、PEQ、Gate/GEQ、Comp/Pan 的上下分组、TouchChannel、Touch Screen、Screen Select、SoftKeys、Master Strip 和 Mix Select 的相对位置，不得退化为通用卡片式调音台。

Qu-16 顶部品牌横梁必须使用从 Allen & Heath 官方 `Qu-16-Page.jpg` 原图直接裁出的连续真实资产 `src/assets/hardware/allen-heath-qu16/qu16-brandbar-clean.png`，一次保留完整的左侧 `ALLEN&HEATH` 铭牌、中央双蓝印刷线和右侧 `Qu-16` 铭牌；裁切边界必须去掉两侧螺钉并让两块铭牌到画布边缘的余量左右对称，禁止出现半颗螺钉或任一端截断。禁止把品牌、折角铭牌或双线改回 CSS/SVG 拼图，也不得拆开后非等比拉伸。品牌栏必须按素材原始宽高比完整显示，不能用 `cover` 二次裁切。真机横梁没有 `USB-B AUDIO · ETHERNET CONTROL · TCP 51325` 丝印；该连接信息只能出现在软件状态或设置区域，不能叠加在品牌资产上。

所有 Qu-16 圆形编码器必须使用基于圆心角度的真正 360 度旋转交互，支持环绕拖动、滚轮和键盘；严禁以 `input[type=range]` 横向滑动条套圆形皮肤。SuperStrip 的 PEQ 必须按真机还原为 LF/LM/HM/HF 四列、Width/Freq/Gain 三行共 12 个旋钮，Gate/Comp/HPF 使用下方椭圆 `In` 灯键，并保持参考照片中的文字位置、按钮比例和蓝色分区标题。

SuperStrip 内所有旋钮统一使用 Gate 旋钮的视觉直径；Preamp、HPF、PEQ、Gate、Comp、Pan 不得因分区密度采用不同大小。工程监听区的 Phones 与 Alt Out 也必须复用该视觉直径；通道条旋钮仍使用自己的紧凑尺寸。

PEQ 的蓝色斜切标题必须在标题下沿接续外框横线，标签右侧必须透出控制台底板，不得形成深色矩形标题背景；内部三条竖分割线只覆盖旋钮矩阵，不穿入底部 LF/LM/HM/HF 与公共 In 按键区。PEQ 公共 In 键保持无中心点并与底框留距；Gate 与 GEQ 椭圆键显示可点击切换的中心指示灯，灭态近黑、亮态红色。其余椭圆键是普通功能键，逻辑动作不得通过按钮本体持续发光或变色表达；所有椭圆键在 hover/pressed/active 状态都不得被全局按钮样式染黑。

SuperStrip 右侧处理区按真机分成两排独立比例：上排 Gate/Comp 等宽，下排 GEQ/Pan 约为 35/65，Pan 明显宽于 GEQ。Comp 的 GR 灯位于旋钮下方并与 `In` 键状态分离；当前交互样机允许点击 `Comp In` 演示 GR 灯切换，接入真实 DSP/硬件后必须由实际增益衰减状态驱动。Pan 旋钮必须锁定正圆，顶部为 7 个弧形刻度灯（左 3、中心 1、右 3）；LR 时控制主声像，FX Send 与 Mono Mix1-4 时禁用，Stereo Mix5-10 时控制发送声像，链接输入对时控制 Width。

Qu-16 的 `TouchChannel` 是彩色 LCD 内部上半部的处理块选择区，不是 LCD 左侧独立的物理窄栏；通道身份、Gate、PEQ、Comp 等处理块必须在同一 LCD 视口内组合并随当前 `Sel` 通道更新。LCD 有效内容保持厂商 800×480（5:3）比例并整体缩放，不得横向或纵向拉伸；在完整 Touch Screen 总成中，LCD 外框约占总成高度 73%，下方物理控制带约占 22%，下方 `Screen Rotary` 区约占该控制行宽度的 30%，不得为了塞入内容把屏幕旋钮缩成装饰点。

`Fn`、`Copy`、`Paste`、`Reset` 和 `Screen Rotary` 都位于 LCD 玻璃区域之外的下方物理控制区；屏内底部只保留状态工具栏、Fn 当前功能、Curr/Next Scene 及设备状态。右侧六个 Screen Select 是独立物理键，必须分成靠近的 `Processing/Routing` Sel 键组与留有明显组间距的 `Home/FX/Scenes/Setup` 系统键组，禁止用 `repeat(6, 1fr)` 做成完全等距列表，也不得额外重复显示一个 Processing 标题。

软件中的 Qu-16 LCD 是根据应用和调音台参数状态重建的操作界面，不是从真机读取或转播 framebuffer；文案、设置和交付说明都不得声称支持硬件触屏画面镜像。Ethernet MIDI/NRPN 只负责协议明确支持的通道、处理、路由、场景等参数状态双向同步；LCD 页面、TouchChannel 当前页签、Fn 弹层以及 Copy/Paste/Reset 操作流程属于本地 UI 状态，不得假定或宣称能够远程切换真机页面导航。

Qu-16 Touch Screen 外部实体键必须隔离于全局按钮主题：右侧 Screen Select、下方 Fn/Copy/Paste/Reset 的 normal、hover、pressed 状态均保持各自固定键帽底色，不得在悬停时变黑或染成全局绿色；暂不可执行的 Paste 仍保持实体红色键帽。右侧当前 Screen Select 只以中心红灯表示激活，灭态为近黑。下方 Fn/Copy/Paste/Reset 的实物基准位置必须保持不动并维持约 10–12 CSS px 的下框间距，禁止为了对齐旋钮而把四组标签和键帽整体抬高；只能移动 Screen Rotary，使其圆心与四个键帽圆心上下居中对齐。Screen Rotary 的可见直径必须与当前 Parametric EQ 旋钮一致，后方两条青线必须关于旋钮圆心上下对称。TOUCH SCREEN、PROCESSING/ROUTING/HOME/FX/SCENES/SETUP、FN/COPY/PASTE/RESET 使用可读的大写粗体丝印，禁止再次缩回 5px 微型字。

Qu-16 右上工程监听区固定按 AP9372 第 21 页还原：左列是 L/R 两条独立 12 段主表、中央共用 `Pk/+12/+6/0/-3/-6/-9/-12/-16/-20/-30/-40` 刻度、底部红色 PAFL 状态灯，下方另设默认按住式 Talk 键；右列由上至下是 ST3 IN 3.5mm 插孔、纵向 Qu-Drive USB-A 插口、蓝色 Phones 区和独立 Alt Out 区。`Engineer’s monitor` 是说明书注释，不得重新做成名为 Monitor 的通用旋钮。Phones/Alt Out 都使用与 PEQ 相同的真正 360 度旋钮，常规 40px、紧凑高度 35px；ST3、USB 与耳机插孔是端口，不得伪装成按钮。Talk 激活时 LCD 状态栏显示绿色 T；通道 PAFL 接管主表并点亮表底红灯，再次按同一路恢复 LR。

工程监听区的总宽固定不扩张，表区/接口区采用 51px/55px 加 4px 间距，使右侧 I/O 列略宽于主表。Qu-16 铭牌跨接两列上方并保留左侧斜切；L/R 丝印必须与对应灯柱共中线，12 个刻度必须与每行灯珠共水平中线，PAFL 点灯与文字作为整体居中。该区域必须显式覆盖工作区全局 `span` 字号，避免丝印被放大或挤位；灯珠采用短矩形而非胶囊。Phones 图标位于插孔右上，插孔与 Phones/Alt Out 两只旋钮保持同一竖向中轴；监听旋钮后方不得出现通用控件的青色横向导轨。Qu-Drive 保留纵向金属孔腔和左下琥珀状态灯。

Qu-16 SuperStrip 必须建立自己的丝印排版隔离层：区域标题居中，`Pk/Thresh/GR/In/Fader Flip/L/R`、PEQ 三行参数名和四个频段名不得继承工作区通用 `span` 的字号或字距，也不得与旋钮、按钮、分割线相交。紧凑高度模式不能通过压缩 SuperStrip 使内容溢出到推子区；当前 820px/800px 窗口的上方面板行至少保留 254 CSS px，旋钮统一缩放为 35px，并以几何 QA 验证所有子区仍在框内。

Qu-16 本地数字孪生的 Processing 状态必须按当前 `Sel` 通道独立保存，实体面板造型控件和本地 LCD 必须读取及写入同一份状态。Preamp、HPF、PEQ、Gate、Comp 和 Pan 的面板操作应立即同步到 LCD，切换通道后恢复该通道自己的值。TCP 51325 的下半部 Fader/Send/Mute/PAFL 双向控制不能冒充 Processing 同步；在 Preamp、HPF、PEQ、Gate、Comp 和 Pan 的 NRPN 映射及回读另行实现并通过真机验证前，LCD 必须保留 `data-sync-mode="local-ui-only"`，不得因为下半部控制已连接就把 Processing 标为真机同步。

Qu-16 的 GEQ Fader Flip 不能只切换灯：按键必须按说明书循环正常 Mix 推子、低频 16 段 `31.5Hz–1kHz`、高频 16 段 `500Hz–16kHz`，两层保留 `500/630/800/1kHz` 四段重叠。GEQ 层中的 16 根推子控制当前 Mix 独立保存的 28 段 1/3 倍频程增益（±12dB）；条屏显示频率和增益，`Sel` 仅在 0dB 时点亮并可一键归零。退出 Fader Flip 后必须恢复原通道推子值，不得把 GEQ 值写入播放混音层。

Qu-16 下半部固定使用实机的四区结构：左侧 Mix Assign/Layers 控制轨、16 条等宽物理通道、独立 Master Strip、右侧 SoftKeys/Mix Select。四区必须处于同一行，并保留真机蓝色印刷线对 Layers、16 路通道、Master、SoftKeys 和 Mix Select 的独立围合与转折，不得合并成无分区的通用竖栏。控制区约占条高 40%–45%，推子区约占 45%–50%，底部保留可见金属底板；不得再用 `.qu-channels::before` 伪造 Layers，也不得让 Mix Select 换行。Mute/SoftKey 是灰白小矩形键，Sel 是绿色椭圆键，PAFL 接近灰白正圆；Mix Select 必须保留三种键帽色族：FX1/FX2 为冷白浅蓝、Mix1–4 为浅青蓝、Mix5-6/Mix7-8/Mix9-10 为饱和蓝，LR 为 Master Strip 内独立的饱和蓝椭圆键。推子轨道必须有双边细刻度和每条可读的 `10/5/0/5/10/20/30/40/∞` 标识，推子帽保持宽厚并有明显中央白线。

Qu-16 三层是同一组 16 个物理槽位的映射，不得创建虚构音频源。Lower 为 CH1–CH16；Upper 严格为 ST1–3、FX1–4 Ret、FX1–2 Send、Mix1–4 Master、Mix5-6/7-8/9-10 Master；Custom 是对既有实体的可配置映射。当前 KING CLUB 实机在 2026-08-25 分槽校准中确认 Custom 第 8、9 槽分别回读 FX1 Return、FX2 Return，其余槽保持对应 CH1–7/CH10–16；该映射保存在型号配置 `ui.customLayerProfile.slots`，不得硬改协议通道号。真机只有上下两个灰白椭圆 Layer 键，两个键各自使用键帽右侧的独立状态灯；中间 Custom 也是独立状态灯和丝印，不是第三个按钮。Custom 由两键同时按下进入；桌面 UI 可在 Custom 指示条提供鼠标快捷入口，但外形不得伪装成第三个椭圆实体键，也不得把 Layer 状态灯塞进两个键帽中央。Upper 中的 FX Send/Mix Master 必须与专用 Master Strip 共用 level、mute、PAFL 和 Processing 状态，严禁形成两套 Master。

Qu-16 的 Mix Select 总线全集固定为 LR、FX1、FX2、Mix1–4、Mix5-6、Mix7-8、Mix9-10；LR 键只位于 Master Strip，右侧只显示其余 9 键。切换 Mix 后 16 路发送推子和当前 Master 必须切到该总线的独立记忆，再按当前 Mix 返回 LR。Mute 与 PAFL 跨 Mix 保持实体状态，PAFL 默认 Auto-cancel；Pre Fade 在 LR 禁用，Assign/Pre Fade 只能作用于真实输入实体，不能包含 Custom 槽位副本或输出 Master。FX1/FX2 不提供 GEQ Fader Flip；GEQ 模式仍允许通道和 Master 的 Mute/PAFL，并在真机表计 LIVE 时使用 Monitor RTA。SoftKeys 1–4 的默认分配是 Mute Group 1–4，状态必须以对应 Mute Group state 保存，不能只是无语义的装饰灯。

下半部带中心点的状态键必须把键帽与指示灯分层：通道/Master PAFL、LR、右侧 Mix Select 和 SoftKeys 在 off/on/hover/pressed 状态下都保持各自原有键帽底色，外层点击容器始终透明且无方形背景；激活时只允许 4×4 CSS px 的中心灯变色并发光。禁止再次用 `.active` 改写整个矩形、圆形或椭圆键帽的背景、边框或阴影。

Qu-16 下半部的实体键尺寸必须与上半部保持同一硬件尺寸族：Mute/SoftKey 为 31×22 CSS px，Sel/Mix Select 为 29×20 CSS px，PAFL 常规为 24×24 CSS px、紧凑高度为 23×23 CSS px。所有实体键中心指示点统一为 4×4 CSS px。常规高度下实体键标签、信号标签、推子刻度、条屏主字和通道编号不得低于 7.5/6.5/7/8.5/8 CSS px，条屏副字不得低于 7px；紧凑高度下条屏主/副字不得低于 8/6.75px。调音台主体应在工作区内水平居中并尽量利用可用宽度，同时保留左右对称的最小 6 CSS px 余量；不得重新退回 890px 的窄版上限。下半部底部金属底板在常规高度使用 `clamp(28px, 3.2vh, 36px)`，紧凑高度为 10px，800px 及以下为 4px，禁止重新留下大块无功能留白。下半部紧凑模板按实际内容高度覆盖到 1040px，1041px 才允许恢复普通右轨；响应式门禁至少检查 1041/1040/980/900/841/840/821/820/800px，防止断点上沿裁掉 Mix Select。

Qu-16 通道 `Pk/0/Sig` 必须固定使用从上到下红色、琥珀色、绿色的独立灯珠，并使用真实 dBFS 表计语义，不得以随机数或 0–100 假百分比驱动。`Sig` 在 `>= -48 dBFS`、`0` 在 `>= -18 dBFS`、`Pk` 在任一公开处理测点 `>= -3 dBFS` 时亮起；三灯是累计阈值，允许同时点亮。输入通道使用推子前/静音前表计，Master 使用推子后/静音后表计；GEQ Fader Flip 时改用 PAFL RTA，主导频段点红。没有新鲜真机表计帧、连接断开或数据超过 1500ms 时必须全部熄灭并显示断开状态，禁止回退到演示灯。以太网驱动必须通过 TCP 51325 完成 Get System State、设备 MIDI 通道、Active Sense、Meter SysEx、7-bitized/7Q8 解码、断线清表与重连，前端桥接最多 20 FPS，避免表计刷新拖慢推子交互。

Qu-16 的 31 段 RTA 从 20Hz 开始，映射 28 段 GEQ 时必须跳过前两个频段并使用索引 `2..29`；GEQ 模式的每帧只允许一个主导频段点红色 Pk，其余频段不得回退显示普通通道灯，ARIA/data 数值也必须来自当前 RTA 频段。RackFX 四块的 Post PEQ L/R 映射 `FX1–FX4 Return`；FX1/FX2 的 Send L/R/Mono 是 RackFX 实际输入，只有默认同名 Mix→Return Patch 下才等同 FX Send，因此 UI 必须可见标注 `FX IN`，不得冒充已验证的专用 Send 总线表计。

Qu-16 表计会话必须在后端串行执行 stop/join/start，并分配单调递增 `sessionId`；旧 Worker 发布前校验 generation，前端监听同时校验 effect generation、host 与 sessionId，旧 cleanup 只能停止自己的 session。ASIO 驱动状态检查调用 `reg.exe` 时必须使用 `CREATE_NO_WINDOW`，并通过互斥和至少 30 秒缓存避免 StrictMode、页面重载或并发设置请求反复弹出 Windows Terminal。

Qu-16 下半部真机控制只允许语义化白名单 Fader、Send Level、Mute 与 PAFL，经表计所用的同一个 TCP 51325 Worker 发送。Get System State 之后必须等同 MIDI 通道的 End Sync `0x14` 才开放写入；推子按约 25–30Hz 合并，Mute/PAFL 立即入队。TCP 写成功只能记为等待回读，协议没有 ACK 时不得冒充已确认；不同回读以真机为准。每次重连清空参数和 pending，并以 `connectionEpoch` 阻止上一连接的指令自动重放。Mix Select、Layer、Sel 和屏幕导航保持本地状态，因为公开协议没有这些实体导航键的远程控制项；真机回读不得擅自切换软件 Layer，因为协议没有携带实体 Layer 键状态，自动推断会导致整组 16 根物理槽位映射错乱。没有实体 Qu-16 验证时只能声明协议/mock 测试通过，禁止声称现场真机闭环已验收。

整套主控界面固定采用 Qu-16 工作区同源的专业石墨灰大底：`radial-gradient(circle at 50% 0,#253039 0,#11161a 57%,#0a0e10 100%)`。渐变只在应用外壳绘制一次，L/C/R、顶部、底部与设置页采用透明或半透明石墨面板和中性灰蓝结构线，不得为三列分别重复径向亮斑。LED 有效画布与独立输出继续保持纯黑；Deck 1 绿色、Deck 2 蓝色、交叉推子双色、麦克风紫/橙、PGM/PVW、连接、告警、Blackout 和灯光色盘仅作为功能语义色保留，不得重新扩展为大面积绿色背景。Qu-16 真机数字孪生内部颜色不随外壳主题改写。

石墨灰主题必须同时覆盖主控界面的文字层级和普通鼠标/键盘交互：主要文字使用冷白，次级文字使用中性灰，普通 hover、pressed、selected 与 focus 统一使用冷灰蓝反馈，不得继续沿用全局绿色染色。绿色、蓝色、紫色、橙色、红色和琥珀色只保留给既定功能语义状态；Qu-16 真机数字孪生的实体键、丝印、灯珠和仪表颜色继续由型号包自身隔离控制。

石墨灰外壳中的 Deck 1 与 Deck 2 必须保留轻微的通道身份环境光：Deck 1 为低饱和淡绿、Deck 2 为低饱和淡蓝，且只作为石墨灰上的微弱径向亮度，不得形成大面积纯色底。Crossfader 及其下方总声音、耳机和麦克风横向推子统一复用 Qu-16 的硬件语言：黑色凹槽、上下成对刻度、厚实深灰推子帽和中央白色定位线；方向保持横向，功能色只用于进度、刻度或微弱轮廓。

曲库中已装入 Deck 的行优先显示通道身份色，不得被普通 selected 样式覆盖：Deck 1 淡绿、Deck 2 淡蓝、同时装入时左右双色。主屏/监控位、灯光预设、自动模式及灯具控制等普通按钮的选中态保持石墨灰键帽，只允许用冷灰蓝细边、中心灯或小色点表达状态；灯具自身颜色只能显示在小色点，不能填满按钮。顶部 King 品牌 Logo 固定显示为白色。Crossfader 只绘制一条连续黑色实体槽，刻度必须在槽的上下两侧关于水平中线严格对称，不得用向单侧偏移的阴影伪造第二排刻度。

Crossfader 推子帽必须比普通音量推子更宽更高，使用纯黑落影，不得出现绿色或蓝色背光。上下所有刻度均以黑槽边缘为共同基线并紧贴槽体，短刻度与长刻度只允许向外延伸长度不同；黑槽内部保持接近纯黑并用内阴影表达凹陷深度。

Crossfader 下方四路横向音量推子必须使用与 Crossfader 相同的独立黑槽和上下 17 位对称刻度结构，长刻度位于两端、四分位和中心，短刻度紧贴槽体边缘。有效音量不允许把槽体整体染色，只能在纯黑槽内部显示对应通道颜色的细发光芯线；总声音绿、耳机蓝、麦克风 1 紫、麦克风 2 橙的语义色保持不变。

四路横向音量推子帽的外部落影固定为纯黑，不得使用对应通道颜色描边或发光；通道颜色只能存在于槽内有效音量芯线、图标和数值。

曲库普通行与表头、文字预设/暂存工作区、灯光预设卡片及底部导航必须完整使用石墨灰面板、冷白主文字和中性灰次级文字，不得残留偏绿色的普通文本、边框或面板底色。曲库 Deck 身份行和真实播放状态、灯具小色点及设备连接状态仍可使用功能语义色；文字节目模板缩略图内部的实际输出内容颜色不受操作界面主题覆盖。

四路横向音量推子的刻度有效宽度必须按推子帽半宽向左右内缩，使 0 与 100 两端的长刻度分别与推子在最小值和最大值时的中心线精确重合；不得按 input 外框全宽铺设刻度。

计算四路音量推子刻度端点时必须使用推子帽包含边框在内的实际外宽：当前 24px 帽体加左右各 1px 边框，总外宽 26px，因此刻度层左右各内缩 13px，禁止只按内容宽度内缩 12px。

Crossfader 与四路音量推子的 17 根刻度禁止使用 `repeat(17,1fr)` 后把刻度放在网格单元中心，因为这会让首尾刻度额外内缩半个单元。刻度层必须用 `display:flex; justify-content:space-between`，使第一根和第十七根精确落在有效行程两端，其余 15 根在两端之间等距分布。

Crossfader 当前推子帽为 40px 内容宽加左右各 1px 边框，实际外宽 42px，因此其刻度层左右各内缩 21px；四路音量推子继续按 26px 实际外宽内缩 13px。

双屏预览区域的 PGM/PVW 画布结构线、中央分隔线及左右监控轨道边线必须使用中性灰蓝，轨道普通文字和图标使用冷白/中性灰，不得残留绿色结构线或偏绿文字。PGM 角色标签使用钢蓝石墨样式；PVW 编辑提示可保留琥珀语义色，红色 T 形裁切轮廓继续作为编辑安全标识保留。

Deck 顶部横向音量条必须显示随真实声音包络律动的输出电平，不得继续把 Crossfader 百分比直接当作静态填充宽度。电平使用歌曲后台分析生成的 RMS/峰值包络，并乘入对应 Deck 的等功率 Crossfader 增益和总音量，因此浏览器音频与 mpv 引擎使用同一数据源；显示约 30 FPS、快起慢落，暂停或无有效分析数据时平滑归零，禁止使用随机动画或高频 React state 刷新拖慢推子。

四路横向音量推子的上下刻度必须低对比度显示，短/长/中心刻度保持同比例但整体比 Crossfader 更短，当前高度固定为 4/7/9px，并使用半透明中性灰，避免密集白线抢过黑槽、推子帽、通道图标和数值。

推子拖动必须即时改变浏览器音频音量；桌面 mpv 音量写入采用约 30Hz、单批在途且只保留最新值的合并队列，禁止每个 pointer 事件都堆积 IPC。按住 Crossfader 或下方任一横向推子时仅冻结两个 Deck 的电平律动显示，释放后立即恢复；实际音乐播放不得暂停。

首页工作区始终保留 L/C/R/调音台四个显式 Grid 列；单屏与双屏预览状态下第 4 列必须明确为零宽，禁止只声明前三列而让隐藏的调音台工作区生成隐式 `auto` 列、挤压 R 区并在最右侧留下空白。进入调音台模式时才允许第 4 列展开。

音乐管理页必须直接复用首页 `UI-R02 / L` 的同一个真实业务组件及其 Grid 第一列宽度、纵向起点和曲库面板骨架；不是复制或替换成管理版侧栏。点击“音乐管理”后，L 区仍负责真实的 1/2 号 Deck 目标、已发布歌单选择、搜索和装载；从 L 区选取歌单类型时，右侧编辑区同步切换到该歌单。L 区不得被全宽标题下压、不得改成固定像素侧栏，也不得改成纵向歌单管理器。音乐管理标题、功能页签和编辑工作区只占用 L 区右侧的 C+R 区域。

音乐管理的出场和页签切换动画只允许作用于 L 区右侧的 C+R 管理工作区；首页真实 L 区不得参与位移、淡入或闪烁。动画必须短促克制，并在系统启用 `prefers-reduced-motion` 时关闭位移和淡入。

音乐管理右侧不得重复 L 区已有的分类/歌单选择器。右侧前两项固定为“全部歌单”和“分类管理”：“全部歌单”展示完整曲库，并按 `media/audio` 下的真实相对文件夹提供目录分类筛选；歌曲只能明确加入 L 区当前选中的分类，不得自动播放或自动切换分类。“分类管理”必须提供明确的1号/2号曲库管理范围切换，两套数据互不覆盖；星期分类名称固定，节日活动与自定义分类均支持新增、改名、删除和同类型内上下排序。L 区分类按钮右键必须提供上移/下移，并与分类管理共用同一份持久化顺序。

音乐管理状态下，L 区歌曲的排序与移除统一放入歌曲行右键菜单，不得在左键选中后向窄行内继续堆叠按钮。菜单固定提供上移、下移和“从当前列表移除”；边界项禁用无效方向。菜单必须通过窗口根层 Portal 使用真实视口坐标定位，禁止留在带 transform/will-change 的 L 区内部造成鼠标位置偏移。移除只修改当前曲库当前分类的歌曲归属，绝不删除原始音频文件。若移除项正在播放，必须在修改列表前锁定同一分类中的顺位下一首，使用另一 Deck 立即执行约 2.5 秒等功率交叉淡化，完成后暂停被移除歌曲所在 Deck；列表无下一首时只淡出并停止。另一 Deck 已由操作员播放时不得覆盖其歌曲，改为向该 Deck 淡化让位。

L 区歌曲序号表示当前可见列表的顺序，不是歌曲在完整曲库中的全局索引。当前分类和搜索结果都必须从 1 连续编号；右键上移、下移或移除后，序号立即按新的可见顺序重新计算。

Deck 的自动顺播、随机播放以及手动上一首/下一首必须锁定到该 Deck 装载歌曲时的来源分类（曲库号 + 分类 ID），不能读取之后正在浏览的 L 区分类。操作员播放 1号曲库/周一的歌曲后，即使切到周二或2号曲库查看，曲终仍只能进入原周一列表的下一首；只有从另一分类明确装载歌曲，才更新对应 Deck 的来源。搜索只过滤可见行，不改变播放队列；音乐管理右侧“全部歌曲”只允许单曲备歌，禁止成为自动连播队列。来源分类不存在或没有可用下一首时必须停止，绝不回退到完整曲库。

桌面软件冷启动或刷新时两个 Deck 必须按本机当天星期分别备歌：Deck 1 严格读取1号曲库同名星期分类排序第1首，Deck 2 严格读取2号曲库同名星期分类排序第1首，并立即保存各自的来源分类。两个 Deck 必须独立初始化；任一曲库为空、未完成初始化或首个文件仍在媒体扫描中，都不得阻塞另一 Deck。若首行文件尚未进入稳定媒体索引，必须等待后续扫描重试，禁止跳过首行改装第二首。启动和后续媒体扫描均不得再以完整曲库索引 0/1 补位；某一曲库当天分类为空、来源缺失或首行文件不可用时，对应 Deck 保持空且暂停，不得借用另一曲库或完整曲库歌曲。

桌面 mpv 的顺序/随机播放使用双 Deck 自动衔接，禁止等曲终后才在同一 Deck 重新加载造成静音断口。当前歌曲剩余约15秒时把同一来源分类的下一首以暂停、零增益预载到另一 Deck，最后约6秒启动下一首并执行等功率交叉淡化，完成后暂停上一 Deck；顺序播放的分类清单必须形成闭环，末首按相同预载与交叉淡化规则回到首首，不能在末首停播。单曲循环不参与。自动衔接不得改变来源分类、不得进入完整曲库、不得自动变速或变调。只有目标 Deck 未播放且该目标 Deck 未开启 CUE 时，自动系统才可占用它；另一台 Deck 的 CUE 不得错误阻塞目标 Deck。目标 Deck 被手动送主扩后，两台 Deck 转为互不接管的独立播放，原 Deck 曲终仍按自身来源清单在自身继续，不得被自动停止；目标 Deck 正在播放或开启 CUE 时，原 Deck 使用同 Deck 续播兜底。目标 Deck 停止且无 CUE 后，在原 Deck 下一次临近曲终时自动恢复为可接管状态，不要求额外点击交还。手动换歌、上一首、下一首、播放、CUE、播放模式或 Crossfader 操作必须立即取消正在执行的自动衔接；自动交叉淡化中更换目标 Deck 时先在约400ms内平滑恢复原 Deck，再执行人工操作。人工运行状态必须在 Deck 上可见，并明确提示空闲后自动恢复。

应用每次冷启动时，L 区当前分类默认取本机日期对应的周一至周日；启动后仍允许操作员手动选择任意星期、节日或自定义分类，手动选择不得被定时器自动改回。1号曲库与2号曲库切换栏底部必须始终保留贯穿两栏的中性结构分割线，选中曲库可在该线上叠加通道强调色，但不得让未选中一侧看起来缺线。

1号曲库与2号曲库是两套相互独立的完整分类体系，不是同一套分类的两个装载目标。两边分别保存星期、节日、自定义分类、同组排序、歌曲归属、每日计划以及歌曲视频/灯光编辑；切换曲库时恢复该曲库在本次运行中最后手动选择的分类。旧版单曲库持久化数据只迁移进1号曲库，2号曲库初始化为空分类体系，禁止复制或覆盖1号曲库现有歌单数据。

KING Broadcast Control 只作为 Tauri 桌面软件交付和演示，禁止把独立浏览器页面、本地 HTTP 地址或 Sites 部署当成用户可用版本。Vite 浏览器页面仅允许作为内部自动化验收面，验收完成必须关闭，不得主动给用户打开或发送网页预览链接；用户验收应回到 `king-broadcast-control.exe` 桌面窗口。Tauri 内部 WebView 与打包前端资源属于桌面实现细节，不得表述为网页版。

Deck 电平条以 Crossfader 显示百分比作为当前满刻度：Deck 1 上限为 `100-crossfade`，Deck 2 上限为 `crossfade`；歌曲包络必须先独立换算为 0–100，再乘该上限，禁止先把推子当线性增益乘入音频后再做 dB 显示换算。按住 Crossfader 时停止包络动画，两个电平条必须精确停在各自百分比并随推子同步移动；松开后在各自上限内恢复律动。

双屏预览模式的 L/R 侧栏必须各自保留至少 302 CSS px，并在宽屏按约 18vw 扩展、最高 340px；C 区只能使用扣除两侧后的剩余宽度。L 区不得窄于曲库工具栏和“歌曲/歌手/BPM/时长”表格的固有内容宽度，也不得以父级 `overflow:hidden` 裁掉溢出的按钮、时长或 Deck 标识来掩盖列宽错误。

Deck 电平条的亮色刻度纹理必须始终保持固定像素间距，每根亮色竖线对应底层的一根刻度；电平长度只能通过 `clip-path` 从右侧裁切完整纹理，禁止使用 `scaleX()` 压缩整条纹理，否则百分比降低时刻度会错误变密。

现场人声增强必须由独立的 Rust/C++ 实时音频进程承担，禁止让 Tauri UI、Node、Python、离线 AI Worker 或播放器线程承担音频回调。第一阶段严格按 P0→P3 推进：先完成 48kHz float32 Loopback、Qu-16 USB 路由、物理 RTT，再加入实时 F0；在此前不得接入 Pitch Correction 或生成模型并宣称 AI 修音完成。实时回调禁止动态分配、文件/网络/数据库/JSON/日志、互斥锁、模型推理和阻塞操作；控制参数只能经无锁结构或原子快照注入。

音频延迟证据必须区分请求 buffer、驱动实际 buffer、软件估算和物理 RTT。驱动修正或忽略低延迟 buffer 请求时必须记录实际值；只有物理输出→输入回接测量才允许填写 `roundTripMs`，没有 Qu-16/ASIO、2 小时稳定性和异常拔插证据时必须明确标为 `NOT MEASURED`/`NOT EXECUTED`，禁止用合成 benchmark 或回调耗时冒充现场通过。

灯光配置使用可搬运的 `.kinglight` JSON 包，格式标识固定为 `club.king.kinglight`、当前版本 `1`。包内保存 Titan 目标与 Show 身份、KING 0–9 兼容映射、语义效果注册表、自动规则和显示参数；导入必须明确 `executeOnImport=false`，只更新配置并清空本地模拟/调度状态，绝不 Fire/Release Playback。映射绑定到导出时的 Show 名称，当前真机 Show 不一致时必须拒绝触发。未知语义元数据默认 `safeAuto=false`，不得自动猜测 Titan 默认命名 Playback 的用途。

完整 Titan Playback 注册、语义标注、便携包和数字预演放在底部 `Avolites Tiger Touch Pro` 专用栏目；首页灯光区只保留 0–9 快捷位。数字预演默认必须标为离线模拟且不得发送 DMX；未取得 KING CLUB 平面尺寸和真实灯具坐标前只允许示意空间，不得宣称与现场光束覆盖一致。

Qu-16 表计、播放器进度及其他高频运行数据禁止写入最外层 `App` 状态并触发曲库、视频网格和整页重绘。表计必须通过独立外部 store 只刷新调音台子树，并进行最新帧合并；重复的连接状态/心跳必须按值去重。播放器轮询只在播放状态改变或进度达到可见变化阈值时提交 React 状态，确保推子和按钮交互优先于视觉表计刷新。

自动歌曲制作只处理具有有效歌手名称的曲目。媒体标签和 `.kingsong` 元数据都没有有效歌手名，或歌手值为“未知歌手/Unknown Artist”等占位内容时，任务必须标记为 `skipped / missing-artist`，只允许播放，不得进入歌词识别、原唱分离或伴唱制作。文件名明确符合“歌手 - 歌名”时可安全提取歌手，并允许原 `missing-artist` 任务重新排队；仅有歌名时不得猜测歌手。

歌手包采样默认使用耳麦录音输入。音乐管理页必须优先选择真实的耳麦/Realtek 麦克风端点，降低阵列麦克风优先级并排除 Nahimic/VAD 等虚拟输入；操作员选择的录音设备必须持久化，重启后继续使用，除非该设备已经不存在。录制时直接按设备名称打开输入，不能只依赖 Windows 当前默认麦克风。

R1 视频素材卡片的鼠标悬停和键盘聚焦只允许显示普通交互高亮，禁止自动切换 PVW、启动播放或打开新的解码实例；只有明确点击素材才可预选到 PVW。视频卡片禁止直接嵌入 `<video>` 作为缩略图，必须在首次进入可视区域时由后台串行生成低分辨率 JPG 文件并保存到应用数据目录的 `media/cache/video-thumbnails`；源视频未修改时，后续滚动、切页和重启只读取该持久化图片，禁止重新读取原视频或集中解码。

底部“视频管理”和“灯光管理”合并为统一的“演出编排”，音乐管理只保留歌曲项目入口和旧版单关联兼容；Avolites Tiger Touch Pro 仍作为独立硬件映射/控制栏目。演出编排采用用户确认的双监看方案：上半区为 PVW/PGM、Deck 预载/播放状态、Crossfader 跟随和唯一灯光主控；下半区为歌曲锁定波形、段落、V1/V2、图片、文字、灯光多轨时间线。进入编辑器、选择素材或试听时间线不得自动播放歌曲、上屏或触发 Titan。

演出编排项目按歌曲稳定身份独立持久化，格式标识为 `club.king.show-project`、当前版本为 `1`。每个轨道和片段必须有稳定 ID；歌曲音轨锁定不可移动/删除；V1/V2 视频片段可跨轨拖动，图片、文字和灯光只能进入对应类型轨道。所有裁切更新必须约束源出点大于源入点、时间线时长大于零且不超过歌曲时长。保存、恢复和编辑只更新项目数据，禁止隐式调用 Deck 播放、PGM Take 或 Titan Fire。
