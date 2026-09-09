import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import "./singer-gateway.css";

export default function SingerGatewaySettings(){
  const [status,setStatus]=useState(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [port,setPort]=useState(4865),[deck,setDeck]=useState(1),[reveal,setReveal]=useState(false);
  useEffect(()=>{
    let disposed=false,timer,initialized=false;
    const refresh=async()=>{
      try {
        const next=await invoke("singer_gateway_status");
        if(disposed)return;
        setStatus(next);
        if(!initialized){setPort(next.config.port);setDeck(next.config.deck);initialized=true}
      }catch(cause){if(!disposed)setError(String(cause))}
      if(!disposed)timer=setTimeout(refresh,1500);
    };
    void refresh();return()=>{disposed=true;clearTimeout(timer)};
  },[]);
  const configure=async(enabled,rotateToken=false)=>{
    setBusy(true);setError("");
    try{
      const next=await invoke("singer_gateway_configure",{enabled,port:Number(port),deck:Number(deck),rotateToken});
      setStatus(next);setReveal(false);
    }catch(cause){setError(String(cause))}finally{setBusy(false)}
  };
  return <section className="singer-gateway-settings" aria-label="主唱平板局域网接口">
    <header><b>主唱平板连接</b><span role="status">{status?.running?"接口已开启":"接口已关闭"} · {status?.controllerOnline?"播放器已就绪":"等待播放器"}</span></header>
    <p>选歌、歌词、原唱／伴唱、重唱和切歌。平板通过员工局域网连接本机；选歌后等待主唱点击播放。</p>
    <div className="singer-gateway-controls">
      <label>端口<input aria-label="主唱接口端口" type="number" min="1024" max="65535" value={port} onChange={event=>setPort(event.target.value)}/></label>
      <label>演唱播放器<select aria-label="主唱播放器" value={deck} onChange={event=>setDeck(Number(event.target.value))}><option value="1">Deck 1</option><option value="2">Deck 2</option></select></label>
      <button disabled={busy||!status} onClick={()=>configure(!status?.running)}>{busy?"处理中…":status?.running?"关闭接口":"保存并开启接口"}</button>
      {status?.running&&<button disabled={busy} onClick={()=>configure(true)}>应用连接设置</button>}
    </div>
    {status&&<div className="singer-gateway-connection">
      <label>连接地址<output>{status.addresses.join("\n")}</output></label>
      <label>连接密钥<input aria-label="主唱连接密钥" type={reveal?"text":"password"} readOnly value={status.config.token}/></label>
      <div><button onClick={()=>setReveal(value=>!value)}>{reveal?"隐藏密钥":"显示密钥"}</button><button disabled={busy} onClick={()=>configure(status.running,true)}>更换密钥并解除旧连接</button></div>
      <small>曲库 {status.songCount} 首 · 选歌／切歌会停止背景音乐并准备演唱。耳机 CUE 时拒绝远程操作；更换密钥后平板需要重新配对。</small>
    </div>}
    {(error||status?.error)&&<p role="alert">{error||status.error}</p>}
  </section>;
}
