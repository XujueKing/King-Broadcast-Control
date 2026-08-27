import test from "node:test";
import assert from "node:assert/strict";
import {
  clearTitanSimulator,
  createTitanSimulatorState,
  isTitanPresetSimulated,
  simulateTitanCue,
} from "../src/titan-simulator.js";

test("scene and accent lanes can run together", () => {
  const scene = simulateTitanCue(createTitanSimulatorState(), { presetId: 2, lane: "scene", source: "video" }, 100);
  const accent = simulateTitanCue(scene.state, { presetId: 3, lane: "accent", source: "rhythm" }, 200);
  assert.deepEqual(accent.state.active, { scene: 2, accent: 3 });
  assert.equal(isTitanPresetSimulated(accent.state, 2), true);
  assert.equal(isTitanPresetSimulated(accent.state, 3), true);
});

test("manual cue takes over both automatic lanes", () => {
  const automatic = {
    ...createTitanSimulatorState(),
    active: { scene: 2, accent: 3 },
  };
  const result = simulateTitanCue(automatic, { presetId: 5, lane: "scene", source: "manual" }, 300);
  assert.deepEqual(result.state.active, { scene: 5, accent: null });
});

test("pause clears simulated output and keeps an audit event", () => {
  const fired = simulateTitanCue(createTitanSimulatorState(), { presetId: 1, lane: "scene", source: "manual" }, 100);
  const cleared = clearTitanSimulator(fired.state, 200);
  assert.deepEqual(cleared.active, { scene: null, accent: null });
  assert.equal(cleared.history.at(-1).source, "pause");
});

test("invalid preset is rejected", () => {
  const state = createTitanSimulatorState();
  const result = simulateTitanCue(state, { presetId: 12, lane: "scene", source: "manual" });
  assert.equal(result.accepted, false);
  assert.equal(result.state, state);
});
