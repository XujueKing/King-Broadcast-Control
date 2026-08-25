const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main = targets.find((target)=>!target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");

const socket = new WebSocket(main.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.addEventListener("message",(event)=>{
  const message=JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const handler=pending.get(message.id);
  pending.delete(message.id);
  message.error?handler.reject(new Error(JSON.stringify(message.error))):handler.resolve(message.result);
});
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true})});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});

await call("Runtime.evaluate",{expression:`(async()=>{
  [...document.querySelectorAll('.bottom-nav button')].find((button)=>button.textContent.includes('调音台'))?.click();
  await new Promise((resolve)=>setTimeout(resolve,380));
  const knob=document.querySelector('.qu-rotary-control');
  knob.focus();
  knob.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));
})()`,awaitPromise:true});

const geometry=await call("Runtime.evaluate",{expression:`(()=>{const knob=document.querySelector('.qu-rotary-control');const rect=knob.getBoundingClientRect();return {left:rect.left,top:rect.top,width:rect.width,height:rect.height,before:Number(knob.dataset.value),mode:knob.dataset.inputMode,rangeCount:document.querySelectorAll('.qu-hardware-knob input[type=range]').length}})()`,returnByValue:true});
const box=geometry.result.value;
const cx=box.left+box.width/2;
const cy=box.top+box.height/2;
const radius=Math.max(4,box.width*.38);

await call("Input.dispatchMouseEvent",{type:"mousePressed",x:cx+radius,y:cy,button:"left",buttons:1,clickCount:1});
await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:cx,y:cy+radius,button:"left",buttons:1});
await call("Input.dispatchMouseEvent",{type:"mouseReleased",x:cx,y:cy+radius,button:"left",buttons:0,clickCount:1});
await new Promise((resolve)=>setTimeout(resolve,80));

const afterPointer=await call("Runtime.evaluate",{expression:`Number(document.querySelector('.qu-rotary-control').dataset.value)`,returnByValue:true});
await call("Input.dispatchMouseEvent",{type:"mouseWheel",x:cx,y:cy,deltaX:0,deltaY:-100});
await new Promise((resolve)=>setTimeout(resolve,80));
const afterWheel=await call("Runtime.evaluate",{expression:`Number(document.querySelector('.qu-rotary-control').dataset.value)`,returnByValue:true});
socket.close();

const result={...box,afterPointer:afterPointer.result.value,afterWheel:afterWheel.result.value};
if (result.mode!=="rotary-360" || result.rangeCount!==0) throw new Error(`Not a true rotary control: ${JSON.stringify(result)}`);
if (result.afterPointer<45 || result.afterPointer>55) throw new Error(`Circular pointer motion failed: ${JSON.stringify(result)}`);
if (result.afterWheel!==result.afterPointer+1) throw new Error(`Wheel adjustment failed: ${JSON.stringify(result)}`);
console.log(JSON.stringify(result,null,2));
