import { memo, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  DownloadSimple,
  Eye,
  FolderOpen,
  LightbulbFilament,
  Lightning,
  MapPin,
  MagnifyingGlass,
  SlidersHorizontal,
  UploadSimple,
} from "@phosphor-icons/react";
import { venueBeamPoints } from "./venue-beam-layout.js";

const layerLabels = {
  "": "未分类",
  scene: "SCENE 场景层",
  accent: "ACCENT 节拍层",
  event: "EVENT 事件层",
};

const effectForPlayback = (registry, titanId) => registry.find((effect) => Number(effect.titanHandle) === Number(titanId)) ?? {};

const previewColors = {
  red:"#d92932",
  orange:"#ff7a32",
  amber:"#ffb03b",
  yellow:"#f7df55",
  green:"#54e39d",
  cyan:"#58d6ff",
  blue:"#5790ff",
  purple:"#ad6bff",
  pink:"#ff6fbd",
  white:"#eef8ff",
};

const motionForSpeed = (speed) => speed <= 0 ? "none" : speed < .34 ? "slow" : speed < .67 ? "medium" : "fast";

const staticPlaybackObservations = [
  "按住：加特林关闭",
  "按住：染色关闭",
  "按住：染色+加特林关闭",
  "按住：染色/加特林关闭 · 光束慢开关",
  "按住：全暗 · 光束摇头",
  "按住：全暗 · 光束转圈",
  "按住：全暗 · 光束轻摇",
  "按住：仅光束 · 无打花闪",
  "按住：仅加特林运动",
  "未编程",
];

const fixtureReferenceTypes = {
  beam: { label:"现场光束灯", count:25, Icon:LightbulbFilament },
};

const fixtureReferencePoints = venueBeamPoints;

