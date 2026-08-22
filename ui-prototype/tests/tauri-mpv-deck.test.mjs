import test from "node:test";
import assert from "node:assert/strict";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";

const evaluate = (target, expression) => new Promise((resolve, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error("CDP evaluation timed out"));
  }, 25000);
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

test("two real mpv Decks play independently and only the operator moves the crossfader", async () => {
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const main = targets.find((target) => !/output\.html/.test(target.url) && /(?:localhost:1420\/|tauri\.localhost\/|index\.html(?:$|[?#]))/.test(target.url));
  assert.ok(main, "main Tauri WebView target not found");

  const result = await evaluate(main, `(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const waitFor = async (predicate, message, timeout = 10000) => {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(message);
    };
    const deckState = (deck) => invoke('mpv_deck_state', { deck });
    const before = await waitFor(async () => {
      const deck1 = await deckState(1).catch(() => null);
      const deck2 = await deckState(2).catch(() => null);
      return deck1?.path && deck2?.path ? { deck1, deck2 } : null;
    }, 'both mpv Decks were not loaded');
    await invoke('mpv_deck_set_paused', { deck: 1, paused: true });
    await invoke('mpv_deck_set_paused', { deck: 2, paused: true });
    await invoke('mpv_deck_seek', { deck: 1, seconds: 0 });
    await invoke('mpv_deck_seek', { deck: 2, seconds: 0 });
    const crossfader = document.querySelector('.crossfader input');
    const beforeCrossfade = crossfader?.value;

    const availableRow = await waitFor(
      () => document.querySelector('.track-row:not(.deck-locked)'),
      'no unlocked library track available for Deck loading test',
    );
    availableRow.click();
    const selectedRow = await waitFor(
      () => document.querySelector('.track-row.selected'),
      'library row did not enter the selected state',
    );
    const loadDeck2Button = selectedRow.querySelector('button[aria-label="装载到 2 号 Deck，不自动播放"]');
    if (!loadDeck2Button) throw new Error('Deck 2 load button not found');
    loadDeck2Button.click();
    // Give the UI-initiated native load command priority before polling the same mpv mutex.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const loadedDeck2 = await waitFor(async () => {
      const state = await deckState(2);
      return state.path && state.path !== before.deck2.path ? state : null;
    }, 'Deck 2 did not load the selected library track').catch(async () => {
      const current = await deckState(2);
      const rows = [...document.querySelectorAll('.track-row')].map((row) => ({
        text: row.innerText.replace(/\s+/g, ' ').trim(),
        className: row.className,
        selected: row.classList.contains('selected'),
      }));
      const mpvMessage = document.querySelector('.library-panel .panel-title small')?.title ?? '';
      throw new Error('Deck 2 load diagnostics: ' + JSON.stringify({ before: before.deck2, current, rows, mpvMessage }));
    });
    const afterLoadDeck1 = await deckState(1);
    const afterLoadCrossfade = crossfader?.value;

    const play1 = await waitFor(
      () => [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Deck 1 播放'),
      'Deck 1 play button not found',
    );
    const play2 = await waitFor(
      () => [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Deck 2 播放'),
      'Deck 2 play button not found',
    );
    play1.click();
    play2.click();
    await new Promise((resolve) => setTimeout(resolve, 650));
    const playing1 = await deckState(1);
    const playing2 = await deckState(2);
    const pause1 = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Deck 1 暂停');
    if (!pause1) throw new Error('Deck 1 pause button not found after playback started');
    pause1.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const deck1PausedAt = await deckState(1);
    const deck2ContinuesAt = await deckState(2);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const deck1StillPaused = await deckState(1);
    const deck2StillPlaying = await deckState(2);

    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    valueSetter.call(crossfader, '80');
    crossfader.dispatchEvent(new Event('input', { bubbles: true }));
    crossfader.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => crossfader.value === '80', 'crossfader did not accept operator input');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const mixed1 = await deckState(1);
    const mixed2 = await deckState(2);
    const pause2 = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Deck 2 暂停');
    pause2?.click();

    return {
      before,
      loadedDeck2,
      afterLoadDeck1,
      afterLoadCrossfade,
      playing1,
      playing2,
      deck1PausedAt,
      deck2ContinuesAt,
      deck1StillPaused,
      deck2StillPlaying,
      mixed1,
      mixed2,
      beforeCrossfade,
      afterCrossfade: crossfader?.value,
    };
  })()`);

  assert.equal(result.before.deck1.running, true);
  assert.equal(result.before.deck2.running, true);
  assert.notEqual(result.before.deck1.path, result.before.deck2.path);
  assert.equal(result.loadedDeck2.paused, true, "loading a candidate must leave Deck 2 paused");
  assert.notEqual(result.loadedDeck2.path, result.before.deck2.path);
  assert.equal(result.afterLoadDeck1.path, result.before.deck1.path, "loading Deck 2 changed Deck 1");
  assert.equal(result.afterLoadCrossfade, result.beforeCrossfade, "loading a candidate moved the crossfader");
  assert.equal(result.playing1.paused, false);
  assert.equal(result.playing2.paused, false);
  assert.ok(result.playing1.timePos > 0, "Deck 1 time-pos did not advance");
  assert.ok(result.playing2.timePos > 0, "Deck 2 time-pos did not advance");
  assert.equal(result.deck1PausedAt.paused, true);
  assert.equal(result.deck2ContinuesAt.paused, false);
  assert.ok(Math.abs(result.deck1StillPaused.timePos - result.deck1PausedAt.timePos) < 0.08, "Deck 1 advanced while paused");
  assert.ok(result.deck2StillPlaying.timePos > result.deck2ContinuesAt.timePos, "Deck 2 stopped when Deck 1 paused");
  assert.ok(Math.abs(result.mixed1.volume - Math.cos(0.8 * Math.PI / 2) * 100) < 1, `Deck 1 mix volume is wrong: ${result.mixed1.volume}`);
  assert.ok(Math.abs(result.mixed2.volume - Math.sin(0.8 * Math.PI / 2) * 100) < 1, `Deck 2 mix volume is wrong: ${result.mixed2.volume}`);
  assert.equal(result.afterCrossfade, "80");
});
