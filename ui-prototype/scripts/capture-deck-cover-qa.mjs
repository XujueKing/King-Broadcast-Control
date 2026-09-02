import fs from "node:fs/promises";
import path from "node:path";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const prioritizeTitle = process.env.KING_QA_PRIORITIZE ?? "";
const targetTitle = process.env.KING_QA_TARGET_TITLE ?? "怎么了";
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = targets.find((target) => !target.url.includes("output.html") && /tauri\.localhost|localhost:1420/.test(target.url));
if (!main) throw new Error("Main Tauri WebView target not found");

const socket = new WebSocket(main.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await call("Page.enable");
await call("Runtime.enable");
const state = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const wait=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));
    const library=await window.__TAURI_INTERNALS__.invoke('scan_media_library');
    const targetTitle=${JSON.stringify(targetTitle)};
    const prioritizeTitle=${JSON.stringify(prioritizeTitle)};
    if(prioritizeTitle){
      const target=(library.audio??[]).find((item)=>item.name?.includes(prioritizeTitle));
      if(target)await window.__TAURI_INTERNALS__.invoke('prioritize_audio_ai_analysis',{path:target.path});
    }
    const jobs=await window.__TAURI_INTERNALS__.invoke('list_audio_ai_jobs');
    const workerStatus=await window.__TAURI_INTERNALS__.invoke('audio_ai_worker_status');
    const kgmaAssets=(library.audio??[]).filter((item)=>item.path?.includes('.king-imported'));
    const search=document.querySelector('input[aria-label="搜索歌曲、歌手或目录"]');
    if(search?.value){
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(search,'');
      search.dispatchEvent(new Event('input',{bubbles:true}));
      search.dispatchEvent(new Event('change',{bubbles:true}));
      await wait(300);
    }
    for(let attempt=0;attempt<60&&!([...document.querySelectorAll('.track-row')].some((item)=>item.textContent.includes(targetTitle)));attempt+=1)await wait(200);
    let targetDeck=[...document.querySelectorAll('.deck')].find((deck)=>deck.querySelector('h3')?.textContent.includes(targetTitle));
    if(!targetDeck){
      const row=[...document.querySelectorAll('.track-row')].find((item)=>item.textContent.includes(targetTitle));
      row?.querySelector('.track-deck-one-action')?.click();
      for(let attempt=0;attempt<20;attempt+=1){
        await wait(150);
        targetDeck=[...document.querySelectorAll('.deck')].find((deck)=>deck.querySelector('h3')?.textContent.includes(targetTitle));
        if(targetDeck)break;
      }
    }
    if(!targetDeck)return {error:'目标歌曲未进入 Deck',titles:[...document.querySelectorAll('.deck h3')].map((node)=>node.textContent),rows:document.querySelectorAll('.track-row').length,audioImport:library.audioImport,kgmaAssets:kgmaAssets.map(({name,path,lyricsPath,lyrics,vocalsPath,accompanimentPath})=>({name,path,lyricsPath,lyricsLength:lyrics?.length??0,vocalsPath,accompanimentPath}))};
    const cover=targetDeck.querySelector('.cover');
    for(let attempt=0;attempt<20&&(!cover?.querySelector('img')?.complete||!cover.querySelector('img')?.naturalWidth);attempt+=1)await wait(150);
    const image=cover?.querySelector('img');
    const libraryRow=[...document.querySelectorAll('.track-row')].find((item)=>item.textContent.includes(targetTitle));
    const aiAction=libraryRow?.querySelector('.track-ai-action');
    const rect=targetDeck.querySelector('.deck-track').getBoundingClientRect();
    const fullRect=document.querySelector('.mixer-panel').getBoundingClientRect();
    const originalButton=[...targetDeck.querySelectorAll('button')].find((button)=>button.textContent.trim()==='原唱');
    const accompanimentButton=[...targetDeck.querySelectorAll('button')].find((button)=>button.textContent.includes('伴唱'));
    return {title:targetDeck.querySelector('h3')?.textContent,coverClass:cover?.className,imageSrc:image?.src??'',naturalWidth:image?.naturalWidth??0,naturalHeight:image?.naturalHeight??0,audioImport:library.audioImport,kgmaAssets:kgmaAssets.map(({name,path,lyricsPath,lyrics,vocalsPath,accompanimentPath})=>({name,path,lyricsPath,lyricsLength:lyrics?.length??0,vocalsPath,accompanimentPath})),automaticStemSeparation:{rowText:libraryRow?.textContent??'',aiActionText:aiAction?.textContent??'',aiActionDisabled:Boolean(aiAction?.disabled),originalDisabled:Boolean(originalButton?.disabled),accompanimentDisabled:Boolean(accompanimentButton?.disabled),jobs:jobs.filter((job)=>job.mediaPath?.includes('.king-imported')).map(({mediaPath,status,stage,errorMessage})=>({mediaPath,status,stage,errorMessage})),workerStatus},viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},rect:{x:Math.max(0,rect.x-8),y:Math.max(0,rect.y-8),width:Math.min(innerWidth-Math.max(0,rect.x-8),rect.width+16),height:rect.height+16},fullRect:{x:fullRect.x,y:fullRect.y,width:fullRect.width,height:fullRect.height}};
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
const result = state.result.value;
if (result.error) throw new Error(JSON.stringify(result));
const shot = await call("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
  clip: { ...result.rect, scale: 1 },
});
const output = path.resolve("artifacts/deck-cover-actual.png");
const fullOutput = path.resolve("artifacts/deck-cover-full-actual.png");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, Buffer.from(shot.data, "base64"));
const fullShot = await call("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
  clip: { ...result.fullRect, scale: 1 },
});
await fs.writeFile(fullOutput, Buffer.from(fullShot.data, "base64"));
socket.close();
console.log(JSON.stringify({ output, fullOutput, ...result }, null, 2));
