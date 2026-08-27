# KING Vocal Engine — P28

这是与 Tauri/React UI、播放器和离线 AI Worker 分离的实时音频进程。当前范围严格限定为：

- 48 kHz、内部 `float32` 的单通道输入到单通道输出；
- 回调之间使用预分配 SPSC 环形缓冲区；
- 回调内只使用预分配状态，禁止文件 I/O、锁和堆分配；
- 输出 buffer、处理耗时、队列延迟、underrun、overflow、dropped frames 和 stream errors；
- 支持 Reference/Key/Scale 目标、流式 F0、自然修音和保留共振峰的实际移调；
- 支持固定状态的 HPF/Presence EQ、De-esser、Compressor 和 Limiter；
- 输出可解释的 Pitch/Timing/Stability/Voicing/Energy/Confidence 与总质量分；
- 根据质量分平滑混合延迟对齐的真人原声与修音分支；
- P28 可显式加载与歌曲时间轴对齐的原唱分轨，在严重失准或停声时平滑应急补位；
- 歌手本人音色生成、真实 Qu-16/SLX4 驱动闭环和物理 RTT 仍不在已验证范围内。

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

P28 只有同时提供 `--enable-reference-rescue`、`--reference reference.json` 与 `--reference-vocal vocals.flac` 才启用。它在歌曲参考图预计有人声时同时根据真人包络和质量分连续决定补位比例：小声或失准都会提高补位，只有足够响且评分高才退出；无人演唱时补满，间奏始终关闭。参考层以 32 ms 淡入、180 ms 淡出；默认参考增益为 0 dB，但现场首次武装仍建议显式从 -12 dB 低电平开始。分轨在启动实时流之前一次性解码，音频回调内不读文件、不分配内存。示例：

```powershell
cargo run --release -- run --arm `
  --enable-pitch-correction --enable-vocal-quality --enable-adaptive-blend `
  --enable-reference-rescue `
  --reference "C:\path\reference.json" `
  --reference-vocal "C:\path\vocals.flac" `
  --reference-rescue-gain-db -12 `
  --reference-start-delay-ms 0 `
  --input "输入设备完整名称" --output "输出设备完整名称" `
  --gain-db -24
```

这条 P28 路径是“原唱应急补位”，不是歌手本人音色生成：男歌的 `vocals.flac` 仍然是男声，女歌手演唱时若触发会听出男原唱。正式产品默认只对歌手本人实时做 DSP 修音；只有取得本人同意、建立 Vocal Profile 并离线生成同时间轴的理想女声/男声参考后，才允许选择“本人音色补位”。简单升调或 Formant 变换不能可靠地把男原唱变成该女歌手。

P8 默认参数为 80 Hz 高通、3.2 kHz 轻微存在感、5.8 kHz 齿音检测、-18 dBFS/3:1 压缩、2 dB makeup 和 -1 dBFS limiter。实时路径只有显式提供 `--enable-vocal-dynamics` 才启用；未启用时不经过这条处理链。参数预设和无爆音实时切换留到 P11。

P11 已加入 `natural / professional / strong / auto` 四种控制模式。切换请求以一个原子快照进入实时线程，修音强度、死区、最大修正比例、干湿混合和动态处理湿度用 120 ms 曲线连续过渡，不在音频回调中分配内存或加锁。`--vocal-preset` 只在启用了相应人声处理链时产生听感变化。

三支无线麦采用固定的独立控制面模型：CH1 暂记为已确认的 Shure SLX4；CH2/CH3 暂记为待核对的 UHF A/B。三路预设状态互不共享，且三路均明确关闭 48V。当前代码没有把未经现场核对的 Qu-16 USB 返回通道写死；真实多通道 USB 输入、处理后回送、耳返和主扩分流仍需接机验证。

P12 增加只读 `site-check` 和分级接机安全门。扫描仅枚举本机音频端点，不连接或写入 Qu-16，也不启动音频流。接机顺序固定为 `disarmed → input_meter_only → headphone_return → pa_return`；任何回送模式都必须指定唯一麦克风通道并确认 48V 关闭和安全输入增益，耳机回送还要求主扩静音与专用 USB Return 已确认，PA 回送则必须先通过 Qu-16 direct dry fallback。

P13 把 Vocal Engine 核心提升为固定三路逐帧处理器。三路各自拥有完整的 Tracker、Planner、Formant、Dynamics、Quality、Blend 与原子预设状态；`simulate-multilane` 生成三路独立信号，验证通道顺序、非有限值、数字串音和 128-frame 实时预算。Qu ASIO 的 driver input/return index 保持 `null`，必须现场读取后才能绑定，不能用 WASAPI 的 ST1/ST2/ST3 名称猜测多通道路由。

开始前应关闭扬声器或在 Qu-16 上建立安全的独立 USB Return。没有 `--arm` 时程序拒绝启动。

## 指标边界

`estimatedSoftwarePathMs` 是驱动回调帧数、无锁队列深度、回调处理时间及移调器固定延迟的合计估算，不等于真实声学/电气 RTT。`transformAlgorithmicLatencyMs` 当前为 4 ms；`pitchAnalysisWindowMs` 当前为 42.67 ms，它表示控制判断所需历史窗口，不应误写成音频通路固定延迟。`roundTripMs` 在物理输出回接输入并完成相关性测量之前固定为 `null`。

驱动可忽略或修正请求的 buffer。程序会记录 `bufferFramesRequested` 以及输入、输出各自的 `*BufferFramesConfigured`，并根据实际回调帧数计算 buffer 延迟。
