import test from 'node:test';
import assert from 'node:assert/strict';
import {executeSingerOperation} from '../src/singer-playback.js';

function fixture(overrides={}) {
  const calls=[];
  const context={ready:()=>true,cueActive:()=>false,transitionBusy:()=>false,otherPlaying:()=>false,
    findTrack:key=>key==='known'?7:-1,hasTrack:()=>true,hasAccompaniment:()=>true,
    ...Object.fromEntries(['select','setPaused','restart','setVocalMode'].map(name=>[name,async(...args)=>{calls.push([name,...args])}])),...overrides};
  return {calls,context};
}
const work=operation=>({deck:1,songKey:'known',command:{operation}});
test('select and next use an explicit song and never start audio implicitly',async()=>{
  for(const type of ['select','next']){
    const {calls,context}=fixture();await executeSingerOperation(work({type,songId:'opaque'}),context);
    assert.deepEqual(calls,[['select',1,7]]);
  }
});
test('play, pause, restart, and vocal mode preserve explicit intent',async()=>{
  const {calls,context}=fixture();
  for(const operation of [{type:'play'},{type:'pause'},{type:'restart'},{type:'vocal_mode',mode:'accompaniment'}])await executeSingerOperation(work(operation),context);
  assert.deepEqual(calls,[['setPaused',1,false],['setPaused',1,true],['restart',1],['setVocalMode',1,'accompaniment']]);
});
test('cue, offline runtime and unknown songs reject without side effects',async()=>{
  for(const overrides of [{cueActive:()=>true},{ready:()=>false},{findTrack:()=>-1}]){
    const {calls,context}=fixture(overrides);await assert.rejects(executeSingerOperation(work({type:'select',songId:'opaque'}),context));assert.deepEqual(calls,[]);
  }
});
test('song selection can take over an unattended other Deck, while play cannot mix into it',async()=>{
  const {calls,context}=fixture({otherPlaying:()=>true,transitionBusy:()=>true});
  await executeSingerOperation(work({type:'select',songId:'opaque'}),context);assert.deepEqual(calls,[['select',1,7]]);
  await assert.rejects(executeSingerOperation(work({type:'play'}),context),/desktop_mix_active/);assert.equal(calls.length,1);
});
test('missing accompaniment is rejected before playback control',async()=>{
  const {calls,context}=fixture({hasAccompaniment:()=>false});
  await assert.rejects(executeSingerOperation(work({type:'vocal_mode',mode:'accompaniment'}),context),/accompaniment_unavailable/);assert.deepEqual(calls,[]);
});
test('acknowledgement waits for actual player completion and propagates failure',async()=>{
  let resolve;const pending=new Promise(r=>{resolve=r});let done=false;
  const {context}=fixture({restart:()=>pending});
  const running=executeSingerOperation(work({type:'restart'}),context).then(()=>{done=true});
  await Promise.resolve();assert.equal(done,false);resolve();await running;assert.equal(done,true);
  const failed=fixture({setPaused:async()=>{throw new Error('pipe_timeout')}});
  await assert.rejects(executeSingerOperation(work({type:'play'}),failed.context),/pipe_timeout/);
});
