# P0：48 kHz 低延迟 Audio Loopback

日期：2026-08-24  
状态：**代码与非声学验证完成；真机音频验收未完成**

## 已实现

独立 Rust 进程 `vocal-engine` 提供 48 kHz/float32 直通内核。输入、输出回调通过启动前分配的 SPSC 环形缓冲连接；实时回调不进行文件、网络、数据库、JSON、日志、模型调用或锁等待。控制层只读取原子快照并在非实时线程序列化指标。

可观测字段包括：

- 输入/输出实际回调 buffer 毫秒数；
- 平均、最大、P95、P99 回调处理耗时；
- 平均队列延迟；
- underrun、overflow、dropped frames、stream errors 与合计 xruns；
- 请求 buffer 与驱动允许的实际配置 buffer；
- `roundTripMs: null`，直到具有物理回接测量证据。

## 本机证据

2026-08-24 使用 WASAPI 枚举到：

| 方向 | 设备 | 48 kHz float32 | 通道 | 驱动 buffer |
|---|---|---:|---:|---:|
| 输入 | 麦克风阵列 (Realtek(R) Audio) | 是 | 2 | 固定 480 帧 |
| 输出 | 扬声器 (Realtek(R) Audio) | 是 | 2 | 固定 480 帧 |

480 帧在 48 kHz 下是每侧 10 ms，仅输入加输出 buffer 的理论下限已约 20 ms，尚未计入系统、队列、USB/声学路径。因此本机 Realtek 不能作为 `<15 ms RTT` 的通过证据。

系统 ASIO 注册表与 CPAL 枚举均未发现 Qu-16；当前不能执行 Qu-16 USB 输入→PC→Qu-16 返回、真实 RTT、拔 USB、2 小时稳定性和现场 PA fallback 验收。

## 已运行的验证

- `cargo clippy --all-targets -- -D warnings`：通过；
- `cargo test`：5/5 通过；
- 无锁传输内核：128 帧 × 100,000 块，共 12,800,000 帧；本次平均每块 0.000450 ms，占 128 帧实时预算约 0.0169%；
- `run` 未带 `--arm`：按预期拒绝启动，防止误监听啸叫；
- 实际麦克风→扬声器回送：**NOT EXECUTED**；
- 真机物理 RTT：**NOT MEASURED**；
- 连续 2 小时：**NOT EXECUTED**；
- `raw.wav` / `processed.wav`：**NOT APPLICABLE YET**，P0 尚无 DSP，且未安全启动声学回送。

合成 benchmark 只覆盖内存中的传输内核，不包含驱动、调度、USB 或物理 RTT，不能替代真机证据。

## 接入 Qu-16 后的门禁顺序

1. 安装官方 Qu Windows 驱动，USB-B 连接电脑，确认输入和输出端点均可见且设置为 48 kHz。
2. 先在 Qu-16 中建立不会直接反馈到话筒的独立 USB Return；PA 主扩静音，从耳机或安全测试总线开始。
3. 重新保存 `devices` 枚举证据，确认实际 buffer 范围。
4. 以 `--gain-db -18`、10 秒短测启动，再逐步延长；保存 `metrics.json`。
5. P1 完成明确的 Qu USB 路由；P2 使用物理输出→输入回接与相关性测量生成 `latency.json`。
6. 完成 2 小时、拔 USB、kill engine、CPU 过载、故意 underrun 和异常参数测试后，才可宣布 Audio/Latency/Safety 门通过。

