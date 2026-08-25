const layer=process.argv[2];
if(!["lower","upper","custom"].includes(layer))throw new Error("Usage: node scripts/set-qu16-layer.mjs lower|upper|custom");
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
      expression:`(()=>{const button=document.querySelector('[data-layer-select="${layer}"]');if(!button)return {ok:false};button.click();return {ok:true,layer:document.querySelector('.qu-surface')?.dataset?.layer??''};})()`,
      returnByValue:true,
    },
  }));
});
socket.close();
console.log(JSON.stringify(result));
