import { useEffect, useMemo, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  CheckCircle,
  FilmSlate,
  FloppyDisk,
  Folders,
  ImageSquare,
  LightbulbFilament,
  LockKey,
  MagnifyingGlass,
  MusicNotes,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  TextT,
  Trash,
  VideoCamera,
} from "@phosphor-icons/react";
import {
  addAssetToShowTrack,
  createDefaultShowProject,
  findShowClip,
  moveShowClip,
  normalizeShowProject,
  removeShowClip,
  showProjectStorageKey,
  updateShowClip,
} from "./show-project.js";
import "./show-editor.css";

const SOURCE_ASSETS = [
  { id:"main", type:"V1", name:"Neon_Stage_Main.mp4", duration:"00:30", durationSeconds:30, image:"/assets/neon-stage.png" },
  { id:"loop", type:"V2", name:"Laser_Loop_30s.mp4", duration:"00:30", durationSeconds:30, image:"/assets/red-laser.png" },
  { id:"image", type:"IMG", name:"King_Stage_Backdrop.png", duration:"静态", durationSeconds:300, image:"/assets/green-geometry.png" },
  { id:"text", type:"TXT", name:"KING CLUB 标题", duration:"00:05", durationSeconds:5, image:"/assets/king-club-logo-white.svg" },
];

const TRACK_ICONS={markers:FilmSlate,audio:MusicNotes,v1:VideoCamera,v2:VideoCamera,image:ImageSquare,text:TextT,light:LightbulbFilament};

const fmt = (seconds) => {
  const safe=Math.max(0,Math.round(Number(seconds)||0));
  return `${String(Math.floor(safe/60)).padStart(2,"0")}:${String(safe%60).padStart(2,"0")}`;
};

const secondsFromDuration = (value) => {
  const parts=String(value||"").split(":").map(Number);
  if(parts.some(Number.isNaN))return 342;
  if(parts.length===3)return parts[0]*3600+parts[1]*60+parts[2];
  return (parts[0]||0)*60+(parts[1]||0);
};

function Monitor({ kind, title, image, track, live }) {
  return <section className={`show-monitor show-monitor-${kind}`}>
    <header><span><b>{kind}</b> / {title}</span><em>{live?"直播输出":"下一场景"}</em></header>
    <div className="show-monitor-canvas"><img src={image} alt=""/><span className="show-monitor-safe-frame"/><div className="show-monitor-logo">KING CLUB</div></div>
    <footer><span><b>{track?.title||"未选择歌曲"}</b><small>{track?.artist||"--"}</small></span><strong>{live?"00:01:34":"-00:01:08"}</strong></footer>
  </section>;
}

