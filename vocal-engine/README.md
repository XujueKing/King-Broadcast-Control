# KING Vocal Engine — P0

这是与 Tauri/React UI、播放器和离线 AI Worker 分离的实时音频进程。当前范围严格限定为：

- 48 kHz、内部 `float32` 的单通道输入到单通道输出；
- 回调之间使用预分配 SPSC 环形缓冲区；
- 回调内只做拷贝、增益、限幅、原子指标更新；
- 输出 buffer、处理耗时、队列延迟、underrun、overflow、dropped frames 和 stream errors；
- 不包含 F0、Pitch Correction、模型推理或 UI 改造。

## 命令

```powershell
cd vocal-engine
cargo run -- devices
cargo run -- bench --block-frames 128 --blocks 100000
cargo run -- simulate --seconds 5 --block-frames 128 `
  --output-dir artifacts\simulation-baseline
```

`simulate` 是不依赖 Qu-16 的虚拟 USB 试验台。默认生成可重复的类人声测试信号；也可以用 `--input-wav PATH` 重放真实演唱，输入必须为 48 kHz WAV。每次生成 `raw.wav`、`processed.wav` 和 `metrics.json`。

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

开始前应关闭扬声器或在 Qu-16 上建立安全的独立 USB Return。没有 `--arm` 时程序拒绝启动。

## 指标边界

`estimatedSoftwarePathMs` 是驱动回调帧数、无锁队列深度及回调处理时间的合计估算，不等于真实声学/电气 RTT。`roundTripMs` 在物理输出回接输入并完成相关性测量之前固定为 `null`。

驱动可忽略或修正请求的 buffer。程序会记录 `bufferFramesRequested` 以及输入、输出各自的 `*BufferFramesConfigured`，并根据实际回调帧数计算 buffer 延迟。
