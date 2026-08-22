import test from "node:test";
import assert from "node:assert/strict";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";

const evaluate = (target, expression) => new Promise((resolve, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error(`CDP evaluation timed out for ${target.url}`));
  }, 15000);
  socket.addEventListener("open", () => socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise: true },
  })));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    socket.close();
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
    else resolve(message.result?.result?.value);
  });
  socket.addEventListener("error", reject);
});

const geometryExpression = (rootSelector) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSelector)});
  const screen = root?.querySelector('.led-screen') ?? root;
  if (!screen) return null;
  const screenRect = screen.getBoundingClientRect();
  const elements = [...screen.querySelectorAll('.text-overlay-element')].map((node) => {
    const rect = node.getBoundingClientRect();
    return {
      text: node.textContent.trim(),
      x: (rect.left + rect.width / 2 - screenRect.left) / screenRect.width,
      y: (rect.top + rect.height / 2 - screenRect.top) / screenRect.height,
      width: rect.width / screenRect.width,
      height: rect.height / screenRect.height,
    };
  });
  return { width: screenRect.width, height: screenRect.height, elements };
})()`;

test("C1 PGM and the physical output use identical normalized text geometry", async () => {
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const main = targets.find((target) => !/output\.html/.test(target.url) && /(?:localhost:1420\/|tauri\.localhost\/|index\.html(?:$|[?#]))/.test(target.url));
  const output = targets.find((target) => /output\.html/.test(target.url));
  assert.ok(main, "main Tauri WebView target not found");
  assert.ok(output, "output Tauri WebView target not found");

  const controls = await evaluate(main, `(async () => {
    const waitFor = async (predicate, message, timeout = 10000) => {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      throw new Error(message);
    };
    const textTab = await waitFor(
      () => [...document.querySelectorAll('.media-type-switch button')].find((button) => button.textContent.trim() === '文字'),
      'text media tab not found',
    );
    textTab.click();
    const template = await waitFor(() => document.querySelector('.text-template-row button'), 'text template not found');
    template.click();
    const take = await waitFor(() => document.querySelector('.media-preview-confirm .take'), 'Take button not found');
    take.click();
    await waitFor(() => document.querySelector('.program-pane .text-overlay-element'), 'text did not render in C1 PGM');
    await waitFor(
      () => document.querySelector('.text-format-toolbar') && document.querySelector('.media-preview-confirm.is-synced'),
      'persistent editor disappeared after Take',
    );
    const templates = [...document.querySelectorAll('.text-template-row button')];
    if (templates[1]) templates[1].click();
    await waitFor(() => document.querySelector('.media-preview-confirm.is-pending'), 'editing another template did not mark PVW pending');
    document.querySelector('.media-preview-confirm .reset').click();
    await waitFor(() => document.querySelector('.media-preview-confirm.is-synced'), 'Reset did not restore PVW to PGM');
    const programText = [...document.querySelectorAll('.program-pane .text-overlay-element')].map((node) => node.textContent.trim()).join('|');
    const previewText = [...document.querySelectorAll('.preview-pane .text-overlay-element')].map((node) => node.textContent.trim()).join('|');
    if (programText !== previewText) throw new Error('Reset left PVW different from PGM');
    return {
      toolbarVisible: Boolean(document.querySelector('.text-format-toolbar')),
      resetLabel: document.querySelector('.media-preview-confirm .reset')?.textContent.trim(),
      takeLabel: document.querySelector('.media-preview-confirm .take')?.textContent.trim(),
    };
  })()`);
  assert.equal(controls.toolbarVisible, true);
  assert.equal(controls.resetLabel, "重置");
  assert.equal(controls.takeLabel, "上屏");

  const mainGeometry = await evaluate(main, geometryExpression(".program-pane"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const outputGeometry = await evaluate(output, geometryExpression(".output-window-root"));

  assert.ok(mainGeometry?.elements?.length, "C1 PGM has no text elements");
  assert.equal(outputGeometry?.elements?.length, mainGeometry.elements.length, "output element count differs from C1 PGM");
  assert.notEqual(mainGeometry.width, outputGeometry.width, "test requires differently sized C1 and output canvases");

  for (let index = 0; index < mainGeometry.elements.length; index += 1) {
    const preview = mainGeometry.elements[index];
    const program = outputGeometry.elements[index];
    assert.equal(program.text, preview.text);
    for (const property of ["x", "y", "width", "height"]) {
      assert.ok(
        Math.abs(program[property] - preview[property]) < 0.006,
        `${property} mismatch for ${preview.text}: C1=${preview[property]}, output=${program[property]}`,
      );
    }
  }
});
