import assert from "node:assert/strict";
import test from "node:test";
import {
  QU16_MASTER_TARGETS,
  QU16_MIX_LABELS,
  QU16_SEND_MIX_LABELS,
  QU16_SOURCE_TARGETS,
  QU16_TARGETS,
  decodeQu16ParameterSnapshot,
  midiToUiValue,
  qu16ControlCoalesceKey,
  qu16MasterTargetId,
  qu16MixLabel,
  qu16TargetId,
  uiToMidiValue,
} from "../src/qu16-control.js";
import { qu16SurfaceSourceAt } from "../src/qu16-surface-map.js";
import qu16Model from "../src/mixer-models/allen-heath-qu16/model.json" with { type:"json" };

test("physical slots 8 and 9 remain layer-specific",()=>{
  assert.equal(qu16SurfaceSourceAt("lower",8).id,"ch-8");
  assert.equal(qu16SurfaceSourceAt("lower",9).id,"ch-9");
  assert.equal(qu16SurfaceSourceAt("upper",8).id,"fx-1-send");
  assert.equal(qu16SurfaceSourceAt("upper",9).id,"fx-2-send");
  assert.notEqual(qu16SurfaceSourceAt("lower",8).id,qu16SurfaceSourceAt("upper",8).id);
  assert.notEqual(qu16SurfaceSourceAt("lower",9).id,qu16SurfaceSourceAt("upper",9).id);
});

test("onsite custom layer maps physical slots 8 and 9 to the calibrated FX returns",()=>{
  assert.equal(qu16Model.ui.defaultLayer,"custom");
  assert.equal(qu16SurfaceSourceAt("custom",7).id,"ch-7");
  assert.equal(qu16SurfaceSourceAt("custom",8).id,"fx-1-ret");
  assert.equal(qu16SurfaceSourceAt("custom",9).id,"fx-2-ret");
  assert.equal(qu16SurfaceSourceAt("custom",10).id,"ch-10");
});

const masterCases = [
  ["LR","lr-master"],
  ["FX 1","fx-1-send"],
  ["FX 2","fx-2-send"],
  ["Mix 1","mix-1-master"],
  ["Mix 2","mix-2-master"],
  ["Mix 3","mix-3-master"],
  ["Mix 4","mix-4-master"],
  ["Mix 5-6","mix-5-6-master"],
  ["Mix 7-8","mix-7-8-master"],
  ["Mix 9-10","mix-9-10-master"],
];

const sourceCases = [
  ...Array.from({ length:16 },(_,index)=>[`CH${index+1}`,`ch-${index+1}`]),
  ...Array.from({ length:3 },(_,index)=>[`ST${index+1}`,`st-${index+1}`]),
  ...Array.from({ length:4 },(_,index)=>[`FX Return${index+1}`,`fx-${index+1}-ret`]),
];

test("converts the complete UI and MIDI domains with stable integer rounding",()=>{
  assert.equal(uiToMidiValue(0),0);
  assert.equal(uiToMidiValue(50),64);
  assert.equal(uiToMidiValue(100),127);
  assert.equal(midiToUiValue(0),0);
  assert.equal(midiToUiValue(64),50);
  assert.equal(midiToUiValue(127),100);

  for (let ui=0;ui<=100;ui+=1) {
    assert.equal(midiToUiValue(uiToMidiValue(ui)),ui,`UI round trip at ${ui}`);
  }
  for (let midi=0;midi<=127;midi+=1) {
    const ui=midiToUiValue(midi);
    assert.ok(ui>=0&&ui<=100,`MIDI ${midi} remains in UI range`);
    assert.ok(Math.abs(uiToMidiValue(ui)-midi)<=1,`MIDI round trip at ${midi}`);
  }
});

test("conversion rejects coercion, non-finite values, fractions in MIDI, and out of range values",()=>{
  for (const value of [-1,101,NaN,Infinity,"50",null,undefined]) {
    assert.throws(()=>uiToMidiValue(value));
  }
  for (const value of [-1,128,1.5,NaN,Infinity,"64",null,undefined]) {
    assert.throws(()=>midiToUiValue(value));
  }
});

