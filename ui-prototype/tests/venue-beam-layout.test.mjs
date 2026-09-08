import assert from "node:assert/strict";
import test from "node:test";

import {
  venueBeamPoints,
  venueFixturePoints,
  venueLedBarPoints,
  venueMovingWashPoints,
} from "../src/venue-beam-layout.js";

test("现场光束平面图提供连续且唯一的 A1-A25 指挥编号", () => {
  assert.equal(venueBeamPoints.length, 25);
  assert.deepEqual(venueBeamPoints.map((point) => point.label), Array.from({length:25},(_,index)=>`A${index+1}`));
  assert.equal(new Set(venueBeamPoints.map((point) => `${point.x},${point.y}`)).size, 25);
});

test("A 编号只保存经过逐台 Locate 实测的 TitanId", () => {
  assert.ok(venueBeamPoints.every((point) => point.type === "beam"));
  assert.equal(venueBeamPoints.find((point) => point.id === "A1")?.titanId, 3703);
  assert.equal(venueBeamPoints.find((point) => point.id === "A2")?.titanId, 3706);
  assert.equal(venueBeamPoints.find((point) => point.id === "A3")?.titanId, 3512);
  assert.equal(venueBeamPoints.find((point) => point.id === "A4")?.titanId, 3513);
  assert.equal(venueBeamPoints.find((point) => point.id === "A5")?.titanId, 3704);
  assert.equal(venueBeamPoints.find((point) => point.id === "A6")?.titanId, 3705);
  assert.equal(venueBeamPoints.find((point) => point.id === "A7")?.titanId, 3511);
  assert.equal(venueBeamPoints.find((point) => point.id === "A8")?.titanId, 3514);
  assert.equal(venueBeamPoints.find((point) => point.id === "A9")?.titanId, 15676);
  assert.equal(venueBeamPoints.find((point) => point.id === "A10")?.titanId, 3521);
  assert.equal(venueBeamPoints.find((point) => point.id === "A11")?.titanId, 3519);
  assert.equal(venueBeamPoints.find((point) => point.id === "A12")?.titanId, 3518);
  assert.equal(venueBeamPoints.find((point) => point.id === "A13")?.titanId, 3515);
  assert.equal(venueBeamPoints.find((point) => point.id === "A14")?.titanId, 3522);
  assert.equal(venueBeamPoints.find((point) => point.id === "A15")?.titanId, 3520);
  assert.equal(venueBeamPoints.find((point) => point.id === "A16")?.titanId, 3517);
  assert.equal(venueBeamPoints.find((point) => point.id === "A17")?.titanId, 3516);
  assert.equal(venueBeamPoints.find((point) => point.id === "A18")?.titanId, 3526);
  assert.equal(venueBeamPoints.find((point) => point.id === "A19")?.titanId, 3525);
  assert.equal(venueBeamPoints.find((point) => point.id === "A20")?.titanId, 3524);
  assert.equal(venueBeamPoints.find((point) => point.id === "A21")?.titanId, 3523);
  assert.equal(venueBeamPoints.find((point) => point.id === "A22")?.titanId, 3527);
  assert.equal(venueBeamPoints.find((point) => point.id === "A23")?.titanId, 3528);
  assert.equal(venueBeamPoints.find((point) => point.id === "A24")?.titanId, 3529);
  assert.equal(venueBeamPoints.find((point) => point.id === "A25")?.titanId, 3530);
  assert.ok(venueBeamPoints.every((point) => Number.isInteger(point.titanId)));
});

test("现场平面图包含连续唯一的 B1-B12 与 C1-C12 指挥编号", () => {
  assert.deepEqual(venueMovingWashPoints.map((point) => point.label), Array.from({length:12},(_,index)=>`B${index+1}`));
  assert.deepEqual(venueLedBarPoints.map((point) => point.label), Array.from({length:12},(_,index)=>`C${index+1}`));
  assert.equal(venueFixturePoints.length, 49);
  assert.equal(new Set(venueFixturePoints.map((point) => point.id)).size, 49);
  assert.ok([...venueMovingWashPoints,...venueLedBarPoints].every((point) => point.titanId === null));
});

test("A 组现场异常观察与用户报告一致", () => {
  const observations = Object.fromEntries(venueBeamPoints.map((point) => [point.id, [point.status, point.observation]]));
  assert.deepEqual(observations.A1, ["weak-output", "Locate 实测 · 可摇头 · 非白弱光 · 单灯组 10"]);
  assert.deepEqual(observations.A2, ["output-fault", "现场确认 · 灯源亮但朝上 · Pan/Tilt 无响应 · 单灯组 11"]);
  assert.deepEqual(observations.A3, ["verified", "Locate 实测 · 单灯组 12"]);
  assert.deepEqual(observations.A4, ["output-fault", "Pan/Tilt 正常 · 完全无光"]);
  assert.deepEqual(observations.A5, ["verified", "Locate 实测 · 单灯组 18"]);
  assert.deepEqual(observations.A6, ["verified", "Locate 实测 · 单灯组 19"]);
  assert.deepEqual(observations.A13, ["output-fault", "DMX 085 · CH21 · 蓝灯同正常 A9 · 待机光无花 · Pan/Tilt 无响应 · 单灯组 26"]);
  assert.deepEqual(observations.A7, ["verified", "Locate 实测 · 单灯组 20"]);
  assert.deepEqual(observations.A8, ["verified", "Locate 实测 · 单灯组 21"]);
  assert.deepEqual(observations.A9, ["verified", "Locate 实测 · 直接选灯 43"]);
  assert.deepEqual(observations.A10, ["verified", "Locate 实测 · 单灯组 29"]);
  assert.deepEqual(observations.A11, ["verified", "Locate 实测 · 单灯组 28"]);
  assert.deepEqual(observations.A12, ["verified", "Locate 实测 · 单灯组 27"]);
  assert.deepEqual(observations.A14, ["verified", "Locate 实测 · 单灯组 37"]);
  assert.deepEqual(observations.A15, ["verified", "Locate 实测 · 单灯组 36"]);
  assert.deepEqual(observations.A16, ["verified", "Locate 实测 · 单灯组 35"]);
  assert.deepEqual(observations.A17, ["verified", "Locate 实测 · 单灯组 34"]);
  assert.deepEqual(observations.A18, ["verified", "Locate 实测 · 单灯组 45"]);
  assert.deepEqual(observations.A19, ["verified", "Locate 实测 · 单灯组 44"]);
  assert.deepEqual(observations.A20, ["verified", "Locate 实测 · 单灯组 43"]);
  assert.deepEqual(observations.A21, ["verified", "Locate 实测 · 单灯组 42"]);
  assert.deepEqual(observations.A22, ["verified", "Locate 实测 · 单灯组 46"]);
  assert.deepEqual(observations.A23, ["verified", "Locate 实测 · 单灯组 47"]);
  assert.deepEqual(observations.A24, ["verified", "Locate 实测 · 单灯组 48"]);
  assert.deepEqual(observations.A25, ["verified", "Locate 实测 · 单灯组 49"]);
  assert.ok(venueBeamPoints.every((point) => point.status !== "unverified"));
});
