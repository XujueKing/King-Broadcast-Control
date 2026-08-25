import test from "node:test";
import assert from "node:assert/strict";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";

const evaluate = (target, expression) => new Promise((resolve, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error("KINGSONG desktop evaluation timed out"));
  }, 60_000);
  socket.addEventListener("open", () => socket.send(JSON.stringify({
    id:1,
    method:"Runtime.evaluate",
    params:{expression,returnByValue:true,awaitPromise:true},
  })));
  socket.addEventListener("message", (event) => {
    const message=JSON.parse(String(event.data));
    if(message.id!==1)return;
    clearTimeout(timeout);
    socket.close();
    if(message.error)reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.addEventListener("error",()=>{
    clearTimeout(timeout);
    reject(new Error("KINGSONG desktop CDP connection failed"));
  });
});

test("desktop exposes hardware mode and portable song package commands", {timeout:70_000}, async () => {
  const response=await fetch(`${endpoint}/json/list`);
  assert.equal(response.ok,true);
  const targets=await response.json();
  const main=targets.find((target)=>!/output\.html/.test(target.url)&&/(?:localhost:1420\/|tauri\.localhost\/|index\.html)/.test(target.url));
  assert.ok(main,"main Tauri WebView target not found");
  const shouldExport=process.env.KING_TEST_KINGSONG_EXPORT==="1";
  const state=await evaluate(main,`(async()=>{
    const invoke=window.__TAURI_INTERNALS__.invoke;
    const capability=await invoke('runtime_capabilities');
    const directories=await invoke('song_package_directories');
    const jobs=await invoke('list_audio_ai_jobs');
    const ready=jobs.find(job=>job.status==='ready');
    let exported=null;
    if(${JSON.stringify(shouldExport)}&&ready){
      exported=await invoke('export_kingsong',{path:ready.mediaPath,title:'KINGSONG 实机验证',artist:'KING CLUB'});
    }
    return {capability,directories,ready,exported,toolbar:document.querySelector('.song-package-tools')?.innerText??''};
  })()`);
  assert.match(state.capability.mode,/^(full|player)$/);
  assert.match(state.directories.inboxDirectory,/song-packages[\\/]inbox$/i);
  assert.match(state.directories.outboxDirectory,/song-packages[\\/]outbox$/i);
  assert.match(state.toolbar,/导出包/);
  assert.match(state.toolbar,/导入包/);
  if(shouldExport){
    assert.ok(state.ready,"a ready song is required for real package export");
    assert.match(state.exported.path,/\.kingsong$/i);
    assert.equal(state.exported.status,"exported");
  }
});
