import test from "node:test";
import assert from "node:assert/strict";
import {
  createLightingPackage,
  KINGLIGHT_FORMAT,
  normalizeLightingPackage,
} from "../src/lighting-package.js";

const sample = () => createLightingPackage({
  titanHost: "192.168.1.154",
  titanStatus: { deviceName: "TT-00608", softwareVersion: "11.3.5", showName: "2024.12.28" },
  titanMappings: { 0: 101, 2: 202 },
  titanPlaybacks: [{ titanId: 101, legend: "Cue Playbacks[1]" }],
  presets: [{ id: 0, label: "绿色律动", loop: true }, { id: 2, label: "暖场" }],
  rhythmRule: "bar",
  videoRule: "off",
  playbackModes: { 0: "loop" },
  fixtureColors: { beam: { r: 0, g: 255, b: 120 } },
  exportedAt: "2026-08-26T00:00:00.000Z",
});

test("creates a portable versioned package without enabling execution", () => {
  const result = sample();
  assert.equal(result.format, KINGLIGHT_FORMAT);
  assert.equal(result.console.showName, "2024.12.28");
  assert.equal(result.safety.executeOnImport, false);
  assert.equal(result.effects[0].safeAuto, false);
});

test("normalization restores mappings but does not execute anything", () => {
  const normalized = normalizeLightingPackage(sample());
  assert.deepEqual(normalized.mappings, { 0: 101, 2: 202 });
  assert.equal(normalized.safety.allowFixtureDmx, false);
  assert.equal(normalized.effects[0].titanLegend, "Cue Playbacks[1]");
});

test("rejects packages that request execute-on-import", () => {
  const unsafe = sample();
  unsafe.safety.executeOnImport = true;
  assert.throws(() => normalizeLightingPackage(unsafe), /禁止导入即执行/);
});

test("unknown semantic metadata remains ineligible for safe auto", () => {
  const candidate = sample();
  candidate.effects[0].safeAuto = false;
  candidate.effects[0].layer = "not-a-layer";
  candidate.effects[0].energy = "unknown";
  const effect = normalizeLightingPackage(candidate).effects[0];
  assert.equal(effect.safeAuto, false);
  assert.equal(effect.layer, null);
  assert.equal(effect.energy, null);
});

test("package retains registry effects beyond the 0-9 shortcut slots", () => {
  const result = createLightingPackage({
    presets: [{ id: 0, label: "绿色律动" }],
    titanMappings: {},
    titanPlaybacks: [],
    effectRegistry: [{ effectId: "titan:9001", titanHandle: 9001, kingName: "待现场标注", safeAuto: false }],
  });
  const registryEffect = result.effects.find((effect) => effect.effectId === "titan:9001");
  assert.equal(registryEffect.presetId, null);
  assert.equal(registryEffect.safeAuto, false);
});
