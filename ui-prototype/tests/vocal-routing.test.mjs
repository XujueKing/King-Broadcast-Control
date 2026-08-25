import assert from "node:assert/strict";
import test from "node:test";
import {createOfflineRoutingStatus,normalizeRoutingResponse,routingStageLabel} from "../src/vocal-routing.js";

const virtualReport={
  schemaVersion:1,
  hardwareReady:false,
  ambiguityCount:0,
  inventory:{driverName:"KING Virtual Qu-16 ASIO",sampleRate:48000},
  routingMap:{physicalHardware:false,qu16MappingVerified:false,lanes:[
    {lane:"mic1",quInputChannel:1,inputDriverIndex:2,inputChannelName:"Input A",returnDriverIndex:1,returnChannelName:"Return A",evidence:"virtual_signal_trace"},
    {lane:"mic2",quInputChannel:2,inputDriverIndex:5,inputChannelName:"Input B",returnDriverIndex:4,returnChannelName:"Return B",evidence:"virtual_signal_trace"},
    {lane:"mic3",quInputChannel:3,inputDriverIndex:9,inputChannelName:"Input C",returnDriverIndex:8,returnChannelName:"Return C",evidence:"virtual_signal_trace"},
  ]},
};

test("offline routing state never claims hardware readiness",()=>{
  const status=createOfflineRoutingStatus();
  assert.equal(status.hardwareReady,false);
  assert.equal(status.stage,"not_discovered");
});

test("virtual discovery keeps non-contiguous driver indices",()=>{
  const status=normalizeRoutingResponse(virtualReport);
  assert.equal(status.stage,"virtual_discovered");
  assert.equal(status.hardwareReady,false);
  assert.deepEqual(status.lanes.map(lane=>lane.inputDriverIndex),[2,5,9]);
});

test("saved envelope advances only to virtual saved",()=>{
  const status=normalizeRoutingResponse({saved:true,savedPath:"vocal-routing.json",report:virtualReport});
  assert.equal(status.stage,"virtual_saved");
  assert.equal(routingStageLabel(status.stage),"离线映射已保存");
});

test("truthy strings cannot unlock onsite verification",()=>{
  const unsafe=structuredClone(virtualReport);
  unsafe.hardwareReady="true";
  unsafe.routingMap.physicalHardware="true";
  unsafe.routingMap.qu16MappingVerified="true";
  assert.equal(normalizeRoutingResponse(unsafe).hardwareReady,false);
});
