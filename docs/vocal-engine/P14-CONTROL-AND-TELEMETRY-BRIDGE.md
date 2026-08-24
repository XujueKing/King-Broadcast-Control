# P14：Vocal Engine 控制与状态桥

## 本阶段结果

P14 把独立 `king-vocal-engine` 进程接入 Tauri 和设置页，但仍严格保持离线安全状态：

- Tauri 通过持久子进程和 NDJSON 标准输入/输出通信，WebView 不进入音频回调。
- 三路 `mic1 / mic2 / mic3` 可分别选择 `natural / professional / strong / auto`，修改一路不会污染另外两路。
- 设置页只显示引擎真实返回的状态；没有实时输入时，峰值、质量和修音混合均显示 `--`，不生成模拟数值。
- 当前固定返回 `calibrationMode=disarmed`、`physicalAudioStarted=false`、`hardwareBound=false`。
- 页面只有“刷新状态”和“保持解除武装”，没有离线启声或武装入口。
- Windows 子进程使用无窗口启动标志，避免重复弹出命令行窗口。

## 三路来源标签

| Lane | 当前标签 | 证据状态 |
| --- | --- | --- |
| `mic1` | Shure SLX4 | 已知设备，现场通道仍待最终核对 |
| `mic2` | UHF Receiver A | 接收器具体型号和 Qu-16 通道待现场核对 |
| `mic3` | UHF Receiver B | 接收器具体型号和 Qu-16 通道待现场核对 |

标签不是 ASIO 路由声明。真正的输入/返回通道绑定仍留给现场 P15 校准流程。

## 控制协议

每行一个 JSON 请求和响应，请求带递增 `id`：

```json
{"id":1,"command":"status"}
{"id":2,"command":"set_preset","lane":"mic2","preset":"strong"}
{"id":3,"command":"disarm"}
```

支持命令：

- `status`
- `set_preset`
- `evaluate_arm`（只做安全门评估，不改变真实状态）
- `disarm`

协议错误会返回结构化错误，进程继续服务。Tauri 发现管道失效时最多重启一次控制进程。

## 线程边界

```text
React 设置页
  -> Tauri command
    -> VocalRuntimeBridge mutex
      -> king-vocal-engine control-stdio
        -> atomic preset request / read-only status

独立实时音频线程（P15 现场后启用）
  -> 只读取原子快照
  -> 不读 UI、不写文件、不等待 IPC
```

## 已验证

- Vocal Engine：`cargo fmt --check`、Clippy、59 项测试、Release 构建通过。
- Tauri：`cargo check`、59 项库测试通过。
- 前端：6 项状态归一化、安全显示和 Tauri 接线测试通过，Vite production build 通过。
- 手工 NDJSON 验证：只改变 `mic2` 预设；三次响应均保持解除武装、未绑定硬件、未启动物理音频。

Tauri 全库 Clippy 仍被既有 `mpv_runtime.rs`、`qu16_control.rs`、`qu16_runtime.rs`、`waveform.rs` 和 `lib.rs` 的 8 项旧警告阻断；本阶段新增 `vocal_runtime.rs` 未产生对应告警。

## 下一步 P15

到现场连接 Qu-16 后，先做只读设备与通道枚举，再按安全门逐级验证：输入表计、耳机返回、最后才是 PA 返回。任何一步都必须能一键解除武装，并保留未经处理的干声回退。
