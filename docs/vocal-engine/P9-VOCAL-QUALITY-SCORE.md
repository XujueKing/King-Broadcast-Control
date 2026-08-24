# P9：实时 Vocal Quality Score

日期：2026-08-24

状态：`DETERMINISTIC_SOFTWARE_SCORE_PASSED / HUMAN_CALIBRATION_PENDING`

## 分项与总分

每个 128-frame F0 hop 产生：

- `pitchScore`：相对 Reference，缺少 Reference 时相对最近半音；
- `timingScore`：当前 hop 的“该唱/不该唱”与实际有声/无声是否一致；
- `stabilityScore`：同一目标音内，音高误差相对平滑轨迹的短时偏离；
- `voicingScore`：Reference 人声活动与实际发声状态；
- `energyScore`：人声音量是否处于可用范围；
- `confidenceScore`：F0 检测可信度。

总分固定为：

```text
Pitch      45.0%
Timing     15.0%
Stability  15.0%
Voicing    10.0%
Energy      7.5%
Confidence  7.5%
```

分数下降使用 45 ms，恢复使用 120 ms，避免瞬间跳级。分类阈值可配置，默认：

```text
85..100  preserve
65..85   gentle_correction
40..65   strong_correction
0..40    repair_candidate
```

P9 只评分，不直接修改 DSP 参数。P10 才允许根据平滑分数计算 dry/corrected 混合，并继续使用确定性规则。

## Reference 空白处理

Reference 存在但当前位于间奏/空白段时：

- 歌手保持安静视为正确，不因 F0 confidence 为 0 被判差；
- 在空白段额外发声会降低 Timing 和 Voicing；
- Reference 正在演唱但麦克风无声，会同时降低 Pitch、Timing、Voicing、Energy。

当前 Timing 是 Reference 人声活动的 hop 级对齐，不是字、音素或辅音起始的精密对齐。不能把它描述为完整歌词 timing assist。

## 输出

- `simulate` 始终生成 `quality.json`，保存每个 hop 的六项分数、瞬时总分、平滑总分和等级；
- `metrics.json` 保存均值、最低、最新及四类计数；
- 实时 `run` 使用 `--enable-vocal-quality` 显式开启；启用 Pitch Correction 时自动开启；
- 实时音频线程仅发布原子化的最新总分和等级，不进行 JSON、文件或 UI 操作。

## 软件验证

确定性 5 秒两遍 Reference 试验：

- 原始类人声：平均 `81.702`，全部落在 gentle；
- 同一信号整体升高 100 cents：平均 `56.396`；
- 失准版本 1,824/1,860 个 hop 落在 strong；
- 修音与 P8 同时运行后实测音高移动 `-51.964 cents`；
- 全链 P99 `0.0516 ms`，无 deadline miss、drop 或 NaN。

单元测试另外覆盖准确稳定音、整半音偏差、Reference 漏唱，以及间奏正确静音。

分数尚未使用真人数据校准，不能据此评价具体歌手，也不能作为辞退、录用或生成式替换的自动决策。现场需要匿名 A/B、真人标注与阈值校准。
