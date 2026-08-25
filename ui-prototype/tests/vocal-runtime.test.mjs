import assert from "node:assert/strict";
import test from "node:test";
import {
  createOfflineVocalStatus,
  describeVocalFailover,
  formatVocalMetric,
  normalizeVocalResponse,
  updatePreviewVocalPreset,
} from "../src/vocal-runtime.js";

test("offline status never claims that physical audio or hardware is active",()=>{
  const status=createOfflineVocalStatus();
  assert.equal(status.calibrationMode,"disarmed");
  assert.equal(status.physicalAudioStarted,false);
  assert.equal(status.hardwareBound,false);
  assert.equal(status.failover.state,"inactive");
  assert.equal(status.failover.fresh,false);
  assert.equal(status.lanes.length,3);
  assert.ok(status.lanes.every(lane=>lane.inputPeakDbfs===null&&!lane.fresh));
});

test("failover telemetry is normalized without inventing a live watchdog",()=>{
  const fallback=normalizeVocalResponse({status:{failover:{
    state:"dry_fallback",
    reason:"engine_timeout",
    usingDryFallback:true,
    fresh:true,
    revision:7,
  }}});
  assert.deepEqual(fallback.failover,{
    state:"dry_fallback",
    reason:"engine_timeout",
    usingDryFallback:true,
    fresh:true,
    revision:7,
  });
  assert.equal(describeVocalFailover(fallback.failover).title,"正在使用干声回退");

  const invalid=normalizeVocalResponse({status:{failover:{state:"made_up",fresh:"true"}}});
  assert.equal(invalid.failover.state,"inactive");
  assert.equal(invalid.failover.fresh,false);
});

test("watchdog presentation distinguishes recovery from lost microphone input",()=>{
  assert.equal(describeVocalFailover({state:"recovering"}).tone,"recovering");
  assert.equal(describeVocalFailover({state:"input_unavailable",reason:"input_unavailable"}).tone,"error");
});

test("normalization preserves null telemetry and rejects unsafe truthy flags",()=>{
  const status=normalizeVocalResponse({status:{
    physicalAudioStarted:"true",
    hardwareBound:1,
    lanes:[{lane:"mic1",preset:"strong",qualityScore:"62.5"}],
  }});
  assert.equal(status.physicalAudioStarted,false);
  assert.equal(status.hardwareBound,false);
  assert.equal(status.lanes[0].preset,"strong");
  assert.equal(status.lanes[0].qualityScore,62.5);
  assert.equal(status.lanes[1].qualityScore,null);
});

test("preview preset update changes only the requested lane",()=>{
  const before=createOfflineVocalStatus();
  const after=updatePreviewVocalPreset(before,"mic2","auto");
  assert.equal(after.lanes[0].preset,"professional");
  assert.equal(after.lanes[1].preset,"auto");
  assert.equal(after.lanes[2].preset,"professional");
});

test("telemetry formatter never invents unavailable values",()=>{
  assert.equal(formatVocalMetric(null,{suffix:" dBFS"}),"--");
  assert.equal(formatVocalMetric(0.426,{scale:100,suffix:"%"}),"43%");
});
