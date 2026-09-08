const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const seconds=Math.max(2,Math.min(60,Number(process.argv.find((value)=>value.startsWith("--seconds="))?.split("=")[1])||8));
const targets=await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main=targets.find((target)=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");
const socket=new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true})});
const result=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error("Lighting observation timed out")),seconds*1000+7000);
  socket.addEventListener("message",(event)=>{const message=JSON.parse(String(event.data));if(message.id!==1)return;clearTimeout(timeout);if(message.error)reject(new Error(JSON.stringify(message.error)));else resolve(message.result?.result?.value)});
  socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression:`(async()=>{const events={rhythm:[],lighting:[],beam:[],color:[]};const handlers={rhythm:(event)=>events.rhythm.push(event.detail),lighting:(event)=>events.lighting.push(event.detail),beam:(event)=>events.beam.push(event.detail),color:(event)=>events.color.push(event.detail)};window.addEventListener('king:rhythm',handlers.rhythm);window.addEventListener('king:lighting-cue',handlers.lighting);window.addEventListener('king:beam-cue',handlers.beam);window.addEventListener('king:video-color',handlers.color);await new Promise((resolve)=>setTimeout(resolve,${seconds*1000}));window.removeEventListener('king:rhythm',handlers.rhythm);window.removeEventListener('king:lighting-cue',handlers.lighting);window.removeEventListener('king:beam-cue',handlers.beam);window.removeEventListener('king:video-color',handlers.color);return {counts:{rhythm:events.rhythm.length,lighting:events.lighting.length,beam:events.beam.length,color:events.color.length},lastRhythm:events.rhythm.at(-1)??null,lastLighting:events.lighting.at(-1)??null,lastBeam:events.beam.at(-1)??null,lastColor:events.color.at(-1)??null}})()`,returnByValue:true,awaitPromise:true}}));
});
socket.close();
console.log(JSON.stringify(result,null,2));
