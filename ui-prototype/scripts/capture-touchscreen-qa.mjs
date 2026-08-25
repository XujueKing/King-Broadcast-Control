import fs from "node:fs/promises";
import path from "node:path";

const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const targets=await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main=targets.find((target)=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");

const socket=new WebSocket(main.webSocketDebuggerUrl);
let sequence=0;
const pending=new Map();
socket.addEventListener("message",(event)=>{const message=JSON.parse(String(event.data));if(!message.id||!pending.has(message.id))return;const handler=pending.get(message.id);pending.delete(message.id);message.error?handler.reject(new Error(JSON.stringify(message.error))):handler.resolve(message.result)});
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true})});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});

const requestedPage=process.env.KING_TOUCHSCREEN_PAGE??"Processing";
const requestedHover=process.env.KING_TOUCHSCREEN_HOVER??"";
await call("Runtime.evaluate",{expression:`(async()=>{
  [...document.querySelectorAll('.bottom-nav button')].find((button)=>button.textContent.includes('调音台'))?.click();
  await new Promise((resolve)=>setTimeout(resolve,380));
  const labels=[...document.querySelectorAll('.qu-processing label')];
  labels.find((label)=>label.textContent.trim()==='${requestedPage}')?.querySelector('button')?.click();
  await new Promise((resolve)=>setTimeout(resolve,100));
})()`,awaitPromise:true});

const geometryResult=await call("Runtime.evaluate",{expression:`(()=>{
  const screen=document.querySelector('.qu-touchscreen');
  const select=document.querySelector('.qu-processing');
  const bank=document.querySelector('.qu-knob-bank');
  if(!screen||!select||!bank)return null;
  const a=screen.getBoundingClientRect();
  const b=select.getBoundingClientRect();
  const bankRect=bank.getBoundingClientRect();
  const x=Math.min(a.x,b.x)-3;
  const y=Math.min(a.y,b.y)-11;
  const right=Math.max(a.right,b.right)+3;
  const bottom=Math.max(a.bottom,b.bottom)+3;
  return {x,y,width:right-x,height:bottom-y,screenWidth:a.width,screenHeight:a.height,bankWidth:bankRect.width,bankHeight:bankRect.height,page:screen.querySelector('.qu-lcd-panel')?.dataset.screenPage};
})()`,returnByValue:true});
const geometry=geometryResult.result.value;
if(!geometry)throw new Error("Qu-16 Touch Screen cluster not found");
if(requestedHover){
  const hoverSelectors={fn:".qu-screen-fn button",copy:".qu-screen-edit-keys label:nth-child(1) button",paste:".qu-screen-edit-keys label:nth-child(2) button",reset:".qu-screen-edit-keys label:nth-child(3) button",processing:".qu-processing label:nth-child(1)>button",home:".qu-processing label:nth-child(3)>button"};
  const selector=hoverSelectors[requestedHover];
  if(!selector)throw new Error(`Unsupported Touch Screen hover target: ${requestedHover}`);
  const hoverPoint=await call("Runtime.evaluate",{expression:`(()=>{const node=document.querySelector('${selector}');const rect=node?.getBoundingClientRect();return rect?{x:rect.x+rect.width/2,y:rect.y+rect.height/2}:null})()`,returnByValue:true});
  if(!hoverPoint.result.value)throw new Error(`Touch Screen hover target not found: ${requestedHover}`);
  await call("Input.dispatchMouseEvent",{type:"mouseMoved",...hoverPoint.result.value});
  await new Promise((resolve)=>setTimeout(resolve,40));
}else{
  await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:geometry.x-5,y:geometry.y-5});
}
const shot=await call("Page.captureScreenshot",{format:"png",fromSurface:true,clip:{x:geometry.x,y:geometry.y,width:geometry.width,height:geometry.height,scale:1}});
const suffix=`${requestedPage.toLowerCase()}${requestedHover?`-hover-${requestedHover}`:""}`;
const output=path.resolve(`artifacts/qu16-touchscreen-${suffix}.png`);
await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,Buffer.from(shot.data,"base64"));
if(requestedPage!=="Processing")await call("Runtime.evaluate",{expression:`[...document.querySelectorAll('.qu-processing label')].find((label)=>label.textContent.trim()==='Processing')?.querySelector('button')?.click()`});
socket.close();
console.log(JSON.stringify({output,...geometry},null,2));
