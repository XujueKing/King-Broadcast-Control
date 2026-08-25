import fs from "node:fs/promises";
import path from "node:path";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main = targets.find((target)=>!target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");

const socket = new WebSocket(main.webSocketDebuggerUrl);
let sequence=0;
const pending=new Map();
socket.addEventListener("message",(event)=>{const message=JSON.parse(String(event.data));if(!message.id||!pending.has(message.id))return;const handler=pending.get(message.id);pending.delete(message.id);message.error?handler.reject(new Error(JSON.stringify(message.error))):handler.resolve(message.result)});
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true})});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});

const lampsOn=process.env.KING_SUPERSTRIP_LAMPS_ON==="1";
const captureHeight=Number(process.env.KING_SUPERSTRIP_CAPTURE_HEIGHT)||0;
let metricsOverridden=false;
if(captureHeight){
  const viewport=await call("Runtime.evaluate",{expression:`({width:window.innerWidth})`,returnByValue:true});
  await call("Emulation.setDeviceMetricsOverride",{width:Math.round(viewport.result.value.width),height:captureHeight,deviceScaleFactor:1,mobile:false});
  metricsOverridden=true;
  await new Promise((resolve)=>setTimeout(resolve,120));
}
await call("Runtime.evaluate",{expression:`(async()=>{[...document.querySelectorAll('.bottom-nav button')].find((button)=>button.textContent.includes('调音台'))?.click();await new Promise((resolve)=>setTimeout(resolve,380));${lampsOn ? `['gate-in','comp-in'].forEach((id)=>{const button=document.querySelector('[data-panel-key="'+id+'"]');if(button?.getAttribute('aria-pressed')!=='true')button.click()});const geq=document.querySelector('.qu-hardware-block.geq');const geqButton=document.querySelector('[data-panel-key="geq-fader-flip"]');for(let index=0;index<3&&geq?.dataset.geqRange!=='low';index+=1){geqButton?.click();await new Promise((resolve)=>setTimeout(resolve,30));}await new Promise((resolve)=>setTimeout(resolve,160));` : ""}return true})()`,awaitPromise:true});
const geometry=await call("Runtime.evaluate",{expression:`(()=>{const node=document.querySelector('.qu-knob-bank');const rect=node.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,rotaries:node.querySelectorAll('.qu-rotary-control').length,rangeInputs:node.querySelectorAll('input[type=range]').length}})()`,returnByValue:true});
const rect=geometry.result.value;
const shot=await call("Page.captureScreenshot",{format:"png",fromSurface:true,clip:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,scale:1}});
const output=path.resolve(captureHeight?`artifacts/qu16-superstrip-compact-${captureHeight}.png`:lampsOn?"artifacts/qu16-superstrip-lamps-on.png":"artifacts/qu16-superstrip-actual.png");
await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,Buffer.from(shot.data,"base64"));
if(lampsOn) await call("Runtime.evaluate",{expression:`(async()=>{['gate-in','comp-in'].forEach((id)=>{const button=document.querySelector('[data-panel-key="'+id+'"]');if(button?.getAttribute('aria-pressed')==='true')button.click()});const geq=document.querySelector('.qu-hardware-block.geq');const geqButton=document.querySelector('[data-panel-key="geq-fader-flip"]');for(let index=0;index<3&&geq?.dataset.geqRange!=='off';index+=1){geqButton?.click();await new Promise((resolve)=>setTimeout(resolve,30));}})()`,awaitPromise:true});
if(metricsOverridden)await call("Emulation.clearDeviceMetricsOverride");
socket.close();
console.log(JSON.stringify({output,...rect},null,2));
