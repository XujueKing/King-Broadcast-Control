import test from "node:test";
import assert from "node:assert/strict";
import {
  KINGCLUB_QU16_OUTPUT_BASELINE_ID,
  kingClubQu16OutputBaselineDifferences,
  kingClubQu16OutputBaselineWrites,
} from "../src/qu16-output-baseline.js";

test("8/26 output baseline restores only the proven ST3 to LR path",()=>{
  assert.equal(KINGCLUB_QU16_OUTPUT_BASELINE_ID,"kingclub-2026-08-26-st3-lr");
  assert.deepEqual(kingClubQu16OutputBaselineWrites(),[
    {key:"pafl:st-3",value:0},
    {key:"fader:st-3",value:98},
    {key:"fader:lr-master",value:98},
    {key:"assign:st-3:LR",value:1},
    {key:"mute:st-3",value:0},
    {key:"mute:lr-master",value:0},
  ]);
  assert.equal(kingClubQu16OutputBaselineWrites().some(({key})=>/ch-11|ch-12|process|preamp|dca|mute-group/.test(key)),false);
});

test("baseline comparison uses authoritative raw Qu values",()=>{
  const writes=kingClubQu16OutputBaselineWrites();
  const parameters=Object.fromEntries(writes.map(({key,value})=>[key,value]));
  assert.deepEqual(kingClubQu16OutputBaselineDifferences({parameters,pendingDetails:{}}),[]);
  assert.deepEqual(
    kingClubQu16OutputBaselineDifferences({parameters:{...parameters,"fader:st-3":1},pendingDetails:{}}),
    [{key:"fader:st-3",value:98,actual:1}],
  );
  assert.deepEqual(
    kingClubQu16OutputBaselineDifferences({parameters,pendingDetails:{"assign:st-3:LR":{state:"awaiting-readback"}}}),
    [{key:"assign:st-3:LR",value:1,actual:1}],
  );
});