test("all Qu-16 source labels and stable ids resolve without collisions",()=>{
  assert.equal(QU16_SOURCE_TARGETS.length,23);
  assert.equal(new Set(QU16_SOURCE_TARGETS.map(target=>target.id)).size,23);
  for (const [label,id] of sourceCases) {
    assert.equal(qu16TargetId(label),id,label);
    assert.equal(qu16TargetId(id),id,id);
  }
  assert.equal(qu16TargetId("FX1 Ret"),"fx-1-ret");
  assert.equal(qu16TargetId("FX Return 4"),"fx-4-ret");
});

test("every Qu-16 master label maps to a stable target id",()=>{
  assert.equal(QU16_MASTER_TARGETS.length,10);
  assert.deepEqual(QU16_MIX_LABELS,masterCases.map(([label])=>label));
  for (const [label,id] of masterCases) {
    assert.equal(qu16MasterTargetId(label),id,label);
    assert.equal(qu16TargetId(label),id,label);
    assert.equal(qu16TargetId(id),id,id);
    assert.equal(qu16MixLabel(label),label,label);
    assert.equal(qu16MixLabel(id),label,id);
  }
  assert.equal(qu16MasterTargetId("FX1 Send"),"fx-1-send");
  assert.equal(qu16MasterTargetId("Mix5-6"),"mix-5-6-master");
  assert.equal(QU16_TARGETS.length,33);
});

test("coalesce keys cover every source, master, and sends-on-faders destination",()=>{
  const keys=new Set();
  for (const target of QU16_TARGETS) {
    const fader=qu16ControlCoalesceKey({ kind:"fader",target:target.id,value:25 });
    const mute=qu16ControlCoalesceKey({ kind:"mute",target:target.id,value:true });
    const pafl=qu16ControlCoalesceKey({ kind:"pafl",target:target.id,value:false });
    assert.equal(fader,`fader:${target.id}`);
    assert.equal(mute,`mute:${target.id}`);
    assert.equal(pafl,`pafl:${target.id}`);
    keys.add(fader).add(mute).add(pafl);
  }

  for (const source of QU16_SOURCE_TARGETS) {
    for (const mix of QU16_SEND_MIX_LABELS) {
      const key=qu16ControlCoalesceKey({ kind:"send",target:source.id,mix,value:75 });
      assert.equal(key,`send:${source.id}:${mix}`);
      keys.add(key);
    }
  }

  assert.equal(keys.size,QU16_TARGETS.length*3+QU16_SOURCE_TARGETS.length*QU16_SEND_MIX_LABELS.length);
});

test("coalesce keys normalize known aliases and do not depend on value",()=>{
  assert.equal(
    qu16ControlCoalesceKey({ kind:"fader",target:"LR",mix:"LR",value:0 }),
    "fader:lr-master",
  );
  assert.equal(
    qu16ControlCoalesceKey({ kind:"fader",target:"lr-master",value:100 }),
    "fader:lr-master",
  );
  assert.equal(
    qu16ControlCoalesceKey({ kind:"send",target:"CH1",mix:"mix-1-master",value:0 }),
    "send:ch-1:Mix 1",
  );
  assert.equal(
    qu16ControlCoalesceKey({ kind:"send",target:"ch-1",mix:"Mix 1",value:100 }),
    "send:ch-1:Mix 1",
  );
});

test("an exhaustive parameter snapshot decodes to the React digital-twin patch",()=>{
  const parameters=new Map();
  const expectedLevels={ LR:{} };
  const expectedMaster={};
  const expectedMute={};

  QU16_SEND_MIX_LABELS.forEach(mix=>{ expectedLevels[mix]={}; });

  QU16_SOURCE_TARGETS.forEach((target,index)=>{
    const faderRaw=index%128;
    const muted=index%2;
    parameters.set(`fader:${target.id}`,faderRaw);
    parameters.set(`mute:${target.id}`,muted);
    parameters.set(`pafl:${target.id}`,1);
    expectedLevels.LR[target.id]=midiToUiValue(faderRaw);
    expectedMute[target.id]=Boolean(muted);

    QU16_SEND_MIX_LABELS.forEach((mix,mixIndex)=>{
      const raw=(index*11+mixIndex*7)%128;
      parameters.set(`send:${target.id}:${mix}`,raw);
      expectedLevels[mix][target.id]=midiToUiValue(raw);
    });
  });

  QU16_MASTER_TARGETS.forEach((target,index)=>{
    const faderRaw=127-index;
    const muted=(index+1)%2;
    parameters.set(`fader:${target.id}`,faderRaw);
    parameters.set(`mute:${target.id}`,muted);
    parameters.set(`pafl:${target.id}`,1);
    expectedMaster[target.label]={ level:midiToUiValue(faderRaw),muted:Boolean(muted) };
  });

  const patch=decodeQu16ParameterSnapshot({ parameters });
  assert.deepEqual(patch.levels,expectedLevels);
  assert.deepEqual(patch.master,expectedMaster);
  assert.deepEqual(patch.mute,expectedMute);
  assert.deepEqual(
    patch.paflTargets,
    QU16_TARGETS.map(target=>({ kind:target.kind,id:target.id })),
  );
});

