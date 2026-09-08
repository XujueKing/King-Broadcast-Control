const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const inspectOutput = process.argv.includes("--output");
const main = targets.find((target) => (inspectOutput ? target.url.includes("output.html") : !target.url.includes("output.html")) && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");
const playDeck = Number(process.argv.find((argument) => argument.startsWith("--play="))?.split("=")[1]);

const socket = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Audio status read timed out")), 15000);
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
        ${Number.isFinite(playDeck) ? `await window.__TAURI_INTERNALS__.invoke('mpv_deck_set_paused', { deck: ${playDeck}, paused: false });` : ""}
        const mediaLibrary = await window.__TAURI_INTERNALS__.invoke('scan_media_library');
        return ({
        deck1: await window.__TAURI_INTERNALS__.invoke('mpv_deck_state', { deck: 1 }),
        deck2: await window.__TAURI_INTERNALS__.invoke('mpv_deck_state', { deck: 2 }),
        aiWorker: await window.__TAURI_INTERNALS__.invoke('audio_ai_worker_status'),
        mediaLibrary: {
          audioCount: mediaLibrary.audio?.length ?? 0,
          audioImport: mediaLibrary.audioImport,
          lyricChecks: (mediaLibrary.audio ?? [])
            .filter((item) => ['爱如潮水 (Live)', '答案'].includes(item.name))
            .map((item) => ({ name: item.name, artist: item.artist, lyricsPath: item.lyricsPath })),
        },
        qu16Meter: await window.__TAURI_INTERNALS__.invoke('qu16_meter_status'),
        lighting: (() => {
          const toggle = document.querySelector('.lighting-power-toggle:not(.beam-show-arm)');
          const identity = document.querySelector('.titan-panel-identity');
          const automatic = document.querySelector('.quick-actions .auto');
          const beamArm = document.querySelector('.beam-show-arm');
          return {
            enabled: toggle?.getAttribute('aria-pressed') === 'true',
            toggleText: toggle?.textContent?.trim() ?? '',
            titanText: identity?.textContent?.trim() ?? '',
            automatic: automatic?.getAttribute('aria-pressed') === 'true',
            beamShowArmed: beamArm?.getAttribute('aria-pressed') === 'true',
            beamShowText: beamArm?.textContent?.trim() ?? '',
          };
        })(),
        videoAudio: (() => {
          const toggle = document.querySelector('.video-audio-toggle');
          return {
            enabled: toggle?.getAttribute('aria-pressed') === 'true',
            text: toggle?.textContent?.trim() ?? '',
            videos: [...document.querySelectorAll('video')].map((video) => ({
              muted:video.muted,
              paused:video.paused,
              volume:video.volume,
              currentSrc:video.currentSrc,
            })),
          };
        })(),
        buttons: [...document.querySelectorAll('.deck')].map((deck) => ({
          title: deck.querySelector('h3,b')?.textContent ?? '',
          text: deck.innerText.slice(0, 180),
        })),
        trackRows: [...document.querySelectorAll('.track-row')].slice(0, 5).map((row, index) => ({
          index,
          text: row.innerText.slice(0, 160),
          className: row.className,
        })),
        });
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
