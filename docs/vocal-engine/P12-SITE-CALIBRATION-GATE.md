# P12 现场接机与校准安全门

## 当前结果

P12 首先建立只读设备扫描和不可绕过的接机状态机，不直接打开人声回送。

2026-08-25 本机扫描结果：

- 音频 Host：WASAPI；
- Qu-16 USB 输入端点：未检测到；
- Qu-16 USB 返回端点：未检测到；
- 当前状态：`disarmed`；
- Qu-16 写操作：0；
- 音频输出启动：否。

这与 USB-B 已拔出的现场状态一致。它不否定 2026-08-24 已保存的驱动和 USB 设备证据，只表示本次扫描时设备不在线。

## 四级状态

| 状态 | 允许的行为 | 硬门 |
| --- | --- | --- |
| `disarmed` | 只读设备枚举 | 无音频流、无写操作 |
| `input_meter_only` | 选择一支麦，只读取输入 | 唯一 Lane、48V 关闭、安全 Gain |
| `headphone_return` | 处理后声音仅回耳机验证 | 上述条件 + 耳机确认 + 主扩静音 + 专用 USB Return |
| `pa_return` | 允许进入主扩验收 | 上述路由 + Direct Qu dry fallback 已验证 |

状态机不会因为检测到 Qu-16 就自动升级。所有确认都必须来自当前现场操作，旧证据不能自动替代本次安全确认。

## 三路顺序

1. MIC 1 / CH1 / Shure SLX4：首个校准对象。
2. MIC 2 / CH2 / UHF A：必须先核对接收器背板独立输出。
3. MIC 3 / CH3 / UHF B：必须先核对接收器背板独立输出。

禁止同时武装多路。每支麦分别记录输入噪声、说话峰值、演唱峰值、F0 置信度、处理后峰值和 dropout，再进入下一路。

## 当前阻塞项

- Qu-16 USB 输入/返回端点当前不在线；
- USB Send 通道映射未验证；
- USB Return 专用通道未验证；
- Qu-16 内部 direct dry fallback 未验证；
- 物理往返延迟未测量；
- UHF 接收器准确型号与独立输出未验证。

## 下次接线后的执行顺序

1. 保持主扩 Mute，插回 USB-B。
2. 运行 `site-check`，确认输入和返回端点同时出现。
3. 备份当前 Qu-16 Scene/Show。
4. 确认 CH1 48V 关闭、Gain 安全，只进入 `input_meter_only`。
5. 确认专用 USB Return 后进入 `headphone_return`，不走 LR/PA。
6. 拔 USB/停进程验证 direct dry fallback。
7. 物理回接测 RTT，不能用软件估算代替。
8. 最后才允许小音量 `pa_return` 和真人匿名 A/B。

证据文件：`evidence/2026-08-25-p12-site-readiness.json`。
