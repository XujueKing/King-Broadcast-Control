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

const inspect=()=>evaluate(`(()=>{
  const superstrip=document.querySelector('.qu-superstrip');
  const surface=document.querySelector('.qu-surface');
  const bank=document.querySelector('.qu-knob-bank');
  const rect=(node)=>{const value=node?.getBoundingClientRect();return value?{x:value.x,y:value.y,width:value.width,height:value.height,right:value.right,bottom:value.bottom}:null};
  const intersection=(a,b)=>a&&b?Math.max(0,Math.min(a.right,b.right)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)):0;
  const rotaries=[...bank.querySelectorAll('.qu-rotary-control')].map(rect);
  const peqBands=[...bank.querySelectorAll('.qu-peq-band')].map((band)=>({
    name:band.querySelector('b')?.textContent.trim(),
    rotaries:[...band.querySelectorAll('.qu-rotary-control')].map(rect),
    labels:[...band.querySelectorAll(':scope>span')].map((node)=>({text:node.textContent.trim(),rect:rect(node)})),
    band:rect(band.querySelector('b'))
  }));
  const panelLabels=[...bank.querySelectorAll('.qu-panel-lamp-key>span')].map((node)=>({
    text:node.textContent.trim(),
    fontSize:parseFloat(getComputedStyle(node).fontSize),
    lineHeight:parseFloat(getComputedStyle(node).lineHeight),
    letterSpacing:parseFloat(getComputedStyle(node).letterSpacing)||0
  }));
  const preampKnob=rect(bank.querySelector('.preamp .qu-rotary-control'));
  const preampPk=rect(bank.querySelector('.preamp .qu-pk-led'));
  const dynamics=[...bank.querySelectorAll('.gate,.comp')].map((panel)=>({
    name:panel.classList.contains('gate')?'gate':'comp',
    knob:rect(panel.querySelector('.qu-rotary-control')),
    threshold:rect(panel.querySelector('.qu-threshold-knob>span')),
    gr:rect(panel.querySelector('.qu-threshold-knob>i')),
    panel:rect(panel)
  }));
  const pan={
    panel:rect(bank.querySelector('.pan')),
    sides:rect(bank.querySelector('.qu-pan-sides')),
    knob:rect(bank.querySelector('.pan .qu-rotary-control'))
  };
  return {
    viewport:{width:innerWidth,height:innerHeight},
    superstrip:rect(superstrip),surface:rect(surface),bank:rect(bank),
    directChildren:[...superstrip.children].map((node)=>({className:node.className,rect:rect(node)})),
    rotaries,peqBands,panelLabels,preamp:{knob:preampKnob,pk:preampPk,intersection:intersection(preampKnob,preampPk)},
    dynamics:dynamics.map((item)=>({...item,thresholdIntersection:intersection(item.knob,item.threshold),grIntersection:intersection(item.knob,item.gr)})),
    pan
  };
})()`);

const assertLayout=(report,{compact=false}={})=>{
  if(!report.superstrip||!report.surface||!report.bank)throw new Error(`SuperStrip geometry is missing: ${JSON.stringify(report)}`);
  const tolerance=1;
  if(report.directChildren.some((child)=>!child.rect||child.rect.bottom>report.superstrip.bottom+tolerance))throw new Error(`A SuperStrip child overflows its row: ${JSON.stringify(report.directChildren)}`);
  if(report.surface.y<report.superstrip.bottom-tolerance)throw new Error(`SuperStrip overlaps the fader surface: ${JSON.stringify({superstrip:report.superstrip,surface:report.surface})}`);
  const expectedSize=compact?35:40;
  if(report.rotaries.length!==17||report.rotaries.some((knob)=>Math.abs(knob.width-expectedSize)>.5||Math.abs(knob.height-expectedSize)>.5||Math.abs(knob.width-knob.height)>.25))throw new Error(`SuperStrip rotary size drifted: ${JSON.stringify({compact,rotaries:report.rotaries})}`);
  const centerX=(value)=>value.x+value.width/2;
  for(const band of report.peqBands){
    const axis=centerX(band.band);
    if(band.rotaries.some((knob)=>Math.abs(centerX(knob)-axis)>.75)||band.labels.some((label)=>Math.abs(centerX(label.rect)-axis)>.75))throw new Error(`PEQ ${band.name} column is not on one axis: ${JSON.stringify(band)}`);
    const [widthLabel,freqLabel,gainLabel]=band.labels.map((label)=>label.rect);
    const [widthKnob,freqKnob,gainKnob]=band.rotaries;
    if(widthLabel.y<widthKnob.bottom+1||widthLabel.bottom>freqKnob.y-1||freqLabel.y<freqKnob.bottom+1||freqLabel.bottom>gainKnob.y-1||gainLabel.y<gainKnob.bottom+1||gainLabel.bottom>band.band.y-1)throw new Error(`PEQ ${band.name} labels collide with controls: ${JSON.stringify(band)}`);
  }
  if(report.panelLabels.some((label)=>Math.abs(label.fontSize-7)>.2||Math.abs(label.lineHeight-7)>.3||Math.abs(label.letterSpacing)>.05))throw new Error(`Panel-key typography is inconsistent: ${JSON.stringify(report.panelLabels)}`);
  // Chromium can leave a <0.06px edge contact at fractional DPI. Treat an
  // overlap area below half a CSS pixel as rasterization noise, not collision.
  const incidentalAreaTolerance=.5;
  if(report.preamp.intersection>incidentalAreaTolerance)throw new Error(`Preamp Pk overlaps the Gain rotary: ${JSON.stringify(report.preamp)}`);
  for(const item of report.dynamics){
    if(item.thresholdIntersection>incidentalAreaTolerance||item.grIntersection>incidentalAreaTolerance)throw new Error(`${item.name} silk-screen overlaps its rotary: ${JSON.stringify(item)}`);
  }
  if(report.pan.sides.bottom>report.pan.knob.y-1.5||report.pan.knob.bottom>report.pan.panel.bottom-1)throw new Error(`Pan labels or rotary are cramped/clipped: ${JSON.stringify(report.pan)}`);
};

let metricsOverridden=false;
const reports={};
try{
  await evaluate(`(async()=>{[...document.querySelectorAll('.bottom-nav button')].find((button)=>button.textContent.includes('调音台'))?.click();await new Promise((resolve)=>setTimeout(resolve,380));return true})()`);
  await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:1,y:1});
  reports.default=await inspect();
  assertLayout(reports.default);
  const viewport=await evaluate(`({width:innerWidth,height:innerHeight})`);
  for(const height of [820,800]){
    await call("Emulation.setDeviceMetricsOverride",{width:Math.round(viewport.width),height,deviceScaleFactor:1,mobile:false});
    metricsOverridden=true;
    await wait(120);
    reports[`height${height}`]=await inspect();
    assertLayout(reports[`height${height}`],{compact:true});
  }
}finally{
  if(metricsOverridden)await call("Emulation.clearDeviceMetricsOverride").catch(()=>{});
  socket.close();
}

console.log(JSON.stringify(reports,null,2));
