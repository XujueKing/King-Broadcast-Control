import {useEffect,useState} from 'react';

const reasons={audio_unbound:'请先在中控绑定通道',mixer_unavailable:'调音台未连接',audio_readback_pending:'等待调音台回读',player_unavailable:'请先准备演唱歌曲'};
function Level({name,level,max,disabled,onChange}){
  const [draft,setDraft]=useState(level?.value??0);
  useEffect(()=>setDraft(level?.value??0),[level?.value,disabled]);
  const commit=event=>{if(!disabled&&Number(event.currentTarget.value)!==level?.value)onChange(Number(event.currentTarget.value));};
  return <label className="singer-audio-level"><span>{name}<output>{level?.value??'—'} / {max}</output></span>
    <input aria-label={name} type="range" min="0" max={max} step="1" value={Math.min(max,draft)} disabled={disabled}
      onChange={event=>setDraft(Number(event.target.value))} onPointerUp={commit}
      onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))commit(event)}}
      onPointerCancel={()=>setDraft(level?.value??0)} onBlur={()=>setDraft(level?.value??0)}/>
    <small>{level?.available?'松手后应用':reasons[level?.reason]||'暂不可用'}</small>
  </label>;
}
export default function SingerAudioPanel({audio,policy,busy,onOperation}){
  const [error,setError]=useState(''),[pending,setPending]=useState(false);
  const run=async operation=>{setPending(true);setError('');try{await onOperation(operation)}catch{setError('调节未确认，请检查连接与实际回读后重试')}finally{setPending(false)}};
  const locked=busy||pending;
  return <section className="singer-audio-panel" aria-label="全场演唱调音">
    <h3>全场演唱调音</h3>
    <div className="singer-audio-levels">{Object.entries({music:'伴奏音量',microphone:'麦克风音量',reverb:'混响大小'}).map(([control,name])=>
      <Level key={control} name={name} level={audio?.[control]} max={policy[`${control}Max`]} disabled={locked||!audio?.[control]?.available||(control==='music'&&audio.acappella)} onChange={value=>run({type:'audio_level',control,value})}/>)}</div>
    <button aria-pressed={Boolean(audio?.acappella)} disabled={locked||!audio?.music?.available} onClick={()=>run({type:'acappella',enabled:!audio.acappella})}>{audio?.acappella?'退出清唱 · 恢复伴奏':'进入清唱模式'}</button>
    <p>清唱仅关闭伴奏，麦克风与混响保留，歌词继续。退出后恢复原伴奏音量。</p>
    {locked&&<p role="status">正在等待实际回读…</p>}{error&&<p role="alert">{error}</p>}
  </section>;
}
