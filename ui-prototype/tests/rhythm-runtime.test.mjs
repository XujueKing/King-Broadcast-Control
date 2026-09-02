import assert from "node:assert/strict";
import test from "node:test";
import { collectRhythmEvents } from "../src/rhythm-runtime.js";

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

test("look-ahead emits the next grid marker for Titan latency compensation", () => {
  const events = collectRhythmEvents(analysis, 0.3, 0.4, { lookAheadSeconds:0.16 });

  assert.equal(events.length, 1);
  assert.equal(events[0].atSeconds, 0.5);
});
