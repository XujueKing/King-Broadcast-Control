import fs from "node:fs/promises";
import path from "node:path";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main = targets.find((target)=>!target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");

const socket = new WebSocket(main.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.addEventListener("message",(event)=>{
  const message=JSON.parse(String(event.data));
  if (!message.id) return;
  const handler=pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  message.error?handler.reject(new Error(JSON.stringify(message.error))):handler.resolve(message.result);
});
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true})});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
const requestedGeqRange=["low","high"].includes(process.env.KING_MIXER_GE_RANGE)?process.env.KING_MIXER_GE_RANGE:"";
const captureFullscreen=process.env.KING_MIXER_FULLSCREEN==="1";

await call("Runtime.evaluate",{expression:`(async()=>{
  [...document.querySelectorAll('.bottom-nav button')].find((button)=>button.textContent.includes('调音台'))?.click();
  await new Promise((resolve)=>setTimeout(resolve,380));
  ${requestedGeqRange?`const geq=document.querySelector('.qu-hardware-block.geq');const geqButton=document.querySelector('[data-panel-key="geq-fader-flip"]');for(let index=0;index<3&&geq?.dataset.geqRange!=='${requestedGeqRange}';index+=1){geqButton?.click();await new Promise((resolve)=>setTimeout(resolve,35));}`:""}
  return true;
})()`,awaitPromise:true});
const metrics=await call("Runtime.evaluate",{expression:`(()=>{const node=document.querySelector('.qu-console');const rect=${captureFullscreen?"{x:0,y:0,width:innerWidth,height:innerHeight}":"node.getBoundingClientRect()"};return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,channels:document.querySelectorAll('.qu-channel').length,model:document.querySelector('.mixer-workspace>header b')?.textContent}})()`,returnByValue:true});
const rect=metrics.result.value;
const shot=await call("Page.captureScreenshot",{format:"png",fromSurface:true,clip:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,scale:1}});
const output=path.resolve(captureFullscreen?"artifacts/qu16-mixer-fullscreen-actual.png":requestedGeqRange?`artifacts/qu16-mixer-geq-${requestedGeqRange}.png`:"artifacts/qu16-mixer-actual.png");
await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,Buffer.from(shot.data,"base64"));
if(requestedGeqRange)await call("Runtime.evaluate",{expression:`(async()=>{const geq=document.querySelector('.qu-hardware-block.geq');const geqButton=document.querySelector('[data-panel-key="geq-fader-flip"]');for(let index=0;index<3&&geq?.dataset.geqRange!=='off';index+=1){geqButton?.click();await new Promise((resolve)=>setTimeout(resolve,35));}})()`,awaitPromise:true});
socket.close();
console.log(JSON.stringify({output,...rect},null,2));
