# KING Vocal Engine — P10

这是与 Tauri/React UI、播放器和离线 AI Worker 分离的实时音频进程。当前范围严格限定为：

- 48 kHz、内部 `float32` 的单通道输入到单通道输出；
- 回调之间使用预分配 SPSC 环形缓冲区；
- 回调内只使用预分配状态，禁止文件 I/O、锁和堆分配；
- 输出 buffer、处理耗时、队列延迟、underrun、overflow、dropped frames 和 stream errors；
- 支持 Reference/Key/Scale 目标、流式 F0、自然修音和保留共振峰的实际移调；
- 支持固定状态的 HPF/Presence EQ、De-esser、Compressor 和 Limiter；
- 输出可解释的 Pitch/Timing/Stability/Voicing/Energy/Confidence 与总质量分；
- 根据质量分平滑混合延迟对齐的真人原声与修音分支；
- 生成式重建、真实 Qu-16/SLX4 驱动闭环和物理 RTT 仍不在已验证范围内。

## 命令

```powershell
cd vocal-engine
cargo run -- devices
cargo run -- bench --block-frames 128 --blocks 100000
cargo run -- simulate --seconds 5 --block-frames 128 `
  --enable-vocal-dynamics --output-dir artifacts\simulation-p8
```

`simulate` 是不依赖 Qu-16 的虚拟 USB 试验台。默认生成可重复的类人声测试信号；也可以用 `--input-wav PATH` 重放真实演唱，输入必须为 48 kHz WAV。每次生成 `raw.wav`、`processed.wav`、`metrics.json`、流式 F0 轨迹 `pitch.json`、P4 修正控制轨 `correction.json`、P9 分项评分轨 `quality.json` 和 P10 混合轨 `blend.json`。

P4 控制参数可在模拟时调整：

```powershell
cargo run -- simulate --seconds 5 `
  --correction-strength 0.75 `
  --deadband-cents 8 `
  --max-correction-cents 45
```

`correction.json` 保存目标音与修正量计划；`processed.wav` 默认已经执行保留共振峰的实际移调。A/B 基准会做离线 RMS 匹配，避免把音量差误认为音质提升。需要只看控制轨时可加 `--bypass-transform`。

P5 Key/Scale 约束：

```powershell
cargo run -- simulate --key C --scale major `
  --output-dir artifacts\p5-c-major
```

P6 Reference 两遍流程：

```powershell
# 制作阶段：从理想/原唱人声生成 reference.json
cargo run -- simulate --seconds 5 --output-dir artifacts\reference-ideal

# 演唱阶段：读取同一时间轴参考；+100 cents 仅用于确定性测试
cargo run -- simulate --seconds 5 `
  --synthetic-detune-cents 100 `
  --reference artifacts\reference-ideal\reference.json `
  --output-dir artifacts\reference-singer
```

目标优先级固定为 `Reference > Key/Scale > Chromatic`。Reference 不覆盖的空白、间奏或低置信度区域才回退到 Key/Scale 或 Chromatic。

故障模式用于提前开发 fallback：

```powershell
cargo run -- simulate --fault underrun --output-dir artifacts\simulation-underrun
cargo run -- simulate --fault disconnect --output-dir artifacts\simulation-disconnect
cargo run -- simulate --fault cpu-overload --output-dir artifacts\simulation-overload
```

模拟结果只允许标记为 `SIMULATION_PASSED` 或 `EXPECTED_FAULT_OBSERVED`，不能替代 Qu-16 驱动、USB 路由和物理 RTT 证据。

真实回送具有啸叫风险，必须显式解锁：

```powershell
cargo run --release -- run --arm `
  --input "输入设备完整名称" `
  --output "输出设备完整名称" `
  --input-channel 0 --output-channel 0 `
  --buffer-frames 128 --gain-db -18 `
  --seconds 10 --metrics artifacts\metrics.json
```

实时修音必须再显式打开一次：

```powershell
cargo run --release -- run --arm --enable-pitch-correction `
  --enable-adaptive-blend `
  --input "输入设备完整名称" --output "输出设备完整名称" `
  --reference artifacts\reference-ideal\reference.json `
  --correction-strength 0.75 --deadband-cents 8 `
  --max-correction-cents 45 --enable-vocal-dynamics --gain-db -18
```

没有 Reference 时可使用 `--key C --scale major`；优先级仍为 `Reference > Key/Scale > Chromatic`。实时路径不做自动增益匹配，以免改变现场增益结构。

只监测演唱质量而不打开修音时可加 `--enable-vocal-quality`。打开实时修音时评分自动启用，最新总分与等级通过实时指标发布；详细逐 hop 分项只在模拟/录制证据中写入 JSON，不在音频线程写文件。

P10 只有显式提供 `--enable-adaptive-blend` 才启用。原声分支会先延迟 192 帧，与修音器固定 4 ms 延迟对齐，再做线性等增益交叉混合：质量分高于 85 时保持真人原声；下降到 65、40 和 0 分时，目标修音占比分别连续增加到 35%、75% 和 100%。修音占比使用 45 ms 上升、180 ms 下降，避免等级边界抖动、突变和爆音。P10 只混合真人与 DSP 修音，不包含生成式重建。

P8 默认参数为 80 Hz 高通、3.2 kHz 轻微存在感、5.8 kHz 齿音检测、-18 dBFS/3:1 压缩、2 dB makeup 和 -1 dBFS limiter。实时路径只有显式提供 `--enable-vocal-dynamics` 才启用；未启用时不经过这条处理链。参数预设和无爆音实时切换留到 P11。

开始前应关闭扬声器或在 Qu-16 上建立安全的独立 USB Return。没有 `--arm` 时程序拒绝启动。

## 指标边界

`estimatedSoftwarePathMs` 是驱动回调帧数、无锁队列深度、回调处理时间及移调器固定延迟的合计估算，不等于真实声学/电气 RTT。`transformAlgorithmicLatencyMs` 当前为 4 ms；`pitchAnalysisWindowMs` 当前为 42.67 ms，它表示控制判断所需历史窗口，不应误写成音频通路固定延迟。`roundTripMs` 在物理输出回接输入并完成相关性测量之前固定为 `null`。

驱动可忽略或修正请求的 buffer。程序会记录 `bufferFramesRequested` 以及输入、输出各自的 `*BufferFramesConfigured`，并根据实际回调帧数计算 buffer 延迟。
