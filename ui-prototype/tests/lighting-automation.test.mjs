import test from "node:test";
import assert from "node:assert/strict";
import {
  createLightingAutomationState,
  lightingCueIsAuthorized,
  lightingAutomationPolicy,
  planLightingCue,
} from "../src/lighting-automation.js";

test("rhythm accent cues are rate limited and deduplicated", () => {
  let state = createLightingAutomationState();
  const first = planLightingCue(state, { presetId: 3, source: "rhythm" }, 10_000);
  assert.equal(first.accepted, true);
  assert.equal(first.lane, "accent");
  state = first.state;
  assert.equal(planLightingCue(state, { presetId: 4, source: "rhythm" }, 11_000).reason, "cooldown");
  assert.equal(planLightingCue(state, { presetId: 3, source: "rhythm" }, 20_000).reason, "duplicate");
  assert.equal(
    planLightingCue(state, { presetId: 4, source: "rhythm" }, 10_000 + lightingAutomationPolicy.rhythmSwitchMs).accepted,
    true,
  );
});

test("video scene and rhythm accent can run together", () => {
  const video = planLightingCue(createLightingAutomationState(), { presetId: 2, source: "video" }, 20_000);
  const rhythm = planLightingCue(video.state, { presetId: 3, source: "rhythm" }, 20_100);
  assert.equal(video.lane, "scene");
  assert.equal(rhythm.lane, "accent");
  assert.equal(rhythm.accepted, true);
  assert.equal(rhythm.state.scene.lastPresetId, 2);
  assert.equal(rhythm.state.accent.lastPresetId, 3);
});

test("video category holds before sampled color may replace it", () => {
  const video = planLightingCue(createLightingAutomationState(), { presetId: 2, source: "video" }, 20_000);
  assert.equal(video.state.scene.holdUntil, 28_000);
  assert.equal(planLightingCue(video.state, { presetId: 1, source: "video-color" }, 25_000).reason, "category-hold");
  assert.equal(planLightingCue(video.state, { presetId: 1, source: "video-color" }, 28_000).accepted, true);
});

test("manual cue overrides and clears both automatic lanes", () => {
  const video = planLightingCue(createLightingAutomationState(), { presetId: 2, source: "video" }, 20_000);
  const rhythm = planLightingCue(video.state, { presetId: 3, source: "rhythm" }, 20_100);
  const manual = planLightingCue(rhythm.state, { presetId: 5, source: "manual" }, 20_200);
  assert.equal(manual.accepted, true);
  assert.equal(manual.state.scene.lastPresetId, 5);
  assert.equal(manual.state.accent.lastPresetId, null);
});

test("invalid preset is rejected", () => {
  assert.equal(planLightingCue(createLightingAutomationState(), { presetId: "bad", source: "video" }, 1).reason, "invalid-preset");
});

test("automatic cues require an explicitly safe non-event effect", () => {
  const registry=[
    {presetId:2,titanHandle:202,layer:"scene",safeAuto:true},
    {presetId:3,titanHandle:303,layer:"event",safeAuto:true},
    {presetId:4,titanHandle:404,layer:"accent",safeAuto:false},
  ];
  assert.equal(lightingCueIsAuthorized({source:"video",presetId:2,titanId:202,effectRegistry:registry}),true);
  assert.equal(lightingCueIsAuthorized({source:"rhythm",presetId:3,titanId:303,effectRegistry:registry}),false);
  assert.equal(lightingCueIsAuthorized({source:"rhythm",presetId:4,titanId:404,effectRegistry:registry}),false);
  assert.equal(lightingCueIsAuthorized({source:"video-color",presetId:9,titanId:909,effectRegistry:registry}),false);
  assert.equal(lightingCueIsAuthorized({source:"unexpected",presetId:2,titanId:202,effectRegistry:registry}),false);
  assert.equal(lightingCueIsAuthorized({source:"manual",presetId:9,titanId:909,effectRegistry:registry}),true);
});
