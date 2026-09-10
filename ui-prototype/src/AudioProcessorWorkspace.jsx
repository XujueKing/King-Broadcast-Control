import { useEffect, useRef, useState } from "react";
import {
  SpeakerHigh,
  MapPin,
  DownloadSimple,
  UploadSimple,
  Plus,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";
import {
  createProcessorLayout,
  validateProcessorLayout,
  updateSpeaker,
  updateOutputDraft,
  pointFromClient,
  gridLabel,
  distanceToDelay,
  DSP_STORAGE_KEY,
} from "./dp448-layout.js";
import "./audio-processor.css";

const kinds = { full: "全频", sub: "低音", fill: "补声", monitor: "返听" };
function Numeric({ label, value, min, max, step = 1, unit, onCommit }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  return (
    <label className="dsp-field">
      <span>
        {label}
        <small>{unit}</small>
      </span>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        placeholder="未设置"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={() => {
          const next = text === "" ? null : Number(text);
          if (
            next !== null &&
            (!Number.isFinite(next) || next < min || next > max)
          ) {
            setText(value ?? "");
            return;
          }
          if (onCommit(next) === false) setText(value ?? "");
        }}
      />
    </label>
  );
}
export default function AudioProcessorWorkspace() {
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(DSP_STORAGE_KEY);
      return {
        layout: raw
          ? validateProcessorLayout(JSON.parse(raw))
          : createProcessorLayout(),
        error: "",
      };
    } catch {
      return {
        layout: createProcessorLayout(),
        error: "已有布局无法读取；当前显示初始模板，原存储暂未覆盖。",
      };
    }
  });
  const [layout, setLayout] = useState(initial.layout),
    [message, setMessage] = useState(initial.error),
    [selected, setSelected] = useState(initial.layout.speakers[0]?.id ?? "A1"),
    [outputId, setOutputId] = useState(1),
    [placing, setPlacing] = useState(false),
    [showLines, setShowLines] = useState(true);
  const fileRef = useRef(null),
    dragRef = useRef(null);
  const speaker = layout.speakers.find((s) => s.id === selected),
    channel = layout.outputs.find(
      (o) => o.id === (speaker?.output ?? outputId),
    );
  const linked = layout.speakers.filter((s) => s.output === channel.id),
    unplaced = layout.speakers.filter((s) => s.x === null);
  function save(next) {
    try {
      validateProcessorLayout(next);
      localStorage.setItem(DSP_STORAGE_KEY, JSON.stringify(next));
      setLayout(next);
      setMessage("");
      return true;
    } catch (error) {
      setMessage(String(error.message));
      return false;
    }
  }
  function editSpeaker(patch) {
    try {
      return save(updateSpeaker(layout, selected, patch));
    } catch (e) {
      setMessage(e.message);
      return false;
    }
  }
  function editDraft(patch) {
    try {
      return save(updateOutputDraft(layout, channel.id, patch));
    } catch (e) {
      setMessage(e.message);
      return false;
    }
  }
  function selectSpeaker(s) {
    setSelected(s.id);
    if (s.output) setOutputId(s.output);
    setPlacing(false);
  }
  function addSpeaker() {
    const id = `P${Date.now().toString(36)}`;
    if (
      save({
        ...layout,
        speakers: [
          ...layout.speakers,
          {
            id,
            name: "新增喇叭",
            kind: "fill",
            output: channel.id,
            candidates: [],
            x: null,
            y: null,
            angle: 0,
            distanceM: null,
            heightM: null,
            note: "",
          },
        ],
      })
    ) {
      setSelected(id);
      setPlacing(true);
    }
  }
  function exportLayout() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "KINGCLUB-DP448.kingaudio";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importLayout(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      if (file.size > 1000000) throw Error("方案文件过大");
      const next = validateProcessorLayout(JSON.parse(await file.text()));
      if (save(next)) {
        setSelected(next.speakers[0]?.id ?? null);
        setOutputId(1);
        setPlacing(false);
      }
    } catch (error) {
      setMessage(error.message);
    }
  }
  const direction = speaker?.angle ?? 0;
  return (
    <section className="dsp-workspace" aria-label="专业数字音频处理器">
      <header className="dsp-header">
        <div>
          <SpeakerHigh size={28} />
          <span>
            <h1>专业数字音频处理器</h1>
            <p>DP448 · 4 INPUT / 8 OUTPUT</p>
          </span>
        </div>
        <div className="dsp-header-actions">
          <span className="dsp-offline">设备未连接 · 布局编辑</span>
          <button onClick={exportLayout}>
            <DownloadSimple />
            导出方案
          </button>
          <button onClick={() => fileRef.current.click()}>
            <UploadSimple />
            导入方案
          </button>
          <input
            ref={fileRef}
            hidden
            type="file"
            accept=".kingaudio,.json"
            onChange={importLayout}
          />
        </div>
      </header>
      {message && (
        <div className="dsp-error" role="alert">
          {message}
        </div>
      )}
      <div className="dsp-body">
        <aside className="dsp-routing">
          <header>
            <b>输出线路</b>
            <small>Qu-16 → DP448 → 功放 → 喇叭</small>
          </header>
          <div className="dsp-inputs">
            {["A", "B", "C", "D"].map((id) => (
              <span key={id}>
                IN {id}
                <small>待读取</small>
              </span>
            ))}
          </div>
          <div className="dsp-output-list">
            {layout.outputs.map((o) => (
              <button
                key={o.id}
                className={channel.id === o.id ? "selected" : ""}
                onClick={() => {
                  setOutputId(o.id);
                  setSelected(null);
                  setPlacing(false);
                }}
              >
                <strong>OUT {o.id}</strong>
                <span>
                  {o.label}
                  <small>
                    {layout.speakers
                      .filter((s) => s.output === o.id)
                      .map((s) => s.name)
                      .join("、") || "单只喇叭待绑定"}
                  </small>
                </span>
                <i className={o.id >= 7 ? "sub" : ""} />
              </button>
            ))}
          </div>
          <div className="dsp-history">
            <b>历史线路记录</b>
            <p>OUT 1–2：舞台上方两只 15 寸全频箱。</p>
            <p>OUT 7–8：四只低音箱，单只分配待确认。</p>
            <p>OUT 3–6：尚无已确认的喇叭映射。</p>
            <small>来源：2026-08-26 现场记录</small>
          </div>
        </aside>
        <section className="dsp-map-panel">
          <header>
            <div>
              <b>一楼 · 喇叭平面图</b>
              <small>A 全频（约4.3m） · B 低音 · C 舞台返听；朝向按标注图估计</small>
            </div>
            <label className="dsp-lines">
              <input
                type="checkbox"
                checked={showLines}
                onChange={(e) => setShowLines(e.target.checked)}
              />
              线路
            </label>
          </header>
          <div className="dsp-map-wrap">
            <div
              className={`dsp-map ${placing ? "placing" : ""}`}
              aria-label="喇叭布局平面图"
              onClick={(e) => {
                if (placing && speaker) {
                  editSpeaker(
                    pointFromClient(
                      e.currentTarget.getBoundingClientRect(),
                      e.clientX,
                      e.clientY,
                    ),
                  );
                  setPlacing(false);
                }
              }}
            >
              <img
                src="/assets/king-club-floor-outline.svg"
                alt="KING CLUB 一楼平面轮廓"
                draggable="false"
              />
              <div className="dsp-stage" aria-hidden="true">舞台</div>
              <div className="dsp-grid" aria-hidden="true">
                {Array.from({ length: 48 }, (_, i) => (
                  <span key={i}>
                    {String.fromCharCode(65 + (i % 6))}
                    {Math.floor(i / 6) + 1}
                  </span>
                ))}
              </div>
              <div className="dsp-rack" aria-hidden="true">
                DP448<small>线路示意</small>
              </div>
              {showLines && (
                <svg
                  className="dsp-wires"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {layout.speakers
                    .filter((s) => s.x !== null && s.output)
                    .map((s) => (
                      <path
                        key={s.id}
                        d={`M 7 95 L 7 ${s.y} L ${s.x} ${s.y}`}
                        className={s.id === selected ? "selected" : ""}
                      />
                    ))}
                </svg>
              )}
              {layout.speakers
                .filter((s) => s.x !== null)
                .map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-label={`${s.name}，${gridLabel(s)}，${s.output ? `OUT ${s.output}` : "待绑定"}`}
                    className={`dsp-speaker kind-${s.kind} ${selected === s.id ? "selected" : ""}`}
                    style={{ left: `${s.x}%`, top: `${s.y}%` }}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectSpeaker(s);
                    }}
                    onPointerDown={(e) => {
                      if (!placing) return;
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      dragRef.current = s.id;
                    }}
                    onPointerUp={(e) => {
                      if (dragRef.current !== s.id) return;
                      const rect =
                        e.currentTarget.parentElement.getBoundingClientRect();
                      save(
                        updateSpeaker(
                          layout,
                          s.id,
                          pointFromClient(rect, e.clientX, e.clientY),
                        ),
                      );
                      dragRef.current = null;
                      setPlacing(false);
                    }}
                  >
                    <span
                      className="dsp-direction"
                      style={{ transform: `rotate(${s.angle}deg)` }}
                    >
                      ▲
                    </span>
                    <SpeakerHigh weight="fill" />
                    <strong>{s.id}</strong>
                    <small>{s.output ? `OUT ${s.output}` : "待绑定"}</small>
                  </button>
                ))}
            </div>
          </div>
          <div className="dsp-map-tools">
            <button
              disabled={!speaker}
              className={placing ? "selected" : ""}
              onClick={() => setPlacing(!placing)}
            >
              <MapPin />
              {placing ? "点击图上位置" : "标注 / 移动位置"}
            </button>
            <button onClick={addSpeaker}>
              <Plus />
              添加喇叭
            </button>
            <span>
              {layout.speakers.length - unplaced.length} 已定位 /{" "}
              {layout.speakers.length} 只
            </span>
          </div>
          <div className="dsp-unplaced">
            <b>待定位 · 先选喇叭，再点击图上位置</b>
            <div>
              {unplaced.map((s) => (
                <button
                  className={selected === s.id ? "selected" : ""}
                  key={s.id}
                  onClick={() => {
                    selectSpeaker(s);
                    setPlacing(true);
                  }}
                >
                  <SpeakerHigh />
                  <span>
                    {s.id} · {s.name}
                    <small>
                      {s.output
                        ? `OUT ${s.output}`
                        : s.candidates.length
                          ? `候选 OUT ${s.candidates.join(" / ")}`
                          : "线路待确认"}
                    </small>
                  </span>
                </button>
              ))}
              {!unplaced.length && (
                <small>全部喇叭已标注，可以继续拖动调整。</small>
              )}
            </div>
          </div>
          <details className="dsp-room">
            <summary>平面比例与距离</summary>
            <div className="dsp-fields">
              <Numeric
                label="平面宽度"
                unit="m"
                min={1}
                max={200}
                step={0.1}
                value={layout.room.widthM}
                onCommit={(widthM) =>
                  save({ ...layout, room: { ...layout.room, widthM } })
                }
              />
              <Numeric
                label="平面长度"
                unit="m"
                min={1}
                max={200}
                step={0.1}
                value={layout.room.lengthM}
                onCommit={(lengthM) =>
                  save({ ...layout, room: { ...layout.room, lengthM } })
                }
              />
            </div>
            <p>
              图纸用于位置登记，真实尺寸和测量距离需现场填写；朝向箭头不代表实测覆盖范围。
            </p>
          </details>
        </section>
        <aside className="dsp-inspector">
          <header>
            <b>
              {speaker
                ? `${speaker.id} · ${speaker.name}`
                : `OUT ${channel.id} · ${channel.label}`}
            </b>
            <small>
              {speaker
                ? `${kinds[speaker.kind]} · ${gridLabel(speaker)}`
                : "输出通道参数"}
            </small>
          </header>
          {speaker && (
            <section>
              <h2>位置与线路</h2>
              <label className="dsp-field">
                <span>喇叭名称</span>
                <input
                  value={speaker.name}
                  maxLength={80}
                  onChange={(e) => editSpeaker({ name: e.target.value })}
                />
              </label>
              <div className="dsp-fields">
                <label className="dsp-field">
                  <span>类型</span>
                  <select
                    value={speaker.kind}
                    onChange={(e) => editSpeaker({ kind: e.target.value })}
                  >
                    {Object.entries(kinds).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="dsp-field">
                  <span>输出线路</span>
                  <select
                    value={speaker.output ?? ""}
                    onChange={(e) => {
                      const output = Number(e.target.value) || null;
                      if (editSpeaker({ output }) && output)
                        setOutputId(output);
                    }}
                  >
                    <option value="">待确认</option>
                    {layout.outputs.map((o) => (
                      <option key={o.id} value={o.id}>
                        OUT {o.id} · {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="dsp-fields">
                <Numeric
                  label="X 坐标"
                  unit="%"
                  min={0}
                  max={100}
                  step={0.1}
                  value={speaker.x}
                  onCommit={(x) =>
                    editSpeaker(
                      x === null
                        ? { x: null, y: null }
                        : { x, y: speaker.y ?? 50 },
                    )
                  }
                />
                <Numeric
                  label="Y 坐标"
                  unit="%"
                  min={0}
                  max={100}
                  step={0.1}
                  value={speaker.y}
                  onCommit={(y) =>
                    editSpeaker(
                      y === null
                        ? { x: null, y: null }
                        : { y, x: speaker.x ?? 50 },
                    )
                  }
                />
                <Numeric
                  label="朝向"
                  unit="° · 0°朝上"
                  min={0}
                  max={359}
                  value={direction}
                  onCommit={(angle) => editSpeaker({ angle: angle ?? 0 })}
                />
                <Numeric
                  label="安装高度"
                  unit="m"
                  min={0}
                  max={50}
                  step={0.1}
                  value={speaker.heightM}
                  onCommit={(heightM) => editSpeaker({ heightM })}
                />
              </div>
              <Numeric
                label="喇叭至参考点的测量距离"
                unit="m"
                min={0}
                max={200}
                step={0.1}
                value={speaker.distanceM}
                onCommit={(distanceM) => editSpeaker({ distanceM })}
              />
              <p className="dsp-note">
                声程时间：
                {speaker.distanceM === null
                  ? "待测量"
                  : `${distanceToDelay(speaker.distanceM)} ms（按343 m/s估算）`}
                。这不是应设置的补偿延时；需对比参考喇叭声程。
              </p>
              <button
                className="dsp-text-button"
                disabled={speaker.x === null}
                onClick={() => editSpeaker({ x: null, y: null })}
              >
                <ArrowCounterClockwise />
                撤回待定位列表
              </button>
            </section>
          )}
          <section className="dsp-channel">
            <h2>
              OUT {channel.id} · 通道设置 <span>离线草稿</span>
            </h2>
            <p className="dsp-note">
              {speaker && !speaker.output
                ? "当前喇叭尚未绑定，以下显示所选输出线路。"
                : linked.length > 1
                  ? `此通道由 ${linked.map((s) => s.name).join("、")} 共用。`
                  : "参数作用于整条输出线路。"}
            </p>
            <label className="dsp-field">
              <span>功放 / 功放通道</span>
              <input
                placeholder="例如：功放1 · CH A"
                value={channel.amp}
                onChange={(e) =>
                  save({
                    ...layout,
                    outputs: layout.outputs.map((o) =>
                      o.id === channel.id ? { ...o, amp: e.target.value } : o,
                    ),
                  })
                }
              />
            </label>
            <div className="dsp-fields">
              <Numeric
                label="输出音量"
                unit="dB"
                min={-60}
                max={12}
                step={0.1}
                value={channel.draft.gainDb}
                onCommit={(gainDb) => editDraft({ gainDb })}
              />
              <Numeric
                label="补偿延时"
                unit="ms"
                min={0}
                max={1000}
                step={0.01}
                value={channel.draft.delayMs}
                onCommit={(delayMs) => editDraft({ delayMs })}
              />
              <Numeric
                label="高通频率"
                unit="Hz"
                min={10}
                max={24000}
                value={channel.draft.hpfHz}
                onCommit={(hpfHz) => editDraft({ hpfHz })}
              />
              <Numeric
                label="低通频率"
                unit="Hz"
                min={10}
                max={24000}
                value={channel.draft.lpfHz}
                onCommit={(lpfHz) => editDraft({ lpfHz })}
              />
            </div>
            <label className="dsp-field">
              <span>极性</span>
              <select
                value={
                  channel.draft.polarity === null
                    ? ""
                    : String(channel.draft.polarity)
                }
                onChange={(e) =>
                  editDraft({
                    polarity:
                      e.target.value === "" ? null : e.target.value === "true",
                  })
                }
              >
                <option value="">未读取</option>
                <option value="false">正常</option>
                <option value="true">反相</option>
              </select>
            </label>
            <h2 className="dsp-eq-title">
              参数均衡{" "}
              <button
                disabled={channel.draft.eq.length >= 12}
                onClick={() =>
                  editDraft({
                    eq: [...channel.draft.eq, { hz: 1000, db: 0, q: 1 }],
                  })
                }
              >
                <Plus />
                增加草稿频段
              </button>
            </h2>
            {!channel.draft.eq.length && (
              <p className="dsp-note">
                尚无 EQ 草稿。设备实际 EQ、分频斜率和限幅值未读取。
              </p>
            )}
            {channel.draft.eq.map((e, i) => (
              <div className="dsp-eq-band" key={i}>
                <b>{i + 1}</b>
                {[
                  ["hz", "频率", "Hz", 10, 24000, 1],
                  ["db", "增益", "dB", -12, 12, 0.1],
                  ["q", "Q", "", 0.1, 20, 0.1],
                ].map(([key, label, unit, min, max, step]) => (
                  <Numeric
                    key={key}
                    label={label}
                    unit={unit}
                    value={e[key]}
                    min={min}
                    max={max}
                    step={step}
                    onCommit={(v) =>
                      v !== null &&
                      editDraft({
                        eq: channel.draft.eq.map((band, n) =>
                          n === i ? { ...band, [key]: v } : band,
                        ),
                      })
                    }
                  />
                ))}
                <button
                  aria-label={`删除频段 ${i + 1}`}
                  onClick={() =>
                    editDraft({
                      eq: channel.draft.eq.filter((_, n) => n !== i),
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <div className="dsp-readback">
              <span>
                设备回读<strong>—</strong>
              </span>
              <span>
                限幅 / 保护<strong>未读取</strong>
              </span>
            </div>
            <button className="dsp-apply" disabled>
              设备未连接 · 无法下发
            </button>
            <p className="dsp-note">
              布局和参数草稿自动保存在本机。当前没有向 DP448
              发送命令；参数范围仅用于方案编辑，连接后须按实机能力核验。
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}
