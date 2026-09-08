// Explicit onsite validation: native app must be idle, PGM black, video muted.
// Runs actual video EOF without outputting audio. Restores PGM to black at end.
import { test } from "node:test";
import assert from "node:assert/strict";
const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
async function evaluate(target,expression){
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.close();reject(new Error("Native evaluation timeout"));},15000);
    socket.addEventListener("open",()=>socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}})));
    socket.addEventListener("message",event=>{
      const message=JSON.parse(String(event.data));if(message.id!==1)return;
      clearTimeout(timer);socket.close();
      if(message.error||message.result?.exceptionDetails)reject(new Error(JSON.stringify(message.error||message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    });
    socket.addEventListener("error",reject);
  });
}
async function until(target,expression){
  return evaluate(target,`(async()=>{const deadline=Date.now()+10000;while(Date.now()<deadline){const result=(${expression});if(result)return result;await new Promise(r=>setTimeout(r,100));}throw new Error('Native verification condition not reached');})()`);
}
test("native PGM advances on real EOF; preview and browsing do not redirect its captured queue",{skip:process.env.KING_RUN_VIDEO_SEQUENCE_TEST!=="1"},async()=>{
  const targets=await fetch(`${endpoint}/json/list`).then(r=>r.json());
  const main=targets.find(t=>t.url.includes("tauri.localhost")&&!t.url.includes("output.html"));
  const output=targets.find(t=>t.url.includes("output.html"));
  assert.ok(main&&output);
  const before=await evaluate(main,`(async()=>({program:await window.__TAURI_INTERNALS__.invoke('get_program_state'),decks:await Promise.all([1,2].map(deck=>window.__TAURI_INTERNALS__.invoke('mpv_deck_state',{deck}))),muted:document.querySelector('.video-audio-toggle')?.getAttribute('aria-pressed')==='false'}))()`);
  assert.ok(before.decks.every(deck=>deck.paused),"operator has music running; do not interfere");
  assert.equal(before.program.media.id,"black-screen","operator already has PGM content; do not overwrite");
  assert.equal(before.muted,true);
  let took=false;
  try{
    await evaluate(main,`document.querySelector('.video-grid button[aria-label^="预览视频"]').click()`);
    await until(main,`Boolean(document.querySelector('.media-preview-confirm .take'))`);
    const previewProgram=await evaluate(main,`window.__TAURI_INTERNALS__.invoke('get_program_state')`);
    assert.equal(previewProgram.media.id,"black-screen");
    await evaluate(main,`document.querySelector('.media-preview-confirm .take').click()`);took=true;
    const first=await until(main,`(await window.__TAURI_INTERNALS__.invoke('get_program_state')).playback.token>0&&(await window.__TAURI_INTERNALS__.invoke('get_program_state'))`);
    assert.equal(first.playback.mode,"sequence");assert.ok(first.playback.queueIds.length>1);
    await until(output,`document.querySelector('video')?.readyState>=2`);
    assert.equal(await evaluate(output,`document.querySelector('video').muted`),true);
    await evaluate(main,`document.querySelectorAll('.video-grid button[aria-label^="预览视频"]')[2].click()`);
    const staged=await until(main,`document.querySelector('.preview-pane video')?.currentSrc`);
    await evaluate(main,`[...document.querySelectorAll('.media-category-switch button')].find(b=>b.textContent==='舞台').click()`);
    // Real EOF, not a fabricated JS ended event. Only a muted video is sought.
    await evaluate(output,`(()=>{const video=document.querySelector('video');if(!video.muted)throw new Error('Video is audible');video.currentTime=video.duration-.15;return video.play();})()`);
    const next=await until(main,`(await window.__TAURI_INTERNALS__.invoke('get_program_state')).playback.token>${first.playback.token}&&(await window.__TAURI_INTERNALS__.invoke('get_program_state'))`);
    assert.equal(next.playback.mediaId,first.playback.queueIds[1]);
    assert.equal(next.playback.token,first.playback.token+1);
    // PVW remains selected even when its tile is hidden by a different folder.
    assert.equal(await evaluate(main,`document.querySelector('.preview-pane video')?.currentSrc`),staged);
    // A delayed EOF for the previous token must not skip another clip.
    await evaluate(output,`window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to',{target:{kind:'WebviewWindow',label:'main'},event:'program-video-ended',payload:${JSON.stringify({mediaId:first.playback.mediaId,token:first.playback.token})}})`);
    const afterDuplicate=await evaluate(main,`window.__TAURI_INTERNALS__.invoke('get_program_state')`);
    assert.equal(afterDuplicate.playback.token,next.playback.token);
    await evaluate(main,`[...document.querySelectorAll('.media-category-switch button')].find(b=>b.textContent==='全部').click()`);
    await evaluate(main,`(async()=>{for(let batch=0;batch<8;batch++){const more=document.querySelector('.video-grid-load-more');if(!more)break;more.click();await new Promise(r=>setTimeout(r,100));}const cards=document.querySelectorAll('.video-grid button[aria-label^="预览视频"]');cards[cards.length-1].click();})()`);
    await evaluate(main,`document.querySelector('.media-preview-confirm .take').click()`);
    const last=await until(main,`(await window.__TAURI_INTERNALS__.invoke('get_program_state')).playback.mediaId===${JSON.stringify(first.playback.queueIds.at(-1))}&&(await window.__TAURI_INTERNALS__.invoke('get_program_state'))`);
    await until(output,`document.querySelector('video')?.readyState>=2`);
    await evaluate(output,`(()=>{const video=document.querySelector('video');if(!video.muted)throw new Error('Video is audible');video.currentTime=video.duration-.15;return video.play();})()`);
    const wrapped=await until(main,`(await window.__TAURI_INTERNALS__.invoke('get_program_state')).playback.token>${last.playback.token}&&(await window.__TAURI_INTERNALS__.invoke('get_program_state'))`);
    assert.equal(wrapped.playback.mediaId,first.playback.queueIds[0]);
    const afterDecks=await evaluate(main,`Promise.all([1,2].map(deck=>window.__TAURI_INTERNALS__.invoke('mpv_deck_state',{deck})))`);
    assert.deepEqual(afterDecks,before.decks);
    console.log(JSON.stringify({nativeSequence:true,lastToFirst:true,queueLength:first.playback.queueIds.length,first:first.playback.mediaId,next:next.playback.mediaId,muted:true,decksUnchanged:true}));
  }finally{
    if(took){
      await evaluate(main,`[...document.querySelectorAll('.media-type-switch button')].find(b=>b.textContent==='图片').click()`);
      await until(main,`Boolean(document.querySelector('.image-grid button'))`);
      await evaluate(main,`document.querySelector('.image-grid button').click()`);
      await until(main,`Boolean(document.querySelector('.media-preview-confirm .take'))`);
      await evaluate(main,`document.querySelector('.media-preview-confirm .take').click()`);
      await until(main,`(await window.__TAURI_INTERNALS__.invoke('get_program_state')).media.id==='black-screen'`);
      await evaluate(main,`[...document.querySelectorAll('.media-type-switch button')].find(b=>b.textContent==='视频').click()`);
      await evaluate(main,`(()=>{const toggle=document.querySelector('.preview-toggle');if(toggle?.getAttribute('aria-pressed')==='true')toggle.click();})()`);
    }
  }
});
