import test from "node:test";
import assert from "node:assert/strict";
import { reconcileStableAssets } from "../src/media-scan-stability.js";

const asset = (path, sizeBytes, modifiedUnixMs = 100_000) => ({ path, sizeBytes, modifiedUnixMs });

test("a growing download is hidden until one unchanged scan", () => {
  const tracker = new Map();
  const options = { nowMs:100_100, minimumAgeMs:10_000, requiredUnchangedScans:1 };
  assert.deepEqual(reconcileStableAssets([], [asset("new.mp3", 100)], tracker, options), []);
  assert.deepEqual(reconcileStableAssets([], [asset("new.mp3", 200)], tracker, options), []);
  assert.deepEqual(reconcileStableAssets([], [asset("new.mp3", 200)], tracker, options).map((item)=>item.path), ["new.mp3"]);
});
test("an existing growing file retains its previous descriptor", () => {
  const tracker = new Map();
  const old = asset("playing.mp3", 100);
  const changed = asset("playing.mp3", 200);
  const result = reconcileStableAssets([old], [changed], tracker, { nowMs:100_100, minimumAgeMs:10_000 });
  assert.equal(result[0], old);
});

test("the currently loaded path survives a transient missing scan", () => {
  const tracker = new Map();
  const playing = asset("playing.mp3", 100, 1);
  const result = reconcileStableAssets([playing], [], tracker, { preservePaths:[playing.path] });
  assert.deepEqual(result, [playing]);
});
