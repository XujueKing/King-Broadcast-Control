import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

// Execute the real effect against a deterministic event transport and clock.
const source=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
const start=source.indexOf('    let disposed=false;',source.indexOf('let startedSessionId')-500);
const end=source.indexOf('\n  },[desktopRuntime,mixerControlHost,mixerModelId]);',start);
function harness(){
  let startup,tick,control={},snapshot=null,reads=0;
  const handlers={};
  const session={current:null},applyRef={current:null};
  let backend={host:'desk',sessionId:7,revision:3,connected:true,synced:true,parameters:{'fader:ch-1':77}};
  const values={
    effectGeneration:1,host:'desk',qu16MeterEffectGenerationRef:{current:1},
    qu16ControlSessionRef:session,qu16ParameterFrameApplyRef:applyRef,
    mixerParameterSnapshotRef:{current:null},
    setMixerControlStatus:fn=>{control=typeof fn==='function'?fn(control):fn;},
    setMixerParameterSnapshot:v=>{snapshot=v;},setMixerMeterStatus:()=>{},
    publishQu16MeterSnapshot:()=>{},clearQu16MeterSnapshot:()=>{},
    window:{setTimeout:fn=>{startup=fn;return 1;},clearTimeout:()=>{},setInterval:fn=>{tick=fn;return 2;},clearInterval:()=>{tick=null;}},
    listen:async(name,fn)=>{handlers[name]=fn;return ()=>delete handlers[name];},
    invoke:async name=>{
      if(name==='qu16_start_metering')return {host:'desk',sessionId:7,state:'live'};
      if(name==='qu16_parameter_status'){reads++;return backend;}
    },
  };
  assert.ok(start>=0&&end>start);
  const cleanup=new Function(...Object.keys(values),source.slice(start,end))(...Object.values(values));
  return {start:async()=>{await startup();await Promise.resolve();},tick:()=>tick(),cleanup,
    event:(name,payload)=>handlers[name]({payload}),setBackend:v=>{backend=v;},
    get control(){return control;},get snapshot(){return snapshot;},get reads(){return reads;}};
}
test('missed recovery event and late disconnect recover from authoritative snapshot',async()=>{
  const h=harness();await h.start();
  assert.equal(h.control.mode,'hardware-live');
  h.event('qu16-meter-status',{host:'desk',sessionId:7,state:'disconnected'});
  assert.equal(h.control.mode,'local-ui-only');
  await h.tick();
  assert.equal(h.control.mode,'hardware-live');
  assert.equal(h.snapshot.parameters['fader:ch-1'],77);
  const unchanged=h.snapshot;await h.tick();assert.equal(h.snapshot,unchanged);
  h.cleanup();
});
test('disconnected, unsynced and foreign sessions never enable controls',async()=>{
  const h=harness();await h.start();
  for(const [revision,connected,synced,expected] of [[4,false,false,'local-ui-only'],[5,true,false,'hardware-syncing'],[6,true,true,'hardware-live']]){
    h.setBackend({host:'desk',sessionId:7,revision,connected,synced});await h.tick();assert.equal(h.control.mode,expected);
  }
  h.event('qu16-meter-status',{host:'desk',sessionId:7,state:'disconnected'});
  h.setBackend({host:'desk',sessionId:8,revision:99,connected:true,synced:true});await h.tick();
  assert.equal(h.control.mode,'local-ui-only');
  h.cleanup();
});
