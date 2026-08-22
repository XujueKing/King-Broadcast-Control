import test from "node:test";
import assert from "node:assert/strict";
import {
  nextConfiguredId,
  rhythmEventMatchesRule,
  selectDominantDeck,
} from "../src/rhythm-automation.js";

test("automation follows the only audible Deck and then the crossfader", () => {
  assert.equal(selectDominantDeck({ 1:true, 2:false }, 90), 1);
  assert.equal(selectDominantDeck({ 1:false, 2:true }, 10), 2);
  assert.equal(selectDominantDeck({ 1:true, 2:true }, 28), 1);
  assert.equal(selectDominantDeck({ 1:true, 2:true }, 72), 2);
  assert.equal(selectDominantDeck({ 1:false, 2:false }, 50), null);
});
test("beat, downbeat and bar rules match deterministic grid events", () => {
  const beat = { type:"beat", beatIndex:8, isDownbeat:false, isBar:false };
  assert.equal(rhythmEventMatchesRule("beat", beat), true);
  assert.equal(rhythmEventMatchesRule("beat-2", beat), true);
  assert.equal(rhythmEventMatchesRule("beat-4", beat), true);
  assert.equal(rhythmEventMatchesRule("beat-8", { ...beat, beatIndex:9 }), false);
  assert.equal(rhythmEventMatchesRule("downbeat", { ...beat, type:"downbeat", isDownbeat:true }), true);
  assert.equal(rhythmEventMatchesRule("bar", { ...beat, type:"bar", isDownbeat:true, isBar:true }), true);
  assert.equal(rhythmEventMatchesRule("off", beat), false);
});

test("configured presets cycle without entering empty slots", () => {
  assert.equal(nextConfiguredId([0, 1, 3, 5], 1), 3);
  assert.equal(nextConfiguredId([0, 1, 3, 5], 5), 0);
  assert.equal(nextConfiguredId([], 1), null);
});
