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

test("real video uses PVW/Take and its audio switch stays independent from both Decks", async () => {
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const main = targets.find((target) => !/output\.html/.test(target.url) && /(?:localhost:1420\/|tauri\.localhost\/|index\.html(?:$|[?#]))/.test(target.url));
  const output = targets.find((target) => /output\.html/.test(target.url));
  assert.ok(main, "main Tauri WebView target not found");
  assert.ok(output, "output Tauri WebView target not found");

  const result = await evaluate(main, `(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const waitFor = async (predicate, message, timeout = 10000) => {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(message);
    };
    const waitForProgram = async (predicate, message) => {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const program = await invoke('get_program_state');
        if (predicate(program)) return program;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      throw new Error(message);
    };

    const videoButton = await waitFor(
      () => document.querySelector('.video-grid button[aria-label^="预览视频"]'),
      'real video tile did not appear after media scan',
    );
    const beforeProgram = await invoke('get_program_state');
    const beforeDeck1 = await invoke('mpv_deck_state', { deck: 1 });
    const beforeDeck2 = await invoke('mpv_deck_state', { deck: 2 }).catch(() => null);
    const crossfader = document.querySelector('.crossfader input');
    const beforeCrossfade = crossfader?.value;

    videoButton.click();
    await waitFor(() => document.querySelector('.media-preview-confirm .take'), 'Take button did not appear');
    const stagedProgram = await invoke('get_program_state');
    const previewVideo = document.querySelector('.preview-pane video, .led-stage video');
    document.querySelector('.media-preview-confirm .take').click();
    const mutedProgram = await waitForProgram(
      (program) => program?.media?.type === 'video' && program.media.muted === true,
      'confirmed video did not reach PGM in muted state',
    );
    await waitFor(
      () => document.querySelector('.led-stage video'),
      'confirmed video did not render in the C1 live preview',
    );
    const readPreviewVideo = () => {
      const video = document.querySelector('.led-stage video');
      return {
        source: video?.currentSrc ?? video?.src ?? '',
        time: video?.currentTime ?? -1,
        duration: Number.isFinite(video?.duration) ? video.duration : -1,
        paused: video?.paused ?? true,
        readyState: video?.readyState ?? 0,
        error: video?.error?.message ?? null,
      };
    };
    const previewPlaybackBefore = readPreviewVideo();
    const assetFetch = await fetch(previewPlaybackBefore.source)
      .then((response) => ({ ok: response.ok, status: response.status, type: response.headers.get('content-type'), length: response.headers.get('content-length') }))
      .catch((error) => ({ ok: false, status: 0, error: String(error) }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const previewPlaybackAfter = readPreviewVideo();

    const audioButton = await waitFor(
      () => document.querySelector('.video-audio-toggle'),
      'video audio toggle missing',
    );
    audioButton.click();
    const audibleProgram = await waitForProgram(
      (program) => program?.media?.id === mutedProgram.media.id && program.media.muted === false,
      'video audio did not enable in PGM state',
    );
    const afterDeck1 = await invoke('mpv_deck_state', { deck: 1 });
    const afterDeck2 = await invoke('mpv_deck_state', { deck: 2 }).catch(() => null);
    const afterCrossfade = crossfader?.value;

    audioButton.click();
    const remutedProgram = await waitForProgram(
      (program) => program?.media?.id === mutedProgram.media.id && program.media.muted === true,
      'video audio did not return to muted state',
    );

    return {
      beforeProgram,
      stagedProgram,
      previewVideoSource: previewVideo?.currentSrc ?? previewVideo?.src ?? '',
      previewPlaybackBefore,
      previewPlaybackAfter,
      assetFetch,
      mutedProgram,
      audibleProgram,
      remutedProgram,
      beforeDeck1,
      afterDeck1,
      beforeDeck2,
      afterDeck2,
      beforeCrossfade,
      afterCrossfade,
    };
  })()`);

  assert.equal(result.stagedProgram.media.id, result.beforeProgram.media.id, "PVW selection changed PGM before Take");
  assert.match(result.previewVideoSource, /real\.mp4/i);
  const previewDuration = result.previewPlaybackBefore.duration;
  const previewAdvance = previewDuration > 0
    ? (result.previewPlaybackAfter.time - result.previewPlaybackBefore.time + previewDuration) % previewDuration
    : result.previewPlaybackAfter.time - result.previewPlaybackBefore.time;
  assert.ok(
    previewAdvance > 0.2 && previewAdvance < 2,
    `C1 real MP4 playback did not advance: ${JSON.stringify({ before: result.previewPlaybackBefore, after: result.previewPlaybackAfter, assetFetch: result.assetFetch })}`,
  );
  assert.match(result.mutedProgram.media.path ?? "", /real\.mp4$/i);
  assert.equal(result.mutedProgram.media.muted, true);
  assert.equal(result.audibleProgram.media.muted, false);
  assert.equal(result.remutedProgram.media.muted, true);
  assert.equal(result.afterCrossfade, result.beforeCrossfade);
  assert.equal(result.afterDeck1.path, result.beforeDeck1.path);
  assert.equal(result.afterDeck1.paused, result.beforeDeck1.paused);
  assert.equal(result.afterDeck2?.path ?? null, result.beforeDeck2?.path ?? null);
  assert.equal(result.afterDeck2?.paused ?? null, result.beforeDeck2?.paused ?? null);

  const outputState = await evaluate(output, `(() => {
    const video = document.querySelector('.output-window-root video');
    return {
      hasVideo: Boolean(video),
      source: video?.currentSrc ?? video?.src ?? '',
      muted: video?.muted ?? null,
    };
  })()`);
  assert.equal(outputState.hasVideo, true);
  assert.match(outputState.source, /real\.mp4/i);
  assert.equal(outputState.muted, true);
});
