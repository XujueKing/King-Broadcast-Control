import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSingerAudioPolicy,singerAudioSnapshot,singerAudioWrite,executeSingerAudio,transitionSingerAcappella} from '../src/singer-audio.js';
import {executeSingerOperation} from '../src/singer-playback.js';

const policy={...defaultSingerAudioPolicy,microphone:'ch-6',reverbBus:'FX 1'};
const mixer={connected:true,synced:true,parameters:{'fader:ch-6':98,'send:ch-6:FX 1':44},pendingDetails:{}};
const snapshot=(extra={})=>singerAudioSnapshot({policy,musicVolume:66,musicReady:true,acappella:false,mixerLive:true,mixer,...extra});
test('mic/FX controls require explicit binding, live sync and actual parameter echo',()=>{
  assert.equal(snapshot().microphone.value,77);
  assert.equal(snapshot({policy:defaultSingerAudioPolicy}).microphone.reason,'audio_unbound');
  for(const extra of [{mixerLive:false},{mixer:{...mixer,synced:false}},{mixer:{...mixer,parameters:{}}},{mixer:{...mixer,pendingDetails:{'fader:ch-6':{}}}}]){
    assert.equal(snapshot(extra).microphone.available,false);
    assert.equal(snapshot(extra).microphone.value,null);
  }
  assert.equal(snapshot({policy:{...policy,reverbBus:''}}).reverb.available,false);
});
test('singer writes target only the bound mic fader or that mic FX send',()=>{
  assert.deepEqual(singerAudioWrite(policy,'microphone',77),{key:'fader:ch-6',value:98});
  assert.deepEqual(singerAudioWrite(policy,'reverb',60),{key:'send:ch-6:FX 1',value:76});
  for(const microphone of ['ch-11','lr-master','st-3',''])assert.throws(()=>singerAudioWrite({...policy,microphone},'microphone',50),/audio_unbound/);
});
test('bounds and current binding are checked before any side effect; hardware failures propagate',async()=>{
  const writes=[];const context={policy:()=>policy,snapshot,writeMixer:async w=>writes.push(w),setMusic:async v=>writes.push(v)};
  for(const op of [{control:'microphone',value:78},{control:'reverb',value:61},{control:'music',value:-1},{control:'music',value:1.5},{control:'gain',value:20}])await assert.rejects(executeSingerAudio({type:'audio_level',...op},context),/invalid_audio_value/);
  assert.deepEqual(writes,[]);
  await executeSingerAudio({type:'audio_level',control:'microphone',value:70},context);
  assert.equal(writes[0].key,'fader:ch-6');
  await assert.rejects(executeSingerAudio({type:'audio_level',control:'music',value:55},{...context,snapshot:()=>snapshot({acappella:true})}),/acappella_active/);
  await assert.rejects(executeSingerAudio({type:'audio_level',control:'reverb',value:40},{...context,writeMixer:async()=>{throw Error('audio_readback_failed')}}),/audio_readback_failed/);
});
test('a cappella mutes only music, restores prior level, respects changed ceiling and waits for confirmation',async()=>{
  const values=[];let resolve;
  const pending=new Promise(r=>resolve=r);let completed=false;
  const enter=transitionSingerAcappella({enabled:true,current:false,volume:66,restore:null,max:100,write:async v=>{values.push(v);await pending}}).then(v=>{completed=true;return v});
  await Promise.resolve();assert.equal(completed,false);resolve();const state=await enter;
  assert.deepEqual(state,{enabled:true,restore:66});assert.deepEqual(values,[0]);
  const exit=await transitionSingerAcappella({enabled:false,current:true,volume:0,restore:state.restore,max:60,write:async v=>values.push(v)});
  assert.deepEqual(values,[0,60]);assert.deepEqual(exit,{enabled:false,restore:null});
  await assert.rejects(transitionSingerAcappella({enabled:true,current:false,volume:55,max:100,write:async()=>{throw Error('failed')}}));
});
test('CUE and other-deck playback reject audio operations before mixer or player write',async()=>{
  let writes=0;
  const base={ready:()=>true,cueActive:()=>false,transitionBusy:()=>false,otherPlaying:()=>false,audio:async()=>writes++};
  for(const overrides of [{cueActive:()=>true},{otherPlaying:()=>true},{transitionBusy:()=>true}])await assert.rejects(executeSingerOperation({deck:1,command:{operation:{type:'acappella',enabled:true}}},{...base,...overrides}));
  assert.equal(writes,0);
});
