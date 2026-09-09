# KING CLUB 软件审计 · 2026-09-09

本轮由 GPT-6 审计。软件已打开，首页、演出编排界面可运行；源码构建成功，但发现 **12 项问题：3 项 P1、9 项 P2**。当前版本还不能作为已完成现场验收的交付版本，优先处理播放器阻塞、灯光暂停和显示模式三个问题。

本报告是审计结果，问题尚未修复。未修改业务源码，未创建分支、提交或推送；复现程序和日志位于 `tmp/audit-20260909/`。

## 范围和版本

| 项目 | 本轮证据 |
| --- | --- |
| 仓库 | `D:\WEB3_AI\KINGCLUB-Broadcast-Control` |
| 分支 / HEAD | `main` / `9ec9ba47283cd727dea4c24972f86ec10cf3705e` |
| 启动程序 | `ui-prototype/src-tauri/target/release/king-broadcast-control.exe` |
| EXE 修改时间 | 2026-09-08 21:23:47 +08:00 |
| EXE SHA-256 | `219BCA4BBF87E3D1D944CBBD2A9F629C305DCF7E5A4900B6DDF8B7553E89B215` |
| 进程 | PID 6080，窗口响应正常；审计结束保持打开 |
| 实际界面状态 | NVIDIA 全功能版标识；两个 Deck 未装载；首页 PGM 黑屏；单屏 C1 预览；Titan 显示连接失败 |
| 审查范围 | 桌面启动/打包、双 Deck/mpv、PGM/PVW、曲库与歌曲包、AI 调度、人声引擎、Qu-16 控制、Titan 跟拍、演出编排、依赖与测试 |
| 验证方式 | 源码调用链检查、现有测试、真实 mpv 静音测试、独立命名管道故障注入、真实窗口检查、mock 灯控/存储复现、依赖公告核对 |

当前审计机器并非用户的 i5-10400F / 8GB / RX550 / Windows 10 酒吧电脑。本轮不提供该设备的帧率、内存余量或现场延迟合格结论。

## P1：优先修复

### F01 · mpv 响应读取没有超时，一路失联会拖住两个 Deck 的控制

**位置：** [mpv_runtime.rs:511](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/mpv_runtime.rs:511)，共享锁见同文件 65、649、767、782 行。

`send_command()` 的两秒超时仅覆盖连接。连接成功后，`BufReader::read_line()` 可以无限等待；外层加载/跳转的 deadline 也无法打断这次读取。加载、音量、暂停、状态读取等路径都持有同一个 `MpvManager` 锁。

**触发和影响：** 某个 mpv 实例仍保留管道连接但不返回响应时，该 Deck 的操作不结束，另一个 Deck 的推子、暂停、状态轮询也会等待同一个锁；关闭程序时的 `shutdown_all` 同样依赖该锁。这不等于界面每次都会冻结，但控制调用会无法完成。

**已复现：** 独立 Rust 程序直接 `include!` 当前生产模块，连接本地审计专用管道；服务端收到请求后不应答。等待 **6,500ms** 后调用仍未返回，主动关闭该测试管道才返回断开错误。未挂起或终止真实播放器。

**修复方向：** 对整个请求加入可中断的读写 deadline；按实例隔离串行控制，避免持有全局管理锁等待 I/O；断开、超时、退出必须能结束等待。补充“预载 Deck 不响应时另一 Deck 仍可调音量/暂停”的故障测试。

同类风险还见 [vocal_runtime.rs:349](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/vocal_runtime.rs:349)：子进程 stdout 读取也没有 deadline。本轮只对 mpv 做了故障注入，人声路径为源码证据。

### F02 · 暂停联动不能撤销排队中的灯光命令

**位置：** [App.jsx:2554](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src/App.jsx:2554)，排队执行 2572–2597，暂停处理 2708–2724。

