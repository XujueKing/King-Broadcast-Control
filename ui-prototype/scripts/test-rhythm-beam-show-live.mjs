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
  const timeout = setTimeout(() => reject(new Error("Rhythm beam show timed out")), 50_000);
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
      const wait=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));
      const arm=document.querySelector(".beam-show-arm");
      const lighting=document.querySelector(".lighting-power-toggle:not(.beam-show-arm)");
      const cues=[];
      const record=(event)=>cues.push({
        at:Date.now(),look:event.detail?.look,beatIndex:event.detail?.rhythm?.beatIndex,
        energy:event.detail?.rhythm?.energy,dimmerPercent:event.detail?.dimmerPercent,
        shutterOpen:event.detail?.shutterOpen,panValue:event.detail?.panValue,tiltValue:event.detail?.tiltValue,
      });
      window.addEventListener("king:beam-cue",record);
      try{
        if(lighting?.getAttribute("aria-pressed")!=="true")lighting?.click();
        if(arm?.getAttribute("aria-pressed")!=="true")arm?.click();
        await wait(250);
        await invoke("mpv_deck_set_paused",{deck:1,paused:false});
        await wait(35_000);
        return {ok:true,cues,armedDuringTest:true};
      }finally{
        await Promise.all([1,2].map((deck)=>invoke("mpv_deck_set_paused",{deck,paused:true}).catch(()=>null)));
        if(arm?.getAttribute("aria-pressed")==="true")arm.click();
        await invoke("titan_update_beam",{
          host:"192.168.1.154",expectedShowName:"2024.12.28",
          dimmerPercent:0,shutterOpen:false,panValue:null,tiltValue:null,
        }).catch(()=>null);
        window.removeEventListener("king:beam-cue",record);
      }
    })()`,returnByValue:true,awaitPromise:true,
  }}));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