test("snapshot decoding accepts plain maps and preserves additive PAFL state",()=>{
  const patch=decodeQu16ParameterSnapshot({
    parameters:{
      "fader:ch-1":127,
      "send:st-1:Mix 9-10":64,
      "fader:lr-master":0,
      "mute:ch-1":1,
      "mute:lr-master":0,
      "pafl:ch-1":1,
      "pafl:st-1":1,
      "pafl:lr-master":1,
      "pafl:ch-2":0,
    },
  });

  assert.deepEqual(patch,{
    levels:{ LR:{ "ch-1":100 },"Mix 9-10":{ "st-1":50 } },
    master:{ LR:{ level:0,muted:false } },
    mute:{ "ch-1":true },
    paflTargets:[
      { kind:"source",id:"ch-1" },
      { kind:"source",id:"st-1" },
      { kind:"master",id:"lr-master" },
    ],
  });
  assert.deepEqual(decodeQu16ParameterSnapshot({ parameters:new Map() }),{
    levels:{},master:{},mute:{},paflTargets:[],
  });
});

test("unknown target, mix, kind, malformed keys, and invalid values are rejected",()=>{
  assert.throws(()=>qu16MasterTargetId("CH1"),/Unknown Qu-16 master/);
  assert.throws(()=>qu16TargetId("CH17"),/Unknown Qu-16 target/);
  assert.throws(()=>qu16MixLabel("Mix 11"),/Unknown Qu-16 target/);
  assert.throws(()=>qu16ControlCoalesceKey({ kind:"gain",target:"ch-1",value:50 }),/kind/);
  assert.throws(()=>qu16ControlCoalesceKey({ kind:"fader",target:"ch-99",value:50 }),/target/);
  assert.throws(()=>qu16ControlCoalesceKey({ kind:"fader",target:"ch-1",mix:"Mix 11",value:50 }),/target/);
  assert.throws(()=>qu16ControlCoalesceKey({ kind:"send",target:"ch-1",value:50 }),/requires a mix/);
  assert.throws(()=>qu16ControlCoalesceKey({ kind:"send",target:"ch-1",mix:"LR",value:50 }),/not send/);
  assert.throws(()=>qu16ControlCoalesceKey({ kind:"send",target:"mix-1-master",mix:"Mix 1",value:50 }),/input source/);
  assert.throws(()=>qu16ControlCoalesceKey({ kind:"mute",target:"ch-1",value:1 }),/boolean/);
  assert.throws(()=>qu16ControlCoalesceKey({ kind:"pafl",target:"ch-1",value:"true" }),/boolean/);
  assert.throws(()=>qu16ControlCoalesceKey({ kind:"fader",target:"ch-1",value:101 }),/0 and 100/);

  const invalidSnapshots=[
    null,
    {},
    { parameters:[] },
    { parameters:{ "gain:ch-1":64 } },
    { parameters:{ "fader:ch-99":64 } },
    { parameters:{ "fader:CH1":64 } },
    { parameters:{ "fader:ch-1:extra":64 } },
    { parameters:{ "send:ch-1":64 } },
    { parameters:{ "send:ch-1:Mix 11":64 } },
    { parameters:{ "send:ch-1:LR":64 } },
    { parameters:{ "send:mix-1-master:Mix 1":64 } },
    { parameters:{ "fader:ch-1":128 } },
    { parameters:{ "fader:ch-1":1.5 } },
    { parameters:{ "mute:ch-1":2 } },
    { parameters:{ "mute:ch-1":true } },
    { parameters:{ "pafl:ch-1":127 } },
  ];
  invalidSnapshots.forEach(snapshot=>assert.throws(()=>decodeQu16ParameterSnapshot(snapshot)));
});
