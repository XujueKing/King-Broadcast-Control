# P17 — ASIO 通道发现与安全映射

## 目标

P17 不假设 Qu-16 的 `CH1` 必然等于驱动索引 `0`。它先枚举驱动通道，再逐路发送/观察唯一测试信号，保存名称、索引、方向和证据，最后生成三路 Vocal Engine 映射。

固定业务通道仍为：

- Mic1 → 计划 Qu-16 CH1（Shure SLX4，现场路由待核验）
- Mic2 → 计划 Qu-16 CH2（UHF A，设备接口和路由待核验）
- Mic3 → 计划 Qu-16 CH3（UHF B，设备接口和路由待核验）

## 安全规则

- 只读发现阶段不写调音台参数。
- 每次只追踪一路，避免把相邻 ASIO 通道误认为目标。
- 输入索引、返回索引、名称和方向必须与发现清单完全一致。
- 采样率必须为 48 kHz。
- 虚拟信号只能证明流程和结构，`hardwareReady` 必须保持 `false`。
- 只有实体 Qu-16 已连接、三路均完成现场信号追踪、USB 返回也已验证，才能保存 `onsite_signal_trace` 并标记硬件可用。
- DP440 及下游功放/音箱不属于本阶段的通道发现范围，不能根据产品名称推断其路由。

## 离线验证

```powershell
cargo run --manifest-path vocal-engine/Cargo.toml --release -- discover-routing-virtual `
  --output docs/vocal-engine/evidence/2026-08-25-p17-virtual-routing.json
```

虚拟清单故意使用不连续索引 `2/5/9` 和 `1/4/8`，用来阻止代码形成“通道号等于数组位置”的错误假设。报告同时明确：无硬件写入、无音频输出、无通道歧义。

## 现场待做

1. 确认 Allen & Heath ASIO 驱动名称和 48 kHz 状态。
2. Qu-16 主输出保持静音或使用安全监听链路。
3. 逐支麦克风单独讲话，记录唯一输入峰值通道。
4. 逐路验证处理后 USB 返回，不允许同时开放三路测试音。
5. 保存现场映射 JSON 和照片/路由证据，再解除 `hardwareReady` 阻断。