`lightingEnabled` 只在入队前检查，真正调用 Titan 前不再核对当前开关或控制代次。暂停 effect 清理的是模拟/Playback 状态，没有取消加特林 pending，也不能阻止已经等待公共命令队列的闭包。`cancelPending()` 当前只在启动光束短秀时调用。

**已复现：** 用生产 `updateGatling` 回调和生产 latest-only 队列，阻塞公共队列，排入两拍，再模拟 React 切换为暂停。新请求被拒绝，但解除阻塞后，先前两条 `titan_pulse_gatling` 仍执行。所有 `invoke` 均为 mock。

**影响：** 操作员已按暂停，灯具仍可能继续变化；旧节拍可能晚于当前音乐。光束 `safety-off` 也进入同一公共队列，而后端六排短秀没有中断检查，因此关闭联动后的收光不能优先执行。单独撤销“光束布防”允许当前短秀结束是现有界面约定，不单独列为缺陷。

**修复方向：** 为联动会话建立可失效的代次，执行前再次核对；暂停时取消待发任务；为强制收光提供优先且可中断的路径，不能只把它追加到队尾。

### F03 · 启动无条件切换 Windows 为扩展桌面

**位置：** [lib.rs:1104](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/lib.rs:1104)，启动调用见 [lib.rs:2281](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/lib.rs:2281)。

每次启动执行 `DisplaySwitch.exe /extend`，随后固定等待 1.5 秒。没有先判断用户现有显示模式，也没有由操作员触发该动作。

**触发和影响：** 酒吧电脑已有复制屏、投影机或处理器输入配置时，打开软件就可能改变显示拓扑并干扰现场画面。仓库 `AGENTS.md` 明确要求只检测/适配第二屏，不强制改变 Windows 显示模式。

**证据级别：** 启动调用链已确认；本轮单屏环境没有复现多屏切换后的现场后果。

**修复方向：** 默认只检测现有显示器；如需协助设置扩展模式，放到明确的操作员入口；保留输出排除主控屏及单屏隐藏输出规则。

## P2：功能、交付和开发环境问题

### F04 · 新跟拍脉冲漏掉速度参数

**位置：** [App.jsx:2575](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src/App.jsx:2575)，节拍调用见 4408–4413；[titan_runtime.rs:787](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/titan_runtime.rs:787)。

节拍计算仍输出 `speedValue`，但 `source === "rhythm"` 分支调用 `titan_pulse_gatling` 时只传亮度和脉冲时长；后端脉冲也不写速度。正常更新速度的旧路径被绕过。

**已复现：** 80 BPM 重拍计算速度 **0.18**，实际 mock invoke 参数中没有 `speedValue`。初始化则仍写入基线 **0.361**。因此慢歌可以改变明暗，运动速度却不会按该节拍计算调整。

**修复方向：** 给脉冲/音乐状态变化恢复明确的速度更新路径，同时保留低延迟缓存；用集成断言核对最终 invoke 参数，不能只测试算法返回值。

### F05 · 视频取色失败后被错误记成成功，相同颜色不会重试

**位置：** [App.jsx:4492](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src/App.jsx:4492)。

4500 行在发送前就更新 `lastAppliedFamily`。随后若光束忙碌、离线、调用失败，或颜色任务被新节拍替换，返回 `false` 也不回滚标记；4499 行继续屏蔽相同颜色。

**已复现：** 连续五次蓝色采样，mock 控制返回失败；只尝试发送一次，但状态仍记为蓝色已应用。

**修复方向：** 只在当前媒体/颜色请求确认成功后更新已应用标记；失败保持可重试，区分待发送颜色和已确认颜色。

### F06 · 编排写入失败仍显示“已保存”

**位置：** [ShowEditorWorkspace.jsx:112](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src/ShowEditorWorkspace.jsx:112)。

`localStorage.setItem` 出错被空 `catch` 吞掉，之后无条件 `setSaved(true)`。

**已复现：** mock 存储抛出 `QuotaExceededError`，没有完成写入，界面保存标记仍变为 `true`。用户随后离开或重启，会丢失以为已经保存的编排。

