# P16：故障看门狗遥测与界面状态

## 完成结果

P16 将 P15 的回退路由状态通过无锁原子快照发布给控制协议，并接入设置页。音频路径不调用 UI、不等待 IPC、不写文件；控制线程只读取最近一次状态转换。

## 状态模型

| 状态 | 页面文字 | 含义 |
| --- | --- | --- |
| `inactive` | 看门狗未启动 | 当前没有物理音频流或实时数据 |
| `processed` | 处理声运行 | 三路处理链正常 |
| `dry_fallback` | 正在使用干声回退 | 超时、异常结果或控制桥断开 |
| `recovering` | 正在恢复处理声 | 20 ms 平滑淡回过程中 |
| `input_unavailable` | 麦克风输入不可用 | 输入源断开，执行安全淡出 |

故障原因独立记录：

- `engine_timeout`
- `invalid_processed_output`
- `control_bridge_disconnect`
- `input_unavailable`

## 实时线程约束

```text
ThreeLaneFailoverRouter
        │ 仅在状态转换时
        ▼
单个 AtomicU64（状态、原因、fresh、revision 一致打包）
        │ 无锁快照
        ▼
control-stdio → Tauri → React 设置页
```

- 音频处理不使用 Mutex；
- 相同状态不会逐样本重复发布；
- UI 对未知状态降级为 `inactive`；
- `fresh=false` 时不会显示正在运行或正在回退；
- 无硬件时固定返回 `inactive / revision=0`，所有实时表计保持 `--`。

## 验证

- Vocal Engine：64 项测试、Clippy、Release 构建通过；
- Tauri：`cargo check` 和 59 项库测试通过；
- 前端：8 项状态归一化、安全显示与接线测试通过；
- Vite production build 通过；
- 四类故障各产生 4 次有效状态转换，最终均回到 `processed`；
- 故障矩阵所有输出有限、最大串音 0、物理音频未启动。

证据：[2026-08-25-p16-watchdog-telemetry.json](evidence/2026-08-25-p16-watchdog-telemetry.json)

## 当前界面行为

现在这台未接 Qu-16 的开发机只会看到：

```text
离线控制 / 未武装
看门狗未启动
未连接物理音频，当前没有实时状态
```

这不是故障，而是当前真实状态。只有以后实际音频线程发布原子快照，页面才允许显示处理声、回退或输入断开。

## 下一步 P17

建立现场通道发现与校准记录：读取 ASIO 通道列表、逐路信号追踪、保存可审核映射，但仍先保持 `input_meter_only`，不开放 PA Return。
