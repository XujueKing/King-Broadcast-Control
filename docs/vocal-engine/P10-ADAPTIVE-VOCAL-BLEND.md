# P10：质量驱动的实时真人/修音混合

日期：2026-08-25

状态：`DETERMINISTIC_SOFTWARE_BLEND_PASSED / HUMAN_LISTENING_CALIBRATION_PENDING`

## 目标

P10 使用 P9 的平滑 `Vocal Quality Score` 控制两条实时人声分支：

```text
Mic ─┬─ 192-frame dry delay ───────────────┐
     └─ formant-preserving pitch correct ──┤ linear unity-gain blend ─ dynamics ─ output
                                            ↑
                              P9 quality score / 45 ms rise / 180 ms fall
```

- 唱得好：尽量保留延迟对齐后的真人原声；
- 轻微跑调：连续增加 DSP 修音，不进行硬切换；
- 严重失准：继续增加 DSP 修音占比；
- `repair_candidate` 在 P10 仍然只是 100% DSP 修音上限，不代表生成式替换已经存在。

## 连续映射

默认目标修音占比：

| P9 分数 | 目标修音占比 |
| --- | ---: |
| `85..100` | `0%` |
| `65` | `35%` |
| `40` | `75%` |
| `0` | `100%` |

区间内线性插值，不按 `preserve/gentle/strong/repair_candidate` 硬切。质量下降时用 45 ms 逐采样增加修音；质量恢复时用 180 ms 逐采样减少修音，防止边界抖动和声音突然改变。

## 延迟和增益安全

Formant shifter 固定延迟为 192 frames / 4 ms。P10 使用无分配的固定数组把 dry 分支延迟同样的 192 frames 后再混合，避免未对齐信号造成梳状失真。

混合公式固定为：

```text
output = dry + correctedMix * (corrected - dry)
dryMix + correctedMix = 1
```

不使用 constant-power crossfade，因为 dry 与 corrected 高度相关；线性等增益混合可避免中间位置额外约 3 dB 的相关信号增益。修音分支出现非有限值时，当前 sample 回退到 dry。

## 实时约束

- `run` 必须同时提供 `--enable-pitch-correction --enable-adaptive-blend`；
- 音频线程只更新预分配状态和原子指标，不写文件、不锁、不操作 UI；
- `LatencyMetrics` 发布 `adaptiveVocalBlendEnabled` 和 `correctedMixLatest`；
- `simulate` 生成 `blend.json`，保存每个 P9 hop 的目标/实际修音占比；
- 关闭 P10 时保留 P9 以前的全修音行为，避免无提示改变既有命令语义。

## 软件验证

5 秒确定性 Reference 两遍模拟：

| 用例 | 平均质量分 | 平均修音占比 | 最大修音占比 | P99 |
| --- | ---: | ---: | ---: | ---: |
| 准确演唱 | `83.474` | `3.803%` | `5.112%` | `0.0469 ms` |
| 整体失准 `+100 cents` | `56.396` | `49.968%` | `53.163%` | `0.0465 ms` |

两次运行均为 0 deadline miss、0 非有限修音回退，输出 peak 分别为 `0.3423` 和 `0.4640`，未削波。43 项 Rust 单元/模拟测试全部通过。

这些结果只证明确定性软件路径。尚未完成真人歌手听感标注、Qu-16 USB 物理回送、SLX4 麦克风、耳返延迟与现场 PA A/B，因此不能宣称已经达到专业歌手效果。

## 运行示例

```powershell
cargo run --release -- simulate --seconds 5 `
  --reference artifacts/p10-reference/reference.json `
  --synthetic-detune-cents 100 `
  --enable-adaptive-blend `
  --output-dir artifacts/p10-detuned-100c
```

现场路径仍受 `--arm` 防啸叫门保护：

```powershell
cargo run --release -- run --arm `
  --enable-pitch-correction --enable-adaptive-blend `
  --reference PATH_TO_REFERENCE_JSON `
  --input "INPUT DEVICE" --output "OUTPUT DEVICE" `
  --gain-db -18
```

下一阶段是 P11：可原子切换的人声预设、真实设备电平标定、耳返/主扩分流以及匿名真人 A/B 校准。
