import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import "./singer-gateway.css";
import {defaultSingerAudioPolicy,singerMicrophones} from './singer-audio.js';
import SingerAudioPanel from './SingerAudioPanel.jsx';

export default function SingerGatewaySettings({audioControls}){
  const [policy,setPolicy]=useState(defaultSingerAudioPolicy);
  const [status,setStatus]=useState(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [port,setPort]=useState(4865),[deck,setDeck]=useState(1),[reveal,setReveal]=useState(false);
  useEffect(()=>{
    let disposed=false,timer,initialized=false;
    const refresh=async()=>{
      try {
        const next=await invoke("singer_gateway_status");
        if(disposed)return;
        setStatus(next);
        if(!initialized){setPolicy(next.config.audioPolicy??defaultSingerAudioPolicy);setPort(next.config.port);setDeck(next.config.deck);initialized=true}
      }catch(cause){if(!disposed)setError(String(cause))}
      if(!disposed)timer=setTimeout(refresh,1500);
    };
    void refresh();return()=>{disposed=true;clearTimeout(timer)};
  },[]);
  const configure=async(enabled,rotateToken=false)=>{
    setBusy(true);setError("");
    try{
      const next=await invoke("singer_gateway_configure",{enabled,port:Number(port),deck:Number(deck),rotateToken,audioPolicy:policy});
      setStatus(next);setPolicy(next.config.audioPolicy??defaultSingerAudioPolicy);setReveal(false);
    }catch(cause){setError(String(cause))}finally{setBusy(false)}
  };
  const pair=async(enabled)=>{
    setBusy(true);setError("");
    try{setStatus(await invoke("singer_gateway_pairing",{enabled}));}
    catch(cause){setError(String(cause));}finally{setBusy(false);}
  };
  return <section className="singer-gateway-settings" aria-label="主唱平板局域网接口">
    <header><b>主唱平板连接</b><span role="status">{status?.running?"接口已开启":"接口已关闭"} · {status?.controllerOnline?"播放器已就绪":"等待播放器"}</span></header>
    <p>选歌、歌词、原唱／伴唱、重唱和切歌。平板通过员工局域网连接本机；选歌后等待主唱点击播放。</p>
    <div className="singer-gateway-controls">
      <label>端口<input aria-label="主唱接口端口" type="number" min="1024" max="65535" value={port} onChange={event=>setPort(event.target.value)}/></label>
      <label>演唱播放器<select aria-label="主唱播放器" value={deck} onChange={event=>setDeck(Number(event.target.value))}><option value="1">Deck 1</option><option value="2">Deck 2</option></select></label>
      <button disabled={busy||audioControls?.busy||!status} onClick={()=>configure(!status?.running)}>{busy?"处理中…":status?.running?"关闭接口":"保存并开启接口"}</button>
      {status?.running&&<button disabled={busy||audioControls?.busy} onClick={()=>configure(true)}>应用连接设置</button>}
    </div>
    <section className="singer-audio-binding" aria-label="主唱调音权限">
      <h3>主唱调音权限 · 全场音箱</h3>
      <div className="singer-gateway-controls">
        <label>歌手麦克风<select aria-label="歌手麦克风通道" value={policy.microphone} onChange={e=>setPolicy({...policy,microphone:e.target.value})}><option value="">未绑定</option>{Object.entries(singerMicrophones).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>第二支麦克风<select aria-label="第二支麦克风通道" value={policy.microphone2??''} onChange={e=>setPolicy({...policy,microphone2:e.target.value})}><option value="">未绑定</option>{Object.entries(singerMicrophones).map(([key,label])=><option key={key} value={key} disabled={key===policy.microphone}>{label}</option>)}</select></label>
        <label>混响效果总线<select aria-label="混响效果总线" value={policy.reverbBus} onChange={e=>setPolicy({...policy,reverbBus:e.target.value})}><option value="">未绑定</option><option>FX 1</option><option>FX 2</option></select></label>
        {Object.entries({music:'伴奏',microphone:'麦克风1',microphone2:'麦克风2',reverb:'混响'}).map(([key,label])=><label key={key}>{label}上限<input type="number" aria-label={label+'调节上限'} min="0" max={key==='music'?100:77} value={policy[key+'Max']??77} onChange={e=>setPolicy({...policy,[key+'Max']:Number(e.target.value)})}/></label>)}
        <button disabled={busy||audioControls?.busy||!status} onClick={()=>configure(status.running)}>保存调音权限</button>
      </div>
      <p>请按现场表计确认歌手通道，并确认所选 FX 已设置为混响。保存只绑定控制范围；麦克风与混响推子最高 77（约 0 dB）。歌手无法调整输入增益或全场总推子。</p>
    </section>
    {audioControls&&<SingerAudioPanel {...audioControls}/>}
    {status&&<div className="singer-gateway-connection">
      <section aria-label="平板快捷配对">
        <h3>自动连接 · 4 位配对码</h3>
        <p>平板连接员工 Wi-Fi 后自动寻找中控。首次输入一次配对码，以后自动连接。</p>
        {status.pairing?.active ? <><output className="singer-pair-code" aria-label="4位配对码">{status.pairing.code}</output><p>5 分钟内有效，成功配对一次即失效。输错 5 次后需重新生成。</p><button disabled={busy} onClick={()=>pair(false)}>结束配对</button></> : <><button disabled={busy||!status.running} onClick={()=>pair(true)}>生成 4 位配对码</button>{status.pairing?.locked&&<p role="alert">输错次数过多，请重新生成配对码。</p>}</>}
      </section>
      <details><summary>手动连接与密钥管理</summary>
      <label>连接地址<output>{status.addresses.join("\n")}</output></label>
      <label>连接密钥<input aria-label="主唱连接密钥" type={reveal?"text":"password"} readOnly value={status.config.token}/></label>
      <div><button onClick={()=>setReveal(value=>!value)}>{reveal?"隐藏密钥":"显示密钥"}</button><button disabled={busy||audioControls?.busy} onClick={()=>configure(status.running,true)}>更换密钥并解除旧连接</button></div>
      <small>曲库 {status.songCount} 首 · 选歌／切歌会停止背景音乐并准备演唱。耳机 CUE 时拒绝远程操作；更换密钥后平板需要重新配对。</small>
      </details>
    </div>}
    {(error||status?.error)&&<p role="alert">{error||status.error}</p>}
  </section>;
}
