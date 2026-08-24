# P7：低延迟保共振峰修音

日期：2026-08-24

状态：`SOFTWARE_A_B_PASSED / LIVE_DEVICE_PENDING`

## 已接入路径

```text
48 kHz Mic/USB Input
  -> Streaming F0
  -> Reference > Key/Scale > Chromatic
  -> Correction Planner
  -> LPC spectral envelope + shifted excitation
  -> lock-free ring
  -> Output gain / limiter
  -> USB Output
```

移调器只移动 LPC 残差信号，并使用原始声道估计的声道滤波器重建，避免把声道共振峰随音高一起粗暴移动。瞬态会短暂旁路湿声，修正量与干湿比例均平滑变化。

## 实时约束

- 音频回调内不读取文件、不获取锁、不申请堆内存；
- Reference 文件、F0 状态和移调器状态均在开流前创建；
- 修音默认关闭，`run` 必须同时提供 `--arm` 与 `--enable-pitch-correction`；
- 未启用修音时保持原来的直通路径；
- 实时路径不做 RMS 自动匹配，现场增益仍由 Qu-16/系统路由负责。

## 延迟边界

- 移调器固定算法延迟：192 samples / 4.00 ms；
- F0 分析窗：2048 samples / 42.67 ms；这是控制响应历史窗，不是额外串联音频缓冲；
- 128 帧输入、128 帧输出与 256 帧预填充的理论软件路径约为 14.67 ms，再加回调计算；
- 驱动、USB、Qu-16、无线麦克风、DP440 与 PA 的物理往返延迟尚未测量，不能声明现场 `<15 ms` 已通过。

## 软件 A/B

确定性试验使用同一理想参考，将测试人声合成升高 100 cents，并把自然修正上限设为 45 cents：

- 原始 Reference 误差：98.474 cents；
- 控制计划平均修正：44.573 cents；
- 实际输出测得移动：-51.097 cents；
- 处理后 Reference 误差：47.690 cents；
- A/B RMS 均为 -16.792 dBFS；离线匹配增益为 +0.671 dB；
- 平均回调块计算 0.040 ms，P99 0.051 ms，无 deadline miss、NaN 或丢帧。

数值来自软件合成输入，证明控制轨已经真正改变音频，不能代替真人盲听、Qu-16 USB 路由或物理 loopback 证据。
