import fs from "node:fs/promises";
import path from "node:path";

const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const targets=await fetch(`${endpoint}/json/list`).then(response=>response.json());
const main=targets.find(target=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");

const socket=new WebSocket(main.webSocketDebuggerUrl);
let sequence=0;
const pending=new Map();
socket.addEventListener("message",event=>{
  const message=JSON.parse(String(event.data));
  if(!message.id)return;
  const handler=pending.get(message.id);
  if(!handler)return;
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
const requestedWidth=Number.parseInt(process.env.KING_SURFACE_WIDTH??"",10);
const requestedHeight=Number.parseInt(process.env.KING_SURFACE_HEIGHT??"",10);
const requestedMix=process.env.KING_SURFACE_ACTIVE_MIX??"LR";
const requestedMute=Number.parseInt(process.env.KING_SURFACE_ACTIVE_MUTE??"",10);
const requestedPafl=Number.parseInt(process.env.KING_SURFACE_ACTIVE_PAFL??"",10);
const hasViewportOverride=Number.isFinite(requestedWidth)&&Number.isFinite(requestedHeight);
if(hasViewportOverride){
  await call("Emulation.setDeviceMetricsOverride",{width:requestedWidth,height:requestedHeight,deviceScaleFactor:1,mobile:false});
}

await call("Runtime.evaluate",{expression:`(async()=>{
  [...document.querySelectorAll('.bottom-nav button')].find(button=>button.textContent.includes('调音台'))?.click();
  await new Promise(resolve=>setTimeout(resolve,380));
  const mixId=(button)=>button?.dataset.mixSelect??button?.closest('.qu-mix-group[data-mix-select]')?.dataset.mixSelect??null;
  const findMixButton=(target)=>[...document.querySelectorAll('button')].find((button)=>mixId(button)===target);
  document.querySelector('[data-layer-select="lower"]')?.click();
  findMixButton('LR')?.click();
  await new Promise(resolve=>setTimeout(resolve,60));
  const requestedMix=${JSON.stringify(requestedMix)};
  if(requestedMix!=="LR"){
    findMixButton(requestedMix)?.click();
    await new Promise(resolve=>setTimeout(resolve,60));
  }
  document.querySelector('.qu-channel[data-slot="1"] .qu-key.select')?.click();
  const requestedMute=${Number.isFinite(requestedMute)?requestedMute:"null"};
  if(Number.isFinite(requestedMute)){
    const mute=document.querySelector('.qu-channel[data-slot="'+requestedMute+'"] .qu-key.mute');
    if(mute?.getAttribute("aria-pressed")!=="true")mute?.click();
    await new Promise(resolve=>setTimeout(resolve,60));
  }
  const requestedPafl=${Number.isFinite(requestedPafl)?requestedPafl:"null"};
  if(Number.isFinite(requestedPafl)){
    const pafl=document.querySelector('.qu-channel[data-slot="'+requestedPafl+'"] .qu-pafl');
    if(pafl?.getAttribute("aria-pressed")!=="true")pafl?.click();
    await new Promise(resolve=>setTimeout(resolve,60));
  }
  const geq=document.querySelector('.qu-hardware-block.geq');
  const geqButton=document.querySelector('[data-panel-key="geq-fader-flip"]');
  for(let index=0;index<3&&geq?.dataset.geqRange!=='off';index+=1){
    geqButton?.click();
    await new Promise(resolve=>setTimeout(resolve,35));
  }
  await new Promise(resolve=>setTimeout(resolve,120));
  return true;
})()`,awaitPromise:true});

const metrics=await call("Runtime.evaluate",{expression:`(()=>{
  const node=document.querySelector('.qu-surface');
  if(!node)return null;
  const rect=node.getBoundingClientRect();
  const bounds=element=>{const value=element?.getBoundingClientRect();return value?{x:value.x,y:value.y,width:value.width,height:value.height,bottom:value.bottom,right:value.right}:null};
  const type=element=>element?{...bounds(element),fontSize:getComputedStyle(element).fontSize,lineHeight:getComputedStyle(element).lineHeight}:null;
  const visual=element=>{if(!element)return null;const style=getComputedStyle(element);return {background:style.background,backgroundColor:style.backgroundColor,backgroundImage:style.backgroundImage,border:style.border,boxShadow:style.boxShadow,filter:style.filter,outline:style.outline}};
  const mixButtons=[...document.querySelectorAll('.qu-mix-select button')].filter((button)=>
    Boolean(button.dataset.mixSelect||button.closest('.qu-mix-group[data-mix-select]'))
  );
  const mixId=(button)=>button?.dataset.mixSelect??button?.closest('.qu-mix-group[data-mix-select]')?.dataset.mixSelect??null;
  const mixFamily=(button)=>button?.dataset.mixFamily??button?.closest('[data-mix-group]')?.dataset.mixGroup??null;
  const firstMixButton=mixButtons[0]??null;
  const activeMixButton=mixButtons.find((button)=>button.getAttribute('aria-pressed')==='true')??null;
  const lrButton=document.querySelector('.qu-master-strip button[data-mix-select="LR"],.qu-master-strip [data-mix-select="LR"] button');
  const layerKeys=[...document.querySelectorAll('button.qu-layer-key[data-layer-select]')];
  return {
    clip:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
    console:bounds(document.querySelector('.qu-console')),
    surface:bounds(node),
    layerRail:bounds(document.querySelector('.qu-layer-rail')),
    channels:bounds(document.querySelector('.qu-channels')),
    firstChannel:bounds(document.querySelector('.qu-channel')),
    firstFader:bounds(document.querySelector('.qu-channel .qu-fader-lane')),
    master:bounds(document.querySelector('.qu-master-strip')),
    mixSelect:bounds(document.querySelector('.qu-mix-select')),
    channelCount:document.querySelectorAll('.qu-channel').length,
    mixCount:mixButtons.length,
    mixFamilies:mixButtons.map((button)=>({id:mixId(button),family:mixFamily(button),face:visual(button.querySelector(':scope>i,.qu-surface-key-face'))})),
    meterTransport:document.querySelector('.qu-meter-bank')?.dataset.meterTransport??null,
    state:{
      activeMix:document.querySelector('.qu-surface')?.dataset.activeMix??null,
      activeMute:document.querySelector('.qu-channel .qu-key.mute[aria-pressed="true"]')?.closest('.qu-channel')?.dataset.slot??null,
      activePafl:document.querySelector('.qu-channel .qu-pafl[aria-pressed="true"]')?.closest('.qu-channel')?.dataset.slot??null,
      activeElement:document.activeElement?.outerHTML?.slice(0,180)??null,
      mixVisual:{
        outer:visual(activeMixButton),
        face:visual(activeMixButton?.querySelector('i')),
        label:visual(activeMixButton?.querySelector('span')),
        lamp:visual(activeMixButton?.querySelector('b'))
      },
      layerKeys:layerKeys.map((button)=>({
        id:button.dataset.layerSelect,
        pressed:button.getAttribute('aria-pressed'),
        keycap:bounds(button.querySelector(':scope>i')),
        lamp:bounds(button.querySelector(':scope>b')),
        independentLamp:Boolean(button.querySelector(':scope>b')&&!button.querySelector(':scope>i')?.contains(button.querySelector(':scope>b')))
      })),
      lrVisual:{
        pressed:lrButton?.getAttribute('aria-pressed')??null,
        face:visual(lrButton?.querySelector(':scope>i')),
        lamp:visual(lrButton?.querySelector(':scope>i>b'))
      },
      meterLamps:[...document.querySelectorAll('.qu-channel:first-of-type .qu-signal [data-meter-band]')].map((lamp)=>({
        band:lamp.dataset.meterBand,
        lit:lamp.dataset.lit,
        color:getComputedStyle(lamp).backgroundColor
      }))
    },
    bottomInset:rect.bottom-document.querySelector('.qu-channels').getBoundingClientRect().bottom,
    surfacePaddingBottom:Number.parseFloat(getComputedStyle(node).paddingBottom),
    controls:{
      upperOval:bounds(document.querySelector('[data-panel-key="gate-in"]')),
      channelMuteFace:bounds(document.querySelector('.qu-channel .qu-key.mute .qu-surface-key-face')),
      channelSelFace:bounds(document.querySelector('.qu-channel .qu-key.select .qu-surface-key-face')),
      channelPaflFace:bounds(document.querySelector('.qu-channel .qu-pafl .qu-surface-key-face')),
      channelCentreDot:bounds(document.querySelector('.qu-channel .qu-surface-key-face>b')),
      channelLabel:type(document.querySelector('.qu-channel .qu-key.mute>span')),
      signalLabel:type(document.querySelector('.qu-channel .qu-signal b')),
      stripLabel:type(document.querySelector('.qu-channel .qu-strip-screen b')),
      stripSecondary:type(document.querySelector('.qu-channel .qu-strip-screen small')),
      scaleLabel:type(document.querySelector('.qu-channel .qu-db-scale .major b')),
      softLabel:type(document.querySelector('.qu-softkeys>button>span')),
      softFace:bounds(document.querySelector('.qu-softkeys>button>i')),
      mixLabel:type(firstMixButton?.querySelector(':scope>span')),
      mixFace:bounds(firstMixButton?.querySelector(':scope>i,.qu-surface-key-face')),
      mixCentreDot:bounds(firstMixButton?.querySelector(':scope>i>b,.qu-surface-key-face>b'))
    },
    overflowX:Math.max(0,node.scrollWidth-node.clientWidth),
    overflowY:Math.max(0,node.scrollHeight-node.clientHeight)
  };
})()`,returnByValue:true});
if(!metrics.result.value)throw new Error("Qu-16 surface not found");
const {clip,...geometry}=metrics.result.value;
const shot=await call("Page.captureScreenshot",{format:"png",fromSurface:true,clip:{...clip,scale:1}});
const suffix=process.env.KING_SURFACE_SUFFIX?`-${process.env.KING_SURFACE_SUFFIX}`:"";
const output=path.resolve(`artifacts/qu16-surface-actual${suffix}.png`);
await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,Buffer.from(shot.data,"base64"));
if(hasViewportOverride)await call("Emulation.clearDeviceMetricsOverride");
socket.close();
console.log(JSON.stringify({output,...geometry},null,2));
