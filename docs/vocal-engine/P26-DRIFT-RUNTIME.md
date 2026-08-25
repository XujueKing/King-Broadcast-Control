# P26 — 长期漂移运行控制器与有界遥测

## 完成范围

P26 只实现 Vocal Engine 后端，不新增或修改 UI。

P25 的 `DriftAwareLiveJointMatcher` 现在由 `DriftRuntimeController` 长期持有。控制器负责接收 USB 输入证据和 Qu-16 返回证据，并把当前状态发布到固定大小的遥测快照中。

## 运行状态

遥测状态只包含四种：

- `disconnected`：没有可用的 Qu-16 返回连接；
- `acquiring`：连接存在，但新代次尚未积累 5 个有效观测；
- `locked`：漂移模型已锁定，证据可以用于后续联合判断；
- `unsafe`：漂移、时钟顺序或证据边界异常，已失败关闭。

每次发布都会增加 `revision`。快照只保留当前值和累计计数，不保存随运行时间增长的事件列表，因此控制面可以长期轮询而不会造成无界内存增长。

## 重连规则

- 连接代次变化时清空旧漂移模型；
- 断线立即发布 `return_disconnected`，并令 `evidenceLive=false`；
- 重连后状态回到 `acquiring`；
- 新代次重新积累 5 个有效观测后才进入 `locked`；
- 旧代次的锁定状态不会沿用到新连接；
- 超范围漂移发布具体故障原因并进入 `unsafe`。

## 控制面接入

`VocalControlStatus` 新增 `clockDrift` 字段。`control-stdio` 的 `status` 请求可以轮询：

- 当前连接代次；
- 已见连接代次数；
- 锁定次数和断线次数；
- 匹配证据数；
- 接受/拒绝观测数；
- 估计漂移 ppm；
- 最新残差；
- 当前故障原因；
- `evidenceLive`。

这个接入仍是只读控制面，不会启动音频输出或写入 Qu-16。

## 确定性回放

回放状态链：

```text
disconnected
  -> generation 1 locked
  -> return disconnected
  -> generation 2 acquiring
  -> generation 2 locked
  -> drift_rate_out_of_range
  -> unsafe
```

最终证据：

- 见过 2 个连接代次；
- 完成 2 次独立锁定；
- 记录 1 次断线；
- 匹配 12 对有效证据；
- 超范围漂移被拒绝并发布 `drift_rate_out_of_range`；
- 最终 `evidenceLive=false`；
- `outputStreamStarted=false`；
- `qu16WritesPerformed=false`；
- `audioResamplingPerformed=false`；
- `hardwareReady=false`。

## 验证结果

- 109 项 Vocal Engine 测试全部通过；
- 覆盖固定大小快照、修订号、断线原因、重连重新锁定、控制面轮询和异常失败关闭；
- 修正 P13 测试中的 Windows 墙钟抖动误判：性能数字仍记录，但单元测试不再要求每个非实时模拟块都达到硬实时期限；
- Clippy `-D warnings` 通过；
- Release 构建通过；
- 证据：[2026-08-25-p26-drift-runtime.json](evidence/2026-08-25-p26-drift-runtime.json)

## 尚未执行

- 没有连接实体 Qu-16 USB-B；
- 没有启动实体 ASIO 输入/输出线程；
- 没有验证现场 TCP 表计与 USB 回调的真实重连时序；
- 没有物理 PA 或耳返输出。

## 下一阶段

P27 继续只做后端：建立“输出授权门”。只有输入路由验证、漂移锁定、干声回退和安全电平全部同时有效时，才生成可撤销的输出授权；任一条件失效立即撤销，默认仍不实际开启 PA。
