const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const includeEntries = process.env.KING_QU16_LIVE_VERBOSE === "1";
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = targets.find((target) => !target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");

const socket = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Qu-16 status read timed out")), 5000);
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
        const status = await window.__TAURI_INTERNALS__.invoke('qu16_parameter_status');
        const entries = Object.entries(status.parameters ?? {});
        const groups = entries.reduce((counts,[key]) => {
          const kind=key.split(":",1)[0];
          counts[kind]=(counts[kind]??0)+1;
          return counts;
        },{});
        const surface = document.querySelector('.qu-surface');
        const ui = [...document.querySelectorAll('.qu-channel')].slice(7, 9).map((channel, index) => ({
          channel: index + 8,
          source: channel.dataset.sourceId ?? '',
          layer: channel.dataset.layer ?? '',
          value: channel.querySelector('.qu-vertical-fader')?.value ?? '',
          selected: channel.classList.contains('selected'),
        }));
        const processingLamps = [...document.querySelectorAll('.qu-superstrip [data-panel-key]')].map(node => ({
          key: node.dataset.panelKey,
          state: node.dataset.lampState,
          known: node.dataset.parameterKnown,
        }));
        const muteGroups = [...document.querySelectorAll('.qu-softkeys [data-softkey]')].map(node => ({
          key: Number(node.dataset.softkey),
          state: node.dataset.groupState,
          origin: node.dataset.syncOrigin,
          disabled: node.disabled,
        }));
        return {
          status: { host: status.host, state: status.state, synced: status.synced, sessionId: status.sessionId, revision: status.revision, lastError: status.lastError, parameterCount:entries.length, groups, entries:${includeEntries ? "entries" : "undefined"}, pendingDetails: status.pendingDetails },
          dom: {
            qaRootCount: document.querySelectorAll('#qu16-control-qa-root').length,
            mixerWorkspaceCount: document.querySelectorAll('.mixer-workspace').length,
          },
          surface: surface ? { layer: surface.dataset.layer, activeMix: surface.dataset.activeMix, navigationSync: surface.dataset.navigationSync, lastHardwareKey: surface.dataset.lastHardwareKey, lastHardwareValue: surface.dataset.lastHardwareValue, lastHardwareRevision: surface.dataset.lastHardwareRevision } : null,
          ui,
          indicators: { processingLamps, muteGroups },
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
