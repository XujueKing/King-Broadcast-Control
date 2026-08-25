import fs from "node:fs/promises";
import path from "node:path";

const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const targets=await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main=targets.find((target)=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");

const socket=new WebSocket(main.webSocketDebuggerUrl);
let sequence=0;
const pending=new Map();
socket.addEventListener("message",(event)=>{
  const message=JSON.parse(String(event.data));
  if(!message.id||!pending.has(message.id))return;
  const handler=pending.get(message.id);
  pending.delete(message.id);
  message.error?handler.reject(new Error(JSON.stringify(message.error))):handler.resolve(message.result);
});
await new Promise((resolve,reject)=>{
  socket.addEventListener("open",resolve,{once:true});
  socket.addEventListener("error",reject,{once:true});
});
const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence;
  pending.set(id,{resolve,reject});
  socket.send(JSON.stringify({id,method,params}));
});

let result;
try{
  await call("Runtime.evaluate",{expression:`(async()=>{
    [...document.querySelectorAll('.bottom-nav button')].find((button)=>button.textContent.includes('调音台'))?.click();
    await new Promise((resolve)=>setTimeout(resolve,380));
    [...document.querySelectorAll('.qu-channel .qu-pafl[aria-pressed="true"]')].forEach((button)=>button.click());
    await new Promise((resolve)=>setTimeout(resolve,80));
    return true;
  })()`,awaitPromise:true});
  await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:1,y:1});

  const geometryResult=await call("Runtime.evaluate",{expression:`(()=>{
    const meter=document.querySelector('.qu-meter-bank[data-meter-source]');
    const monitor=document.querySelector('.qu-monitor-panel');
    const brandbar=document.querySelector('.qu-console-brandbar');
    const badge=document.querySelector('.qu-brandbar-art,.qu-brand-plaque.qu16,.qu-console-brandbar b');
    const processingButtons=[...document.querySelectorAll('.qu-processing button')];
    if(!meter||!monitor||!badge)return {missing:{meter:!meter,monitor:!monitor,badge:!badge}};
    const a=meter.getBoundingClientRect();
    const b=monitor.getBoundingClientRect();
    const rawBadge=badge.getBoundingClientRect();
    const c=badge.matches('.qu-brandbar-art')?{
      x:Math.min(a.x,b.x),y:rawBadge.y,right:rawBadge.right,bottom:rawBadge.bottom,
      width:rawBadge.right-Math.min(a.x,b.x),height:rawBadge.height
    }:rawBadge;
    const x=Math.min(a.x,b.x);
    const y=Math.min(a.y,b.y);
    const right=Math.max(a.right,b.right);
    const bottom=Math.max(a.bottom,b.bottom);
    const padding=2;
    const detailX=Math.max(0,Math.min(a.x,b.x,c.x)-padding);
    const detailY=Math.max(0,Math.min(a.y,b.y,c.y)-padding);
    const detailRight=Math.max(a.right,b.right,c.right)+padding;
    const detailBottom=Math.max(a.bottom,b.bottom,c.bottom)+padding;
    const processingButtonRects=processingButtons.map((button)=>{
      const rect=button.getBoundingClientRect();
      return {x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom};
    });
    const intersectsProcessingButton=processingButtonRects.some((rect)=>detailX<rect.right&&detailRight>rect.x&&detailY<rect.bottom&&detailBottom>rect.y);
    return {
      x,y,width:right-x,height:bottom-y,
      meter:{x:a.x,y:a.y,width:a.width,height:a.height},
      monitor:{x:b.x,y:b.y,width:b.width,height:b.height},
      source:meter.dataset.meterSource,
      meterColumns:meter.querySelectorAll('.qu-main-meter-column').length,
      monitorRotaries:monitor.querySelectorAll('.qu-rotary-control').length,
      detailGeometry:{
        x:detailX,
        y:detailY,
        width:detailRight-detailX,
        height:detailBottom-detailY,
        padding,
        badge:{x:c.x,y:c.y,width:c.width,height:c.height},
        meter:{x:a.x,y:a.y,width:a.width,height:a.height},
        monitor:{x:b.x,y:b.y,width:b.width,height:b.height},
        excludesProcessingButtons:!intersectsProcessingButton
      }
    };
  })()`,returnByValue:true});
  const geometry=geometryResult.result.value;
  if(!geometry||geometry.missing)throw new Error(`Qu-16 monitor capture nodes not found: ${JSON.stringify(geometry?.missing??null)}`);
  if(geometry.width<=0||geometry.height<=0)throw new Error(`Monitor-bank capture bounds are invalid: ${JSON.stringify(geometry)}`);
  if(geometry.detailGeometry.width<=0||geometry.detailGeometry.height<=0)throw new Error(`Monitor detail capture bounds are invalid: ${JSON.stringify(geometry.detailGeometry)}`);
  if(!geometry.detailGeometry.excludesProcessingButtons)throw new Error(`Monitor detail capture would include a Processing button: ${JSON.stringify(geometry.detailGeometry)}`);

  const shot=await call("Page.captureScreenshot",{format:"png",fromSurface:true,clip:{x:geometry.x,y:geometry.y,width:geometry.width,height:geometry.height,scale:1}});
  const output=path.resolve("artifacts/qu16-monitor-actual.png");
  const detailShot=await call("Page.captureScreenshot",{format:"png",fromSurface:true,clip:{x:geometry.detailGeometry.x,y:geometry.detailGeometry.y,width:geometry.detailGeometry.width,height:geometry.detailGeometry.height,scale:1}});
  const detailOutput=path.resolve("artifacts/qu16-monitor-detail-actual.png");
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,Buffer.from(shot.data,"base64"));
  await fs.writeFile(detailOutput,Buffer.from(detailShot.data,"base64"));
  result={output,...geometry,detailOutput};
}finally{
  socket.close();
}

console.log(JSON.stringify(result,null,2));
