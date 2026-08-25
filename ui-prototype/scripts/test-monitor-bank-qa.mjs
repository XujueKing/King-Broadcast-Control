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
const evaluate=async(expression)=>{
  const result=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  return result.result.value;
};
const wait=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));
const clickAt=async({x,y})=>{
  await call("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
  await call("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
};

let report;
let metricsOverridden=false;
try{
  await evaluate(`(async()=>{
    [...document.querySelectorAll('.bottom-nav button')].find((button)=>button.textContent.includes('调音台'))?.click();
    await new Promise((resolve)=>setTimeout(resolve,380));
    [...document.querySelectorAll('.qu-channel .qu-pafl[aria-pressed="true"]')].forEach((button)=>button.click());
    await new Promise((resolve)=>setTimeout(resolve,40));
    return true;
  })()`);
  await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:1,y:1});

  const inspect=()=>evaluate(`(()=>{
    const meter=document.querySelector('.qu-meter-bank[data-meter-source]');
    const monitor=document.querySelector('.qu-monitor-panel');
    const superstrip=document.querySelector('.qu-superstrip');
    const mainMeter=document.querySelector('.qu-main-meter');
    const talkBlock=document.querySelector('.qu-talk-block');
    const connectors=document.querySelector('.qu-monitor-connectors');
    const phonesSection=document.querySelector('.qu-phones-section');
    const altOutSection=document.querySelector('.qu-alt-out-section');
    const columns=[...document.querySelectorAll('.qu-main-meter-column[data-side]')];
    const meterHeaders=[...document.querySelectorAll('.qu-main-meter-head > span')];
    const scale=[...document.querySelectorAll('.qu-main-meter-scale span')];
    const paflLamp=document.querySelector('.qu-main-meter-pafl[data-lamp-state]');
    const paflDot=paflLamp?.querySelector('i');
    const paflText=paflLamp?.querySelector('span');
    const talk=document.querySelector('.qu-talk-key[data-talk-state]');
    const talkLabel=document.querySelector('.qu-talk-block>span');
    const lcdTalk=document.querySelector('.qu-lcd-talk-status');
    const st3=document.querySelector('.qu-st3-jack');
    const drive=document.querySelector('.qu-drive-socket');
    const phonesJack=document.querySelector('.qu-phones-jack');
    const phones=document.querySelector('[data-monitor-control="phones"] .qu-rotary-control');
    const altOut=document.querySelector('[data-monitor-control="alt-out"] .qu-rotary-control');
    const peq=document.querySelector('.qu-peq-grid .qu-rotary-control');
    const rect=(node)=>{
      const value=node?.getBoundingClientRect();
      return value?{x:value.x,y:value.y,width:value.width,height:value.height,right:value.right,bottom:value.bottom}:null;
    };
    const overflow=(node)=>node?{
      clientWidth:node.clientWidth,
      clientHeight:node.clientHeight,
      scrollWidth:node.scrollWidth,
      scrollHeight:node.scrollHeight
    }:null;
    return {
      exists:{meter:Boolean(meter),monitor:Boolean(monitor),superstrip:Boolean(superstrip),mainMeter:Boolean(mainMeter),talkBlock:Boolean(talkBlock),connectors:Boolean(connectors),phonesSection:Boolean(phonesSection),altOutSection:Boolean(altOutSection),paflLamp:Boolean(paflLamp),talk:Boolean(talk),lcdTalk:Boolean(lcdTalk),st3:Boolean(st3),drive:Boolean(drive),phonesJack:Boolean(phonesJack),phones:Boolean(phones),altOut:Boolean(altOut),peq:Boolean(peq)},
      source:meter?.dataset.meterSource,
      columnSides:columns.map((column)=>column.dataset.side),
      segmentCounts:columns.map((column)=>column.querySelectorAll('.qu-meter-segment').length),
      segmentRects:columns.map((column)=>[...column.querySelectorAll('.qu-meter-segment')].map(rect)),
      meterHeaderRects:meterHeaders.map(rect),
      scaleLabels:scale.map((label)=>label.textContent.trim()),
      scaleRects:scale.map(rect),
      paflContentRects:{dot:rect(paflDot),text:rect(paflText)},
      typography:{
        meterHeader:parseFloat(getComputedStyle(document.querySelector('.qu-main-meter-head>span')).fontSize),
        meterScale:parseFloat(getComputedStyle(scale[0]).fontSize),
        pafl:parseFloat(getComputedStyle(paflLamp.querySelector('span')).fontSize),
        talk:parseFloat(getComputedStyle(talkLabel).fontSize)
      },
      paflState:paflLamp?.dataset.lampState,
      talkState:talk?.dataset.talkState,
      talkPressed:talk?.getAttribute('aria-pressed'),
      lcdTalkActive:lcdTalk?.classList.contains('active')??false,
      lcdTalkLabel:lcdTalk?.getAttribute('aria-label')??"",
      rectangles:{meter:rect(meter),monitor:rect(monitor),superstrip:rect(superstrip),mainMeter:rect(mainMeter),talkBlock:rect(talkBlock),connectors:rect(connectors),phonesSection:rect(phonesSection),altOutSection:rect(altOutSection),paflLamp:rect(paflLamp),talk:rect(talk),talkLabel:rect(talkLabel),st3:rect(st3),drive:rect(drive),phonesJack:rect(phonesJack),phones:rect(phones),altOut:rect(altOut),peq:rect(peq)},
      overflow:{meter:overflow(meter),monitor:overflow(monitor),superstrip:overflow(superstrip)},
      legacyUsbPanelCount:document.querySelectorAll('.qu-usb-panel').length,
      monitorRotaryCount:monitor?.querySelectorAll('.qu-rotary-control').length??0,
      portsAreButtons:[st3,drive,phonesJack].some((node)=>Boolean(node?.closest('button'))),
      monitorKnobGuideDisplay:getComputedStyle(phones,'::before').display,
      values:{phones:Number(phones?.dataset.value),altOut:Number(altOut?.dataset.value)},
      points:{
        pafl:(()=>{const node=document.querySelector('.qu-channel .qu-pafl .qu-surface-key-face');const value=node?.getBoundingClientRect();return value?{x:value.x+value.width/2,y:value.y+value.height/2}:null})(),
        talk:(()=>{const value=talk?.getBoundingClientRect();return value?{x:value.x+value.width/2,y:value.y+value.height/2}:null})(),
        phones:(()=>{const value=phones?.getBoundingClientRect();return value?{x:value.x+value.width/2,y:value.y+value.height/2}:null})(),
        altOut:(()=>{const value=altOut?.getBoundingClientRect();return value?{x:value.x+value.width/2,y:value.y+value.height/2}:null})()
      }
    };
  })()`);

  const initial=await inspect();
  const missing=Object.entries(initial.exists).filter(([,exists])=>!exists).map(([name])=>name);
  if(missing.length)throw new Error(`Monitor-bank nodes are missing: ${JSON.stringify({missing,initial})}`);
  if(initial.columnSides.join(",")!=="L,R"||initial.segmentCounts.some((count)=>count!==12))throw new Error(`Main meter must have ordered L/R columns with 12 segments each: ${JSON.stringify(initial)}`);
  const expectedScale=["Pk","+12","+6","0","-3","-6","-9","-12","-16","-20","-30","-40"];
  if(initial.scaleLabels.join("|")!==expectedScale.join("|"))throw new Error(`Main meter scale is not the Qu-16 scale: ${JSON.stringify(initial.scaleLabels)}`);
  if(Math.abs(initial.typography.meterHeader-4.6)>.2||Math.abs(initial.typography.meterScale-4.5)>.2||Math.abs(initial.typography.pafl-4.8)>.2||Math.abs(initial.typography.talk-5)>.2)throw new Error(`Meter labels were overridden by a workspace-wide font rule: ${JSON.stringify(initial.typography)}`);
  for(const column of initial.segmentRects){
    if(column.some((segment)=>!segment||segment.width<=0||segment.height<=0))throw new Error(`Main meter contains a zero-sized segment: ${JSON.stringify(initial.segmentRects)}`);
    if(column.some((segment,index)=>index>0&&segment.y<column[index-1].y))throw new Error(`Main meter segments are not vertically ordered: ${JSON.stringify(initial.segmentRects)}`);
  }
  if(initial.meterHeaderRects.length!==2)throw new Error(`Main meter must expose L/R header geometry: ${JSON.stringify(initial.meterHeaderRects)}`);
  const centerX=(rectangle)=>rectangle.x+rectangle.width/2;
  const centerY=(rectangle)=>rectangle.y+rectangle.height/2;
  const headerCenterErrors=initial.meterHeaderRects.map((header,index)=>Math.abs(centerX(header)-centerX(initial.segmentRects[index][0])));
  if(headerCenterErrors.some((error)=>error>.75))throw new Error(`L/R headers are not centered over their LED columns: ${JSON.stringify({headerCenterErrors,headers:initial.meterHeaderRects,segments:initial.segmentRects.map((column)=>column[0])})}`);
  if(initial.scaleRects.length!==initial.segmentRects[0].length)throw new Error(`Meter scale geometry does not match the LED row count: ${JSON.stringify({scaleRects:initial.scaleRects,segmentRects:initial.segmentRects[0]})}`);
  const scaleCenterErrors=initial.scaleRects.map((label,index)=>Math.abs(centerY(label)-centerY(initial.segmentRects[0][index])));
  if(scaleCenterErrors.some((error)=>error>1.1))throw new Error(`Meter scale labels are not vertically centered with their LED rows: ${JSON.stringify({scaleCenterErrors,scaleRects:initial.scaleRects,segmentRects:initial.segmentRects[0]})}`);
  const {dot:paflDotRect,text:paflTextRect}=initial.paflContentRects;
  if(!paflDotRect||!paflTextRect)throw new Error(`PAFL dot or label geometry is missing: ${JSON.stringify(initial.paflContentRects)}`);
  const paflUnionLeft=Math.min(paflDotRect.x,paflTextRect.x);
  const paflUnionRight=Math.max(paflDotRect.right,paflTextRect.right);
  const paflCenterError=Math.abs((paflUnionLeft+paflUnionRight)/2-centerX(initial.rectangles.mainMeter));
  if(paflCenterError>.75)throw new Error(`PAFL dot and label group is not centered in the main meter: ${JSON.stringify({paflCenterError,paflContentRects:initial.paflContentRects,mainMeter:initial.rectangles.mainMeter})}`);
  if(initial.source!=="lr"||initial.paflState!=="off")throw new Error(`Main meter did not start in LR mode with PAFL off: ${JSON.stringify(initial)}`);

  const {meter,monitor,superstrip,mainMeter,talkBlock,connectors,phonesSection,altOutSection,st3,drive,phonesJack,phones,altOut,peq,talk,talkLabel}=initial.rectangles;
  const tolerance=1;
  const inside=(child,parent)=>child.x>=parent.x-tolerance&&child.y>=parent.y-tolerance&&child.right<=parent.right+tolerance&&child.bottom<=parent.bottom+tolerance;
  if(Math.abs(meter.y-monitor.y)>tolerance||Math.abs(meter.bottom-monitor.bottom)>tolerance||meter.right>monitor.x+tolerance)throw new Error(`Meter and monitor panels are not aligned side by side: ${JSON.stringify(initial.rectangles)}`);
  if(!inside(meter,superstrip)||!inside(monitor,superstrip))throw new Error(`Meter or monitor panel overflows the SuperStrip: ${JSON.stringify(initial.rectangles)}`);
  const ratios={mainMeter:mainMeter.height/meter.height,talk:talkBlock.height/meter.height,connectors:connectors.height/monitor.height,phonesSection:phonesSection.height/monitor.height,altOutSection:altOutSection.height/monitor.height};
  if(ratios.mainMeter<.70||ratios.mainMeter>.76||ratios.talk<.19||ratios.talk>.26||ratios.connectors<.38||ratios.connectors>.44||ratios.phonesSection<.33||ratios.phonesSection>.39||ratios.altOutSection<.19||ratios.altOutSection>.25)throw new Error(`Meter/monitor vertical proportions drifted from the Qu-16 reference: ${JSON.stringify(ratios)}`);
  if([st3,drive,phonesJack,phones,altOut].some((node)=>!inside(node,monitor)))throw new Error(`A monitor-panel control overflows its enclosure: ${JSON.stringify(initial.rectangles)}`);
  if(Math.abs(centerX(talk)-centerX(talkBlock))>.75||Math.abs(centerX(talkLabel)-centerX(talkBlock))>.75)throw new Error(`Talk label/key are not centred in their hardware block: ${JSON.stringify({talkBlock,talk,talkLabel})}`);
  if(Math.abs(centerX(phonesJack)-centerX(phones))>.75||Math.abs(centerX(phones)-centerX(altOut))>.75||Math.abs(centerX(phones)-centerX(monitor))>.75)throw new Error(`Phones jack and monitor rotaries do not share the hardware centreline: ${JSON.stringify({monitor,phonesJack,phones,altOut})}`);
  const verticalOrder=[st3,drive,phonesJack,phones,altOut];
  if(verticalOrder.some((node,index)=>index>0&&node.y<verticalOrder[index-1].bottom-tolerance))throw new Error(`Monitor-panel controls overlap or are out of order: ${JSON.stringify(verticalOrder)}`);
  if(initial.overflow.meter.scrollWidth>initial.overflow.meter.clientWidth+tolerance||initial.overflow.meter.scrollHeight>initial.overflow.meter.clientHeight+tolerance||initial.overflow.monitor.scrollWidth>initial.overflow.monitor.clientWidth+tolerance||initial.overflow.monitor.scrollHeight>initial.overflow.monitor.clientHeight+tolerance)throw new Error(`Monitor-bank content overflows its panel: ${JSON.stringify(initial.overflow)}`);
  if(initial.legacyUsbPanelCount!==0||initial.monitorRotaryCount!==2||initial.portsAreButtons||initial.monitorKnobGuideDisplay!=="none")throw new Error(`Legacy monitor card, rotary count, port semantics, or monitor knob guide are wrong: ${JSON.stringify({legacyUsbPanelCount:initial.legacyUsbPanelCount,monitorRotaryCount:initial.monitorRotaryCount,portsAreButtons:initial.portsAreButtons,monitorKnobGuideDisplay:initial.monitorKnobGuideDisplay})}`);
  if(Math.abs(phones.width-phones.height)>.25||Math.abs(altOut.width-altOut.height)>.25||Math.abs(phones.width-peq.width)>.5||Math.abs(phones.height-peq.height)>.5||Math.abs(altOut.width-peq.width)>.5||Math.abs(altOut.height-peq.height)>.5)throw new Error(`Phones and Alt Out rotaries do not match the PEQ rotary: ${JSON.stringify({phones,altOut,peq})}`);

  if(!initial.points.pafl)throw new Error("Channel PAFL control not found");
  await clickAt(initial.points.pafl);
  await wait(50);
  const paflOn=await inspect();
  if(paflOn.source!=="source:ch-1"||paflOn.paflState!=="on")throw new Error(`PAFL did not take over the main meter with the selected source identity: ${JSON.stringify(paflOn)}`);
  await clickAt(initial.points.pafl);
  await wait(50);
  const paflOff=await inspect();
  if(paflOff.source!=="lr"||paflOff.paflState!=="off")throw new Error(`PAFL did not restore the LR meter source: ${JSON.stringify(paflOff)}`);

  if(!initial.points.talk)throw new Error("Talk key not found");
  await call("Input.dispatchMouseEvent",{type:"mousePressed",x:initial.points.talk.x,y:initial.points.talk.y,button:"left",buttons:1,clickCount:1});
  await wait(40);
  const talkDown=await inspect();
  if(talkDown.talkState!=="on"||talkDown.talkPressed!=="true"||!talkDown.lcdTalkActive||!talkDown.lcdTalkLabel.toLowerCase().includes("active"))throw new Error(`Talk did not enter its momentary pressed state: ${JSON.stringify(talkDown)}`);
  await call("Input.dispatchMouseEvent",{type:"mouseReleased",x:initial.points.talk.x,y:initial.points.talk.y,button:"left",buttons:0,clickCount:1});
  await wait(40);
  const talkUp=await inspect();
  if(talkUp.talkState!=="off"||talkUp.talkPressed!=="false"||talkUp.lcdTalkActive||!talkUp.lcdTalkLabel.toLowerCase().includes("inactive"))throw new Error(`Talk did not leave its momentary pressed state: ${JSON.stringify(talkUp)}`);

  const resetRotaries=()=>evaluate(`(()=>{
    for(const selector of ['[data-monitor-control="phones"] .qu-rotary-control','[data-monitor-control="alt-out"] .qu-rotary-control']){
      const knob=document.querySelector(selector);
      knob?.focus();
      knob?.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));
    }
    return true;
  })()`);
  await resetRotaries();
  await wait(30);
  const rotariesAtZero=await inspect();
  if(rotariesAtZero.values.phones!==0||rotariesAtZero.values.altOut!==0)throw new Error(`Monitor rotaries did not reset independently: ${JSON.stringify(rotariesAtZero.values)}`);
  await call("Input.dispatchMouseEvent",{type:"mouseWheel",x:rotariesAtZero.points.phones.x,y:rotariesAtZero.points.phones.y,deltaX:0,deltaY:-120});
  await wait(40);
  const phonesTurned=await inspect();
  if(phonesTurned.values.phones!==1||phonesTurned.values.altOut!==0)throw new Error(`Phones wheel changed the wrong rotary: ${JSON.stringify(phonesTurned.values)}`);
  await call("Input.dispatchMouseEvent",{type:"mouseWheel",x:phonesTurned.points.altOut.x,y:phonesTurned.points.altOut.y,deltaX:0,deltaY:-120,modifiers:8});
  await wait(40);
  const altOutTurned=await inspect();
  if(altOutTurned.values.phones!==1||altOutTurned.values.altOut!==5)throw new Error(`Alt Out Shift-wheel was not independent or coarse: ${JSON.stringify(altOutTurned.values)}`);

  await evaluate(`(()=>{
    const restore=(selector,value)=>{
      const knob=document.querySelector(selector);
      if(!knob)return;
      knob.focus();
      knob.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));
      for(let step=0;step<Math.floor(value/5);step+=1)knob.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true,cancelable:true}));
      for(let step=0;step<value%5;step+=1)knob.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));
    };
    restore('[data-monitor-control="phones"] .qu-rotary-control',${initial.values.phones});
    restore('[data-monitor-control="alt-out"] .qu-rotary-control',${initial.values.altOut});
    return true;
  })()`);

  const viewport=await evaluate(`({width:window.innerWidth,height:window.innerHeight,deviceScaleFactor:window.devicePixelRatio})`);
  await call("Emulation.setDeviceMetricsOverride",{width:Math.round(viewport.width),height:800,deviceScaleFactor:1,mobile:false});
  metricsOverridden=true;
  await wait(120);
  const compact=await inspect();
  const compactRotaries={phones:compact.rectangles.phones,altOut:compact.rectangles.altOut,peq:compact.rectangles.peq};
  if(Math.abs(compactRotaries.phones.width-35)>.5||Math.abs(compactRotaries.phones.height-35)>.5||Math.abs(compactRotaries.altOut.width-35)>.5||Math.abs(compactRotaries.altOut.height-35)>.5||Math.abs(compactRotaries.peq.width-35)>.5||Math.abs(compactRotaries.peq.height-35)>.5)throw new Error(`Compact monitor rotaries do not match the compact PEQ size: ${JSON.stringify(compactRotaries)}`);
  if(compact.overflow.monitor.scrollWidth>compact.overflow.monitor.clientWidth+1||compact.overflow.monitor.scrollHeight>compact.overflow.monitor.clientHeight+1)throw new Error(`Compact monitor panel overflows: ${JSON.stringify(compact.overflow.monitor)}`);
  await call("Emulation.clearDeviceMetricsOverride");
  metricsOverridden=false;
  await wait(100);

  report={initial,paflOn,paflOff,talkDown,talkUp,rotariesAtZero:rotariesAtZero.values,phonesTurned:phonesTurned.values,altOutTurned:altOutTurned.values,compact:{viewport,rotaries:compactRotaries,overflow:compact.overflow.monitor}};
}finally{
  if(metricsOverridden)await call("Emulation.clearDeviceMetricsOverride").catch(()=>{});
  socket.close();
}

console.log(JSON.stringify(report,null,2));
