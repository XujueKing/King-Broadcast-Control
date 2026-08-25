const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const durationMs=Number(process.env.KING_QU16_WATCH_MS??120000);
const targets=await fetch(`${endpoint}/json/list`).then(response=>response.json());
const main=targets.find(target=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");

const socket=new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{
  socket.addEventListener("open",resolve,{once:true});
  socket.addEventListener("error",reject,{once:true});
});

let requestId=0;
const pending=new Map();
socket.addEventListener("message",event=>{
  const message=JSON.parse(String(event.data));
  const waiter=pending.get(message.id);
  if(!waiter)return;
  pending.delete(message.id);
  message.error?waiter.reject(new Error(JSON.stringify(message.error))):waiter.resolve(message.result?.result?.value);
});

function evaluate(expression){
  const id=++requestId;
  return new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    socket.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}}));
  });
}

const expression=`(async()=>{
  const status=await window.__TAURI_INTERNALS__.invoke('qu16_parameter_status');
  const entries=Object.entries(status.parameters??{}).filter(([key])=>/^(?:fader|send):/.test(key));
  const surface=document.querySelector('.qu-surface');
  const activeLayer=surface?.dataset?.layer??'';
  const slots=[...document.querySelectorAll('.qu-channel')].slice(7,9).map((channel,index)=>({
    slot:index+8,
    source:channel.dataset.sourceId??'',
    layer:channel.dataset.layer??'',
    value:channel.querySelector('.qu-vertical-fader')?.value??'',
    selected:channel.classList.contains('selected'),
  }));
  return {revision:status.revision,entries,activeLayer,lastHardwareKey:surface?.dataset?.lastHardwareKey??'',lastHardwareValue:surface?.dataset?.lastHardwareValue??'',lastHardwareRevision:surface?.dataset?.lastHardwareRevision??'',slots};
})()`;

const startedAt=Date.now();
let previousState=null;
while(Date.now()-startedAt<durationMs){
  const state=await evaluate(expression);
  if(previousState){
    const previousEntries=new Map(previousState.entries);
    const changes=state.entries.filter(([key,value])=>previousEntries.get(key)!==value);
    const surfaceChanged=state.activeLayer!==previousState.activeLayer||state.lastHardwareRevision!==previousState.lastHardwareRevision;
    if(changes.length||surfaceChanged){
      console.log(new Date().toISOString(),JSON.stringify({revision:state.revision,changes,activeLayer:state.activeLayer,lastHardwareKey:state.lastHardwareKey,lastHardwareValue:state.lastHardwareValue,lastHardwareRevision:state.lastHardwareRevision,slots:state.slots}));
    }
  }else{
    console.log(new Date().toISOString(),JSON.stringify({revision:state.revision,changes:[],activeLayer:state.activeLayer,lastHardwareKey:state.lastHardwareKey,lastHardwareValue:state.lastHardwareValue,lastHardwareRevision:state.lastHardwareRevision,slots:state.slots}));
  }
  previousState=state;
  await new Promise(resolve=>setTimeout(resolve,100));
}
socket.close();
