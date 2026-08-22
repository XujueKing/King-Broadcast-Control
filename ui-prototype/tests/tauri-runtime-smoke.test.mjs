import test from "node:test";
import assert from "node:assert/strict";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";

const evaluate = (target, expression) => new Promise((resolve, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error(`CDP evaluation timed out for ${target.url}`));
  }, 5000);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    socket.close();
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error(`CDP connection failed for ${target.url}`));
  });
});

test("Tauri desktop keeps C1 active and the output WebView hidden on one display", async () => {
  const response = await fetch(`${endpoint}/json/list`);
  assert.equal(response.ok, true, `WebView debug endpoint unavailable: ${response.status}`);
  const targets = await response.json();
  const main = targets.find((target) => !/output\.html/.test(target.url) && /(?:localhost:1420\/|tauri\.localhost\/|index\.html(?:$|[?#]))/.test(target.url));
  const output = targets.find((target) => /output\.html/.test(target.url));
  assert.ok(main, "main Tauri WebView target not found");
  assert.ok(output, "output Tauri WebView target not found");

  const mainState = await evaluate(main, `(async () => ({
    visibility: document.visibilityState,
    status: document.querySelector('.system-status')?.innerText ?? '',
    footer: document.querySelector('.preview-footer')?.innerText ?? '',
    deckCount: document.querySelectorAll('.deck').length,
    audioEngineCount: document.querySelectorAll('.media-audio-engine audio').length,
    libraryHeader: document.querySelector('.library-panel .panel-title')?.innerText ?? '',
    bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
    viteError: document.querySelector('vite-error-overlay')?.shadowRoot?.textContent?.slice(0, 2000) ?? '',
    nativeOutputStatus: await window.__TAURI_INTERNALS__.invoke('output_window_status'),
    nativeMpvStatus: await window.__TAURI_INTERNALS__.invoke('mpv_runtime_status'),
  }))()`);
  const outputState = await evaluate(output, `({
    visibility: document.visibilityState,
    hasOutputRoot: Boolean(document.querySelector('.output-window-root')),
  })`);

  if (!mainState.status) {
    console.error(JSON.stringify({ bodyText: mainState.bodyText, viteError: mainState.viteError }, null, 2));
  }

  assert.equal(mainState.visibility, "visible");
  assert.match(mainState.status, /单屏 · C1 预览/);
  assert.match(mainState.footer, /单屏模式 · C1 实时预览/);
  assert.equal(mainState.deckCount, 2);
  assert.equal(mainState.audioEngineCount, 2);
  assert.equal(mainState.nativeOutputStatus.previewMode, true);
  assert.equal(mainState.nativeOutputStatus.windowVisible, false);
  assert.equal(mainState.nativeOutputStatus.monitorIndex, null);
  assert.equal(outputState.hasOutputRoot, true);
  if (process.env.KING_EXPECT_MPV === "1") {
    assert.equal(mainState.nativeMpvStatus.available, true);
    assert.match(mainState.nativeMpvStatus.version ?? "", /^mpv v/i);
    assert.match(mainState.nativeMpvStatus.binaryPath ?? "", /mpv\.exe$/i);
  }
  if (process.env.KING_EXPECT_BUNDLED_MPV === "1") {
    assert.doesNotMatch(mainState.nativeMpvStatus.binaryPath ?? "", /\.local-tools/i);
  }
  if (process.env.KING_EXPECT_LOCAL_MEDIA === "1") {
    assert.match(mainState.libraryHeader, /mpv 播放引擎/);
  }
});
