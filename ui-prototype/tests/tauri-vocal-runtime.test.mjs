import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tauriSource=await readFile(new URL("../src-tauri/src/lib.rs",import.meta.url),"utf8");
const appSource=await readFile(new URL("../src/App.jsx",import.meta.url),"utf8");

test("Tauri registers the independent Vocal Engine control commands",()=>{
  for(const command of ["vocal_runtime_status","vocal_set_preset","vocal_evaluate_arm","vocal_disarm"]){
    assert.match(tauriSource,new RegExp(`fn ${command}\\b`));
    assert.match(tauriSource,new RegExp(`\\b${command},`));
  }
  assert.match(tauriSource,/manage\(vocal_runtime::VocalRuntimeBridge::default\(\)\)/);
});

test("offline settings surface exposes disarm but no arm or audio-start action",()=>{
  assert.match(appSource,/invoke\("vocal_disarm"\)/);
  assert.match(appSource,/保持解除武装/);
  assert.doesNotMatch(appSource,/invoke\("vocal_evaluate_arm"\)/);
  assert.doesNotMatch(appSource,/>\s*(启动补音|武装音频)\s*</);
});
