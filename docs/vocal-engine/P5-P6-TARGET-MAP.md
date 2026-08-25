# P5/P6：Key-Aware Target 与 Reference Vocal Map

日期：2026-08-24
状态：`TARGET_SIMULATION_PASSED / AUDIO_TRANSFORM_NOT_IMPLEMENTED`

## P5 Key/Scale-aware

P5 支持 12 个主音及 Major/Natural Minor 音阶。修正规划器只在允许的 pitch class 中选择最近目标，并继续使用 P4 的 confidence、deadband、hysteresis、最大修正和 attack/release。

示例：C Major 允许 `C D E F G A B`；输入稳定落在 C# 时，不再把 C# 当成合法目标，而会选择距离最近的 C 或 D。Key-aware 能排除调外音，但仍无法判断两个调内音中此刻歌曲真正需要哪一个。

## P6 Reference Vocal Map

制作阶段对分离出的原唱人声执行 P3 F0 分析，然后将连续、相同的目标音压缩成时间段：

```json
{
  "schemaVersion": 1,
  "sampleRate": 48000,
  "hopFrames": 128,
  "segments": [
    {
      "startSample": 1024,
      "endSample": 4096,
      "midiNote": 56,
      "targetHz": 207.65234,
      "confidence": 0.99
    }
  ]
}
```

现场查询只按当前伴奏样本位置在只读 segment 表中定位，不运行 MOSS、不读取磁盘、不解析 JSON，也不动态分配。文件在歌曲载入时由非实时线程校验并加载，目标优先级固定为：

```text
Reference Vocal Map > Key/Scale > Chromatic
```

低置信度、无声和参考空白处不会强拉声音。参考段缺失时才使用 Key/Scale；没有歌曲 Key 时再回退 Chromatic。

## 两遍模拟证据

### 制作遍

- 输入：2 秒、196 Hz ±10 Hz 类人声参考；
- F0 点：735；
- 压缩结果：38 个 Reference segments；
- 输出：`reference.json`。

### 演唱遍

- 使用同一信号，但故意整体升高 100 cents；
- Reference 命中：735/735；
- 平均识别偏差：98.47 cents；
- 平均平滑修正计划：43.87 cents；
- 最大修正计划：44.99 cents，受默认 45 cents 安全上限保护；
- P99：0.0539 ms/128 帧；
- deadline miss：0。

这证明 Reference 能识别普通 Chromatic 模式无法识别的“准确唱到相邻错误半音”。它尚未证明声音已经被自然修正，因为 `processed.wav` 仍保持 0 dB bypass。

## 歌曲包集成

桌面制作队列 v6 会在分离人声轨仍存在时，以 48 kHz/128 帧 hop 离线生成 Reference Vocal Map，并将紧凑 `reference.json` 写入歌曲资产。`.kingsong` 导出把它作为 `analysis/reference.json` 携带；播放版导入时校验歌曲指纹、采样率、时间轴和 BLAKE3 数据块后解包。播放版客户机读取已经生成的参考图，不需要 NVIDIA、Python、分离模型或 MOSS。

Reference Map 必须携带歌曲内容指纹、时间轴版本和音频 trim/offset。导入、重新编码或更换音源导致指纹/时长不一致时禁止静默套用旧参考图。

## 下一门

下一步不是生成式补声，而是让已经随歌曲落地的 Reference 控制轨驱动实际低延迟移调，同时加入瞬态保护和 Formant preservation。必须输出响度匹配的 raw/processed A/B，并验证颤音、滑音、假声和辅音没有被拉成机械声。
