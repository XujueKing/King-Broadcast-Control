import assert from "node:assert/strict";
import test from "node:test";

import { createBeamShowController, kingclubBeamProfile } from "../src/beam-runtime.js";

test("现场光束档绑定 Group 57 的 25 台白名单", () => {
  assert.equal(kingclubBeamProfile.groupTitanId, 15735);
  assert.equal(kingclubBeamProfile.fixtureTitanIds.length, 25);
  assert.equal(new Set(kingclubBeamProfile.fixtureTitanIds).size, 25);
});

test("光束平时不发送命令，只在段落小节启动南到北六拍点缀", () => {
  const controller=createBeamShowController();
  assert.equal(controller.next({trackId:"a",type:"bar",isBar:true,beatIndex:0,energy:.4}).skip,true);
  assert.equal(controller.next({trackId:"a",type:"bar",isBar:true,beatIndex:4,energy:.9}).skip,true);
  assert.deepEqual(controller.next({trackId:"a",type:"bar",isBar:true,beatIndex:8,energy:.8,bpm:126}), {skip:false,look:"beam-walk-south-north",bpm:126,beats:6,rows:6});
  assert.equal(controller.next({trackId:"a",type:"beat",beatIndex:9,energy:.9,bpm:126}).skip,true);
});

test("常规光束点缀至少冷却 64 拍，不会连续巡航或不停摇头", () => {
  const controller=createBeamShowController();
  controller.next({trackId:"a",type:"bar",isBar:true,beatIndex:8,energy:.9});
  assert.equal(controller.next({trackId:"a",type:"bar",isBar:true,beatIndex:20,energy:.9}).skip,true);
  assert.equal(controller.next({trackId:"a",type:"bar",isBar:true,beatIndex:68,energy:.9}).skip,true);
  assert.equal(controller.next({trackId:"a",type:"bar",isBar:true,beatIndex:72,energy:.9}).look,"beam-walk-south-north");
});

test("慢歌允许低能量小节做六排温柔点缀，并保持 32 拍冷却", () => {
  const controller=createBeamShowController();
  assert.deepEqual(controller.next({trackId:"slow",type:"bar",isBar:true,beatIndex:8,energy:.24,bpm:84}), {
    skip:false,
    look:"beam-gentle-south-north",
    bpm:84,
    beats:6,
    rows:6,
  });
  assert.equal(controller.next({trackId:"slow",type:"bar",isBar:true,beatIndex:36,energy:.5,bpm:84}).skip,true);
  assert.equal(controller.next({trackId:"slow",type:"bar",isBar:true,beatIndex:40,energy:.5,bpm:84}).look,"beam-gentle-south-north");
});

test("BPM 缺失时使用现场稳定默认值", () => {
  const controller=createBeamShowController();
  assert.equal(controller.next({trackId:"a",type:"bar",isBar:true,beatIndex:8,energy:.9}).bpm,128);
});
