import test from "node:test";
import assert from "node:assert/strict";
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

test("rhythm pulses stay dark and release quickly", () => {
  const pulse = gatlingPulseForRhythm({ type: "bar", isBar: true, bpm: 128 });
  assert.equal(pulse.peakDimmerPercent, 12.5);
  assert.equal(pulse.baseDimmerPercent, 10);
  assert.equal(pulse.releaseAfterMs, 117);
  assert.equal(pulse.speedValue, 0.361);
});
