# P13 固定三路 Vocal Engine

## 完成范围

P13 将原来的单路处理实例提升为固定三路处理器：

```text
MIC 1 frame ─→ Vocal Processor 1 ─→ Return 1
MIC 2 frame ─→ Vocal Processor 2 ─→ Return 2
MIC 3 frame ─→ Vocal Processor 3 ─→ Return 3
```

每一路独立保存：

- F0 Tracker 历史；
- Reference/Scale Correction Planner；
- Formant-preserving pitch shifter；
- Vocal Dynamics；
- Vocal Quality Scorer；
- Adaptive dry/corrected blender；
- Atomic Vocal Preset。

处理接口固定接收和返回 `[f32; 3]`，音频帧处理中不创建集合、不写文件、不调用网络，也不使用互斥锁。MIC 1 有输入而 MIC 2/3 为静音时，后两路输出必须保持绝对 0，不能通过共享分析状态产生数字串音。

## Qu-16 多通道后端契约

后端要求：

- Host：ASIO；
- Device hint：`Qu ASIO Driver`；
- Sample rate：48 kHz；
- 默认 block：128 frames；
- 三路 driver input index：未绑定；
- 三路 driver return index：未绑定。

`CH1/CH2/CH3` 是计划中的 Qu-16 物理输入编号，不等同于未经验证的 ASIO 数组索引。P13 会拒绝重复的输入或返回 index，但不会自动填入猜测值。只有现场读取驱动通道表并完成单路信号追踪后，`hardwareReady` 才能成立。

## 三秒确定性模拟

| Lane | 预设 | 合成失谐 | 最新质量分 | 最新修音混合 | 非有限样本 |
| --- | --- | ---: | ---: | ---: | ---: |
| MIC 1 | Natural | 0 cents | 96.235 | 0.0000 | 0 |
| MIC 2 | Professional | +35 cents | 84.340 | 0.0116 | 0 |
| MIC 3 | Strong | -35 cents | 84.302 | 0.0122 | 0 |

性能结果：

- 三路数字串音最大值：`0.0`；
- 128-frame block 预算：`2.6667 ms`；
- 本次平均处理：小于 `0.20 ms/block`；
- 本次 P99：小于 `0.25 ms/block`；
- deadline miss：0；
- 物理音频启动：否。

这是本机确定性软件证据，不是 Qu-16 ASIO、无线麦、耳返或 PA 证据。不同 CPU、驱动线程和真实输入下必须重新测量。

## 下一阶段

P14 继续完成与桌面程序之间的控制/遥测桥：三路预设、输入电平、质量分、修音占比、armed 状态和故障原因进入 Tauri；实时音频仍留在独立 Vocal Engine 进程。实际 ASIO adapter 可以在没有 Qu-16 时先用 mock contract 开发，但 `driverInputIndices` 与 `driverReturnIndices` 必须保持未绑定。

证据：`evidence/2026-08-25-p13-multilane-simulation.json`。
