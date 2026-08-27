import test from "node:test";
import assert from "node:assert/strict";
import { analyzeVideoPixels, lightingPresetForVideoColor } from "../src/video-color-runtime.js";

const pixels = (...colors) => new Uint8ClampedArray(colors.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));

test("video color analysis favors saturated stage colors", () => {
  const sample = analyzeVideoPixels(pixels([10, 10, 10], [20, 20, 20], [20, 60, 240], [30, 80, 250]));
  assert.equal(sample.family, "blue");
  assert.ok(sample.b > sample.r * 3);
});

test("video color analysis classifies warm and green frames", () => {
  assert.equal(analyzeVideoPixels(pixels([255, 125, 10], [230, 105, 5])).family, "orange");
  assert.equal(analyzeVideoPixels(pixels([20, 230, 70], [15, 200, 45])).family, "green");
});

test("transparent or black frames do not publish a color", () => {
  assert.equal(analyzeVideoPixels(pixels([0, 0, 0], [255, 0, 0, 0])), null);
});

test("nearly monochrome frames are neutral", () => {
  assert.equal(analyzeVideoPixels(pixels([120, 124, 126], [160, 162, 165])).family, "neutral");
});

test("video color families use only explicitly mapped KING presets", () => {
  const mappings = { 0: 1000, 1: 1001, 2: 1002 };
  assert.equal(lightingPresetForVideoColor({ family: "green" }, mappings), 0);
  assert.equal(lightingPresetForVideoColor({ family: "purple" }, mappings), 1);
  assert.equal(lightingPresetForVideoColor({ family: "orange" }, mappings), 2);
  assert.equal(lightingPresetForVideoColor({ family: "neutral" }, mappings), null);
  assert.equal(lightingPresetForVideoColor({ family: "blue" }, { 0: 1000 }), null);
});

test("offline simulation may resolve a color without a Titan mapping", () => {
  assert.equal(lightingPresetForVideoColor({ family: "blue" }, {}, { allowUnmapped: true }), 1);
  assert.equal(lightingPresetForVideoColor({ family: "neutral" }, {}, { allowUnmapped: true }), null);
});
