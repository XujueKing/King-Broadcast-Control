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
  const timeout = setTimeout(() => reject(new Error("Titan read timed out")), 10_000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{
    expression:`(async()=>{
      const invoke=window.__TAURI_INTERNALS__.invoke;
      const [status,playbacks,staticPlaybacks]=await Promise.all([
        invoke("titan_status",{host:"192.168.1.154"}),
        invoke("titan_playbacks",{host:"192.168.1.154"}),
        invoke("titan_static_playbacks",{host:"192.168.1.154"}),
      ]);
      return {status,playbacks,staticPlaybacks};
    })()`,returnByValue:true,awaitPromise:true,
  }}));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
