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
  ['gate-in','comp-in'].forEach((id)=>{
    const button=document.querySelector('[data-panel-key="'+id+'"]');
    if(button?.getAttribute('aria-pressed')==='true')button.click();
  });
  const geq=document.querySelector('.qu-hardware-block.geq');
  const geqButton=document.querySelector('[data-panel-key="geq-fader-flip"]');
  for(let index=0;index<3&&geq?.dataset.geqRange!=='off';index+=1){geqButton?.click();await new Promise((resolve)=>setTimeout(resolve,30));}
})()`,awaitPromise:true});

const inspect=async(controlId)=>{
  const result=await call("Runtime.evaluate",{expression:`(()=>{
    const button=document.querySelector('[data-panel-key="${controlId}"]');
    const lamp=button?.querySelector('i');
    const rect=button?.getBoundingClientRect();
    const style=button?getComputedStyle(button):null;
    const lampStyle=lamp?getComputedStyle(lamp):null;
    return button?{
      x:rect.x+rect.width/2,
      y:rect.y+rect.height/2,
      pressed:button.getAttribute('aria-pressed'),
      state:button.dataset.lampState,
      background:style.backgroundColor,
      shadow:style.boxShadow,
      filter:style.filter,
      lampDisplay:lampStyle.display,
      lampColor:lampStyle.backgroundColor
    }:null;
  })()`,returnByValue:true});
  if (!result.result.value) throw new Error(`${controlId} button not found`);
  return result.result.value;
};

const inspectCompGr=async()=>{
  const result=await call("Runtime.evaluate",{expression:`(()=>{
    const indicator=document.querySelector('.qu-hardware-block.comp .qu-comp-gr');
    const knob=document.querySelector('.qu-hardware-block.comp .qu-rotary-control');
    if(!indicator || !knob) return null;
    const indicatorRect=indicator.getBoundingClientRect();
    const knobRect=knob.getBoundingClientRect();
    return {
      state:indicator.dataset.compGr,
      color:getComputedStyle(indicator,'::before').backgroundColor,
      y:indicatorRect.y,
      knobY:knobRect.y,
      knobHeight:knobRect.height
    };
  })()`,returnByValue:true});
  if (!result.result.value) throw new Error('Comp GR indicator not found');
  return result.result.value;
};

const inspectPan=async()=>{
  const result=await call("Runtime.evaluate",{expression:`(()=>{
    const pan=document.querySelector('.qu-hardware-block.pan');
    const geq=document.querySelector('.qu-hardware-block.geq');
    const knob=pan?.querySelector('.qu-rotary-control');
    const leds=pan?[...pan.querySelectorAll('.qu-pan-leds i')]:[];
    const active=leds.findIndex((led)=>led.classList.contains('active'));
    if(!pan || !geq || !knob) return null;
    const panRect=pan.getBoundingClientRect();
    const geqRect=geq.getBoundingClientRect();
    const knobRect=knob.getBoundingClientRect();
    return {
      width:knobRect.width,
      height:knobRect.height,
      tickCount:leds.length,
      tick:Number(pan.querySelector('.qu-pan-leds')?.dataset.panTick),
      active,
      panWidth:panRect.width,
      geqWidth:geqRect.width
    };
  })()`,returnByValue:true});
  if (!result.result.value) throw new Error('Pan controls not found');
  return result.result.value;
};

const clickAt=async({x,y})=>{
  await call("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
  await call("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
};

await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:1,y:1});
await new Promise((resolve)=>setTimeout(resolve,50));
const gateOff=await inspect("gate-in");

await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:gateOff.x,y:gateOff.y});
await new Promise((resolve)=>setTimeout(resolve,80));
const gateHover=await inspect("gate-in");

await clickAt(gateOff);
await new Promise((resolve)=>setTimeout(resolve,160));
const gateOn=await inspect("gate-in");

const geqOff=await inspect("geq-fader-flip");
await clickAt(geqOff);
await new Promise((resolve)=>setTimeout(resolve,160));
const geqOn=await inspect("geq-fader-flip");

await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:1,y:1});
await new Promise((resolve)=>setTimeout(resolve,80));
const compOff=await inspect("comp-in");
const compGrOff=await inspectCompGr();
await clickAt(compOff);
await new Promise((resolve)=>setTimeout(resolve,80));
const compOn=await inspect("comp-in");
const compGrOn=await inspectCompGr();
await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:compOn.x,y:compOn.y});
await new Promise((resolve)=>setTimeout(resolve,80));
const compHover=await inspect("comp-in");

const panCenter=await inspectPan();
await call("Runtime.evaluate",{expression:`(()=>{const knob=document.querySelector('.qu-hardware-block.pan .qu-rotary-control');knob?.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));})()`});
await new Promise((resolve)=>setTimeout(resolve,30));
const panLeft=await inspectPan();
await call("Runtime.evaluate",{expression:`(()=>{const knob=document.querySelector('.qu-hardware-block.pan .qu-rotary-control');knob?.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));})()`});
await new Promise((resolve)=>setTimeout(resolve,30));
const panRight=await inspectPan();

await call("Runtime.evaluate",{expression:`(async()=>{
  ['gate-in','comp-in'].forEach((id)=>{
    const button=document.querySelector('[data-panel-key="'+id+'"]');
    if(button?.getAttribute('aria-pressed')==='true')button.click();
  });
  const geq=document.querySelector('.qu-hardware-block.geq');
  const geqButton=document.querySelector('[data-panel-key="geq-fader-flip"]');
  for(let index=0;index<3&&geq?.dataset.geqRange!=='off';index+=1){geqButton?.click();await new Promise((resolve)=>setTimeout(resolve,30));}
  const knob=document.querySelector('.qu-hardware-block.pan .qu-rotary-control');
  knob?.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));
  for(let index=0;index<10;index+=1)knob?.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true,cancelable:true}));
})()`,awaitPromise:true});
socket.close();

if (gateOff.pressed!=="false" || gateOff.state!=="off" || gateOff.lampDisplay==="none") throw new Error(`Gate off state is invalid: ${JSON.stringify(gateOff)}`);
if (gateHover.background!==gateOff.background || gateHover.shadow!==gateOff.shadow || gateHover.filter!==gateOff.filter) throw new Error(`Oval key hover style changed: ${JSON.stringify({gateOff,gateHover})}`);
if (gateOff.lampColor!=="rgb(20, 23, 25)" || gateOn.lampColor!=="rgb(228, 70, 77)") throw new Error(`Gate lamp colors are invalid: ${JSON.stringify({gateOff,gateOn})}`);
if (gateOn.pressed!=="true" || gateOn.state!=="on" || gateOn.background!==gateOff.background || gateOn.shadow!==gateOff.shadow || gateOn.filter!==gateOff.filter) throw new Error(`Gate shell changed with lamp state: ${JSON.stringify({gateOff,gateOn})}`);
if (geqOff.pressed!=="false" || geqOn.pressed!=="true" || geqOff.lampColor!=="rgb(20, 23, 25)" || geqOn.lampColor!=="rgb(228, 70, 77)") throw new Error(`GEQ lamp state is invalid: ${JSON.stringify({geqOff,geqOn})}`);
if (geqOn.background!==geqOff.background || geqOn.shadow!==geqOff.shadow || geqOn.filter!==geqOff.filter) throw new Error(`GEQ shell changed with lamp state: ${JSON.stringify({geqOff,geqOn})}`);
if (compOff.pressed!=="false" || compOn.pressed!=="true" || compOff.lampDisplay!=="none" || compOn.lampDisplay!=="none") throw new Error(`Comp button state is invalid: ${JSON.stringify({compOff,compOn})}`);
if (compOn.background!==compOff.background || compOn.shadow!==compOff.shadow || compOn.filter!==compOff.filter || compHover.background!==compOn.background || compHover.shadow!==compOn.shadow || compHover.filter!==compOn.filter) throw new Error(`Comp ordinary button shell changed: ${JSON.stringify({compOff,compOn,compHover})}`);
if (compGrOff.state!=="off" || compGrOff.color!=="rgb(20, 23, 25)" || compGrOn.state!=="on" || compGrOn.color!=="rgb(139, 179, 60)") throw new Error(`Comp GR indicator did not toggle: ${JSON.stringify({compGrOff,compGrOn})}`);
if (compGrOn.y<=compGrOn.knobY+compGrOn.knobHeight*0.68) throw new Error(`Comp GR indicator is not low enough: ${JSON.stringify(compGrOn)}`);
if (Math.abs(panCenter.width-panCenter.height)>0.25) throw new Error(`Pan knob is not circular: ${JSON.stringify(panCenter)}`);
if (panCenter.tickCount!==7 || panCenter.tick!==3 || panCenter.active!==3 || panLeft.tick!==0 || panLeft.active!==0 || panRight.tick!==6 || panRight.active!==6) throw new Error(`Pan seven-step indicator is invalid: ${JSON.stringify({panCenter,panLeft,panRight})}`);
if (panCenter.panWidth<=panCenter.geqWidth*1.5) throw new Error(`Pan section is not wider than GEQ: ${JSON.stringify(panCenter)}`);

console.log(JSON.stringify({gateOff,gateHover,gateOn,geqOff,geqOn,compOff,compOn,compHover,compGrOff,compGrOn,panCenter,panLeft,panRight},null,2));
