# Allen & Heath Qu-16 官方手册与实现索引

本目录长期保存 Qu-16 型号包所依据的厂商原版资料，供开发、实施和现场人员离线手工翻阅。`official/` 内 PDF 保持厂商原文件，不改写、不压缩。

## 官方原版文档

- [Qu Mixer Reference Guide AP9372 iss.10](official/Qu-Mixer-Reference-Guide-AP9372_10.pdf) - 92 页完整操作参考手册，适用 Qu Firmware V1.9。
- [Qu MIDI Protocol V1.9](official/Qu_MIDI_Protocol_V1.9.pdf) - MIDI、NRPN 与 Ethernet TCP 控制协议。
- [Qu Windows Driver Help V5.72.0](official/Qu_WindowsDriverHelpV5.72.0_Iss1.pdf) - Windows 10/11 ASIO/WDM 驱动安装与音频端口说明。

官方在线入口：[Qu-16 Resources](https://www.allen-heath.com/hardware/qu/qu-classic/qu-16/resources/)。归档日期：2026-08-23。

## 官方视觉资产

- 顶部连续品牌横梁使用 `ui-prototype/src/assets/hardware/allen-heath-qu16/qu16-brandbar-clean.png`。源图为 Allen & Heath 官方 2800×1867 产品正视图 [`Qu-16-Page.jpg`](https://www.allen-heath.com/content/uploads/2023/01/Qu-16-Page.jpg)，厂商资源入口为 [Qu-16 Resources](https://www.allen-heath.com/hardware/qu/qu-classic/qu-16/resources/)。
- 该 PNG 从未缩放的官方原图按像素矩形 `x=686, y=212, width=1407, height=70` 直接裁切并转存，成品仍为 1407×70；没有重绘、拆分、补字或改变横向比例。裁切一次完整保留左侧 `ALLEN&HEATH` 铭牌、中央双蓝印刷线和右侧 `Qu-16` 铭牌，去掉两端螺钉，并让蓝色印刷图案到左右画布边缘各保留 4px。
- 资产只用于 Qu-16 数字孪生顶部的真机品牌横梁，必须作为一张连续图片按原始宽高比完整显示，禁止拆成 CSS/SVG 近似 Logo、分别拉伸或用 `cover` 再次裁掉两端。真机横梁不包含 `USB-B AUDIO · ETHERNET CONTROL · TCP 51325`；USB-B、Network 与 TCP 连接状态只能在软件状态/设置区显示，不得叠加到该资产上。

## 手工翻阅页码

| 内容 | 参考手册页码 | 软件对应区域 |
| --- | ---: | --- |
| Qu-16 面板总览与区域名称 | 21 | 调音台整页布局 |
| Fader Strip、Mute、Sel、PAFL | 21-22 | 16 路通道条 |
| Master Strip 与 Mix Select | 23 | LR 主推子及右侧 Mix 键 |
| SuperStrip、TouchChannel、Touch Screen | 28 | 上方处理区 |
| Preamp 与 USB-B 输入源 | 29-30 | 前级处理与音频输入配置 |
| Gate、PEQ、Comp、GEQ、Pan | 31-38 | SuperStrip 旋钮和处理页 |
| Touch Screen 控件、TouchChannel、Fn/Edit 键与 Screen Rotary | 46 | 软件触摸屏数字孪生 |
| Network、MIDI over TCP 与 Qu-Pad 连接边界 | 68 | 以太网控制配置 |
| Mix Routing、Sends on Faders | 67-68 | Mix Select 切换逻辑 |
| USB Audio | 75-78 | USB-B 24x22 音频链路 |
| Qu-Pad 无线控制能力与连接方式 | 81-82 | 远程控制边界 |
| Qu-16 触摸屏物理规格 | 92 | 5 英寸 TFT、800x480 |

补充协议索引：`Qu MIDI Protocol V1.9` 第 1 页说明 A&H MIDI Control 的虚拟 MIDI 端口与 MIDI Thru/协议转换职责；第 10 页定义 TCP `51325`、Active Sensing、Get System State 和后续 NRPN 状态推送。

## 真机表计接入

- 在软件“设置 → 调音台型号包”中填写 Qu-16 的以太网 IP 或可解析主机名。程序先发 All Call `Get System State`，核对返回的 `BoxID=1`，再按真机返回的 MIDI Channel 发送 `MeterOn=1`；不能用音频驱动已安装来冒充真机已连接。
- 表计使用协议第 11-12 页的 SysEx `0x12 / 0x13`，解开 7-bitized 数据并按带 `0x8000` 偏移的有符号 `7Q8` 数值换算 dBFS。首个合法的完整 Qu-16 表计帧到达后，界面才显示 `LIVE`；断线、表计超时或连续 3 个坏帧会清空全部灯位并重连，单个瞬态坏帧不会让现场画面闪灭。
- `Sig / 0 / Pk` 是累计式快速峰值指示，电平足够高时三灯可以同时亮：`Sig ≥ -48 dBFS`、`0 ≥ -18 dBFS`、`Pk ≥ -3 dBFS`。参考手册以模拟标称值写作 `Sig=-26 dBu`、`0=0 dBu`、`Pk=削波前 3 dB`，两种标法指向同一组硬件灯语义。
- 输入通道的主显示值取协议 `Post Delay`（处理链末端、推子和 Mute 之前）；`Pk` 取 `Post Preamp / Post PEQ / Post Compressor / Post Delay` 的最大值，以贴合手册的多点过载检测说明。Stereo 通道左右取较高值；Mix Master 使用 `Post Fader`。这是基于公开测点的实现映射，仍需连接实机逐级过载复核。
- 四个 RackFX 数据块的 `Post PEQ L/R` 映射为 `FX1–FX4 Return` 推子前表计。FX1/FX2 的 RackFX 输入 `Send L/R/Mono` 仅在对应效果器保持厂商默认的同名 `Mix→Return` Patch 时等同 FX Send Master；软件通过 `meterRole=rack-fx-input` 明确保留这一边界，不把改接后的效果器输入冒充成独立 FX Send 总线表计。
- GEQ Fader Flip 时，先把协议的 31 段 `20Hz–20kHz` RTA 对齐到 GEQ 的 28 段 `31.5Hz–16kHz`；每帧只选一个最强频段点红色 `Pk` 灯，其余频段三灯全灭，不回退显示普通通道的 `Pk / 0 / Sig`。
- 工程师 L/R 主表在真机 `LIVE` 时直接使用协议的 Monitor L/R（它由实体 Qu-16 自己跟随 PAFL/LR），不以软件本地 PAFL 按钮猜测真机监听源。LR Master 自身仍使用 Main Post Fader 表计。
- 实时帧在桌面桥接层限速为最高 20 FPS，避免表计消息抢占 UI 线程造成推子卡顿；协议读取仍在独立 TCP worker 中持续进行。
- 每次连接分配单调递增的 `sessionId`；停止、切换 IP 与重连在后端串行，旧 Worker 和旧 React cleanup 不能覆盖或停止新会话。

## 真机推子与按键控制

- 当前双向控制范围固定为下半部物理混音层：各 Source/Master 的主推子、Sends on Faders、Mute 与 PAFL。前端只提交语义化白名单 key，后端再编码为协议第 5-6 页定义的 Fader `0x17`、Send Level `0x20`、PAFL `0x51` 和 Mute Note 消息；任意原始 NRPN ID（包括 Remote Shutdown）都不能从 UI 表示或发送。
- Get System State 返回 MIDI Channel 后，程序先接收该通道的初始 NRPN/Note 状态；只有收到同一通道的 End Sync `0x14` 才把控制面标记为 `synced` 并允许写入。推子在前端按约 26 FPS 合并，所有控制仍经表计所用的同一个 TCP `51325` Worker 和连接发送，不创建第二条真机连接。
- 官方公开 MIDI 协议没有 Mix Select、Layer、Sel 或实体屏幕页面导航的远程控制项。软件里的 Mix Select 只切换本地当前总线，并据此选择后续推子写成主 Fader 还是 Send Level；不得把本地导航状态描述成真机按钮同步。虽然 Fader/Send 回读携带目标实体，但不能由此可靠反推真机当前 Layer；软件不得根据回读擅自切换 Layer，以免整组 16 根物理槽位错位。
- TCP `write_all` 成功不等于真机确认。每项写入依次显示为 `queued`、`awaiting-readback`，超过回读窗口后标成 `sent-unconfirmed`；匹配回读才算闭环，不同回读立即以真机值为准。待回读期间界面保留操作员刚设置的值，避免旧快照把推子弹回。
- 每次重连都会增加 `connectionEpoch`，清空旧参数与 pending。上一连接中未发完或未确认的写入一律丢弃，绝不在新连接自动重放，避免现场恢复网络后突然改变音量或静音状态。
- 以上控制链已完成协议编码、混合 MIDI 流解码、会话隔离与自动化测试；仓库当前没有连接实体 Qu-16，因此仍需在目标固件上逐项完成推子电机、Mute/PAFL 回灯、发送总线和断线恢复的真机验收，才能标记为现场验证通过。

## 触摸屏与远程控制边界

- Qu-16 的物理屏幕是 5 英寸彩色 TFT 触摸屏，原生分辨率为 `800x480`；这是硬件显示规格，不代表 Network 端口提供屏幕像素流。
- 厂商参考手册和 MIDI 协议均未定义 framebuffer、屏幕截图或视频镜像接口。Qu-Pad 是独立渲染的远程调音界面；A&H MIDI Control 是电脑端虚拟 MIDI 端口和 MIDI 连接/转换工具，两者都不是物理触摸屏镜像。
- 本软件采用“参数状态数字孪生”：根据 Qu-16 型号定义绘制本地 UI，通过 Get System State、后续 NRPN/SysEx 状态推送及本地控制回写，保持协议可见参数与实体调音台同步；不得将它描述成物理屏幕 framebuffer 镜像。
- 数字孪生只覆盖官方 MIDI 协议公开的参数。仅存在于实体触摸屏的弹窗、文件浏览、固件提示或未公开内部状态，不能承诺逐像素或完整状态复现。
- 控制链路使用后面板 Network 以太网的 MIDI over TCP，客户端端口为 `51325`；MIDI 协议对通用 TCP MIDI 控制器规定同时只允许一个连接。A&H MIDI Control 与本软件直连模式不能同时占用这条通用控制链路。参考手册对 Qu-Pad 的厂商应用连接数另有规定，不能把 Qu-Pad 的名额等同于可增加的通用 TCP 客户端；与 Qu-Pad 并行运行须按目标固件做实机验证，不能仅凭 UI 假定兼容。
- USB-B 可同时承载音频与 MIDI，但本型号方案约定 USB-B 用于 Windows 音频，Network 用于播控参数同步，避免把音频传输、A&H MIDI Control 和 Qu-Pad 的职责混为一体。

## UI 还原约束

- 布局顺序以参考手册第 21 页为准：SuperStrip、内部包含 TouchChannel 的 Touch Screen、Screen Select、Qu-Drive/Monitor；其下是 16 路 Fader Strips、Master Strip、SoftKeys 与 Mix Select。
- 面板功能区使用蓝色边界和分割线，不把不同硬件区域合并成一个通用卡片。
- 实体外形基准：Mute 与 SoftKey 为灰白矩形键，Sel 为绿色椭圆键，PAFL 为灰白圆键；FX1/FX2 为冷白浅蓝椭圆，Mix1–4 为浅青蓝椭圆，Mix5-6/Mix7-8/Mix9-10 与 LR 为饱和蓝椭圆。PAFL、LR、Mix Select 与 SoftKey 的状态只切换键帽中心灯，按钮外壳和外层矩形容器不得随 active、hover 或 pressed 变色或发光。Layers 只有上下两个灰白椭圆实体键，两个键和中间 Custom 各使用键帽外的独立状态灯；Custom 不是第三个按钮。通道与 Master 的 `Pk/0/Sig` 灯从上至下固定为红色、琥珀色、绿色。
- 圆形编码器支持拖动、键盘及鼠标滚轮；`Shift + 滚轮`为五步粗调。
- 圆形编码器必须是按控件圆心和指针角度计算的 360 度旋转控件，不得使用横向 `input[type=range]` 再通过 CSS 伪装成圆形。PEQ 固定为 LF/LM/HM/HF 四列，每列依次为 Width、Freq、Gain 三个旋钮，共用的 `In` 椭圆灯键位于 LM/HM 之间。
- PEQ 的蓝色 `Parametric EQ` 斜切标签在标签下沿接续外框横线，标签右侧露出控制台底板而不是填充一块深色标题背景；三条竖向频段分割线只贯穿旋钮矩阵，不进入底部频段名和公共 `In` 按键区。PEQ 公共 `In` 键保持无中心点并与底边留距；Gate 与 GEQ 椭圆键保留可点击切换的中心指示灯，灭态近黑、亮态红色。
- 本软件中其余带中心点的椭圆键按普通功能键呈现：点击可触发或切换对应处理，但按钮外壳在 off/on/hover/pressed 状态始终保持各自原有的灰白或浅蓝，不使用持续发光或深色选中态；需要状态反馈时只改变中心指示灯。这是桌面 UI 状态表达，不作为实体 Qu-16 灯光结构的声明。Comp 的 `GR` 灯放在旋钮下方；UI 演示阶段由 `Comp In` 点击切换，连接真实 Qu/DSP 状态后应改为显示实际 Gain Reduction。
- Gate/Comp 在右侧上排等宽；GEQ/Pan 在下排约按 35/65 分配，Pan 明显宽于 GEQ。Pan 旋钮锁定正圆，顶部使用 7 个弧形刻度灯（左 3、中心、右 3）表示位置。
- Pan 的手册语义：LR 模式控制通道主声像；FX Send 和 Mono Mix1-4 时禁用；Stereo Mix5-10 时控制通道发送声像；链接输入对时变为 Width 控制。
- 软件触控界面的 SuperStrip 统一以 Gate 旋钮为尺寸基准；Preamp、HPF、PEQ、Gate、Comp 与 Pan 旋钮保持相同直径，避免前方旋钮因密度而缩小。
- 音频固定走后面板 USB-B；软件控制固定走 Network 以太网，MIDI over TCP 端口 `51325`。
