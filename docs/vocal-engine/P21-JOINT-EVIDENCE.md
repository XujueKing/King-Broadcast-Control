# P21 — USB 输入与 Qu-16 返回联合证据

## 目标

单独看到 USB 麦克风输入电平，不能证明处理后的声音返回到了正确的 Qu-16 通道。P21 使用两条相互独立的只读证据流：

```text
USB / ASIO 输入电平 ─┐
                     ├─ 时间对齐 ─ P19 校准状态机
Qu-16 TCP 返回表计 ──┘
```

## 对齐规则

- 输入证据源只能包含输入通道。
- 返回证据源只能包含返回表计通道。
- 两个来源都必须是 48 kHz 时间基准。
- 每一路输入帧与返回帧最大允许偏差为 960 帧，即 20 ms。
- 超过窗口的旧返回帧会被拒绝并继续等待新帧。
- 返回缺失、来源方向混合、夹具耗尽或时间错误时失败关闭。
- 三路都同步成功才生成 `allLanesSynchronized=true`。

## 离线证据

默认双夹具包含：

- USB 输入索引：2、5、9。
- Qu-16 返回索引：1、4、8。
- 每一路时间偏差：120 帧，即 2.5 ms。
- 最大允许偏差：960 帧，即 20 ms。

验证命令：

```powershell
cargo run --manifest-path vocal-engine/Cargo.toml --release -- `
  replay-joint-evidence `
  --output docs/vocal-engine/evidence/2026-08-25-p21-joint-evidence.json
```

## 安全边界

- 当前输入和返回均来自录制夹具。
- `outputStreamStarted=false`。
- `hardwareReady=false`。
- 生成的路由仍使用 `virtual_signal_trace`。
- 实体 Qu-16、USB Patch、DP440 与 PA 路由尚未由本报告验证。

## 桌面界面

设置页向导显示最大实际偏差与允许偏差，例如 `同步 120/960 帧`。该信息来自联合证据报告，不由前端估算。

## 验证结果

- Vocal Engine：83 项测试通过。
- Tauri：63 项测试通过。
- 前端与命令契约：18 项测试通过。
- Vite 生产构建通过。
