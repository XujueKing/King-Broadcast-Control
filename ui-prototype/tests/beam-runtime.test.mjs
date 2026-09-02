import assert from "node:assert/strict";
import test from "node:test";

import { beamPulseForRhythm, kingclubBeamProfile } from "../src/beam-runtime.js";

test("现场光束档绑定 Group 57 的 25 台白名单", () => {
  assert.equal(kingclubBeamProfile.groupTitanId, 15735);
  assert.equal(kingclubBeamProfile.fixtureTitanIds.length, 25);
  assert.equal(new Set(kingclubBeamProfile.fixtureTitanIds).size, 25);
});

test("光束以暗拍、可见普通拍和小节重拍参加律动", () => {
  assert.deepEqual(beamPulseForRhythm({type:"beat",beatIndex:1}), {look:"beam-shadow",dimmerPercent:20});
  assert.deepEqual(beamPulseForRhythm({type:"beat",beatIndex:2}), {look:"beam-beat",dimmerPercent:50});
  assert.deepEqual(beamPulseForRhythm({type:"bar",isBar:true,beatIndex:4}), {look:"beam-bar",dimmerPercent:70});
});