**修复方向：** 仅写入成功后标记保存；失败保留未保存状态并给出可理解的错误/导出入口。

### F07 · 演出编排的播放与 PGM 监看仍有示例实现

**位置：** [ShowEditorWorkspace.jsx:56](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src/ShowEditorWorkspace.jsx:56)，另见 72–75、93–94、169、182、188 行。

`currentTime` 固定为 `Math.min(duration,94)`；播放按钮只改变 `timelinePlaying` 图标，没有推进时间或执行片段。PGM/PVW 对视频和黑屏使用固定示例图片；“直播输出”时间写死。底栏 `60fps`、`Deck 2 已准备`、`安全锁定` 同样是固定文本。

**界面复现：** 首页真实 PGM 为黑屏、两个 Deck 都未装载；进入编排却显示彩色舞台 PGM，底栏称 Deck 2 已准备。12:56:59 点击时间线播放后，12:57:14 仍停在 **01:34**，按钮已显示暂停。随后恢复暂停。

**影响：** 操作员无法用此页面确认真实输出、待播状态或编排执行结果。此问题限于演出编排页面，不能据此说首页实际视频/Deck 都是模拟。

**修复方向：** 接入实际 PGM/PVW 和编辑预览时钟；未接通的功能明确标为预览/未实现；状态必须来自实际数据，编排预览与现场执行保持独立。

### F08 · 编排允许零长度源片段

**位置：** [show-project.js:75](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src/show-project.js:75)。

`sourceIn` 能等于项目时长；此时 `sourceOut` 的下界为 `sourceIn + .1`，上界却仍是项目时长，下界大于上界，最终得到相等的入点和出点。

**已复现：** 342 秒项目设置入点/出点为 342，`updateShowClip` 接受并返回 `{ sourceIn:342, sourceOut:342 }`。不满足 `sourceOut > sourceIn`，并且目前校验用歌曲时长代替素材自身时长。

**修复方向：** 保存稳定素材身份与素材真实时长，先检查边界可行性，再约束入出点；无有效长度时拒绝编辑或明确调整。

### F09 · 每次启动重复完整解包 inbox 中已经导入的歌曲

**位置：** [kingsong.rs:567](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/kingsong.rs:567)、[kingsong.rs:673](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/kingsong.rs:673)，启动入口 [lib.rs:2291](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/lib.rs:2291)。

`import_inbox` 每次枚举所有包，没有已导入标记。`import_song` 先复制所有条目到 staging、校验原唱，602 行以后才判断本机是否已经完成同一导入。启动 setup 同步调用整个过程。

**触发和影响：** 用户长期把已导入的大批歌曲包保留在 inbox 时，每次启动都会重复读写全量数据、占临时磁盘空间，并阻塞启动完成。8GB / 224GB SSD 的目标机器尤其需要避免这种工作量。

**证据级别：** 源码确认执行顺序；本轮没有用真实曲库做大包压力测试，也没有删除或搬走用户歌曲。

**修复方向：** 后台执行导入，记录已验证的包身份/状态；保持必要完整性验证，避免每次重新解包；保留用户源文件。

### F10 · 安装包没有闭合 AI/人声运行环境，NVIDIA 标识不能代表全功能就绪

**位置：** [tauri.conf.json:60](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/tauri.conf.json:60)、[ai_worker.rs:219](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/ai_worker.rs:219)、[vocal_runtime.rs:514](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/vocal_runtime.rs:514)、[runtime_capability.rs:62](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/src-tauri/src/runtime_capability.rs:62)。

资源声明包含 mpv、libmpv、KGMA 解码器和许可证，没有 Python/模型或 `king-vocal-engine.exe`。AI 发现路径固定从编译时项目目录定位 `.venv-audio-ai` 和 `ai-worker/worker.py`；人声执行器依赖另行提供的同目录文件、环境变量或开发目录。硬件探测只要识别出 NVIDIA，就设置 `ai_processing_available = true`。

