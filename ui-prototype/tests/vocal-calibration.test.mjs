import assert from "node:assert/strict";
import test from "node:test";
import {createCalibrationStatus,normalizeCalibrationReport} from "../src/vocal-calibration.js";

test("calibration begins with three pending lanes",()=>{
  const status=createCalibrationStatus();
  assert.equal(status.finalState,"idle");
  assert.ok(status.lanes.every(lane=>lane.state==="pending"));
});

test("completed report retains rejected crosstalk evidence",()=>{
  const status=normalizeCalibrationReport({
    mode:"virtual_calibration_wizard",
    finalState:"complete",
    completedLanes:3,
    rejectedObservations:1,
    events:[{sequence:11,state:"tracing_input",lane:"mic2",accepted:false,rejection:"ambiguous_signal",message:"检测到多路相近信号"}],
  });
  assert.equal(status.finalState,"complete");
  assert.equal(status.rejectedObservations,1);
  assert.equal(status.events[0].accepted,false);
  assert.ok(status.lanes.every(lane=>lane.state==="complete"));
});

test("unknown report cannot advance the wizard",()=>{
  assert.equal(normalizeCalibrationReport({mode:"onsite",completedLanes:3}).completedLanes,0);
});

test("joint evidence exposes bounded synchronization without claiming onsite status",()=>{
  const status=normalizeCalibrationReport({mode:"joint_recorded_evidence_replay",allLanesSynchronized:true,maximumObservedSkewFrames:120,maximumAllowedSkewFrames:960,calibration:{mode:"virtual_calibration_wizard",finalState:"complete",completedLanes:3,rejectedObservations:0,events:[]}});
  assert.equal(status.jointEvidence,true);
  assert.equal(status.allLanesSynchronized,true);
  assert.equal(status.maximumSkewFrames,120);
});
