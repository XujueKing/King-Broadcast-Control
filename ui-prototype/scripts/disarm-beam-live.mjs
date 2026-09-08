const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const armRequested=process.argv.includes("--arm");
const targets=await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main=targets.find((target)=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");
const socket=new WebSocket(main.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true})});
const result=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error("Beam disarm timed out")),5000);
  socket.addEventListener("message",(event)=>{const message=JSON.parse(String(event.data));if(message.id!==1)return;clearTimeout(timeout);if(message.error)reject(new Error(JSON.stringify(message.error)));else resolve(message.result?.result?.value)});
  socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression:`(()=>{const button=document.querySelector('.beam-show-arm');const before=button?.getAttribute('aria-pressed');const desired=${armRequested};if((before==='true')!==desired)button.click();return {before,after:button?.getAttribute('aria-pressed'),text:button?.textContent?.trim()}})()`,returnByValue:true}}));
});
socket.close();
console.log(JSON.stringify(result,null,2));
