import test from 'node:test';
import assert from 'node:assert/strict';
import {SingerClient} from '../../integrations/singer-client.mjs';
const state={controllerOnline:true,busy:false,sessionId:'session',revision:12,serverTimeUnixMs:123456789};
test('tablet client authenticates and uses server time instead of device time',async()=>{
  const calls=[];
  const client=new SingerClient({baseUrl:'http://127.0.0.1:4865/',token:'test-secret',fetchImpl:async(url,options)=>{
    calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/state')?state:{id:'receipt',status:'succeeded'}};
  }});
  await client.nextSong('opaque-song-id');
  assert.equal(calls[0].options.headers.Authorization,'Bearer test-secret');
  const sent=JSON.parse(calls[1].options.body);
  assert.equal(sent.issuedAtUnixMs,state.serverTimeUnixMs);assert.equal(sent.expectedRevision,12);
  assert.deepEqual(sent.operation,{type:'next',songId:'opaque-song-id'});
  assert.ok(!calls[1].url.includes('test-secret'));
});
test('uncertain delivery preserves request ID without issuing another command',async()=>{
  let sends=0,id;
  const client=new SingerClient({baseUrl:'http://127.0.0.1:4865',token:'test',fetchImpl:async(url,options)=>{
    if(url.endsWith('/state'))return {ok:true,json:async()=>state};
    sends++;id=JSON.parse(options.body).id;throw new Error('network lost');
  }});
  await assert.rejects(client.restart(),error=>error.commandId===id&&/network lost/.test(error.message));
  assert.equal(sends,1);
});
test('offline controller produces no mutation request',async()=>{
  const calls=[];
  const client=new SingerClient({baseUrl:'http://127.0.0.1:4865',token:'test',fetchImpl:async url=>{
    calls.push(url);return {ok:true,json:async()=>({...state,controllerOnline:false})};
  }});
  await assert.rejects(client.play(),/controller_offline/);assert.equal(calls.length,1);
});
