# P22 — Qu-16 实时表计快照适配器

## 目标

把桌面端 `qu16_runtime::Qu16MeterSnapshot` 的只读 TCP 表计快照转换为 P21 使用的 Qu-16 返回证据帧。当前阶段只使用录制快照，不连接现场 Qu-16，不启动音频输出，也不发送任何参数写入。

## 数据边界

原生快照字段保持与桌面运行时一致：

- `source`
- `sessionId`
- `connected`
- `state`
- `updatedAtMs`
- `frameSequence`
- `channels`

桥接层另行附加：

- `connectionGeneration`：连接代次，拒绝重连前的旧快照；
- `sampleFramePosition`：与 USB 输入证据共享的 48 kHz 采样时钟位置。

这两个字段不伪装成 Qu-16 驱动原生字段，后续由桌面实时桥在收取快照时提供。

## 失败关闭规则

适配器只接受同时满足以下条件的快照：

1. 来源为 `qu16-tcp-midi`；
2. 会话和连接代次与当前桥一致；
3. `connected=true` 且状态为 `metering`；
4. 快照时间不在未来，年龄不超过 250 ms；
5. `frameSequence` 严格递增；
6. 通道键必须是有效的 `ch-N`，电平必须为有限数。

调用 `disconnect()` 后，当前适配器立即失效，后续快照全部拒绝。重新连接必须创建新代次。

## 录制回放结果

`replay-qu16-meter-adapter` 回放 5 个快照：

- 1 个旧连接代次快照被拒绝；
- 1 个超过 250 ms 的快照被拒绝；
- 3 个有效快照分别形成 Mic1、Mic2、Mic3 的 Qu-16 返回证据。

有效证据继续进入 P21 双流校准，三路最大时差为 120 帧（2.5 ms），低于 960 帧（20 ms）上限。

证据文件：[2026-08-25-p22-qu16-meter-adapter.json](evidence/2026-08-25-p22-qu16-meter-adapter.json)

## 本阶段没有证明的内容

- 没有连接实体 Qu-16；
- 没有验证现场 USB-B 通道编号；
- 没有启动输入或输出音频流；
- 没有向 Qu-16 写入参数；
- `hardwareReady` 保持 `false`。

## 下一阶段

P23 将在桌面 Tauri 进程内把真实 `qu16_runtime` 快照装入桥接信封，并使用单调采样时钟进行对齐。首次现场运行仍只读，断线或超时立即清空证据并阻断校准完成。
