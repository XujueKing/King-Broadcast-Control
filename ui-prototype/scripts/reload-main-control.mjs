const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const targets=await fetch(`${endpoint}/json/list`).then(response=>response.json());
const main=targets.find(target=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");
const socket=new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{
  socket.addEventListener("open",resolve,{once:true});
  socket.addEventListener("error",reject,{once:true});
});
socket.send(JSON.stringify({id:1,method:"Page.reload",params:{ignoreCache:true}}));
await new Promise(resolve=>setTimeout(resolve,500));
socket.close();
console.log("Main control WebView reloaded");
