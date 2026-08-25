# P23 — 桌面 Qu-16 实时表计桥

## 完成范围

P23 将桌面端现有 `qu16_runtime::Qu16MeterSnapshot` 串接到 P22 只读适配器。此阶段只增加后端桥、Tauri 命令和事件，不修改校准区 UI、布局或样式。

实时路径：

```text
Qu-16 TCP 51325 meter worker
  -> Qu16MeterSnapshot
  -> VocalMeterBridge
  -> DesktopQu16MeterBridge
  -> Qu16ReturnMeterAdapter
  -> read-only MeterFrame / bridge status
```

桌面进程发布 `vocal-qu16-meter-evidence` 事件，并提供：

- `vocal_qu16_meter_bridge_status`
- `vocal_replay_desktop_qu16_bridge`

目前没有 UI 消费这些接口；后续界面必须在用户提供布局方案后再接入。

## 安全行为

- Qu-16 `sessionId` 变化时建立新连接代次；
- 同一会话进入 `reconnecting/stopped/error` 后，下一次 `metering` 必须建立新代次；
- 断线立即清除上一帧序号与采样位置；
- 快照超过 250 ms、来自未来、乱序或重复时拒绝；
- `connected` 只表示 TCP 传输状态，只有有效新鲜帧才会令 `evidenceLive=true`；
- 桌面原生 `updatedAtMs` 映射为 48 kHz 共享时间轴；P24 再把 USB 输入捕获锚定到同一时间基准；
- 不启动输出流、不写 Qu-16、不会解除 Vocal Engine 武装阻断。

## 验证

- Vocal Engine：94 项测试通过；
- Tauri 后端：64 项测试通过；
- 桌面命令静态测试：2 项通过；
- Vocal Engine Clippy `-D warnings` 通过；
- Tauri 全仓 Clippy 仍被 8 个既存警告阻断，均位于 P23 未修改的旧代码路径。

录制回放包含连接、有效表计、断线重连、第二代有效表计和过期表计。最终统计为 2 个接受、3 个拒绝、2 个连接代次。

证据：[2026-08-25-p23-desktop-qu16-bridge.json](evidence/2026-08-25-p23-desktop-qu16-bridge.json)

## 尚未执行

- 未连接实体 Qu-16；
- 未验证真实 TCP 快照速率与现场抖动；
- 未把 USB-B 输入捕获接到共同采样时钟；
- 未做物理音频 RTT；
- `hardwareReady=false`。

## 下一阶段

P24 只做音频后端：给 USB 输入表计增加同一 48 kHz 时间基准，把实时 USB 输入帧与本桥的 Qu-16 返回帧汇入 P21 联合校准器。仍先使用录制双流做断线、漂移和超时测试，不做 UI。
