# P4-A：Chromatic Pitch Correction Control Track

日期：2026-08-24  
状态：`CONTROL_SIMULATION_PASSED / AUDIO_TRANSFORM_NOT_IMPLEMENTED`

## 当前完成内容

P4-A 根据 P3 的 voiced F0 生成实时修正控制轨，不改变音频：

- 把高置信度 F0 映射到最近的十二平均律半音；
- 输出目标 MIDI、目标 Hz、带符号 cents error、期望/平滑修正量和 correction percent；
- 默认 confidence 门为 0.72，低置信度和无声直接 bypass；
- 默认 8 cents deadband，保留轻微自然摆动；
- 默认 75% strength、最大 45 cents，避免过强瞬时拉音；
- 半音边界使用 12 cents target hysteresis，避免目标音来回抖动；
- 18 ms attack、55 ms release，目标丢失后平滑退回 0；
- 修正规划器构造后逐帧无动态内存分配。

每次虚拟 Qu-16 重放生成 `correction.json`。`processed.wav` 当前继续保持 0 dB bypass；必须等移调与 Formant 保护实现并通过响度匹配 A/B，才能真正修改音频。

## 模拟证据

2 秒、48 kHz、128 帧、196 Hz ±10 Hz 类人声测试：

| 指标 | 结果 |
|---|---:|
| 修正决策 | 735 |
| Active | 690 |
| Deadband | 45 |
| Bypassed | 0 |
| 平均绝对音高偏差 | 28.46 cents |
| 平均平滑修正量 | 10.88 cents |
| 最大平滑修正量 | 24.85 cents |
| 全链处理 P99 | 0.0827 ms/128 帧 |
| Deadline miss | 0 |

自动测试覆盖 +25 cents、-50 cents、deadband、最大修正限制、低 confidence、静音、半音边界 hysteresis 和异常频率。

## 必须公开的能力边界

纯 chromatic 模式只知道“最近哪个半音”，不知道歌曲本来应该唱哪个音。歌手若准确地唱到错误的相邻半音，即相对正确旋律偏差恰好 ±100 cents，P4-A 会认为该相邻音本身是准确的，不能把它拉回原旋律。

因此后续必须依次加入：

1. P5 Key/Scale-aware：排除调外音，但仍不能解决调内唱错音；
2. P6 Reference Melody-aware：使用歌曲提前制作的旋律时间轴判断此刻的正确音符；
3. 修正行为分类：颤音、滑音、转音、说话与噪声不使用同一拉音规则；
4. 实际移调与 Formant preservation，再做响度匹配盲听。

这条边界也是“普通人唱错整句”最终需要 Reference-Guided Repair，而不是只依赖 Auto-Tune 的原因。

