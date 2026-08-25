# P20 — 只读实体电平采集与回放夹具

## 目标

P20 将校准向导与具体音频来源解耦。同一套 P19 状态机可以由录制电平夹具驱动，也可以在现场由 48 kHz float32 输入设备的只读电平流驱动。

## 只读实体适配器

`CpalInputMeterSource`：

- 只枚举并打开指定输入设备。
- 只建立 input stream，不建立 output stream。
- 每个回调只计算各通道绝对峰值并转换为 dBFS。
- 使用有界 `sync_channel`；UI/控制线程过慢时丢弃旧回调，不阻塞音频线程。
- `next_frame` 使用超时读取。
- `stop` 立即释放输入流；对象释放时同样停止。
- 设备不存在、不是 48 kHz float32、超时或流断开均失败关闭。

该适配器当前只负责麦克风输入发现。处理返回的现场确认仍需 Qu-16 网络表计或经过确认的物理回环证据，不能通过创建输出流来假装测量成功。

## 回放夹具

`ReplayMeterSource` 使用带序号、帧位置、方向和逐通道峰值的 JSON 结构。夹具必须明确：

- `physicalCapture=false`
- `inventory.physicalHardware=false`
- 48 kHz
- 序号递增
- 时间不倒退
- 所有峰值有限

夹具截断、时序损坏或冒充物理采集时立即拒绝。

## 验证命令

```powershell
cargo run --manifest-path vocal-engine/Cargo.toml --release -- `
  replay-meter-fixture `
  --output docs/vocal-engine/evidence/2026-08-25-p20-meter-replay.json
```

默认夹具包含 7 帧：三路输入、三路返回以及一次 Mic2 串音。回放结果消耗全部帧，拒绝一次串音，并完成三路虚拟映射。

## 安全结果

- `outputStreamStarted=false`
- `physicalAudioStarted=false`
- `qu16WritesPerformed=false`
- `hardwareReady=false`
- 实体 Qu-16 测试未执行

## 验证结果

- Vocal Engine：79 项测试通过。
- Tauri：63 项测试通过。
- 前端与命令契约：17 项测试通过。
- Vite 生产构建通过。