**触发和影响：** 全新机器只安装现有安装包时，可能显示全功能版，但 AI/人声子程序不可用。无 NVIDIA 播放机进入 player 模式的源码分支存在；这并不证明歌曲参考补音所需的独立人声程序已部署。

**修复方向：** 区分硬件能力、运行环境安装、模型可用和真实自检结果；提供可迁移的程序定位/安装流程，并把播放版实际需要的执行文件列入交付清单。

### F11 · 当前打开的 EXE 与本轮源码构建资源不一致

**证据：** EXE 二进制中找到 `styles-49XLR9rj.js`；同一工作区执行 `npm run build:web` 生成 `styles-s2zYKw69.js`。运行程序时间戳为 9 月 8 日 21:23:47，HEAD 提交时间为当日 21:26:00。

当前运行界面与本轮源码测试不是同一个前端构建产物，不能把源码测试通过直接当作这个 EXE 已通过验收。不同指纹证明资源身份不同；本轮没有逐条反编译旧包，不能据此列出旧包遗漏的全部修改。

**修复方向：** 修复完成后统一 `npm run desktop:build`，记录提交/包哈希，启动新产物做验证，再交付。仅运行前端构建不会更新已经打开的 EXE。

### F12 · Windows 开发服务器暴露于网络，使用的 Vite 有已知文件读取漏洞

**位置：** [vite.config.mjs:19](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/vite.config.mjs:19)、[package.json:55](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/package.json:55)。

`npm audit` 报告 **5 个受影响依赖包：4 high、1 moderate**：Vite、PostCSS、nanoid、Browserslist、baseline-browser-mapping。数量指包，不等于五个独立漏洞。

最直接的环境暴露是 Vite **6.4.2** 加 `host: "0.0.0.0"`。官方公告确认，在 Windows/相关卷条件下，网络可达的开发服务器可绕过 `server.fs.deny` 读取允许目录中的敏感文件，6.4.3 已修复该项。见 [Vite 官方安全公告 GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)。

**影响边界：** 运行 `npm run dev` / Tauri 开发模式且满足公告条件时存在风险；本轮没有尝试读取密钥，也不把开发工具漏洞等同于正式 EXE 已被攻破。其他包的公告和受影响版本详见原始审计 JSON。

**修复方向：** 默认绑定回环地址，更新受影响依赖和 lockfile，核对当前全部公告后运行构建/测试；不能只升级 Vite 就宣称五项全部消失。

## 测试结果

| 检查 | 结果 | 实际覆盖/限制 |
| --- | --- | --- |
| 前端 Node 测试 | **163 项，162 通过、1 失败** | `tests/*.test.mjs`，排除依赖桌面会话的 `tauri-*` 和媒体浏览器集成测试 |
| 桌面 Rust `cargo test --locked --lib` | **115 通过** | 含数据、协议及运行时单元测试；无 fixture 的条件集成测试会提前返回 |
| 人声 Rust `cargo test --locked --lib` | **126 通过** | 算法/协议/故障逻辑，不是现场 ASIO/声学验收 |
| AI Worker Python unittest | **24 通过** | 使用现有 `.venv-audio-ai` |
| Vocal Generator Python unittest | **3 通过** | 使用现有 `.venv-vocal-generator` |
| 真实 mpv 条件集成测试，补充执行 | **1 通过** | 指定两份本地 48kHz 双声道静音 WAV，实跑加载、播放、跳转、暂停、换源、音量状态；测试构建强制 `--ao=null` |
| 本轮前端缺陷复现 | **5 组均复现** | 排队灯光暂停、速度漏传、取色不重试、保存失败、零长度片段；使用生产函数和 mock I/O |
| IPC 故障注入 | **复现等待不超时** | 编译未修改生产模块；审计专用管道，不连接真实 mpv |
| `npm run build:web` | **通过** | 前端 4610 模块；主 JS 663.94kB / gzip 202.06kB；大 chunk 警告本身不证明卡顿 |
| `npm audit --json` | **未通过** | 4 high、1 moderate；无 critical |
| 正式程序窗口 | **打开且响应** | 实查首页和演出编排；未启动 Deck 音频 |

