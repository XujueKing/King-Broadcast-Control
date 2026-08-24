# P8：实时人声动态处理链

日期：2026-08-24

状态：`SOFTWARE_SIGNAL_TEST_PASSED / LIVE_DEVICE_PENDING`

## 信号顺序

```text
Pitch/Formant output or dry input
  -> 80 Hz high-pass
  -> 3.2 kHz presence EQ
  -> 5.8 kHz split-band de-esser
  -> compressor
  -> limiter
  -> lock-free output ring
```

默认参数偏自然，不以“更响”冒充“更好”：

- Presence：+1.5 dB；
- De-esser：-24 dBFS，4:1；只衰减检测到的高频分量；
- Compressor：-18 dBFS，3:1，10 ms attack，90 ms release；
- Makeup：+2 dB；
- Limiter：-1 dBFS ceiling，快速 attack，80 ms release。

## 实时实现

- Rust 固定状态 IIR、envelope follower 和 gain computer；
- 构造阶段计算系数，回调内无文件 I/O、锁或堆分配；
- Dynamics 不使用 look-ahead，不新增固定音频缓冲延迟；
- 非有限输入被替换为安全样本，最终输出受 limiter ceiling 约束；
- 实时开关为 `--enable-vocal-dynamics`，默认旁路；修音和 Dynamics 可分别启用。

## 验证

自动信号测试覆盖：

- 30 Hz 次低频相对 500 Hz 人声频段被明显衰减；
- 8 kHz 齿音信号触发 De-esser；
- 0.95 peak 强信号触发 Compressor/Limiter，输出不越过 -1 dBFS；
- NaN 与正负 Infinity 不会进入输出；
- 全项目 30 项测试、Clippy `-D warnings` 和 release build 通过。

5 秒全链模拟（Reference 修音 + P8）结果：

- 240,000 samples / 1,875 blocks；
- mean 0.0429 ms，P99 0.0553 ms，max 0.1308 ms；
- deadline miss、drop、NaN 均为 0；
- Compressor 最大衰减 4.405 dB；
- 实际音高移动 -51.964 cents，证明 P8 没有切断 P7；
- A/B 离线 RMS 匹配后两侧均为 -17.031 dBFS。

这些结果仅证明软件链和确定性信号行为。真人齿音、呼吸、爆破音、无线麦克风、Qu-16 USB、DP440/PA 与真实 RTT 必须现场测量，当前不能标为硬件通过。
