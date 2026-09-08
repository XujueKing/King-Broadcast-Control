const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = targets.find((target) => !target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");
const socket = new WebSocket(main.webSocketDebuggerUrl);
const requestedEnabled = process.argv.includes("--enable");
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once:true });
  socket.addEventListener("error", reject, { once:true });
});
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Lighting link update timed out")), 5000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{
    expression:`(async()=>{
      const toggle=document.querySelector(".lighting-power-toggle:not(.beam-show-arm)");
      const wasEnabled=toggle?.getAttribute("aria-pressed")==="true";
      if(Boolean(${requestedEnabled})!==wasEnabled)toggle.click();
      await new Promise((resolve)=>setTimeout(resolve,180));
      return {wasEnabled,enabledAfter:toggle?.getAttribute("aria-pressed"),text:toggle?.textContent?.trim()};
    })()`,returnByValue:true,awaitPromise:true,
  }}));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
