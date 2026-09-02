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

test("ordinary beats stay dark but produce a visible pulse", () => {
  const pulse = gatlingPulseForRhythm({ type:"beat", bpm:128 });

  assert.equal(pulse.baseDimmerPercent, kingclubGatlingProfile.baseDimmerPercent);
  assert.equal(pulse.peakDimmerPercent, 13.5);
  assert.equal(pulse.releaseAfterMs, 211);
  assert.ok(pulse.peakDimmerPercent > pulse.baseDimmerPercent);
});

test("strong beats use the venue's 15 percent safety ceiling", () => {
  const pulse = gatlingPulseForRhythm({ type:"bar", isBar:true, bpm:156 });

  assert.equal(pulse.peakDimmerPercent, 15);
  assert.equal(pulse.releaseAfterMs, 173);
  assert.ok(pulse.speedValue <= 0.47);
});

test("release duration remains bounded for unusual tempo metadata", () => {
  assert.equal(gatlingPulseForRhythm({ type:"beat", bpm:300 }).releaseAfterMs, 140);
  assert.equal(gatlingPulseForRhythm({ type:"beat", bpm:30 }).releaseAfterMs, 220);
});
