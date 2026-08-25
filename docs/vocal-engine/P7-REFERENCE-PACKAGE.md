# P7：Reference Vocal Map 制作与便携包

日期：2026-08-24

状态：`SOFTWARE_ROUND_TRIP_PASSED / HARDWARE_PENDING`

## 制作路径

新制作流水线版本为 `king-audio-ai-moss-v6`：

```text
原曲
  -> BS-RoFormer 人声/伴奏分离
  -> vocals.flac
  -> 48 kHz pYIN 离线 F0
  -> 音符迟滞与连续段压缩
  -> reference.json
```

参考图固定使用 48 kHz 和 128 帧 hop，并携带：

- 原曲内容指纹；
- 人声轨总样本数；
- 时间轴 offset；
- 生成器版本与分离器 profile；
- 每个目标段的起止样本、MIDI 音符、Hz 与置信度。

同一歌曲如果更换分离模型配置或参考图生成器，Worker 会重建参考图，不复用旧结果。

## `.kingsong` 兼容策略

KSG1 容器版本不变。旧包继续包含原唱、伴奏、LRC 和原生时间戳四项；新包增加第五项：

```text
analysis/reference.json
```

`referenceFile` 是可选 manifest 字段，因此旧包仍能导入。对于 v6 新制作结果，导出时缺少参考图会明确报错，避免发出表面“已制作”但无法进行参考修音的包。

导入前后执行：

- 容器条目路径白名单和数量/大小上限；
- 每个数据块 BLAKE3 校验；
- 原曲内容指纹校验；
- Reference schema、48 kHz、歌曲指纹、段时间轴与参数范围校验。

## 验证结果

- Python Worker：19 项测试通过；
- 真实 48 kHz FLAC 正弦输入：440 Hz 被写成 MIDI 69；
- Rust `.kingsong`：新五条目导出、校验、导入和本地解包通过；
- Vocal Engine：21 项测试通过。

以上是软件与虚拟输入证据，不是 Qu-16、SLX4、DP440 或现场 PA 的硬件闭环证据。
