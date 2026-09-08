const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = targets.find((target) => !target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");
const socket = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once:true });
  socket.addEventListener("error", reject, { once:true });
});
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Deck pause timed out")), 5000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{
    expression:`(async()=>{
      document.querySelectorAll('.deck-play-toggle[aria-pressed="true"]').forEach((button)=>button.click());
      await new Promise((resolve)=>setTimeout(resolve,120));
      return Promise.all([1,2].map((deck)=>window.__TAURI_INTERNALS__.invoke("mpv_deck_set_paused",{deck,paused:true})));
    })()`,
    returnByValue:true,awaitPromise:true,
  }}));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