export function ShowEditorWorkspace({ track, deck1, deck2, playingDecks, cueDeck, crossfade, programMedia, previewMedia, videos=[] }) {
  const duration=secondsFromDuration(track?.duration);
  const songKey=String(track?.path||track?.id||track?.title||"draft");
  const [assetQuery,setAssetQuery]=useState("");
  const [assetType,setAssetType]=useState("全部");
  const [selectedAsset,setSelectedAsset]=useState("main");
  const [project,setProject]=useState(()=>createDefaultShowProject(songKey,duration));
  const [selectedClip,setSelectedClip]=useState({trackId:"v1",clipId:"v1-clip-1"});
  const [timelinePlaying,setTimelinePlaying]=useState(false);
  const [saved,setSaved]=useState(true);
  const currentTime=Math.min(duration,94);
  const timeTicks=useMemo(()=>Array.from({length:8},(_,index)=>Math.round(duration*index/7)),[duration]);
  const waveform=useMemo(()=>Array.from({length:96},(_,index)=>18+Math.abs(Math.sin(index*1.83)+Math.cos(index*.37)) * 19),[]);
  const runtimeAssets=useMemo(()=>videos.slice(0,4).map((item,index)=>({
    id:`runtime-${item.id??index}`,
    type:index?"V2":"V1",
    name:item.name||`本地视频 ${index+1}`,
    duration:item.duration||"本地",
    durationSeconds:secondsFromDuration(item.duration)||30,
    image:item.thumbnailSrc||SOURCE_ASSETS[index%SOURCE_ASSETS.length].image,
  })),[videos]);
  const assets=[...(runtimeAssets.length?runtimeAssets:SOURCE_ASSETS),...SOURCE_ASSETS.filter(item=>!runtimeAssets.some(asset=>asset.name===item.name))];
  const visibleAssets=assets.filter(item=>(assetType==="全部"||item.type===assetType)&&item.name.toLowerCase().includes(assetQuery.toLowerCase()));
  const selected=assets.find(item=>item.id===selectedAsset)??assets[0];
  const selectedEntry=findShowClip(project,selectedClip.trackId,selectedClip.clipId);
  const selectedProjectClip=selectedEntry?.clip??null;
  const deckOneStatus=playingDecks?.[1]?"播放中":deck1===null||deck1===undefined?"未装载":"已预载";
  const deckTwoStatus=cueDeck===2?"CUE 监听":playingDecks?.[2]?"播放中":deck2===null||deck2===undefined?"未装载":"已预载";
  const lightOwner=playingDecks?.[2]&&crossfade>=50?"Deck 2":"Deck 1";
  const programImage=programMedia?.type==="image"&&programMedia.src?programMedia.src:"/assets/neon-stage.png";
  const previewImage=previewMedia?.type==="image"&&previewMedia.src?previewMedia.src:"/assets/red-laser.png";

  useEffect(()=>{
    let raw=null;
    try{raw=JSON.parse(localStorage.getItem(showProjectStorageKey(track))||"null")}catch{}
    const next=normalizeShowProject(raw,songKey,duration);
    setProject(next);
    const first=next.tracks.find(item=>item.id==="v1")?.clips[0]??next.tracks.find(item=>!item.locked&&item.clips.length)?.clips[0];
    setSelectedClip(first?{trackId:"v1",clipId:first.id}:{trackId:"",clipId:""});
    setSaved(true);
  },[songKey,duration,track]);

  const applyProject=(next)=>{if(next===project)return;setProject(next);setSaved(false)};
  const selectClip=(trackId,clipId)=>setSelectedClip({trackId,clipId});
  const updateSelected=(patch)=>{
    if(!selectedProjectClip)return;
    applyProject(updateShowClip(project,selectedClip.trackId,selectedClip.clipId,patch));
  };
  const saveProject=()=>{
    const stored={...project,updatedAt:Date.now()};
    try{localStorage.setItem(showProjectStorageKey(track),JSON.stringify(stored));setProject(stored)}catch{}
    setSaved(true);
  };
  const dragPayload=(event,payload)=>{
    event.dataTransfer.effectAllowed="move";
    event.dataTransfer.setData("application/x-king-show",JSON.stringify(payload));
  };
  const acceptDrop=(event,targetTrackId,targetIndex)=>{
    event.preventDefault();
    event.stopPropagation();
    let payload=null;
    try{payload=JSON.parse(event.dataTransfer.getData("application/x-king-show"))}catch{return}
    if(payload?.kind==="clip"){
      const next=moveShowClip(project,payload.trackId,targetTrackId,payload.clipId,targetIndex);
      applyProject(next);
      if(next!==project)setSelectedClip({trackId:targetTrackId,clipId:payload.clipId});
      return;
    }
    if(payload?.kind==="asset"){
      const asset=assets.find(item=>item.id===payload.assetId);
      if(!asset)return;
      const next=addAssetToShowTrack(project,targetTrackId,asset,targetIndex);
      applyProject(next);
      if(next!==project){const lane=next.tracks.find(item=>item.id===targetTrackId);const added=lane?.clips.find(item=>item.assetId===asset.id);if(added)setSelectedClip({trackId:targetTrackId,clipId:added.id})}
    }
  };
  const deleteSelectedClip=()=>{
    if(!selectedProjectClip||selectedEntry.track.locked)return;
    const next=removeShowClip(project,selectedClip.trackId,selectedClip.clipId);
    applyProject(next);
    const replacement=next.tracks.find(item=>item.id===selectedClip.trackId)?.clips[0];
    setSelectedClip(replacement?{trackId:selectedClip.trackId,clipId:replacement.id}:{trackId:"",clipId:""});
  };

  return <section className="show-editor" aria-label="演出编排编辑器">
    <header className="show-editor-head">
      <div><FilmSlate weight="fill"/><span><b>演出编排</b><small>{track?.title||"请选择歌曲"} · {track?.duration||"--:--"}</small></span></div>
      <div className="show-editor-deck-state" aria-label="双 Deck 演出状态">
        <span className={playingDecks?.[1]?"live":""}><i>DECK 1</i><b>{deckOneStatus}</b></span>
        <span className="show-owner"><i>编排跟随</i><b>{crossfade<50?"1 → 2":"2 → 1"} · {crossfade}%</b></span>
        <span className={playingDecks?.[2]?"live cue":"cue"}><i>DECK 2</i><b>{deckTwoStatus}</b></span>
      </div>
      <button type="button" className={saved?"show-save saved":"show-save"} onClick={saveProject}>{saved?<CheckCircle weight="fill"/>:<FloppyDisk weight="fill"/>}{saved?"已保存":"保存编排"}</button>
    </header>

    <div className="show-editor-upper">
      <aside className="show-assets">
        <div className="show-assets-tabs">{["全部","V1","V2","IMG","TXT"].map(type=><button type="button" key={type} className={assetType===type?"active":""} onClick={()=>setAssetType(type)}>{type}</button>)}</div>
        <label><MagnifyingGlass/><input value={assetQuery} onChange={event=>setAssetQuery(event.target.value)} placeholder="搜索素材"/></label>
        <div className="show-asset-list">{visibleAssets.map(asset=><button type="button" draggable key={asset.id} className={selectedAsset===asset.id?"active":""} onDragStart={event=>dragPayload(event,{kind:"asset",assetId:asset.id})} onClick={()=>setSelectedAsset(asset.id)} title="拖到兼容时间线轨道以添加"><img src={asset.image} alt=""/><span><b>{asset.name}</b><small>{asset.type} · {asset.duration} · 可拖入轨道</small></span></button>)}</div>
        <button type="button" className="show-import"><Folders/>导入素材</button>
      </aside>

      <section className="show-monitor-bank">
        <div className="show-monitor-deckbar"><span className="deck-one"><b>DECK 1</b><em>{deckOneStatus}</em></span><span className="show-follow"><b>推杆值</b><strong>{100-crossfade} / {crossfade}</strong></span><span className="deck-two"><b>DECK 2</b><em>{deckTwoStatus}</em></span></div>
        <div className="show-monitor-grid"><Monitor kind="PVW" title="预览" image={previewImage} track={track}/><Monitor kind="PGM" title="主屏" image={programImage} track={track} live/></div>
        <div className="show-monitor-controls"><span><i className="status-dot"/>画面跟随 Crossfader</span><span className="lighting-owner"><LightbulbFilament weight="fill"/><i>灯光主控</i><b>{lightOwner}</b><LockKey weight="fill"/></span><span>只预览 · 不触发现场</span></div>
      </section>

      <aside className="show-inspector">
        <div className="show-inspector-tabs"><button className="active">属性</button><button>效果</button><button>灯光</button></div>
        <section><header><b>片段属性</b><small>{selectedProjectClip?.name||"请选择片段"}</small></header><div className="show-inspector-asset"><img src={selected?.image} alt=""/><span><b>{selectedProjectClip?.name||selected?.name}</b><small>{selectedEntry?.track?.label||"1920×1080 · 60fps"}</small></span>{selectedEntry&&!selectedEntry.track.locked&&<button type="button" className="show-delete-clip" onClick={deleteSelectedClip} title="从当前编排删除片段"><Trash/>删除</button>}</div></section>
        <section className="show-time-fields"><label><span>源入点（秒）</span><input aria-label="片段源入点秒数" type="number" min="0" step="0.1" value={selectedProjectClip?.sourceIn??0} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({sourceIn:event.target.value})}/></label><label><span>源出点（秒）</span><input aria-label="片段源出点秒数" type="number" min="0.1" step="0.1" value={selectedProjectClip?.sourceOut??0} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({sourceOut:event.target.value})}/></label><label><span>时间线（秒）</span><input aria-label="片段时间线时长秒数" type="number" min="0.1" max={duration} step="0.1" value={selectedProjectClip?.timelineDuration??0} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({timelineDuration:event.target.value})}/></label></section>
        <section className="show-loop-settings"><header><b>短视频填充方式</b><small>源时长与歌曲时长独立</small></header>{["循环到歌曲结束","循环到下一段","重复次数","尾帧保持","精确裁切"].map(mode=><label key={mode}><input type="radio" name="loop-mode" checked={selectedProjectClip?.loopMode===mode} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={()=>updateSelected({loopMode:mode})}/><span>{mode}</span>{mode==="重复次数"&&<input aria-label="片段重复次数" type="number" min="1" max="999" value={selectedProjectClip?.repeatCount??1} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({repeatCount:event.target.value})}/>}</label>)}</section>
        <section className="show-transform"><header><b>画面参数</b><SlidersHorizontal/></header><label><span>缩放</span><input type="range" min="25" max="200" defaultValue="100"/></label><label><span>不透明度</span><input type="range" min="0" max="100" defaultValue="100"/></label></section>
      </aside>
    </div>

    <div className="show-timeline-toolbar"><span><button type="button"><ArrowCounterClockwise/></button><button type="button"><ArrowsClockwise/></button><button type="button"><SkipBack/></button><button type="button" className="timeline-play" onClick={()=>setTimelinePlaying(value=>!value)}>{timelinePlaying?<Pause weight="fill"/>:<Play weight="fill"/>}</button><button type="button"><SkipForward/></button><em>拖动片段排序；素材可直接拖入兼容轨道</em></span><strong>{fmt(currentTime)}<small> / {fmt(duration)}</small></strong><span><label>吸附<input type="checkbox" defaultChecked/></label><select defaultValue="1/4"><option>1/4 拍</option><option>1/2 拍</option><option>1 拍</option></select><button type="button">适应</button></span></div>
    <section className="show-timeline" style={{"--playhead":`${Math.min(96,Math.max(4,currentTime/duration*100))}%`}}>
      <div className="show-time-ruler"><span/>{timeTicks.map(value=><i key={value}>{fmt(value)}</i>)}</div>
      <div className="show-playhead" aria-hidden="true"><i/></div>
      {project.tracks.map((lane)=>{const LaneIcon=TRACK_ICONS[lane.id]??FilmSlate;return <div className={`show-lane lane-${lane.kind}`} key={lane.id}><header><LaneIcon weight={lane.locked?"fill":"regular"}/><span>{lane.label}</span>{lane.locked&&<LockKey weight="fill"/>}</header><div className="show-lane-clips" onDragOver={event=>{if(!lane.locked)event.preventDefault()}} onDrop={event=>acceptDrop(event,lane.id,lane.clips.length)}>{lane.kind==="wave"?<div className="show-waveform" title={track?.title}>{waveform.map((height,index)=><i key={index} style={{height}}/>)}</div>:lane.clips.map((clip,index)=><button type="button" draggable={!lane.locked} key={clip.id} className={selectedClip.trackId===lane.id&&selectedClip.clipId===clip.id?"active":""} onDragStart={event=>dragPayload(event,{kind:"clip",trackId:lane.id,clipId:clip.id})} onDragOver={event=>event.preventDefault()} onDrop={event=>acceptDrop(event,lane.id,index)} onClick={()=>selectClip(lane.id,clip.id)} title={`${clip.name} · ${clip.timelineDuration.toFixed(1)} 秒 · 拖动调整顺序`} style={{"--clip-weight":Math.max(.5,clip.timelineDuration)}}><span>{clip.name}</span>{(lane.kind==="v1"||lane.kind==="v2")&&<ArrowsClockwise/>}</button>)}</div></div>})}
    </section>
    <footer className="show-editor-foot"><span>项目时长 <b>{fmt(duration)}</b></span><span>帧率 <b>60fps</b></span><span>预载状态 <b className="ready">Deck 2 已准备</b></span><span>现场输出 <b>安全锁定</b></span></footer>
  </section>;
}
