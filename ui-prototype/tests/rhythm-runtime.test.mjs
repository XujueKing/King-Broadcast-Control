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
