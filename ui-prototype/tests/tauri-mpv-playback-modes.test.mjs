import test from "node:test";
import assert from "node:assert/strict";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";

const evaluate = (target, expression) => new Promise((resolve, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error("CDP evaluation timed out"));
  }, 30000);
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

test("real mpv Deck honors repeat, sequence, and shuffle modes", async () => {
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const main = targets.find((target) => !/output\.html/.test(target.url) && /localhost:1420\/$/.test(target.url));
  assert.ok(main, "main Tauri WebView target not found");

  const result = await evaluate(main, `(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate, message, timeout = 8000) => {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await wait(100);
      }
      throw new Error(message);
    };
    const state = () => invoke('mpv_deck_state', { deck: 1 });
    const modeButtons = [...document.querySelectorAll('.deck-channel-one .deck-playback-modes button')].slice(0, 4);
    if (modeButtons.length !== 4) throw new Error('Deck 1 playback mode buttons not found');

    await waitFor(async () => (await state().catch(() => null))?.duration > 0, 'Deck 1 media was not loaded');
    await invoke('mpv_deck_set_paused', { deck: 1, paused: true });
    await invoke('mpv_deck_set_paused', { deck: 2, paused: true });

    modeButtons[1].click();
    await wait(100);
    let before = await state();
    await invoke('mpv_deck_seek', { deck: 1, seconds: Math.max(0, before.duration - 0.35) });
    await invoke('mpv_deck_set_paused', { deck: 1, paused: false });
    const repeated = await waitFor(async () => {
      const current = await state();
      return current.path === before.path && !current.paused && !current.eofReached && current.timePos < Math.min(1, current.duration / 2) ? current : null;
    }, 'repeat-one did not restart the same track');

    modeButtons[2].click();
    await wait(100);
    before = await state();
    await invoke('mpv_deck_seek', { deck: 1, seconds: Math.max(0, before.duration - 0.35) });
    await invoke('mpv_deck_set_paused', { deck: 1, paused: false });
    const sequenced = await waitFor(async () => {
      const current = await state();
      return current.path && current.path !== before.path && !current.paused ? current : null;
    }, 'sequence mode did not load and play the next track');

    modeButtons[3].click();
    await wait(100);
    before = await state();
    await invoke('mpv_deck_seek', { deck: 1, seconds: Math.max(0, before.duration - 0.35) });
    await invoke('mpv_deck_set_paused', { deck: 1, paused: false });
    const shuffled = await waitFor(async () => {
      const current = await state();
      return current.path && current.path !== before.path && !current.paused ? current : null;
    }, 'shuffle mode did not load and play another track');

    await invoke('mpv_deck_set_paused', { deck: 1, paused: true });
    modeButtons[2].click();
    return { repeated, sequenced, shuffled };
  })()`);

  assert.equal(result.repeated.paused, false);
  assert.equal(result.repeated.eofReached, false);
  assert.notEqual(result.sequenced.path, result.repeated.path);
  assert.notEqual(result.shuffled.path, result.sequenced.path);
});
