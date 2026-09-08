const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const durationSeconds=Math.max(10,Number(process.argv.find((arg)=>arg.startsWith("--seconds="))?.split("=")[1])||120);
const testVolume=Math.min(100,Math.max(0,Number(process.argv.find((arg)=>arg.startsWith("--volume="))?.split("=")[1])||66));
const deckNumber=Number(process.argv.find((arg)=>arg.startsWith("--deck="))?.split("=")[1])===2?2:1;
const targets=await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main=targets.find((target)=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");
const socket=new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true})});
let requestId=0;
const evaluate=(expression)=>new Promise((resolve,reject)=>{
  const id=++requestId;
  const timeout=setTimeout(()=>reject(new Error(`CDP request ${id} timed out`)),10000);
  const listener=(event)=>{const message=JSON.parse(String(event.data));if(message.id!==id)return;socket.removeEventListener("message",listener);clearTimeout(timeout);if(message.error)reject(new Error(JSON.stringify(message.error)));else resolve(message.result?.result?.value)};
  socket.addEventListener("message",listener);
  socket.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}}));
});
const sleep=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));
let original=null;
let stopping=false;
const stop=async()=>{
  if(stopping)return;
  stopping=true;
  try{
    const restoreVolume=Number(original?.volume)||0;
    await evaluate(`(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;for(const volume of [44,22,0]){await invoke("mpv_deck_set_volume",{deck:${deckNumber},volume});await new Promise((resolve)=>setTimeout(resolve,120));}await invoke("mpv_deck_set_paused",{deck:${deckNumber},paused:true});return invoke("mpv_deck_set_volume",{deck:${deckNumber},volume:${restoreVolume}})})()`);
  }finally{socket.close();}
};
process.on("SIGINT",async()=>{await stop();process.exit(130)});
try{
  original=await evaluate(`window.__TAURI_INTERNALS__.invoke("mpv_deck_state",{deck:${deckNumber}})`);
  if(!original?.path)throw new Error(`Deck ${deckNumber} has no loaded track`);
  await evaluate(`(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;await invoke("mpv_deck_set_paused",{deck:${deckNumber},paused:true});await invoke("mpv_deck_set_volume",{deck:${deckNumber},volume:0});await invoke("mpv_deck_set_paused",{deck:${deckNumber},paused:false});for(const volume of [11,22,33,44,55,${testVolume}]){await new Promise((resolve)=>setTimeout(resolve,150));await invoke("mpv_deck_set_volume",{deck:${deckNumber},volume})}return invoke("mpv_deck_state",{deck:${deckNumber}})})()`);
  console.log(JSON.stringify({event:"started",deckNumber,durationSeconds,testVolume,startedAt:new Date().toISOString()}));
  const startedAt=Date.now();
  while((Date.now()-startedAt)/1000<durationSeconds){
    await sleep(10000);
    const sample=await evaluate(`(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;const [deck,meter]=await Promise.all([invoke("mpv_deck_state",{deck:${deckNumber}}),invoke("qu16_meter_status")]);return {deck,lr:meter?.masters?.LR,st3:meter?.channels?.["st-3"],frameSequence:meter?.frameSequence,updatedAtMs:meter?.updatedAtMs}})()`);
    console.log(JSON.stringify({event:"sample",elapsedSeconds:Math.round((Date.now()-startedAt)/1000),...sample}));
  }
}finally{
  await stop();
  console.log(JSON.stringify({event:"stopped",stoppedAt:new Date().toISOString()}));
}
