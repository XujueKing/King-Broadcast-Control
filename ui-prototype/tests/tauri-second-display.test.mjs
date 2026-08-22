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

const waitFor = async (check, message, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${message}: ${JSON.stringify(lastValue)}`);
};

test("Tauri routes the visible PGM window to a physical non-operator display", async () => {
  const response = await fetch(`${endpoint}/json/list`);
  assert.equal(response.ok, true, `WebView debug endpoint unavailable: ${response.status}`);
  const targets = await response.json();
  const main = targets.find((target) => !/output\.html/.test(target.url) && /(?:localhost:1420\/|tauri\.localhost\/|index\.html(?:$|[?#]))/.test(target.url));
  const output = targets.find((target) => /output\.html/.test(target.url));
  assert.ok(main, "main Tauri WebView target not found");
  assert.ok(output, "output Tauri WebView target not found");

  const mainState = await waitFor(async () => {
    const state = await evaluate(main, `(async () => ({
      displays: await window.__TAURI_INTERNALS__.invoke('list_displays'),
      output: await window.__TAURI_INTERNALS__.invoke('output_window_status'),
      program: await window.__TAURI_INTERNALS__.invoke('get_program_state'),
      footer: document.querySelector('.preview-footer')?.innerText ?? '',
    }))()`);
    return state?.displays?.length >= 2 && state?.output?.connected && state?.output?.windowVisible
      ? state
      : null;
  }, "second-screen output did not become visible");

  assert.equal(mainState.output.previewMode, false);
  assert.equal(typeof mainState.output.monitorIndex, "number");
  const targetDisplay = mainState.displays[mainState.output.monitorIndex];
  assert.ok(targetDisplay, "native output monitor index is not present in list_displays");
  assert.equal(targetDisplay.isOperator, false, "PGM output was routed to the operator display");
  assert.equal(mainState.output.width, targetDisplay.width);
  assert.equal(mainState.output.height, targetDisplay.height);
  assert.match(mainState.footer, /第二屏输出正常/);
  assert.ok(mainState.program?.media, "PGM program state is empty");

  const outputState = await evaluate(output, `({
    visibility: document.visibilityState,
    hasRoot: Boolean(document.querySelector('.output-window-root')),
    hasProgramCanvas: Boolean(document.querySelector('.output-window-root .led-screen')),
    width: window.innerWidth,
    height: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    devicePixelRatio: window.devicePixelRatio,
  })`);
  assert.equal(outputState.visibility, "visible");
  assert.equal(outputState.hasRoot, true);
  assert.equal(outputState.hasProgramCanvas, true);
  assert.equal(
    Math.round(outputState.width * outputState.devicePixelRatio),
    targetDisplay.width,
    JSON.stringify({ outputState, targetDisplay }),
  );
  assert.equal(
    Math.round(outputState.height * outputState.devicePixelRatio),
    targetDisplay.height,
    JSON.stringify({ outputState, targetDisplay }),
  );
});
