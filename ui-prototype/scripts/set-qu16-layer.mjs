const layer=process.argv[2];
const mix=process.argv[3]??null;
const mixTargets=["LR","FX 1","FX 2","Mix 1","Mix 2","Mix 3","Mix 4","Mix 5-6","Mix 7-8","Mix 9-10"];
if(!["lower","upper","custom"].includes(layer)||mix!==null&&!mixTargets.includes(mix))throw new Error("Usage: node scripts/set-qu16-layer.mjs lower|upper|custom [LR|FX 1|FX 2|Mix 1|Mix 2|Mix 3|Mix 4|Mix 5-6|Mix 7-8|Mix 9-10]");
const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const targets=await fetch(`${endpoint}/json/list`).then(response=>response.json());
const main=targets.find(target=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");
const socket=new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{
  socket.addEventListener("open",resolve,{once:true});
  socket.addEventListener("error",reject,{once:true});
});
const result=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error("Layer switch timed out")),5000);
  socket.addEventListener("message",event=>{
    const message=JSON.parse(String(event.data));
    if(message.id!==1)return;
    clearTimeout(timeout);
    message.error?reject(new Error(JSON.stringify(message.error))):resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({
    id:1,
    method:"Runtime.evaluate",
    params:{
      expression:`(()=>{
        const surface=document.querySelector('.qu-surface');
        if(!surface)return {ok:false,reason:"surface-missing"};
        const layerButton=document.querySelector('[data-layer-select=${JSON.stringify(layer)}]');
        if(!layerButton)return {ok:false,reason:"layer-button-missing"};
        if(surface.dataset.layer!==${JSON.stringify(layer)})layerButton.click();
        const mix=${JSON.stringify(mix)};
        if(mix!==null&&surface.dataset.activeMix!==mix){
          const mixButton=document.querySelector('[data-mix-select="'+CSS.escape(mix)+'"]');
          if(!mixButton)return {ok:false,reason:"mix-button-missing"};
          mixButton.click();
        }
        return {ok:true,layer:surface?.dataset?.layer??'',mix:surface?.dataset?.activeMix??''};
      })()`,
      returnByValue:true,
    },
  }));
});
socket.close();
console.log(JSON.stringify(result));
