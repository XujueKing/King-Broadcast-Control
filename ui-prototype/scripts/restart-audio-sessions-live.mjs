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
  const timeout = setTimeout(() => reject(new Error("Audio session restart timed out")), 20_000);
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
      const before=await Promise.all([1,2].map((deck)=>invoke("mpv_deck_state",{deck})));
      await Promise.all(before.map((state)=>invoke("mpv_deck_set_volume",{deck:state.deck,volume:0}).catch(()=>null)));
      await Promise.all(before.map((state)=>invoke("mpv_deck_set_paused",{deck:state.deck,paused:true}).catch(()=>null)));
      await Promise.all([1,2].map((deck)=>invoke("mpv_deck_shutdown",{deck})));
      const restored=[];
      for(const state of before){
        if(!state.path){
          restored.push(await invoke("mpv_deck_state",{deck:state.deck}));
          continue;
        }
        await invoke("mpv_deck_load",{deck:state.deck,path:state.path});
        if(state.timePos>0)await invoke("mpv_deck_seek",{deck:state.deck,seconds:state.timePos});
        await invoke("mpv_deck_set_volume",{deck:state.deck,volume:state.volume});
        restored.push(await invoke("mpv_deck_set_paused",{deck:state.deck,paused:true}));
      }
      return {before,restored};
    })()`,returnByValue:true,awaitPromise:true,
  }}));
});
socket.close();
console.log(JSON.stringify(result,null,2));
