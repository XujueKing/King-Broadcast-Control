# P15：虚拟 ASIO 路由与故障回退

## 完成结果

P15 在没有连接 Qu-16 的环境下完成三路后端故障演练。它使用明确标记为 `simulation only` 的虚拟路由，不枚举、不打开、也不写入任何物理音频设备。

```text
Virtual Input 0/1/2
        ↓
Three-lane Vocal Engine
        ↓
20 ms failover router ──→ Virtual Return 3/4/5
        ↑
4 ms latency-aligned dry path
```

这些虚拟 index 只是软件测试编号，不代表 Qu-16 ASIO 实际通道映射。

## 回退规则

| 故障 | 软件行为 | 恢复 |
| --- | --- | --- |
| Engine timeout | 使用上一有效输出启动 20 ms 淡变，切到延迟对齐干声 | 引擎恢复后 20 ms 淡回处理声 |
| 非有限处理结果 | 拒绝 NaN/Infinity，保持有限干声输出 | 连续有效结果恢复后淡回 |
| 控制桥断开 | 当前处理声向干声平滑回退 | 控制桥恢复后淡回 |
| 输入断开 | 20 ms 安全淡出；不把残留处理声冒充有效麦克风输入 | 输入恢复后 20 ms 淡入 |

干声软件回退与 Qu-16 内部 direct dry fallback 是两件事。前者已经用确定性软件测试验证，后者仍必须在现场拔 USB/停进程后验证。

## 三路隔离

每个故障场景都额外执行单路探针：MIC1 有信号，MIC2/3 为零。四类故障的最大数字串音均为 `0.0`。

## 3 秒矩阵结果

- 4 类故障全部被识别；
- 所有场景均回退并恢复到处理声；
- 非有限输出样本：0；
- 最大数字串音：0.0；
- 最大逐样本跳变：小于 0.031；
- 64 / 128 / 256 frames 三种 block 均通过；
- 物理音频启动：否；
- Qu-16 ASIO 映射验证：否；
- Qu-16 direct dry fallback 验证：否；
- DP440 实际路由验证：否。

证据：[2026-08-25-p15-virtual-failover.json](evidence/2026-08-25-p15-virtual-failover.json)

## 使用

```powershell
vocal-engine\target\release\king-vocal-engine.exe simulate-failover `
  --seconds 3 `
  --block-frames 128 `
  --output docs\vocal-engine\evidence\p15.json
```

命令不会启动声音。

## 现场仍需完成

1. 读取 Qu ASIO Driver 的真实通道名称与 index；
2. 单路追踪 CH1、CH2、CH3 的 USB Send；
3. 确定三路独立 USB Return，先只进耳机；
4. 停进程、拔 USB，验证 Qu-16 内部干声仍能到达指定安全总线；
5. 核对 DP440 的实际型号、输入输出、配置备份及其在 PA 链路中的位置；
6. 完成物理 RTT、dropout、主扩小音量验收。

在这些步骤完成前，软件仍不得把 `hardwareReady`、`directDryFallbackVerified` 或 `dp440RouteVerified` 标为真。
