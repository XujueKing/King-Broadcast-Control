import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const lib=fs.readFileSync(new URL("../src-tauri/src/lib.rs",import.meta.url),"utf8");
const routing=fs.readFileSync(new URL("../src-tauri/src/vocal_routing.rs",import.meta.url),"utf8");

test("desktop exposes routing discovery status and save commands",()=>{
  for(const command of ["vocal_routing_status","vocal_discover_routing_virtual","vocal_simulate_calibration_wizard","vocal_replay_meter_fixture","vocal_replay_joint_evidence","vocal_replay_desktop_qu16_bridge","vocal_qu16_meter_bridge_status","vocal_save_routing"]){
    assert.match(lib,new RegExp(`fn ${command}\\b`));
    assert.match(lib,new RegExp(`\\b${command},`));
  }
});

test("virtual routing save rejects physical readiness claims",()=>{
  assert.match(routing,/hardwareReady/);
  assert.match(routing,/physicalHardware/);
  assert.match(routing,/qu16MappingVerified/);
  assert.match(routing,/虚拟映射不能声明 Qu-16 已验证/);
});
