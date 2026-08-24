# P11 人声预设与三麦独立控制面

## 本阶段完成

P11 把补音控制收敛为四种模式：

| 模式 | 目标 |
| --- | --- |
| Natural / 自然修音 | 高真人保留、低修正、较宽死区、轻动态处理 |
| Professional / 专业增强 | 中等修正、质量驱动的干湿混合、中等动态稳定 |
| Strong / 强力修音 | 高修正、较窄死区、较强动态稳定 |
| Auto / 自动 | 根据实时质量分数选择上述目标，但仍经过平滑器 |

控制线程只写入一个带 revision 的 `AtomicU64` 快照。音频线程读取完整快照后，用 120 ms 的逐采样曲线平滑以下参数：

- Pitch correction strength
- Deadband cents
- Maximum correction scale
- Corrected voice mix scale
- Dynamics wet mix

因此不存在分别写多个参数时读到“半套新参数、半套旧参数”的状态，也没有互斥锁、文件 I/O 或实时线程内存分配。

## 三支麦克风控制面

| Vocal Lane | Qu-16 输入计划 | 接收器标记 | 当前证据状态 | 48V |
| --- | ---: | --- | --- | --- |
| MIC 1 | CH1 | Shure SLX4 | 接收器型号已确认；物理路由待最终核对 | 关闭 |
| MIC 2 | CH2 | UHF Receiver A | 暂定；需核对接收器背板和 Qu 路由 | 关闭 |
| MIC 3 | CH3 | UHF Receiver B | 暂定；需核对接收器背板和 Qu 路由 | 关闭 |

`ThreeLanePresetBank` 为每路持有独立原子状态。MIC 2 切换 Strong 不会改变 MIC 1 或 MIC 3。后续为每一路建立实际音频处理实例时，也必须各自持有 PitchTracker、QualityScorer、CorrectionPlanner、Formant Shifter、Dynamics 和 Blender 状态，禁止把两支麦先混合再识别。

## 有意没有写死的部分

当前只完成可验证的软件控制面和单路实时处理接入，未宣称完成真实三路 Qu-16 USB 回环。原因是以下事实仍需接机读取：

1. Windows 驱动向 CPAL 暴露的 Qu-16 输入/输出通道顺序。
2. CH1/CH2/CH3 的 Direct Out tap 点与 USB Send 映射。
3. 处理后人声回送到哪些备用 Qu-16 通道，避免与当前 ST3 音乐 USB 返回冲突。
4. 歌手耳返 Mix 与 LR 主扩的分流、实际 RTT 和故障旁路。
5. UHF 双通道接收器的准确型号、独立输出接口及电平类型。

这些项目不能从一段建议文字推定为现场事实。接机前不会自动改 Qu-16 路由，也不会打开任何无线接收器通道的 48V。

## 验证门

- 原子请求以同一 revision 被实时端读取。
- Natural 到 Strong 的参数逐采样最大步进小于 `0.0002`。
- 1 秒后切换收敛误差小于 `0.001`。
- 三路控制状态隔离。
- Auto 的质量分档也经过同一平滑器。
- 全部无线接收器计划均为 `phantomPower: false`。
- Clippy `-D warnings`、完整测试和 Release 构建通过。

## 下一步 P12 接机门

先备份 Qu-16 Scene/Show，再读取 USB Send/Return 和 Mix 路由。只在耳机或静音主扩条件下，从 MIC 1 单路开始标定；确认无反馈、无削波、掉线时 Direct Qu 安全路径仍有声后，再复制到 MIC 2/3。三路同时启用之前必须分别测 RTT、噪声底、输入峰值和处理后峰值。
