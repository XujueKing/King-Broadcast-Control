import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frontLightState,setFrontLight} from '../src/singer-front-light.js';
const binding={verified:true,titanId:321,showName:'test-show',deviceName:'test-console',group:'TestExecutors',index:4};
const status={connected:true,host:'mock',deviceName:'test-console',showName:'test-show'};
const sample=active=>({host:'mock',at:100,handles:[{titanId:321,group:'TestExecutors',index:4,handleType:'cueHandle',active}]});
test('unbound, stale, moved executor and wrong show never become available',()=>{
 assert.equal(frontLightState(null,status,sample(false),100).available,false);
 assert.equal(frontLightState(binding,status,sample(false),5000).available,false);
 assert.equal(frontLightState(binding,{...status,showName:'other'},sample(false),100).available,false);
 assert.equal(frontLightState({...binding,index:5},status,sample(false),100).available,false);
});
test('independent wash only touches the bound handle and confirms both directions',async()=>{
 let active=false;const calls=[];const context={binding,status,now:()=>100,read:async()=>sample(active),fire:async args=>{calls.push(['fire',args]);active=true},release:async args=>{calls.push(['release',args]);active=false}};
 await setFrontLight(true,context);await setFrontLight(true,context);await setFrontLight(false,context);
 assert.deepEqual(calls.map(([type,args])=>[type,args.titanId]),[['fire',321],['release',321]]);
 assert.equal(calls[0][1].alwaysRefire,false);
});
test('unbound does no network work and a missing readback is not success',async()=>{
 const context={binding,status,now:()=>100,read:async()=>sample(false),fire:async()=>{},release:async()=>{}};
 await assert.rejects(setFrontLight(true,{...context,binding:null,read:()=>assert.fail('must not read')}),/unavailable/);
 await assert.rejects(setFrontLight(true,context),/readback_failed/);
});
