// Read-only inspection of the installed native WebView. Never starts playback.
const targets=await fetch("http://127.0.0.1:9229/json/list").then(r=>r.json());
const target=targets.find(t=>t.url.includes("tauri.localhost")&&!t.url.includes("output.html"));
if(!target)throw new Error("Native KING target missing");
const socket=new WebSocket(target.webSocketDebuggerUrl);
const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.close();reject(new Error("Native inspection timed out"));},15000);
  socket.addEventListener("open",()=>socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{awaitPromise:true,returnByValue:true,expression:`(async()=>({
    program:await window.__TAURI_INTERNALS__.invoke("get_program_state"),
    master:document.querySelector('input[aria-label="总声音大小"]')?.value,
    videoMode:document.querySelector('select[aria-label="视频播放模式"]')?.value,
    deckModes:[...document.querySelectorAll('.deck')].map(d=>[...d.querySelectorAll('[aria-pressed="true"]')].map(x=>x.getAttribute('aria-label')||x.title)),
    playlists:Object.fromEntries(Object.entries(localStorage).filter(([key])=>/playlist|schedule/i.test(key)).map(([key,value])=>[key,JSON.parse(value)])),
    lightText:document.querySelector('.titan-panel-identity')?.innerText,
    videoCards:document.querySelectorAll('.video-grid button').length,
    videoLayout:(()=>{const panel=document.querySelector('.video-panel');if(!panel)return null;return {rows:getComputedStyle(panel).gridTemplateRows,children:[...panel.children].map(el=>{const r=el.getBoundingClientRect();return {className:el.className,top:r.top,bottom:r.bottom,height:r.height};})};})(),
    pageErrors:document.body.innerText.includes('Something went wrong')
  }))()`}})));
  socket.addEventListener("message",event=>{
    const message=JSON.parse(String(event.data));
    if(message.id!==1)return;
    clearTimeout(timer);socket.close();
    if(message.error||message.result?.exceptionDetails)reject(new Error(JSON.stringify(message.error||message.result.exceptionDetails)));
    else resolve(message.result.result.value);
  });
  socket.addEventListener("error",reject);
});
function summarize(value){
  if(Array.isArray(value))return value.map(summarize);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>key==="trackPaths"?["trackCount",item.length]:[key,summarize(item)]));
  return value;
}
result.playlists=summarize(result.playlists);
console.log(JSON.stringify(result,null,2));
