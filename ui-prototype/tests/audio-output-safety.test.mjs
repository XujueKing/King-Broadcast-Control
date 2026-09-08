import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const rust=readFileSync(new URL("../src-tauri/src/mpv_runtime.rs",import.meta.url),"utf8");
const lib=readFileSync(new URL("../src-tauri/src/lib.rs",import.meta.url),"utf8");
test("source switches mute and pause before replacement, then verify path and settle seek",()=>{
  const source=rust.split("pub fn switch_source_preserving_state(")[1].split("pub fn set_paused")[0];
  assert.ok(source.indexOf('"volume", 0.0')<source.indexOf('"loadfile"'));
  assert.ok(source.indexOf('"pause", true')<source.indexOf('"loadfile"'));
  assert.ok(source.indexOf("wait_for_loaded_path(")<source.indexOf("safe_seek_instance("));
});
test("fader writes do not query a complete snapshot for every step",()=>{
  const source=rust.split("pub fn set_volume(")[1].split("pub fn deck_state")[0];
  assert.doesNotMatch(source,/deck_state_for_instance/);
  assert.match(source,/Ok\(\(\)\)/);
});
test("player commands perform blocking IPC away from the native UI and async reactor",()=>{
  for(const name of ["mpv_runtime_status","mpv_deck_load","mpv_deck_switch_source","mpv_deck_set_paused","mpv_deck_seek","mpv_deck_set_volume","mpv_deck_state","mpv_deck_shutdown","mpv_rescue_preview_sync"]){
    const source=lib.split(`async fn ${name}(`)[1]?.split("#[tauri::command]")[0];
    assert.ok(source,`${name} must be asynchronous`);
    assert.match(source,/spawn_blocking/);
  }
});
test("diagnostics subscribe read-only and bound log size; tests cannot reach PA",()=>{
  const source=rust.split("fn start_diagnostics(")[1].split("fn send_command")[0];
  assert.match(source,/request_log_messages/);
  assert.match(source,/observe_property/);
  assert.match(source,/8 \* 1024 \* 1024/);
  assert.doesNotMatch(source,/set_property|loadfile|\["seek"/);
  assert.match(rust,/#\[cfg\(test\)\]\s*command.args\(\["--ao=null", "--audio-device=auto"\]\)/);
});
