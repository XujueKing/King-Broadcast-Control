export const KINGLIGHT_FORMAT = "club.king.kinglight";
export const KINGLIGHT_VERSION = 1;

const allowedLayers = new Set(["scene", "accent", "event"]);
const allowedMotion = new Set(["none", "slow", "medium", "fast"]);

const finiteUnit = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : null;
};

const normalizePlaybackModes = (modes) => Object.fromEntries(Object.entries(modes ?? {})
  .map(([presetId, mode]) => [Number(presetId), mode])
  .filter(([presetId, mode]) => Number.isInteger(presetId) && presetId >= 0 && presetId <= 9 && (mode === "once" || mode === "loop")));

const normalizeFixtureColors = (colors) => Object.fromEntries(Object.entries(colors ?? {})
  .filter(([id, color]) => typeof id === "string" && color && typeof color === "object")
  .map(([id, color]) => [id.slice(0, 40), {
    r: Math.max(0, Math.min(255, Math.round(Number(color.r) || 0))),
    g: Math.max(0, Math.min(255, Math.round(Number(color.g) || 0))),
    b: Math.max(0, Math.min(255, Math.round(Number(color.b) || 0))),
  }]));

const normalizeEffect = (effect) => {
  const numericPresetId = Number(effect?.presetId);
  const presetId = Number.isInteger(numericPresetId) && numericPresetId >= 0 && numericPresetId <= 9
    ? numericPresetId
    : null;
  const titanHandle = Number(effect?.titanHandle);
  const normalizedTitanHandle = Number.isSafeInteger(titanHandle) && titanHandle > 0 ? titanHandle : null;
  if (presetId === null && normalizedTitanHandle === null) return null;
  const effectId = typeof effect?.effectId === "string" && effect.effectId.trim()
    ? effect.effectId.trim().slice(0, 100)
    : normalizedTitanHandle
      ? `titan:${normalizedTitanHandle}`
      : `preset:${presetId}`;
  return {
    effectId,
    presetId,
    titanHandle: normalizedTitanHandle,
    titanLegend: typeof effect?.titanLegend === "string" ? effect.titanLegend.slice(0, 160) : "",
    kingName: typeof effect?.kingName === "string" ? effect.kingName.slice(0, 80) : "",
    layer: allowedLayers.has(effect?.layer) ? effect.layer : null,
    category: typeof effect?.category === "string" ? effect.category.slice(0, 40) : "",
    colorFamily: typeof effect?.colorFamily === "string" ? effect.colorFamily.slice(0, 24) : "",
    energy: finiteUnit(effect?.energy),
    motion: allowedMotion.has(effect?.motion) ? effect.motion : null,
    strobe: Boolean(effect?.strobe),
    beatSync: Boolean(effect?.beatSync),
    continuous: Boolean(effect?.continuous),
    safeAuto: effect?.safeAuto === true,
    priority: Number.isInteger(Number(effect?.priority))
      ? Math.max(0, Math.min(100, Number(effect.priority)))
      : 0,
  };
};

