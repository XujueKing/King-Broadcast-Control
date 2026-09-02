import assert from "node:assert/strict";
import test from "node:test";

import {
  gatlingPaletteForVideoFamily,
  gatlingPulseForRhythm,
  gatlingSpeedForBpm,
  kingclubGatlingProfile,
} from "../src/gatling-runtime.js";

test("video families stay inside the现场-confirmed Gatling palette bank", () => {
  assert.equal(gatlingPaletteForVideoFamily("red"), 33207);
  assert.equal(gatlingPaletteForVideoFamily("green"), 33214);
  assert.equal(gatlingPaletteForVideoFamily("blue"), 33219);
  assert.equal(gatlingPaletteForVideoFamily("purple"), 33234);
  assert.equal(gatlingPaletteForVideoFamily("unknown"), 33207);
});

test("BPM tracking preserves the accepted 128 BPM speed and clamps extremes", () => {
  assert.equal(gatlingSpeedForBpm(128), 0.361);
  assert.equal(gatlingSpeedForBpm(20), kingclubGatlingProfile.baseSpeedValue);
  assert.equal(gatlingSpeedForBpm(70), 0.239);
  assert.equal(gatlingSpeedForBpm(180), 0.47);
});

test("ordinary beats form a visible star-field pulse", () => {
  const pulse = gatlingPulseForRhythm({ type:"beat", beatIndex:2, bpm:128 });

  assert.equal(pulse.look, "stars");
  assert.equal(pulse.skip, false);
  assert.equal(pulse.baseDimmerPercent, kingclubGatlingProfile.baseDimmerPercent);
  assert.equal(pulse.peakDimmerPercent, 35);
  assert.equal(pulse.speedValue, 0.441);
  assert.ok(pulse.peakDimmerPercent > pulse.baseDimmerPercent);
});

test("odd ordinary beats create the low-energy side of the pulse", () => {
  const pulse = gatlingPulseForRhythm({ type:"beat", beatIndex:3, bpm:128 });

  assert.equal(pulse.look, "beat-shadow");
  assert.equal(pulse.skip, false);
  assert.equal(pulse.peakDimmerPercent, 5);
});

test("alternating bars create light-speed and meteor looks", () => {
  const lightSpeed = gatlingPulseForRhythm({ type:"bar", isBar:true, beatIndex:8, bpm:156 });
  const meteor = gatlingPulseForRhythm({ type:"bar", isBar:true, beatIndex:12, bpm:156 });

  assert.equal(lightSpeed.look, "light-speed");
  assert.equal(lightSpeed.peakDimmerPercent, 100);
  assert.equal(lightSpeed.speedValue, 1);
  assert.equal(meteor.look, "meteor");
  assert.equal(meteor.peakDimmerPercent, 65);
  assert.ok(meteor.speedValue < lightSpeed.speedValue);
});

test("all rhythmic looks remain inside the fixture protocol envelope", () => {
  for (const event of [
    {type:"beat",beatIndex:2,bpm:30},
    {type:"bar",isBar:true,beatIndex:8,bpm:300},
    {type:"bar",isBar:true,beatIndex:12,bpm:70},
  ]) {
    const look=gatlingPulseForRhythm(event);
    assert.ok(look.peakDimmerPercent >= 0 && look.peakDimmerPercent <= 100);
    assert.ok(look.speedValue >= 0 && look.speedValue <= 1);
  }
});