export const LightingConsoleWorkspace = memo(function LightingConsoleWorkspace({
  titanHost,
  titanStatus,
  titanInventory,
  titanPlaybacks,
  titanStaticPlaybacks,
  titanMappings,
  effectRegistry,
  titanActionStatus,
  lightingPackageStatus,
  lightingEnabled,
  onLightingEnabledChange,
  onRefreshTitan,
  onQuickSlotChange,
  onPlaybackQuickSlotChange,
  onEffectChange,
  onExportPackage,
  onImportPackage,
  onOpenPackageDirectory,
}) {
  const [query, setQuery] = useState("");
  const [layerFilter, setLayerFilter] = useState("all");
  const [previewTitanId, setPreviewTitanId] = useState(null);
  const [selectedFloorPoint, setSelectedFloorPoint] = useState(fixtureReferencePoints[0].id);
  const playbackRows = useMemo(() => {
    const rows = [...titanPlaybacks];
    const known = new Set(rows.map((playback) => Number(playback.titanId)));
    effectRegistry.forEach((effect) => {
      const titanId = Number(effect.titanHandle);
      if (!Number.isSafeInteger(titanId) || titanId <= 0 || known.has(titanId)) return;
      rows.push({
        titanId,
        handleType: "packageEffect",
        legend: effect.titanLegend || effect.kingName || `Titan Playback ${titanId}`,
        active: false,
        selected: false,
        userNumbers: [],
        group: "KINGLIGHT PACKAGE",
        page: null,
        index: null,
      });
      known.add(titanId);
    });
    return rows;
  }, [effectRegistry, titanPlaybacks]);
  const filteredPlaybacks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return playbackRows.filter((playback) => {
      const effect = effectForPlayback(effectRegistry, playback.titanId);
      if (layerFilter === "active" && !playback.active) return false;
      if (["scene", "accent", "event", "unassigned"].includes(layerFilter)) {
        const layer = effect.layer || "unassigned";
        if (layer !== layerFilter) return false;
      }
      if (!needle) return true;
      return [playback.legend, playback.group, playback.handleType, effect.kingName, effect.category, playback.titanId]
        .some((value) => String(value ?? "").toLowerCase().includes(needle));
    });
  }, [effectRegistry, layerFilter, playbackRows, query]);
  const previewPlayback = playbackRows.find((playback) => Number(playback.titanId) === Number(previewTitanId))
    ?? playbackRows.find((playback) => playback.active)
    ?? playbackRows[0]
    ?? null;
  const previewEffect = previewPlayback ? effectForPlayback(effectRegistry, previewPlayback.titanId) : {};
  const previewColor = previewColors[previewEffect.colorFamily] || "#65d9ff";
  const gatlingProfile = previewEffect.fixtureProfile === "gatling-9";
  const gatlingPattern = previewEffect.pattern || "chase";
  const gatlingSpeed = Number.isFinite(Number(previewEffect.speed)) ? Math.max(0, Math.min(1, Number(previewEffect.speed))) : .2;
  const gatlingDirection = previewEffect.direction || "forward";
  const gatlingDuration = 5.2 - gatlingSpeed * 4.65;
  const gatlingEnergy = Number.isFinite(Number(previewEffect.energy)) ? Math.max(.08, Math.min(1, Number(previewEffect.energy))) : .2;
  const inventoryReady = titanInventory?.authoritative === true;
  const inventoryBusy = titanInventory?.state === "scanning";
  const inventoryMessage = inventoryReady
    ? `真机 ${titanInventory.fixtureCount} 个 Fixture · ${titanInventory.groupCount} 个 Group`
    : titanInventory?.blockedReason || "尚未读取真机 Patch";
  const staticPlaybackByIndex = useMemo(
    () => new Map((titanStaticPlaybacks ?? []).map((playback) => [Number(playback.index), playback])),
    [titanStaticPlaybacks],
  );
  const selectedReferencePoint = fixtureReferencePoints.find((point) => point.id === selectedFloorPoint) ?? fixtureReferencePoints[0];
  const selectedReferenceType = fixtureReferenceTypes[selectedReferencePoint.type];

  return <section className="titan-workspace" aria-label="Avolites Titan 灯光控制台映射">
    <header className="titan-workspace-header">
      <div className="titan-workspace-title">
        <Lightning weight="fill"/>
        <span><b>Avolites Titan 数字镜像与效果注册表</b><small>首页 0–9 是快捷位；本页保存完整 Playback、语义、自动化资格和便携配置</small></span>
      </div>
      <div className={`titan-live-summary ${titanStatus.connected ? "live" : "offline"}`}>
        <i/><span><b>{titanStatus.connected ? `${titanStatus.deviceName} · LIVE` : "离线配置模式"}</b><small>{titanStatus.connected ? `Titan ${titanStatus.softwareVersion} · ${inventoryReady ? `Show ${titanInventory.liveShowName}` : "Patch 未就绪"} · ${titanPlaybacks.length} 个 Playback` : `${titanHost || "未配置地址"} · 不发送现场命令`}</small></span>
      </div>
      <button type="button" className="titan-header-action" disabled={inventoryBusy} onClick={onRefreshTitan}><ArrowsClockwise className={inventoryBusy ? "spinning" : ""}/>{inventoryBusy ? "扫描 Patch" : "读取真机 Patch"}</button>
      <button type="button" className={`titan-runtime-switch ${lightingEnabled ? "enabled" : "paused"}`} onClick={() => onLightingEnabledChange(!lightingEnabled)}><span/>{lightingEnabled ? "自动联动开启" : "自动联动暂停"}</button>
    </header>

    <section className="titan-package-bar">
      <div><b>B区 · 设置与调节</b><span>.kinglight 配置搬运</span><small>导入只恢复配置，不 Fire / Release Playback</small></div>
      <button type="button" onClick={onExportPackage}><DownloadSimple/>导出配置包</button>
      <button type="button" onClick={() => onOpenPackageDirectory("outbox")}><FolderOpen/>导出目录</button>
      <button type="button" onClick={() => onOpenPackageDirectory("inbox")}><FolderOpen/>收件箱</button>
      <button type="button" onClick={onImportPackage}><UploadSimple/>导入收件箱</button>
      <span className={`titan-package-message ${lightingPackageStatus.state}`}>{lightingPackageStatus.message}</span>
    </section>

    <section className="titan-quick-map">
      <header><span><b>快捷控制 0–9</b><small>一个 Playback 只占一个快捷位；改变选择不会触发真机</small></span><em>{Object.keys(titanMappings).length}/10 已绑定</em></header>
      <div>{Array.from({ length: 10 }, (_, presetId) => {
        const titanId = Number(titanMappings[presetId]);
        const playback = titanPlaybacks.find((item) => Number(item.titanId) === titanId);
        return <label key={presetId} className={playback?.active ? "active" : titanId ? "mapped" : "empty"}>
          <strong>{presetId}</strong>
          <span><b>{playback?.legend || (titanId ? `Titan ${titanId}` : "未绑定")}</b><small>{playback ? [playback.group, Number.isFinite(playback.page) ? `P${playback.page + 1}` : "", Number.isFinite(playback.index) ? `#${playback.index + 1}` : ""].filter(Boolean).join(" · ") : "选择当前 Show 的 Playback"}</small></span>
          <select value={titanId || ""} disabled={!titanStatus.connected} onChange={(event) => onQuickSlotChange(presetId, event.target.value)}>
            <option value="">未绑定</option>
            {titanPlaybacks.map((item) => <option value={item.titanId} key={item.titanId}>{item.legend || `Playback ${item.titanId}`}</option>)}
          </select>
        </label>;
      })}</div>
      <section className="titan-static-mirror" aria-label="实体 Static Playback 只读镜像">
        <header><b>实体 SWOP 1–10</b><small>只读现场记录 · 按住为临时覆盖，松开恢复 · KING 不发送命令</small></header>
        <div>{staticPlaybackObservations.map((observation, index) => {
          const playback = staticPlaybackByIndex.get(index);
          const programmed = Boolean(playback);
          return <div key={index} className={`titan-static-key ${programmed ? "programmed" : "disabled"}`} title={programmed ? `${observation} · TitanId ${playback.titanId} · User ${playback.userNumbers?.join(", ") || "--"}` : "当前 Show 未编程，真机为黑键"}>
            <strong>{index + 1}</strong>
            <span><b>{observation}</b><small>{programmed ? `Titan ${playback.titanId} · User ${playback.userNumbers?.join(", ") || "--"}` : "无 Handle · 禁用黑键"}</small></span>
          </div>;
        })}</div>
      </section>
      <footer className={titanActionStatus.state}>{titanActionStatus.message}</footer>
    </section>

    <section className="titan-stage-simulator" style={{ "--titan-preview-color": previewColor }}>
      <header><span><b>A区 · 酒吧平面与灯位</b><small>现场光束位置图 · A1–A25 指挥编号</small></span><em>{previewPlayback ? `${previewEffect.kingName || previewPlayback.legend || `Playback ${previewPlayback.titanId}`} · ${layerLabels[previewEffect.layer || ""]}` : "等待效果配置"}</em></header>
      <div className={`titan-venue-plan ${inventoryReady ? "inventory-ready" : "inventory-blocked"}`}>
        <div className="titan-plan-canvas">
          <img src="/assets/king-club-floor-outline.svg" alt="KING CLUB 一楼 SVG 平面轮廓"/>
          <div className="titan-floor-points" aria-label="现场光束灯 A1 到 A25 位置">
            {fixtureReferencePoints.map((point) => {
              const type = fixtureReferenceTypes[point.type];
              const FixtureIcon = type.Icon;
              return <button
                type="button"
                key={point.id}
                className={`titan-floor-point type-${point.type} status-${point.status} ${selectedFloorPoint === point.id ? "selected" : ""}`}
                style={{ left:`${point.x}%`, top:`${point.y}%` }}
                aria-label={`${point.label} · ${point.zone} · ${type.label}`}
                title={`${point.label} · ${point.zone} · TitanId 待逐台定位绑定`}
                onClick={() => setSelectedFloorPoint(point.id)}
              ><span>{point.label}</span><FixtureIcon weight="fill"/></button>;
            })}
          </div>
          <div className="titan-plan-zone-labels" aria-hidden="true"><span className="dance">主舞池</span><span className="booth">DJ / 设备区</span><span className="vip">VIP 卡座</span><span className="entry">主入口</span></div>
          <div className="titan-patch-gate">
            <strong>{inventoryReady ? "真机 Patch 已读取" : inventoryBusy ? "正在读取真机 Patch" : "参考灯位 · 尚未绑定真机"}</strong>
            <span>{inventoryMessage}</span>
            <small>{inventoryReady ? `${titanInventory.fixtureCount} 个 Fixture / ${titanInventory.groupCount} 个 Group 已可用于坐标绑定。` : `图中位置只依据设计图，不写入 Titan；缓存 Show：${titanInventory?.cachedShowName || "--"}。`}</small>
          </div>
        </div>
        <div className="titan-plan-selection"><MapPin weight="fill"/><span><b>{selectedReferencePoint.label} · {selectedReferencePoint.zone}</b><small>{selectedReferenceType.label} · 现场指挥编号 · TitanId 待逐台定位绑定</small></span></div>
        <div className="titan-floor-legend">{Object.entries(fixtureReferenceTypes).map(([id, type]) => { const LegendIcon = type.Icon; return <span key={id} className={`type-${id}`}><LegendIcon weight="fill"/><b>{type.label}</b><small>{type.count}</small></span>; })}</div>
        <div className="titan-stage-scale"><span>平面图 A区</span><small>真机地址以 Titan Fixture Patch 为唯一依据</small></div>
      </div>
    </section>

    <section className="titan-control-rack" aria-label="B区效果调节">
      <header><span><SlidersHorizontal weight="fill"/><b>现场效果调节</b><small>只修改 KING 语义配置，不会立即 Fire Playback</small></span><em>{previewPlayback ? previewEffect.kingName || previewPlayback.legend || `Playback ${previewPlayback.titanId}` : "等待选择 Titan Playback"}</em></header>
      <div>
        <div className={`gatling-preview-card ${gatlingProfile ? "enabled" : "generic"}`} style={{"--gatling-color":previewColor,"--gatling-duration":`${gatlingDuration}s`,"--gatling-energy":gatlingEnergy}}>
          <div className={`gatling-tube-bank pattern-${gatlingPattern} direction-${gatlingDirection}`} aria-label={`九节加特林灯管预演，${Math.round(gatlingSpeed*100)}% 速度`}>
            {Array.from({length:6},(_,tubeIndex)=><div className="gatling-tube" key={tubeIndex}>{Array.from({length:9},(_,segmentIndex)=>{
              const phase=segmentIndex+tubeIndex*.42;
              const rainbowHue=(segmentIndex*38+tubeIndex*17)%360;
              return <i key={segmentIndex} style={{"--gatling-delay":`${-(phase*gatlingDuration/9)}s`,"--gatling-hue":rainbowHue}}/>;
            })}</div>)}
          </div>
          <label><span>灯具模型</span><select disabled={!previewPlayback} value={gatlingProfile?"gatling-9":""} onChange={(event)=>previewPlayback&&onEffectChange(previewPlayback,{fixtureProfile:event.target.value||null})}><option value="">通用效果</option><option value="gatling-9">加特林九节</option></select></label>
        </div>
        <label><span>颜色族</span><select disabled={!previewPlayback} value={previewEffect.colorFamily ?? ""} onChange={(event) => previewPlayback && onEffectChange(previewPlayback, { colorFamily:event.target.value || null })}><option value="">颜色未知</option><option value="cyan">青蓝</option><option value="blue">蓝色</option><option value="green">绿色</option><option value="amber">琥珀</option><option value="red">红色</option><option value="purple">紫色</option><option value="pink">粉色</option><option value="white">白色</option></select></label>
        <label><span>灯管效果</span><select disabled={!previewPlayback||!gatlingProfile} value={gatlingPattern} onChange={(event)=>previewPlayback&&onEffectChange(previewPlayback,{pattern:event.target.value})}><option value="solid">常亮</option><option value="chase">九节流水</option><option value="pulse">整体呼吸</option><option value="rainbow">幻彩流水</option></select></label>
        <label className="gatling-speed"><span>速度 <b>{Math.round(gatlingSpeed*100)}%</b></span><input type="range" min="0" max="100" step="1" disabled={!previewPlayback||!gatlingProfile} value={Math.round(gatlingSpeed*100)} onChange={(event)=>{const speed=Number(event.target.value)/100;previewPlayback&&onEffectChange(previewPlayback,{speed,motion:motionForSpeed(speed)})}}/></label>
        <label><span>方向</span><select disabled={!previewPlayback||!gatlingProfile} value={gatlingDirection} onChange={(event)=>previewPlayback&&onEffectChange(previewPlayback,{direction:event.target.value})}><option value="forward">正向</option><option value="reverse">反向</option><option value="bounce">往返</option></select></label>
        <div className="titan-control-flags"><label><input type="checkbox" disabled={!previewPlayback} checked={previewEffect.beatSync === true} onChange={(event) => previewPlayback && onEffectChange(previewPlayback, { beatSync:event.target.checked })}/>节拍同步</label><label><input type="checkbox" disabled={!previewPlayback} checked={previewEffect.continuous === true} onChange={(event) => previewPlayback && onEffectChange(previewPlayback, { continuous:event.target.checked })}/>持续效果</label><label><input type="checkbox" disabled={!previewPlayback || previewEffect.layer === "event"} checked={previewEffect.safeAuto === true} onChange={(event) => previewPlayback && onEffectChange(previewPlayback, { safeAuto:event.target.checked })}/>允许自动</label></div>
      </div>
    </section>

    <section className="titan-registry">
      <header>
        <div><SlidersHorizontal weight="fill"/><b>效果参数与完整注册表</b><small>把 Titan Playback 解释成 Scene / Accent / Event；未知项默认禁止自动触发</small></div>
        <label className="titan-search"><MagnifyingGlass/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、分组或 TitanId"/></label>
        <select value={layerFilter} onChange={(event) => setLayerFilter(event.target.value)}>
          <option value="all">全部效果</option><option value="active">真机正在运行</option><option value="scene">SCENE 场景层</option><option value="accent">ACCENT 节拍层</option><option value="event">EVENT 事件层</option><option value="unassigned">未分类</option>
        </select>
      </header>
      <div className="titan-registry-head"><span>真机 Playback</span><span>KING 名称 / 分类</span><span>层级</span><span>能量 / 运动</span><span>行为</span><span>快捷位</span></div>
      <div className="titan-registry-list">
        {filteredPlaybacks.length ? filteredPlaybacks.map((playback) => {
          const effect = effectForPlayback(effectRegistry, playback.titanId);
          const quickSlot = Object.entries(titanMappings).find(([, handle]) => Number(handle) === Number(playback.titanId))?.[0] ?? "";
          return <article className={`${playback.active ? "active" : ""} ${effect.safeAuto ? "safe-auto" : ""}`} key={playback.titanId}>
            <div className="titan-playback-identity"><i/><span><b>{playback.legend || `Playback ${playback.titanId}`}</b><small>TitanId {playback.titanId} · {[playback.handleType, playback.group, Number.isFinite(playback.page) ? `P${playback.page + 1}` : "", Number.isFinite(playback.index) ? `#${playback.index + 1}` : ""].filter(Boolean).join(" · ")}</small></span>{playback.active && <em>LIVE</em>}<button type="button" className={Number(previewPlayback?.titanId) === Number(playback.titanId) ? "selected" : ""} title="只在电脑中预演，不触发真机" onClick={() => setPreviewTitanId(playback.titanId)}><Eye/>预演</button></div>
            <div className="titan-semantic-name"><input value={effect.kingName ?? ""} placeholder="KING 显示名称" onChange={(event) => onEffectChange(playback, { kingName: event.target.value })}/><input value={effect.category ?? ""} placeholder="类别，例如 Beam / Wash" onChange={(event) => onEffectChange(playback, { category: event.target.value })}/></div>
            <select value={effect.layer ?? ""} onChange={(event) => onEffectChange(playback, { layer: event.target.value || null, ...(event.target.value === "event" ? { safeAuto: false } : {}) })}>{Object.entries(layerLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
            <div className="titan-energy-motion"><select value={effect.colorFamily ?? ""} onChange={(event) => onEffectChange(playback, { colorFamily: event.target.value || null })}><option value="">颜色未知</option><option value="cyan">青蓝</option><option value="blue">蓝色</option><option value="green">绿色</option><option value="amber">琥珀</option><option value="red">红色</option><option value="purple">紫色</option><option value="pink">粉色</option><option value="white">白色</option></select><select value={effect.energy ?? ""} onChange={(event) => onEffectChange(playback, { energy: event.target.value === "" ? null : Number(event.target.value) })}><option value="">能量未知</option><option value="0.2">低 20%</option><option value="0.5">中 50%</option><option value="0.8">高 80%</option><option value="1">峰值 100%</option></select><select value={effect.motion ?? ""} onChange={(event) => onEffectChange(playback, { motion: event.target.value || null })}><option value="">运动未知</option><option value="none">静态</option><option value="slow">慢速</option><option value="medium">中速</option><option value="fast">快速</option></select></div>
            <div className="titan-effect-flags"><label><input type="checkbox" checked={effect.beatSync === true} onChange={(event) => onEffectChange(playback, { beatSync: event.target.checked })}/>节拍</label><label><input type="checkbox" checked={effect.continuous === true} onChange={(event) => onEffectChange(playback, { continuous: event.target.checked })}/>持续</label><label className={effect.layer === "event" ? "locked" : ""}><input type="checkbox" disabled={effect.layer === "event"} checked={effect.safeAuto === true} onChange={(event) => onEffectChange(playback, { safeAuto: event.target.checked })}/>{effect.safeAuto ? <CheckCircle weight="fill"/> : null}可自动</label></div>
            <select value={quickSlot} onChange={(event) => onPlaybackQuickSlotChange(playback, event.target.value)}><option value="">不放首页</option>{Array.from({ length: 10 }, (_, index) => <option value={index} key={index}>{index} 号快捷位</option>)}</select>
          </article>;
        }) : <div className="titan-registry-empty"><b>{titanStatus.connected ? "没有符合筛选条件的 Playback" : "尚未取得 Titan Playback"}</b><small>{titanStatus.connected ? "更换筛选条件继续查看。" : "可先导入 .kinglight 离线编辑，或现场连接 Titan 后刷新。"}</small></div>}
      </div>
    </section>
  </section>;
});
