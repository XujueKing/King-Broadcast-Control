const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const readArg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
};
const paletteTitanId = readArg("palette", 33207);
const dimmerPercent = readArg("dimmer", 10);
const speedValue = readArg("speed", 0.361);
const pulse = process.argv.includes("--pulse");
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = targets.find((target) => !target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");

const socket = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once:true });
  socket.addEventListener("error", reject, { once:true });
});

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Gatling live update timed out")), 10_000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({
    id:1,
    method:"Runtime.evaluate",
    params:{
      expression:`(async()=>{
        const invoke=(dimmerPercent)=>window.__TAURI_INTERNALS__.invoke("titan_update_gatling", {
          host:"192.168.1.154",
          expectedShowName:"2024.12.28",
          paletteTitanId:${paletteTitanId},
          dimmerPercent,
          speedValue:${speedValue},
        });
        ${pulse ? `
        const low=await invoke(3);
        await new Promise(resolve=>setTimeout(resolve,1000));
        const peak=await invoke(100);
        await new Promise(resolve=>setTimeout(resolve,3000));
        const restored=await invoke(${dimmerPercent});
        return {low,peak,restored};
        ` : `return invoke(${dimmerPercent});`}
      })()`,
      returnByValue:true,
      awaitPromise:true,
    },
  }));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
