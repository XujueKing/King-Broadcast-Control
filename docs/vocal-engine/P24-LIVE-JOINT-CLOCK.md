# P24 — USB/Qu-16 共享 48kHz 时钟与实时证据配对

## 完成范围

P24 只实现音频后端，不新增或修改 UI。

USB 输入表计原来使用从零开始的本地帧计数；现在在只读输入流启动时建立 `Usb48kClockAnchor`：

```text
absoluteFrame = startUnixMs × 48 + localFrameOffset
```

P23 的 Qu-16 TCP 表计也按 `updatedAtMs × 48` 投射到相同时间轴，因此两类证据可以按采样帧位置配对，而不是按到达顺序猜测。

## 实时匹配器

`LiveJointEvidenceMatcher` 分别接收：

- USB 输入 `MeterFrame`；
- P23 Qu-16 返回 `MeterFrame + connectionGeneration`。

匹配规则：

- 最大时间偏差：960 帧，即 20 ms；
- 最大排队时间：250 ms；
- 队列各自最多 32 帧；
- 返回连接代次变化时清空两侧旧队列；
- Qu-16 断线时立即清空证据并令 `evidenceLive=false`；
- 输入、返回方向错误时拒绝；
- 不启动输出流，不写 Qu-16。

## 录制回放结果

三路有效配对：

| Lane | USB 帧位置 | Qu-16 帧位置 | 偏差 |
| --- | ---: | ---: | ---: |
| Mic1 | 48,000,000 | 48,000,096 | 96 帧 / 2 ms |
| Mic2 | 48,004,800 | 48,004,848 | 48 帧 / 1 ms |
| Mic3 | 48,009,600 | 48,009,720 | 120 帧 / 2.5 ms |

回放同时验证：

- 1 个超出 20 ms 的返回帧被拒绝；
- 1 个超过 250 ms 的输入帧超时清除；
- 1 次 Qu-16 断线清空证据；
- 三个有效配对继续驱动 P21 联合校准并完成三路映射；
- 最终保持 `hardwareReady=false`。

## 验证结果

- 99 项 Vocal Engine 测试全部通过；
- Clippy `-D warnings` 通过；
- Release 构建通过；
- 证据：[2026-08-25-p24-live-joint-clock.json](evidence/2026-08-25-p24-live-joint-clock.json)

## 尚未执行

- 没有连接实体 Qu-16 USB-B；
- Windows/Qu ASIO 驱动的回调时钟与系统时钟偏差尚未测量；
- 当前共享时钟是软件纪元，不是硬件采样时钟同步；
- 没有物理输出到输入回接，RTT 仍为 `NOT MEASURED`；
- 没有启动 PA 或耳返输出。

## 下一阶段

P25 继续只做后端：为共享时钟增加滑动漂移估计与偏移校正，使长时间运行时能够识别 USB 时钟与 TCP 时间戳之间的缓慢偏移；超过安全校正范围时失败关闭，不隐式拉伸音频。
