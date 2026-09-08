import assert from "node:assert/strict";
import test from "node:test";

import {
  MEDIA_SCAN_INTERVAL_MS,
  VIDEO_GRID_BATCH_SIZE,
  VIDEO_GRID_INITIAL_LIMIT,
  nextVideoRenderLimit,
  shouldExtendVideoGrid,
  shouldQueueAudioAiAnalysis,
} from "../src/ui-performance.js";

test("AI analysis registration requires both hardware capability and the persisted runtime switch", () => {
  assert.equal(shouldQueueAudioAiAnalysis(true, true), true);
  assert.equal(shouldQueueAudioAiAnalysis(true, false), false);
  assert.equal(shouldQueueAudioAiAnalysis(true, null), false);
  assert.equal(shouldQueueAudioAiAnalysis(false, true), false);
});

test("video grid grows in bounded batches", () => {
  assert.equal(VIDEO_GRID_INITIAL_LIMIT, 48);
  assert.equal(VIDEO_GRID_BATCH_SIZE, 48);
  assert.equal(nextVideoRenderLimit(48, 216), 96);
  assert.equal(nextVideoRenderLimit(192, 216), 216);
  assert.equal(nextVideoRenderLimit(216, 216), 216);
});

test("video grid extends only when the viewport approaches the end", () => {
  assert.equal(shouldExtendVideoGrid({ scrollTop: 400, clientHeight: 300, scrollHeight: 1200 }), false);
  assert.equal(shouldExtendVideoGrid({ scrollTop: 750, clientHeight: 300, scrollHeight: 1200 }), true);
});

test("media library polling is kept out of the high-frequency UI path", () => {
  assert.ok(MEDIA_SCAN_INTERVAL_MS >= 30_000);
});
