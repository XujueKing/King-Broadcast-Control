import assert from "node:assert/strict";
import test from "node:test";

import {
  createLatestOnlyAsyncQueue,
  gatlingPaletteForVideoFamily,
  gatlingPulseForRhythm,
  gatlingSpeedForBpm,
  kingclubGatlingProfile,
} from "../src/gatling-runtime.js";

test("video families use only the physically verified Gatling colours", () => {
  assert.equal(gatlingPaletteForVideoFamily("red"), 33207);
  assert.equal(gatlingPaletteForVideoFamily("orange"), 33207);
  assert.equal(gatlingPaletteForVideoFamily("yellow"), 33207);
  assert.equal(gatlingPaletteForVideoFamily("green"), 33219);
  assert.equal(gatlingPaletteForVideoFamily("cyan"), 33219);
  assert.equal(gatlingPaletteForVideoFamily("blue"), 33219);
  assert.equal(gatlingPaletteForVideoFamily("purple"), 33219);
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
  assert.equal(pulse.peakDimmerPercent, 14);
  assert.equal(pulse.speedValue, 0.481);
  assert.ok(pulse.peakDimmerPercent > pulse.baseDimmerPercent);
});

test("odd ordinary beats create the low-energy side of the pulse", () => {
  const pulse = gatlingPulseForRhythm({ type:"beat", beatIndex:3, bpm:128 });

  assert.equal(pulse.look, "beat-shadow");
  assert.equal(pulse.skip, false);
  assert.equal(pulse.peakDimmerPercent, 2);
});

test("alternating bars create light-speed and meteor looks", () => {
  const lightSpeed = gatlingPulseForRhythm({ type:"bar", isBar:true, beatIndex:8, bpm:156 });
  const meteor = gatlingPulseForRhythm({ type:"bar", isBar:true, beatIndex:12, bpm:156 });

  assert.equal(lightSpeed.look, "light-speed");
  assert.equal(lightSpeed.peakDimmerPercent, 30);
  assert.equal(lightSpeed.speedValue, 1);
  assert.equal(meteor.look, "meteor");
  assert.equal(meteor.peakDimmerPercent, 24);
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

test("slow songs use a restrained breathing curve instead of full-intensity flashes", () => {
  const sparkle=gatlingPulseForRhythm({type:"beat",beatIndex:3,bpm:84,energy:.4});
  const beat=gatlingPulseForRhythm({type:"beat",beatIndex:2,bpm:84,energy:.4});
  const bar=gatlingPulseForRhythm({type:"bar",isBar:true,beatIndex:4,bpm:84,energy:.8});

  assert.equal(sparkle.skip,false);
  assert.equal(sparkle.look,"soft-sparkle");
  assert.ok(sparkle.peakDimmerPercent>=4&&sparkle.peakDimmerPercent<=5);
  assert.equal(beat.look,"gentle-breathe");
  assert.ok(beat.peakDimmerPercent>=5&&beat.peakDimmerPercent<=7);
  assert.equal(bar.look,"gentle-bloom");
  assert.ok(bar.peakDimmerPercent<=12);
  assert.ok(bar.speedValue<=.22);
});

test("Titan updates keep one request in flight and only the newest pending beat", async () => {
  const queue=createLatestOnlyAsyncQueue();
  const order=[];
  let releaseFirst;
  const first=queue.push(async()=>{
    order.push("first-start");
    await new Promise((resolve)=>{releaseFirst=resolve});
    order.push("first-end");
    return true;
  });
  await Promise.resolve();
  const stale=queue.push(async()=>{order.push("stale");return true});
  const latest=queue.push(async()=>{order.push("latest");return true});

  assert.equal(await stale,false);
  releaseFirst();
  assert.equal(await first,true);
  assert.equal(await latest,true);
  assert.deepEqual(order,["first-start","first-end","latest"]);
});
