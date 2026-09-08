const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const deckIndex = process.argv.indexOf("--deck");
const deck = deckIndex >= 0 ? Number(process.argv[deckIndex + 1]) : 1;
const actionIndex = process.argv.indexOf("--action");
const action = actionIndex >= 0 ? process.argv[actionIndex + 1] : "toggle";
if (![1,2].includes(deck) || !["play","pause","toggle"].includes(action)) {
  throw new Error("Usage: node scripts/toggle-deck-play-live.mjs --deck 1|2 --action play|pause|toggle");
}

const targets = await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main = targets.find((target)=>!target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");
const socket = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{
  socket.addEventListener("open",resolve,{once:true});
  socket.addEventListener("error",reject,{once:true});
});
const result = await new Promise((resolve,reject)=>{
  const timeout = setTimeout(()=>reject(new Error("Deck control timed out")),10_000);
  socket.addEventListener("message",(event)=>{
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{
    expression:`(async()=>{
      const button=document.querySelector('button.deck-play-toggle[aria-label^="Deck ${deck} "]');
      if(!button)throw new Error('Deck ${deck} play control not found');
      const playing=button.getAttribute('aria-pressed')==='true';
      const action=${JSON.stringify(action)};
      if((action==='play'&&!playing)||(action==='pause'&&playing)||action==='toggle')button.click();
      await new Promise(resolve=>setTimeout(resolve,500));
      return {deck:${deck},playing:button.getAttribute('aria-pressed')==='true',label:button.getAttribute('aria-label')};
    })()`,returnByValue:true,awaitPromise:true,
  }}));
});
socket.close();
console.log(JSON.stringify(result,null,2));
