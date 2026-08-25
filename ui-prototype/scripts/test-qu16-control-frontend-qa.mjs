const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const targets=await fetch(`${endpoint}/json/list`).then(response=>response.json());
const main=targets.find(target=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url))
  ??targets.find(target=>!target.url.includes("output.html")&&/127\.0\.0\.1:1420/.test(target.url));
if(!main)throw new Error("Main browser target not found");

const socket=new WebSocket(main.webSocketDebuggerUrl);
let sequence=0;
const pending=new Map();
socket.addEventListener("message",event=>{
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
async function evaluate(expression){
  const response=await call("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
  if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description??response.exceptionDetails.text);
  return response.result.value;
}
const pause=(milliseconds=60)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const assertEqual=(actual,expected,label)=>{
  if(actual!==expected)throw new Error(`${label}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
};
const assertDeepEqual=(actual,expected,label)=>{
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`${label}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
};

await evaluate(`(async()=>{
  window.__qu16ControlHarness?.unmount?.();
  document.querySelector("#qu16-control-qa-root")?.remove();
  const host=document.createElement("div");
  host.id="qu16-control-qa-root";
  host.className="mixer-workspace-body";
  document.body.append(host);
  const module=await import("/tests/qu16-control-harness.jsx?qa="+Date.now());
  window.__qu16ControlHarness=module.mountQu16ControlHarness(host,{
    controlMode:"hardware-live",
    parameterSnapshot:{
      host:"qa-host",sessionId:77,connected:true,synced:true,revision:1,pending:0,pendingDetails:{},
      parameters:{
        "fader:ch-1":64,"fader:ch-2":32,
        "mute:ch-1":1,"mute:ch-2":0,
        "pafl:ch-1":1,"pafl:ch-2":1,"pafl:ch-3":0,
        "send:ch-1:Mix 1":16
      }
    }
  });
  await new Promise(resolve=>setTimeout(resolve,80));
  return true;
})()`);

let state=await evaluate(`(()=>({
  surfaceMode:document.querySelector("#qu16-control-qa-root .qu-surface")?.dataset.syncMode,
  lcdMode:document.querySelector("#qu16-control-qa-root .qu-lcd-panel")?.dataset.syncMode,
  ch1:Number(document.querySelector('#qu16-control-qa-root [data-source-id="ch-1"] .qu-vertical-fader')?.value),
  mute:document.querySelector('#qu16-control-qa-root [data-source-id="ch-1"] .qu-key.mute')?.getAttribute("aria-pressed"),
  pafl:[...document.querySelectorAll('#qu16-control-qa-root [data-source-id] .qu-pafl[aria-pressed="true"]')].map(node=>node.closest("[data-source-id]")?.dataset.sourceId)
}))()`);
assertEqual(state.surfaceMode,"hardware-live","Surface sync mode");
assertEqual(state.lcdMode,"local-ui-only","LCD remains local-only");
assertEqual(state.ch1,50,"Snapshot fader application");
assertEqual(state.mute,"true","Snapshot mute application");
assertDeepEqual(state.pafl,["ch-1","ch-2"],"Additive snapshot PAFL targets");

await evaluate(`(async()=>{
  const qa=window.__qu16ControlHarness;
  qa.clearWrites();
  document.querySelector('#qu16-control-qa-root [data-mix-select="Mix 1"]')?.click();
  await new Promise(resolve=>setTimeout(resolve,20));
  return true;
})()`);
state=await evaluate(`(()=>({
  mix:document.querySelector("#qu16-control-qa-root .qu-surface")?.dataset.activeMix,
  writes:window.__qu16ControlHarness.writes.length
}))()`);
assertEqual(state.mix,"Mix 1","Mix Select changes the local sends-on-faders bank");
assertEqual(state.writes,0,"Mix Select never writes a hardware parameter");

await evaluate(`(()=>{
  const fader=document.querySelector('#qu16-control-qa-root [data-source-id="ch-1"] .qu-vertical-fader');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
  for(const value of [20,40,80]){
    setter.call(fader,String(value));
    fader.dispatchEvent(new Event("input",{bubbles:true}));
    fader.dispatchEvent(new Event("change",{bubbles:true}));
  }
  return true;
})()`);
await pause(75);
state=await evaluate(`window.__qu16ControlHarness.writes`);
assertEqual(state.length,1,"Rapid fader changes coalesce into one batch");
assertDeepEqual(state[0].writes,[{key:"send:ch-1:Mix 1",value:102}],"Coalesced fader keeps newest MIDI value");

await evaluate(`(async()=>{
  window.__qu16ControlHarness.update({parameterSnapshot:{
    host:"qa-host",sessionId:77,connected:true,synced:true,revision:2,pending:1,
    pendingDetails:{"send:ch-1:Mix 1":{state:"queued",expectedValue:102}},
    parameters:{
      "fader:ch-1":64,"fader:ch-2":32,
      "mute:ch-1":1,"mute:ch-2":0,
      "pafl:ch-1":1,"pafl:ch-2":1,"pafl:ch-3":0,
      "send:ch-1:Mix 1":16
    }
  }});
  await new Promise(resolve=>setTimeout(resolve,60));
  return true;
})()`);
state=await evaluate(`Number(document.querySelector('#qu16-control-qa-root [data-source-id="ch-1"] .qu-vertical-fader')?.value)`);
assertEqual(state,80,"pendingDetails expectedValue protects optimistic fader state");

await evaluate(`(async()=>{
  window.__qu16ControlHarness.update({parameterSnapshot:{
    host:"qa-host",sessionId:77,connected:true,synced:true,revision:3,pending:0,pendingDetails:{},
    parameters:{
      "fader:ch-1":64,"fader:ch-2":32,
      "mute:ch-1":1,"mute:ch-2":0,
      "pafl:ch-1":1,"pafl:ch-2":1,"pafl:ch-3":0,
      "send:ch-1:Mix 1":64
    }
  }});
  await new Promise(resolve=>setTimeout(resolve,60));
  return true;
})()`);
state=await evaluate(`Number(document.querySelector('#qu16-control-qa-root [data-source-id="ch-1"] .qu-vertical-fader')?.value)`);
assertEqual(state,50,"Final conflicting readback is authoritative after pending clears");

await evaluate(`(async()=>{
  const qa=window.__qu16ControlHarness;
  qa.clearWrites();
  qa.update({rejectWrites:true});
  const fader=document.querySelector('#qu16-control-qa-root [data-source-id="ch-1"] .qu-vertical-fader');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
  setter.call(fader,"90");
  fader.dispatchEvent(new Event("input",{bubbles:true}));
  fader.dispatchEvent(new Event("change",{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,100));
  return true;
})()`);
state=await evaluate(`(()=>(
  {value:Number(document.querySelector('#qu16-control-qa-root [data-source-id="ch-1"] .qu-vertical-fader')?.value),writes:window.__qu16ControlHarness.writes.length}
))()`);
assertEqual(state.writes,1,"Rejected fader write still attempts one coalesced batch");
assertEqual(state.value,50,"Rejected write clears optimistic state and restores observed value");
await evaluate(`(()=>{window.__qu16ControlHarness.update({rejectWrites:false});return true})()`);

await evaluate(`(async()=>{
  const qa=window.__qu16ControlHarness;
  qa.clearWrites();
  document.querySelector('#qu16-control-qa-root [data-source-id="ch-2"] .qu-key.mute')?.click();
  await Promise.resolve();
  return true;
})()`);
state=await evaluate(`window.__qu16ControlHarness.writes`);
assertDeepEqual(state.map(batch=>batch.writes),[[{key:"mute:ch-2",value:1}]],"Mute writes immediately");

await evaluate(`(async()=>{
  const qa=window.__qu16ControlHarness;
  qa.clearWrites();
  document.querySelector('#qu16-control-qa-root [data-source-id="ch-3"] .qu-pafl')?.click();
  await Promise.resolve();
  return true;
})()`);
state=await evaluate(`(()=>({
  active:[...document.querySelectorAll('#qu16-control-qa-root [data-source-id] .qu-pafl[aria-pressed="true"]')].map(node=>node.closest("[data-source-id]")?.dataset.sourceId),
  writes:window.__qu16ControlHarness.writes.map(batch=>batch.writes)
}))()`);
assertDeepEqual(state.active,["ch-1","ch-2","ch-3"],"Local PAFL permits multiple simultaneous targets");
assertDeepEqual(state.writes,[[{key:"pafl:ch-3",value:1}]],"PAFL writes immediately");

await evaluate(`(()=>{
  window.__qu16ControlHarness.unmount();
  delete window.__qu16ControlHarness;
  document.querySelector("#qu16-control-qa-root")?.remove();
  return true;
})()`);
socket.close();
console.log("Qu-16 frontend control QA passed: snapshot, pending/readback, coalescing, local Mix Select, immediate Mute/PAFL, and additive PAFL.");
