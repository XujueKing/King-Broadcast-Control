export const DSP_STORAGE_KEY = "king.dp448.layout.v1";
export function createProcessorLayout() {
  return {
    format: "club.king.audio-layout",
    version: 1,
    room: { widthM: null, lengthM: null },
    outputs: Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      label:
        i < 2
          ? `M-F15+${i === 0 ? "L" : "R"}`
          : i >= 6
            ? "低音输出"
            : "待确认线路",
      note:
        i < 2
          ? "2026-08-26：舞台上方两只15寸全频箱，成对静音核对。左右单只归属待定位。"
          : i >= 6
            ? "2026-08-26：OUT7–8接四只低音箱，逐只分配待确认。"
            : "历史记录未完成定位。",
      amp: "",
      draft: {
        gainDb: null,
        delayMs: null,
        hpfHz: null,
        lpfHz: null,
        polarity: null,
        eq: [],
      },
    })),
    speakers: [
      // User annotated venue plan, 2026-09-10. Directions are plan estimates.
      ...[
        ['A1', 33.3, 18.3, 175], ['A2', 63.2, 18.3, 195],
        ['A3', 78.0, 38.5, 0], ['A4', 62.4, 59.3, 290],
        ['A5', 70.0, 58.9, 65], ['A6', 28.5, 69.0, 165],
        ['B1', 42.0, 16.0, 180], ['B2', 55.1, 16.0, 180],
        ['B3', 73.5, 41.8, 180], ['B4', 56.8, 65.1, 270],
        ['C1', 34.3, 14.4, 40], ['C2', 61.5, 14.4, 325],
      ].map(([id, x, y, angle]) => ({
        id,
        name: `${id.startsWith('A') ? '全频音响' : id.startsWith('B') ? '低音箱' : '舞台返听'} ${id.slice(1)}`,
        kind: id.startsWith('A') ? 'full' : id.startsWith('B') ? 'sub' : 'monitor',
        output: null,
        candidates: ['A1','A2'].includes(id) ? [1,2] : id.startsWith('B') ? [7,8] : [],
        x, y, angle,
        distanceM: null,
        heightM: id.startsWith('A') ? 4.3 : null,
        note: '2026-09-10 用户标注图：位置和朝向按图估计；A组悬挂高度约4.3米；单只输出线路待核实。',
      })),
    ],
  };
}
const numberOrNull = (value, min, max) =>
  value === null ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max);
export function validateProcessorLayout(value) {
  if (
    value?.format !== "club.king.audio-layout" ||
    value.version !== 1 ||
    !Array.isArray(value.outputs) ||
    value.outputs.length !== 8 ||
    !Array.isArray(value.speakers) ||
    value.speakers.length > 64
  )
    throw Error("文件不是有效的音箱布局方案");
  if (
    !value.room ||
    !numberOrNull(value.room.widthM, 1, 200) ||
    !numberOrNull(value.room.lengthM, 1, 200)
  )
    throw Error("场地尺寸无效");
  const text = (v) => typeof v === "string" && v.length <= 500;
  for (const [i, o] of value.outputs.entries()) {
    if (
      o.id !== i + 1 ||
      !text(o.label) ||
      !text(o.note) ||
      !text(o.amp) ||
      !o.draft
    )
      throw Error("输出线路信息无效");
    const d = o.draft;
    if (
      !numberOrNull(d.gainDb, -60, 12) ||
      !numberOrNull(d.delayMs, 0, 1000) ||
      !numberOrNull(d.hpfHz, 10, 24000) ||
      !numberOrNull(d.lpfHz, 10, 24000) ||
      !(d.polarity === null || typeof d.polarity === "boolean") ||
      !Array.isArray(d.eq) ||
      d.eq.length > 12
    )
      throw Error("通道草稿参数无效");
    if (d.hpfHz !== null && d.lpfHz !== null && d.hpfHz >= d.lpfHz)
      throw Error("高通频率必须低于低通频率");
    for (const e of d.eq)
      if (
        !Number.isFinite(e.hz) ||
        e.hz < 10 ||
        e.hz > 24000 ||
        !Number.isFinite(e.db) ||
        Math.abs(e.db) > 12 ||
        !Number.isFinite(e.q) ||
        e.q < 0.1 ||
        e.q > 20
      )
        throw Error("均衡参数无效");
  }
  const ids = new Set();
  for (const s of value.speakers) {
    if (
      !text(s.id) ||
      !s.id ||
      ids.has(s.id) ||
      !text(s.name) ||
      !text(s.note) ||
      !["full", "sub", "fill", "monitor"].includes(s.kind) ||
      ![null, 1, 2, 3, 4, 5, 6, 7, 8].includes(s.output) ||
      !Array.isArray(s.candidates) ||
      s.candidates.some((n) => !Number.isInteger(n) || n < 1 || n > 8)
    )
      throw Error("喇叭信息无效");
    if (
      !numberOrNull(s.x, 0, 100) ||
      !numberOrNull(s.y, 0, 100) ||
      (s.x === null) !== (s.y === null) ||
      !Number.isFinite(s.angle) ||
      s.angle < 0 ||
      s.angle > 359 ||
      !numberOrNull(s.distanceM, 0, 200) ||
      !numberOrNull(s.heightM, 0, 50)
    )
      throw Error("位置、朝向或距离无效");
    ids.add(s.id);
  }
  return value;
}
export function updateOutputDraft(layout, id, patch) {
  return validateProcessorLayout({
    ...layout,
    outputs: layout.outputs.map((o) =>
      o.id === id ? { ...o, draft: { ...o.draft, ...patch } } : o,
    ),
  });
}
export function updateSpeaker(layout, id, patch) {
  return validateProcessorLayout({
    ...layout,
    speakers: layout.speakers.map((s) =>
      s.id === id ? { ...s, ...patch } : s,
    ),
  });
}
export function pointFromClient(rect, clientX, clientY) {
  return {
    x:
      Math.round(
        Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)) *
          10,
      ) / 10,
    y:
      Math.round(
        Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100)) *
          10,
      ) / 10,
  };
}
export function gridLabel(speaker) {
  if (speaker.x === null) return "待定位";
  return `${String.fromCharCode(65 + Math.min(5, Math.floor((speaker.x / 100) * 6)))}${Math.min(7, Math.floor((speaker.y / 100) * 8)) + 1}`;
}
export function distanceToDelay(distanceM) {
  return distanceM === null
    ? null
    : Math.round((distanceM / 343) * 1000 * 100) / 100;
}
