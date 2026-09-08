import assert from "node:assert/strict";
import test from "node:test";
import { collectRhythmEvents, effectiveRhythmBpm, rhythmEnergyAt } from "../src/rhythm-runtime.js";

const analysis = {
  beats:[0.5, 1, 1.5, 2, 2.5],
  downbeats:[0.5, 2.5],
  bars:[0.5, 2.5],
};

test("emits all crossed beat markers without duplicates", () => {
  assert.deepEqual(collectRhythmEvents(analysis, 0.9, 1.6), [
    { type:"beat", beatIndex:1, atSeconds:1, isDownbeat:false, isBar:false },
    { type:"beat", beatIndex:2, atSeconds:1.5, isDownbeat:false, isBar:false },
  ]);
});
test("marks bar/downbeat and ignores seek-sized jumps", () => {
  assert.equal(collectRhythmEvents(analysis, 0.4, 0.6)[0].type, "bar");
  assert.deepEqual(collectRhythmEvents(analysis, 0, 2, { maxCatchupSeconds:0.8 }), []);
});

test("backward seek and pause do not emit events", () => {
  assert.deepEqual(collectRhythmEvents(analysis, 2, 1), []);
  assert.deepEqual(collectRhythmEvents(analysis, 1, 1), []);
});

test("irregular detector output is regularized to the analysed BPM grid", () => {
  const irregular = {
    bpm:128,
    beats:[0.5, 0.97, 1.05, 1.98, 2.45, 2.92],
    downbeats:[0.5],
  };
  const events = collectRhythmEvents(irregular, 1.3, 2.1);

  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.regularized));
  assert.equal(Number((events[1].atSeconds - events[0].atSeconds).toFixed(5)), 0.46875);
});

test("bounded long-mix analysis extends the BPM grid through the full duration", () => {
  const analysis = {
    bpm:120,
    durationSeconds:3600,
    beats:[0,0.5,1,1.5,2],
    downbeats:[0],
    bars:[0],
  };
  assert.deepEqual(collectRhythmEvents(analysis, 1800.1, 1800.6), [{
    type:"beat",
    beatIndex:3601,
    atSeconds:1800.5,
    isDownbeat:false,
    isBar:false,
    regularized:true,
  }]);
});

test("look-ahead emits the next grid marker for Titan latency compensation", () => {
  const events = collectRhythmEvents(analysis, 0.3, 0.4, { lookAheadSeconds:0.16 });

  assert.equal(events.length, 1);
  assert.equal(events[0].atSeconds, 0.5);
});

test("samples local waveform energy without opening another audio stream", () => {
  const energyAnalysis={durationSeconds:4,peaks:[0,20,80,100,40]};
  assert.equal(rhythmEnergyAt(energyAnalysis,2),.667);
  assert.equal(rhythmEnergyAt(energyAnalysis,-5),.1);
  assert.equal(rhythmEnergyAt({},2),0);
});

test("low-confidence double-time slow songs use their musical half-time grid", () => {
  const slowSong = {
    bpm:167.88483,
    bpmConfidence:.2819,
    durationSeconds:337,
    beats:[0,.357,.714,1.071,1.428],
    downbeats:[0],
  };

  assert.equal(Number(effectiveRhythmBpm(slowSong).toFixed(3)), 83.942);
  const events=collectRhythmEvents(slowSong,10,10.6);
  assert.equal(events.length,1);
  assert.ok(events[0].regularized);
});

test("confident fast songs and operator corrections keep their original BPM", () => {
  assert.equal(effectiveRhythmBpm({bpm:168,bpmConfidence:.8}),168);
  assert.equal(effectiveRhythmBpm({bpm:168,bpmConfidence:1,correction:{bpm:168}}),168);
});
