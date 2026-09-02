import assert from "node:assert/strict";
import test from "node:test";

import { venueBeamPoints } from "../src/venue-beam-layout.js";

test("现场光束平面图提供连续且唯一的 A1-A25 指挥编号", () => {
  assert.equal(venueBeamPoints.length, 25);
  assert.deepEqual(venueBeamPoints.map((point) => point.label), Array.from({length:25},(_,index)=>`A${index+1}`));
  assert.equal(new Set(venueBeamPoints.map((point) => `${point.x},${point.y}`)).size, 25);
});

test("A 编号在逐台定位前不会冒充 TitanId", () => {
  assert.ok(venueBeamPoints.every((point) => point.type === "beam"));
  assert.ok(venueBeamPoints.every((point) => point.titanId === null));
  assert.ok(venueBeamPoints.every((point) => point.status === "unverified"));
});
