import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  homeMicrophoneBindings,
  microphoneFaderReadback,
  microphoneFaderWrites,
} from "../src/microphone-control.js";

const model=JSON.parse(readFileSync(new URL("../src/mixer-models/allen-heath-qu16/model.json",import.meta.url),"utf8"));

test("home microphone bindings preserve the linked professional pair and GS channel",()=>{
  const bindings=homeMicrophoneBindings(model);
  assert.deepEqual(bindings.map(binding=>binding.targets),[["ch-1","ch-2"],["ch-6"]]);
});

test("professional microphone writes CH1 and CH2 as one atomic batch",()=>{
  const [professional]=homeMicrophoneBindings(model);
  assert.deepEqual(microphoneFaderWrites(professional,80),[
    {key:"fader:ch-1",value:102},
    {key:"fader:ch-2",value:102},
  ]);
});

test("group readback follows hardware and reports a temporarily split linked pair",()=>{
  const [professional]=homeMicrophoneBindings(model);
  const synchronized=microphoneFaderReadback({parameters:{"fader:ch-1":102,"fader:ch-2":102}},professional);
  assert.deepEqual(synchronized,{available:true,value:80,synchronized:true,pending:false,rawValues:[102,102]});
  const split=microphoneFaderReadback({parameters:{"fader:ch-1":102,"fader:ch-2":64}},professional);
  assert.equal(split.available,true);
  assert.equal(split.synchronized,false);
  assert.equal(split.value,65);
});

test("GS microphone writes only the confirmed CH6 fader",()=>{
  const [,gs]=homeMicrophoneBindings(model);
  assert.deepEqual(microphoneFaderWrites(gs,50),[{key:"fader:ch-6",value:64}]);
});
