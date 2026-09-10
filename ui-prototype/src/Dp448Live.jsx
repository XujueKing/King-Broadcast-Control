import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function Dp448Live({ output }) {
  const [ports, setPorts] = useState([]);
  const [port, setPort] = useState(() => localStorage.getItem("king.dp448.port") || "");
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [gain, setGain] = useState("");
  const [delay, setDelay] = useState("");
  const session = useRef(null), pending = useRef(false), reading = useRef(false), alive = useRef(false);
  const current = snapshot?.outputs.find(o => o.id === output);
  const desktop = !!window.__TAURI_INTERNALS__;
  function accept(next) {
    session.current = next;
    if (alive.current) setSnapshot(previous => previous?.epoch === next.epoch && previous?.revision === next.revision ? previous : next);
  }
  useEffect(() => {
    setGain(current?.gainDb ?? "");
    setDelay(current ? Number(current.delayMs.toFixed(4)) : "");
  }, [output, snapshot?.epoch, current?.gainDb, current?.delayMs]);
  useEffect(() => {
    alive.current = true;
    let disposed = false, timer;
    if (desktop) invoke("dp448_ports").then(found => {
      if (disposed) return;
      setPorts(found); setPort(previous => found.includes(previous) ? previous : found.length === 1 ? found[0] : "");
    }).catch(e => { if (!disposed) setError(String(e)); });
    async function poll() {
      if (disposed) return;
      const state = session.current;
      if (state && !pending.current && !reading.current) {
        reading.current = true;
        try {
          const next = await invoke("dp448_read", { epoch: state.epoch });
          if (!disposed && !pending.current && session.current?.epoch === state.epoch) accept(next);
        } catch (e) {
          if (!disposed) { session.current = null; setSnapshot(null); setError(String(e)); }
        } finally { reading.current = false; }
      }
      if (!disposed) timer = setTimeout(poll, 1000);
    }
    timer = setTimeout(poll, 1000);
    return () => {
      disposed = true; alive.current = false; clearTimeout(timer);
      const state = session.current; session.current = null;
      if (state) invoke("dp448_disconnect", { epoch: state.epoch }).catch(() => {});
    };
  }, [desktop]);
  async function connect() {
    if (pending.current || !port) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const next = await invoke("dp448_connect", { port });
      if (!alive.current) { await invoke("dp448_disconnect", { epoch: next.epoch }); return; }
      accept(next); localStorage.setItem("king.dp448.port", port);
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function disconnect() {
    if (pending.current) return;
    const state = session.current; session.current = null; setSnapshot(null);
    if (state) await invoke("dp448_disconnect", { epoch: state.epoch });
  }
  async function write(field, text) {
    if (pending.current || !session.current || text === "") return;
    const value = Number(text);
    if (!Number.isFinite(value)) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const state = session.current;
      const next = await invoke("dp448_write", { epoch: state.epoch, revision: state.revision, output, field, value });
      if (alive.current) accept(next);
    } catch (e) {
      session.current = null;
      if (alive.current) { setSnapshot(null); setError(String(e)); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="dsp-native" aria-label="DP448 实机控制">
    <h2>DP448 实机控制 <span>{snapshot ? "双向连接" : "未连接"}</span></h2>
    {!snapshot ? <>
      <div className="dsp-native-connect">
        <select aria-label="DP448 串口" value={port} onChange={e => setPort(e.target.value)} disabled={!desktop || busy}>
          <option value="">选择串口</option>{ports.map(p => <option key={p}>{p}</option>)}
        </select>
        <button disabled={!desktop || busy || !port} onClick={connect}>{busy ? "正在读取" : "连接并读取"}</button>
        <button disabled={!desktop || busy} onClick={async () => { try { setPorts(await invoke("dp448_ports")); } catch (e) { setError(String(e)); } }}>刷新串口</button>
      </div>
      <p className="dsp-note">AudioCore 须先离线以释放串口。连接只读取，不应用下方草稿。</p>
    </> : <>
      <p className="dsp-note">{snapshot.model} · {snapshot.port} <button onClick={disconnect} disabled={busy}>断开</button></p>
      <p>OUT {output} · {current.label}</p>
      <p className="dsp-note">{current.linkedOutputs.length > 1 ? `设备联动：OUT ${current.linkedOutputs.join(" / ")}，调节会同时作用于这些输出。` : "独立输出"}</p>
      <div className="dsp-fields">
        <label className="dsp-field"><span>输出音量 <small>dB</small></span>
          <input aria-label="实机输出音量" type="number" min={-60} max={12} step={0.1} value={gain} onChange={e => setGain(e.target.value)} disabled={busy} />
          <small>设备读回 {current.gainDb.toFixed(1)} dB</small>
          <button disabled={busy || gain === "" || Number(gain) < -60 || Number(gain) > 12} onClick={() => write("gainDb", gain)}>应用音量</button>
        </label>
        <label className="dsp-field"><span>输出延时 <small>ms</small></span>
          <input aria-label="实机输出延时" type="number" min={0} max={1000} step={0.001} value={delay} onChange={e => setDelay(e.target.value)} disabled={busy} />
          <small>设备读回 {current.delayMs.toFixed(4)} ms</small>
          <button disabled={busy || delay === "" || Number(delay) < 0 || Number(delay) > 1000} onClick={() => write("delayMs", delay)}>应用延时</button>
        </label>
      </div>
      <small>{busy ? "等待设备回读确认" : "每秒同步设备参数"}</small>
    </>}
    {error && <p role="alert" className="dsp-error">{error}</p>}
    <p className="dsp-note">分频、EQ、极性、静音及限幅的原生控制尚未完成协议核验，暂不下发。</p>
  </section>;
}
