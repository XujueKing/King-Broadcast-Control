const [key, rawValue] = process.argv.slice(2);
const value = Number(rawValue);
if (!key || !Number.isInteger(value) || value < 0 || value > 127) {
  throw new Error("Usage: node scripts/write-qu16-parameter.mjs <canonical-key> <0..127>");
}

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = targets.find((target) => !target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");

const socket = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Qu-16 parameter write timed out")), 5000);
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
      expression: `(async () => {
        const before = await window.__TAURI_INTERNALS__.invoke('qu16_parameter_status');
        const write = await window.__TAURI_INTERNALS__.invoke('qu16_write_parameters', {
          sessionId: before.sessionId,
          writes: [{ key: ${JSON.stringify(key)}, value: ${value} }],
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const after = await window.__TAURI_INTERNALS__.invoke('qu16_parameter_status');
        return {
          key: ${JSON.stringify(key)},
          requested: ${value},
          observed: after.parameters?.[${JSON.stringify(key)}],
          pending: after.pendingDetails?.[${JSON.stringify(key)}] ?? null,
          sessionId: after.sessionId,
          revision: after.revision,
          write,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
