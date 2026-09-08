const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const enabled = process.argv.includes("--enable");
const simulatePlaying = process.argv.includes("--simulate-playing");
const simulateIdle = process.argv.includes("--simulate-idle");
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = targets.find((target) => !target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");

const socket = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("AI runtime update timed out")), 10000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(async () => ({
        worker: await window.__TAURI_INTERNALS__.invoke('${simulatePlaying || simulateIdle ? "set_audio_ai_scheduler" : "set_audio_ai_runtime_enabled"}', ${simulatePlaying ? "{ playingPaths: ['playback-guard-live-test'], deckPaths: ['playback-guard-live-test'] }" : simulateIdle ? "{ playingPaths: [], deckPaths: [] }" : `{ enabled: ${enabled} }`}),
        deck1: await window.__TAURI_INTERNALS__.invoke('mpv_deck_state', { deck: 1 }),
        deck2: await window.__TAURI_INTERNALS__.invoke('mpv_deck_state', { deck: 2 }),
      }))()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }));
});

socket.close();
console.log(JSON.stringify(result, null, 2));
