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
  const timeout = setTimeout(() => reject(new Error("Beam live test timed out")), 45_000);
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
      expression:`(async () => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const common = { host:"192.168.1.154", expectedShowName:"2024.12.28" };
        let prepared = null;
        let show = null;
        try {
          prepared = await invoke("titan_update_beam", {...common,dimmerPercent:0,shutterOpen:true,panValue:0.5,tiltValue:0.5});
          show = await invoke("titan_run_beam_show", {...common,bpm:128,panValue:0.5,tiltValue:0.5});
          return {ok:true,prepared,show};
        } finally {
          await invoke("titan_update_beam", {...common,dimmerPercent:0,shutterOpen:false,panValue:null,tiltValue:null});
        }
      })()`,
      returnByValue:true,
      awaitPromise:true,
    },
  }));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
