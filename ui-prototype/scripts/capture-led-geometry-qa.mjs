import fs from "node:fs/promises";
import path from "node:path";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const outputTarget = targets.find((target) => target.url.includes("output.html"));
if (!outputTarget) throw new Error("LED output WebView target not found");

const socket = new WebSocket(outputTarget.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await call("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 500));

const previousResult = await call("Runtime.evaluate", {
  expression: `window.__TAURI_INTERNALS__.invoke('get_program_state')`,
  returnByValue: true,
  awaitPromise: true,
});
const previousProgram = previousResult.result.value;
await call("Runtime.evaluate", {
  expression: `window.__TAURI_INTERNALS__.invoke('set_program_state', { program: {
    media: { id: 'resolution-test', name: '清晰度测试图', type: 'image', src: '/assets/led-resolution-test.svg' },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, fit: 'cover', mode: 'uniform' },
    lyrics: null
  }})`,
  returnByValue: true,
  awaitPromise: true,
});
await new Promise((resolve) => setTimeout(resolve, 300));

const geometryResult = await call("Runtime.evaluate", {
  expression: `(() => {
    const screen = document.querySelector('.output-window-root .led-screen');
    const canvas = document.querySelector('.output-window-root .led-physical-canvas');
    const screenRect = screen?.getBoundingClientRect();
    const canvasRect = canvas?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      screen: screenRect && { x: screenRect.x, y: screenRect.y, width: screenRect.width, height: screenRect.height },
      canvas: canvasRect && { x: canvasRect.x, y: canvasRect.y, width: canvasRect.width, height: canvasRect.height, offsetWidth: canvas.offsetWidth, offsetHeight: canvas.offsetHeight, transform: getComputedStyle(canvas).transform },
      source: document.querySelector('.media-source')?.getAttribute('src') ?? 'black',
    };
  })()`,
  returnByValue: true,
});
const geometry = geometryResult.result.value;
const screenshot = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
const output = path.resolve("artifacts/led-physical-geometry-output.png");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, Buffer.from(screenshot.data, "base64"));
if (process.env.KING_LED_KEEP_TEST !== "1") {
  await call("Runtime.evaluate", {
    expression: `window.__TAURI_INTERNALS__.invoke('set_program_state', { program: ${JSON.stringify(previousProgram)} })`,
    returnByValue: true,
    awaitPromise: true,
  });
}
socket.close();
console.log(JSON.stringify({ output, ...geometry }, null, 2));
