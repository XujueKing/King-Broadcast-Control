# 项目文档

本目录是项目决策的唯一记录入口。任何功能开发前，应先完成对应需求、架构和 UI 决策。

## 文档导航

1. [产品需求](01-product-requirements.md) — 使用场景、角色、设备、核心流程与范围
2. [技术选型与架构](02-architecture.md) — 客户端形态、通信、数据、可靠性与部署方案
3. [UI 与交互设计](03-ui-ux.md) — 信息架构、控制台布局、状态反馈与安全操作
   - [UI 控制台区域编号](ui/console-region-map.md) — `UI-R01` 至 `UI-R06` 固定区域索引
   - [品牌资产](ui/brand-assets.md) — KING CLUB Logo 文件与使用规则
   - [底部主导航](ui/bottom-navigation.md) — `UI-R06/B` 的 6 个横排页面按钮
   - [暗场颜色令牌](ui/color-tokens.md) — 绿色主色及警告、故障和文字颜色规则
   - [C2 双 Deck 播放控制](ui/c2-dual-deck.md) — 当前/待播歌曲、IN/OUT 和无缝衔接
   - [首页曲库与歌单](ui/home-left-library.md) — `UI-R02/L` 的双曲库、周歌单和播放高亮
   - [视频与灯光快捷区](ui/home-right-media-lighting.md) — `UI-R05/R` 上下均分的视频与 Tiger Touch 快捷控制
4. [开发路线图](04-roadmap.md) — 阶段、验收门槛和开发顺序
5. [决策记录](decisions/README.md) — 已确认的重要技术/产品决策
6. 硬件与现场实施
   - [KING CLUB 现场硬件拓扑基线](hardware/site-topology.md) — AUDIO/LIGHT/VIDEO 真实链路、设备清单与现场勘验项
   - [Qu-16 型号文档](hardware/allen-heath-qu16/README.md) — 官方手册、驱动说明、协议与 UI 实现索引
7. 实时人声引擎
   - [P0：48 kHz Audio Loopback](vocal-engine/P0-48K-LOOPBACK.md) — 实时回路、设备证据、虚拟 Qu-16 与安全门
   - [P3：Realtime F0 Tracker](vocal-engine/P3-F0-TRACKER.md) — 流式音高、voicing、confidence 与模拟证据
   - [P4-A：Chromatic Correction Control](vocal-engine/P4-CHROMATIC-CONTROL.md) — 半音目标、cents、滞回、平滑与能力边界
   - [P5/P6：Key/Scale 与 Reference Vocal Map](vocal-engine/P5-P6-TARGET-MAP.md) — 调式约束、参考旋律制作、查询优先级与整半音错误识别

## 当前状态

状态：`需求讨论中`

首轮讨论建议先回答产品需求文档中的 P0 问题。未确认内容统一标记为 `待确认`，避免把假设误当成需求。