唯一前端失败为 [kgma-playback-only.test.mjs:14](D:/WEB3_AI/KINGCLUB-Broadcast-Control/ui-prototype/tests/kgma-playback-only.test.mjs:14) 的过时源码正则：仍要求直接出现 `runtimeCapability.aiProcessingAvailable ? nextAudio : []`。当前源码通过 `shouldQueueAudioAiAnalysis(...)` 得到 `audioAiQueueAllowed`，同时考虑持久化制作开关，并在 3258 行用于入队。该失败不能当作 KGMA 无法播放的证据，但测试应改为验证实际启停行为。

测试未重复计为新的独立单元总数：补跑的真实 mpv 测试已经包含在 115 项的名称中，只是本次显式提供 fixture 才执行其真实播放器路径。

## 仍需现场或目标机器验证

1. **灯光端到端延迟：** 目前真实时钟轮询周期为 160ms，不能据此声称灯具 160ms 内必然响应。此前记录的 `200/200、202ms` 仅说明一次 HTTP 调用及程序等待耗时，不是音乐起拍到实际灯光变化的测量；本轮窗口灯控离线，没有复测该设备。应在受控、已核验灯具上记录歌曲拍点、发送时间及实际光变化，评估延迟和抖动。
2. **现场听感/声路：** 静音测试不能验证 Qu-16 USB/WASAPI、DP 处理器、功放、音箱中的噪声、爆音、啸叫或真实往返延迟。日志正常不能替代听音和输出采集。
3. **双屏和低配负载：** 需要在目标 Win10 / RX550 / 8GB 机器上验证双 Deck、歌词、视频和双屏并发，以及长时间运行。当前 PGM 视频仍有两个 WebView 播放实例的过渡实现，不能当作单 libmpv 双渲染面已完成。
4. **干净机器安装：** WebView2、厂商音频驱动、mpv/解码器、人声执行文件及播放包迁移需要安装后自检。不能用本机已有开发环境证明安装包齐全。
5. **未执行的检查：** 桌面 CDP 集成测试所需 `127.0.0.1:9229` 当前不可达；未为测试重启正式程序。未做物理灯光/混音器写入验收、8GB 压力测试、跨小时稳定性测试、完整 Rust/Python 依赖漏洞扫描或渗透测试。

## 建议处理顺序

先修 F01–F03，建立可超时、可取消、不会改变显示拓扑的基础控制；随后一起修 F04–F05，验证灯光最终发送参数和节拍时序；再修 F06–F10 及开发依赖问题。最后重建桌面包并记录版本，完成目标酒吧电脑和已核验设备的验收。

## 本机证据

- [测试与构建日志目录](D:/WEB3_AI/KINGCLUB-Broadcast-Control/tmp/audit-20260909)
- [前端复现程序](D:/WEB3_AI/KINGCLUB-Broadcast-Control/tmp/audit-20260909/reproduce.mjs) / [结果 JSON](D:/WEB3_AI/KINGCLUB-Broadcast-Control/tmp/audit-20260909/reproduction-results.json)
- [IPC 复现程序](D:/WEB3_AI/KINGCLUB-Broadcast-Control/tmp/audit-20260909/probe-ipc.mjs) / [结果 JSON](D:/WEB3_AI/KINGCLUB-Broadcast-Control/tmp/audit-20260909/ipc-timeout-result.json)
- [真实 mpv 测试日志](D:/WEB3_AI/KINGCLUB-Broadcast-Control/tmp/audit-20260909/real-mpv-test.log)
- [依赖审计 JSON](D:/WEB3_AI/KINGCLUB-Broadcast-Control/tmp/audit-20260909/npm-audit.json)
- [程序版本与进程快照](D:/WEB3_AI/KINGCLUB-Broadcast-Control/tmp/audit-20260909/runtime-snapshot.json)
