import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProcessorLayout,
  validateProcessorLayout,
  updateOutputDraft,
  updateSpeaker,
  pointFromClient,
  gridLabel,
  distanceToDelay,
} from "../src/dp448-layout.js";
test("annotated plan registers twelve speakers but keeps individual output routes unassigned", () => {
  const l = createProcessorLayout();
  assert.equal(l.outputs.length, 8);
  assert.equal(l.speakers.length, 12);
  for (const s of l.speakers) {
    assert.equal(typeof s.x, "number");
    assert.equal(s.output, null);
  }
  assert.deepEqual(
    l.speakers.filter((s) => s.kind === "sub").map((s) => s.candidates),
    [
      [7, 8],
      [7, 8],
      [7, 8],
      [7, 8],
    ],
  );
  assert.equal(l.speakers.filter(s => s.kind === "full" && s.heightM === 4.3).length, 6);
  assert.equal(l.speakers.filter(s => s.kind === "monitor").length, 2);
  assert.equal(l.outputs[0].draft.gainDb, null);
  assert.deepEqual(validateProcessorLayout(JSON.parse(JSON.stringify(l))), l);
});
test("multiple speakers share one output draft, not independent fictitious DSP channels", () => {
  let l = createProcessorLayout();
  l = updateSpeaker(l, "B1", { output: 7 });
  l = updateSpeaker(l, "B2", { output: 7 });
  l = updateOutputDraft(l, 7, { gainDb: -6, delayMs: 12.5 });
  assert.equal(l.outputs[6].draft.gainDb, -6);
  assert.equal(l.speakers.filter((s) => s.output === 7).length, 2);
  assert.equal(l.outputs[7].draft.gainDb, null);
  assert.throws(
    () => updateOutputDraft(l, 7, { hpfHz: 200, lpfHz: 100 }),
    /高通/,
  );
});
test("layout import rejects invalid coordinates, routes and unsafe numeric values", () => {
  const l = createProcessorLayout();
  for (const patch of [
    { output: 9 },
    { x: 200, y: 0 },
    { angle: Infinity },
    { distanceM: -1 },
  ])
    assert.throws(() => updateSpeaker(l, "B1", patch));
  assert.throws(() =>
    validateProcessorLayout({ ...l, speakers: [l.speakers[0], l.speakers[0]] }),
  );
  assert.deepEqual(
    pointFromClient({ left: 10, top: 20, width: 100, height: 200 }, -10, 300),
    { x: 0, y: 100 },
  );
  assert.equal(gridLabel({ x: 100, y: 100 }), "F8");
  assert.equal(gridLabel({ x: null, y: null }), "待定位");
  assert.equal(distanceToDelay(3.43), 10);
  assert.equal(distanceToDelay(null), null);
});