export const createLightingPackage = ({
  titanHost,
  titanStatus,
  titanMappings,
  titanPlaybacks,
  presets,
  rhythmRule,
  videoRule,
  playbackModes,
  fixtureColors,
  effectRegistry,
  automationIntensity = 0.55,
  exportedAt = new Date().toISOString(),
}) => {
  const playbackById = new Map((titanPlaybacks ?? []).map((playback) => [Number(playback.titanId), playback]));
  const registryById = new Map((effectRegistry ?? [])
    .filter((effect) => Number.isInteger(Number(effect.presetId)))
    .map((effect) => [Number(effect.presetId), effect]));
  const presetEffects = (presets ?? []).map((preset) => {
    const titanHandle = Number(titanMappings?.[preset.id]);
    const playback = playbackById.get(titanHandle);
    const registered = registryById.get(preset.id) ?? {};
    return normalizeEffect({
      ...registered,
      presetId: preset.id,
      titanHandle,
      titanLegend: playback?.legend ?? registered.titanLegend,
      kingName: registered.kingName || preset.label,
      continuous: playbackModes?.[preset.id] === "loop" || registered.continuous === true || preset.loop === true,
      // Registry fields stay unknown and unsafe until a person identifies the
      // actual Titan playback at the venue.
      safeAuto: registered.safeAuto === true,
    });
  }).filter(Boolean);
  const representedEffectIds = new Set(presetEffects.map((effect) => effect.effectId));
  const representedHandles = new Set(presetEffects.map((effect) => effect.titanHandle).filter(Boolean));
  const registryEffects = (effectRegistry ?? [])
    .map(normalizeEffect)
    .filter(Boolean)
    .filter((effect) => !representedEffectIds.has(effect.effectId) && !representedHandles.has(effect.titanHandle));
  const effects = [...presetEffects, ...registryEffects];
  return {
    format: KINGLIGHT_FORMAT,
    version: KINGLIGHT_VERSION,
    exportedAt,
    console: {
      vendor: "Avolites",
      family: "Titan",
      host: String(titanHost ?? "").trim(),
      deviceName: String(titanStatus?.deviceName ?? ""),
      softwareVersion: String(titanStatus?.softwareVersion ?? ""),
      showName: String(titanStatus?.showName ?? ""),
    },
    effects,
    automation: {
      rhythmRule: String(rhythmRule ?? "bar"),
      videoRule: String(videoRule ?? "off"),
      intensity: finiteUnit(automationIntensity) ?? 0.55,
    },
    presentation: {
      playbackModes: normalizePlaybackModes(playbackModes),
      fixtureColors: normalizeFixtureColors(fixtureColors),
    },
    safety: {
      executeOnImport: false,
      allowFixtureDmx: false,
      allowPatchWrite: false,
      allowHighRiskEventAuto: false,
    },
  };
};

export const normalizeLightingPackage = (candidate) => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("灯光配置包不是有效对象");
  }
  if (candidate.format !== KINGLIGHT_FORMAT || Number(candidate.version) !== KINGLIGHT_VERSION) {
    throw new Error("不支持的 .kinglight 格式或版本");
  }
  if (candidate.safety?.executeOnImport !== false) {
    throw new Error("配置包缺少禁止导入即执行的安全声明");
  }
  const effects = (Array.isArray(candidate.effects) ? candidate.effects : [])
    .map(normalizeEffect)
    .filter(Boolean);
  const ids = new Set();
  const presetIds = new Set();
  for (const effect of effects) {
    if (ids.has(effect.effectId)) throw new Error(`配置包包含重复效果：${effect.effectId}`);
    ids.add(effect.effectId);
    if (effect.presetId !== null) {
      if (presetIds.has(effect.presetId)) throw new Error(`配置包包含重复预设：${effect.presetId}`);
      presetIds.add(effect.presetId);
    }
  }
  const mappings = Object.fromEntries(effects
    .filter((effect) => effect.presetId !== null && effect.titanHandle)
    .map((effect) => [effect.presetId, effect.titanHandle]));
  return {
    format: KINGLIGHT_FORMAT,
    version: KINGLIGHT_VERSION,
    exportedAt: String(candidate.exportedAt ?? ""),
    console: {
      vendor: "Avolites",
      family: "Titan",
      host: String(candidate.console?.host ?? "").trim(),
      deviceName: String(candidate.console?.deviceName ?? ""),
      softwareVersion: String(candidate.console?.softwareVersion ?? ""),
      showName: String(candidate.console?.showName ?? ""),
    },
    effects,
    mappings,
    automation: {
      rhythmRule: String(candidate.automation?.rhythmRule ?? "bar"),
      videoRule: String(candidate.automation?.videoRule ?? "off"),
      intensity: finiteUnit(candidate.automation?.intensity) ?? 0.55,
    },
    presentation: {
      playbackModes: normalizePlaybackModes(candidate.presentation?.playbackModes),
      fixtureColors: normalizeFixtureColors(candidate.presentation?.fixtureColors),
    },
    safety: {
      executeOnImport: false,
      allowFixtureDmx: false,
      allowPatchWrite: false,
      allowHighRiskEventAuto: false,
    },
  };
};
