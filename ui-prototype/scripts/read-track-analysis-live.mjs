const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const pathIndex = process.argv.indexOf("--path");
const path = pathIndex >= 0 ? process.argv[pathIndex + 1] : "";
const countIndex = process.argv.indexOf("--sample-count");
const sampleCount = countIndex >= 0 ? Number(process.argv[countIndex + 1]) : 2762;
if (!path) throw new Error("Usage: node scripts/read-track-analysis-live.mjs --path <audio-file>");

const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = targets.find((target) => !target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");
const socket = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once:true });
  socket.addEventListener("error", reject, { once:true });
});
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Track analysis timed out")), 120_000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({
    id:1,
    method:"Runtime.evaluate",
    params:{
      expression:`window.__TAURI_INTERNALS__.invoke("analyze_audio_waveform", ${JSON.stringify({ path, sampleCount })})`,
      returnByValue:true,
      awaitPromise:true,
    },
  }));
});
socket.close();
const beats = Array.isArray(result?.beats) ? result.beats : [];
console.log(JSON.stringify({
  bpm:result?.bpm,
  bpmConfidence:result?.bpmConfidence,
  gridStability:result?.gridStability,
  durationSeconds:result?.durationSeconds,
  correction:result?.correction,
  beatCount:beats.length,
  firstBeats:beats.slice(0,16),
  firstDownbeats:(result?.downbeats ?? []).slice(0,8),
}, null, 2));
