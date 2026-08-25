# P19 — 三路现场校准向导状态机

## 已实现

P19 为 Mic1、Mic2、Mic3 建立严格串行的校准状态机：

```text
idle
  → countdown
  → tracing_input
  → tracing_return
  → lane_complete
  → 下一支麦克风
  → complete
```

任何时候只允许一支麦克风处于活动校准状态。三路必须按 Mic1、Mic2、Mic3 的顺序执行，倒计时结束前不接受信号观测。

## 信号接受条件

- 最强通道峰值不得低于 `-36 dBFS`。
- 最强通道与次强通道必须至少相差 `18 dB`。
- 输入阶段只接受输入通道，返回阶段只接受输出通道。
- 选中索引必须存在于本次驱动发现清单。
- 串音、无信号、方向错误和顺序错误只会记录拒绝事件，不会推进状态机。

## 离线演练

```powershell
cargo run --manifest-path vocal-engine/Cargo.toml --release -- `
  simulate-calibration-wizard `
  --output docs/vocal-engine/evidence/2026-08-25-p19-virtual-calibration-wizard.json
```

演练故意在 Mic2 输入阶段制造两个相近峰值。向导拒绝该次观测，保持在 `tracing_input`，随后用唯一信号完成三路映射。

## 安全边界

- 离线向导只生成 `virtual_signal_trace`。
- 离线向导不能生成 `onsite_signal_trace`。
- `physicalAudioStarted=false`。
- `qu16WritesPerformed=false`。
- `hardwareReady=false`。
- 完成离线向导不代表 Qu-16、DP440、功放或 PA 路由已验证。

## 桌面界面

设置页显示三路校准进度、输入/返回绑定、被拒绝的串音次数以及保存状态。现场确认按钮继续锁定，直到后续实体 Qu-16 校准适配器提供真实测量证据。

## 验证

- Vocal Engine：74 项测试通过。
- Tauri：63 项测试通过。
- 前端与命令契约：17 项测试通过。
- Vite 生产构建通过。
- 实体 Qu-16 测试未执行。
