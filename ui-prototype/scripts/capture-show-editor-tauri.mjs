import { writeFile } from "node:fs/promises";
import path from "node:path";

const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const targets=await fetch(`${endpoint}/json/list`).then(response=>response.json());
const target=targets.find(item=>item.title==="KING CLUB Broadcast Control"&&!/output\.html/.test(item.url));
if(!target)throw new Error("KING CLUB Tauri control WebView not found");

const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{
  socket.addEventListener("open",resolve,{once:true});
  socket.addEventListener("error",()=>reject(new Error("Tauri WebView CDP connection failed")),{once:true});
});

let commandId=0;
const pending=new Map();
socket.addEventListener("message",event=>{
  const message=JSON.parse(String(event.data));
  if(!message.id||!pending.has(message.id))return;
  const {resolve,reject}=pending.get(message.id);
  pending.delete(message.id);
  if(message.error)reject(new Error(JSON.stringify(message.error)));
  else resolve(message.result);
});
const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++commandId;
  pending.set(id,{resolve,reject});
  socket.send(JSON.stringify({id,method,params}));
});
const evaluate=async(expression)=>{
  const result=await call("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||"WebView evaluation failed");
  return result.result?.value;
};

await call("Runtime.enable");
await call("Page.enable");
const state=await evaluate(`(async()=>{
  const nav=[...document.querySelectorAll('.bottom-nav button')].find(button=>button.innerText.includes('演出编排'));
  nav?.click();
  await new Promise(resolve=>setTimeout(resolve,700));
  const firstV1=document.querySelector('.lane-v1 .show-lane-clips button');
  firstV1?.click();
  const transfer=new DataTransfer();
  firstV1?.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
  const v2Lane=document.querySelector('.lane-v2 .show-lane-clips');
  v2Lane?.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  v2Lane?.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  await new Promise(resolve=>setTimeout(resolve,120));
  const setInput=(selector,value)=>{
    const input=document.querySelector(selector);
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    if(!input||!setter)return;
    setter.call(input,String(value));
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  };
  setInput('input[aria-label="片段源入点秒数"]',3.5);
  setInput('input[aria-label="片段源出点秒数"]',21);
  setInput('input[aria-label="片段时间线时长秒数"]',48);
  const repeat=[...document.querySelectorAll('.show-loop-settings label')].find(label=>label.innerText.includes('重复次数'));
  repeat?.querySelector('input[type=radio]')?.click();
  setInput('input[aria-label="片段重复次数"]',8);
  await new Promise(resolve=>setTimeout(resolve,120));
  document.querySelector('.show-save')?.click();
  await new Promise(resolve=>setTimeout(resolve,160));
  const savedProjects=Object.keys(localStorage).filter(key=>key.startsWith('king.show-project.v1.')).map(key=>{try{return JSON.parse(localStorage.getItem(key))}catch{return null}}).filter(Boolean).sort((left,right)=>(right.updatedAt||0)-(left.updatedAt||0));
  const persistedClip=savedProjects[0]?.tracks?.flatMap(track=>track.clips).find(clip=>Number(clip.sourceIn)===3.5&&Number(clip.sourceOut)===21&&Number(clip.timelineDuration)===48&&clip.loopMode==='重复次数'&&Number(clip.repeatCount)===8);
  const home=[...document.querySelectorAll('.bottom-nav button')].find(button=>button.innerText.includes('首页'));
  home?.click();
  await new Promise(resolve=>setTimeout(resolve,100));
  nav?.click();
  await new Promise(resolve=>setTimeout(resolve,450));
  const editor=document.querySelector('.show-editor');
  const timeline=document.querySelector('.show-timeline');
  return {
    activeNav:document.querySelector('.bottom-nav button.active')?.innerText?.trim(),
    editorVisible:Boolean(editor),
    editorRect:editor?{width:editor.getBoundingClientRect().width,height:editor.getBoundingClientRect().height}:null,
    timelineRect:timeline?{width:timeline.getBoundingClientRect().width,height:timeline.getBoundingClientRect().height}:null,
    monitors:document.querySelectorAll('.show-monitor').length,
    lanes:document.querySelectorAll('.show-lane').length,
    selectedAsset:document.querySelector('.show-asset-list button.active b')?.textContent,
    loopMode:[...document.querySelectorAll('.show-loop-settings label')].find(label=>label.querySelector('input[type=radio]')?.checked)?.innerText?.trim(),
    saveState:document.querySelector('.show-save')?.innerText?.trim(),
    persistedClip:Boolean(persistedClip),
    restoredInV2:Boolean(persistedClip&&[...document.querySelectorAll('.lane-v2 .show-lane-clips button span')].some(node=>node.textContent===persistedClip.name)),
    viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio},
    viteError:document.querySelector('vite-error-overlay')?.shadowRoot?.textContent?.slice(0,1200)??'',
  };
})()`);
if(!state.editorVisible||state.monitors!==2||state.lanes!==7||!state.persistedClip||!state.restoredInV2||state.viteError)throw new Error(`Show editor verification failed: ${JSON.stringify(state)}`);

const capture=await call("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false});
const outputPath=path.resolve("artifacts/show-editor-option-3-tauri.png");
await writeFile(outputPath,Buffer.from(capture.data,"base64"));
socket.close();
console.log(JSON.stringify({...state,screenshot:outputPath},null,2));
