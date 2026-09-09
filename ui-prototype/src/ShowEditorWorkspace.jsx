import { saveShowProject, clipAtTime, clipSourceTime, advancePreviewClock } from "./show-editor-runtime.js";
import { useEffect, useMemo, useRef, useState } from "react";
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
  {id:"image",type:"IMG",name:"KING 背景图",duration:"静态",durationSeconds:300,image:"/assets/green-geometry.png",src:"/assets/green-geometry.png"},
  {id:"text",type:"TXT",name:"KING CLUB",duration:"00:05",durationSeconds:5,image:"/assets/king-club-logo-white.svg",text:"KING CLUB"},
];

const TRACK_ICONS={markers:FilmSlate,audio:MusicNotes,v1:VideoCamera,v2:VideoCamera,image:ImageSquare,text:TextT,light:LightbulbFilament};
// Preserve unsaved work when navigating to another workspace in this app session.
const sessionDrafts=new Map();

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

function ClipVideo({src,seconds,playing,onDuration}) {
  const ref=useRef(null);
  useEffect(()=>{
    const video=ref.current;if(!video)return;
    const sync=()=>{
      video.muted=true;
      if(video.readyState>=1&&Math.abs(video.currentTime-seconds)>.2)video.currentTime=seconds;
      if(playing)video.play().catch(()=>{});else video.pause();
    };
    sync();video.addEventListener("loadedmetadata",sync);
    return()=>video.removeEventListener("loadedmetadata",sync);
  },[src,seconds,playing]);
  return <video ref={ref} src={src} muted playsInline preload="metadata" onLoadedMetadata={event=>onDuration?.(event.currentTarget.duration)}/>;
}

function TimelinePreview({project,assets,time,playing,onDuration}) {
  const entries=["v1","v2","image","text"].map(id=>{
    const current=clipAtTime(project.tracks.find(lane=>lane.id===id),time,project.durationSeconds);
    if(!current)return null;
    const asset=assets.find(item=>item.id===current.clip.assetId||current.clip.sourcePath&&item.path===current.clip.sourcePath);
    const seconds=clipSourceTime(current.clip,current.elapsed);
    return asset&&seconds!==null?{...current,asset,seconds,id}:null;
  }).filter(Boolean);
  return <div className="show-timeline-preview">{entries.length?entries.map(({clip,asset,seconds,id})=>
    <div className="show-preview-layer" key={id} style={{opacity:clip.opacity??1,transform:`scale(${clip.scale??1})`}}>
      {["v1","v2"].includes(id)?<ClipVideo src={asset.src} seconds={seconds} playing={playing} onDuration={value=>onDuration(id,clip.id,value)}/>
      :id==="text"?<strong>{asset.text||clip.name}</strong>:<img src={asset.src||asset.image} alt=""/>}
    </div>):<span className="show-preview-empty">当前片段未绑定素材 · 黑屏预览</span>}</div>;
}

function Monitor({kind,title,media,renderMedia,readClock,children}) {
  const videoRef=useRef(null);
  useEffect(()=>{
    if(!readClock)return;
    const sync=()=>{
      const clock=readClock();const video=videoRef.current;
      if(!clock||!video||video.readyState<1)return;
      if(Math.abs(video.currentTime-clock.seconds)>.25)video.currentTime=clock.seconds;
      if(clock.playing)video.play().catch(()=>{});else video.pause();
    };
    sync();const timer=window.setInterval(sync,200);return()=>window.clearInterval(timer);
  },[media?.id,readClock]);
  return <section className={`show-monitor show-monitor-${kind}`}>
    <header><span><b>{kind}</b> / {title}</span><em>{kind==="PGM"?"当前节目 · 静音监看":"本地编辑预览"}</em></header>
    <div className="show-monitor-canvas">{children??renderMedia?.(media,videoRef,kind)}</div>
    <footer><span><b>{media?.name||"黑屏"}</b><small>{kind==="PGM"?"跟随已确认节目":"仅预览，不上屏、不触发灯光"}</small></span></footer>
  </section>;
}

export function ShowEditorWorkspace({ track, deck1, deck2, playingDecks, cueDeck, crossfade, programMedia, previewMedia, videos=[], analysis=null, renderMedia, readProgramClock }) {
  const duration=Math.max(1,secondsFromDuration(track?.duration));
  const storageKey=showProjectStorageKey(track);
  const songKey=String(track?.path||track?.id||track?.title||"draft");
  const [assetQuery,setAssetQuery]=useState("");
  const [assetType,setAssetType]=useState("全部");
  const [selectedAsset,setSelectedAsset]=useState("main");
  const [project,setProject]=useState(()=>createDefaultShowProject(songKey,duration));
  const [selectedClip,setSelectedClip]=useState({trackId:"v1",clipId:"v1-clip-1"});
  const [timelinePlaying,setTimelinePlaying]=useState(false);
  const [saved,setSaved]=useState(true);
  const [dirty,setDirty]=useState(false);
  const [currentTime,setCurrentTime]=useState(0);
  const [previewTimeline,setPreviewTimeline]=useState(false);
  const [saveError,setSaveError]=useState("");
  const clockStartRef=useRef(0);
  const activeSongRef=useRef(songKey);
  const loadingProjectRef=useRef(null);
  useEffect(()=>{
    if(!timelinePlaying)return;
    const started=performance.now();const initial=clockStartRef.current;
    const timer=window.setInterval(()=>{
      const next=advancePreviewClock(initial,(performance.now()-started)/1000,duration);
      setCurrentTime(next.seconds);
      if(!next.playing)setTimelinePlaying(false);
    },50);
    return()=>window.clearInterval(timer);
  },[timelinePlaying,duration]);
  const seekPreview=seconds=>{setTimelinePlaying(false);setPreviewTimeline(true);setCurrentTime(Math.max(0,Math.min(duration,seconds)));};
  const togglePreview=()=>{setPreviewTimeline(true);clockStartRef.current=currentTime>=duration?0:currentTime;setTimelinePlaying(value=>!value);};
  const timeTicks=useMemo(()=>Array.from({length:8},(_,index)=>Math.round(duration*index/7)),[duration]);
  const waveform=useMemo(()=>Array.isArray(analysis?.peaks)?analysis.peaks.map(value=>value/100):[],[analysis]);
  const runtimeAssets=useMemo(()=>videos.map((item,index)=>({
    id:`runtime-${item.id??item.path}`,
    path:item.path,src:item.src,
    type:index?"V2":"V1",
    name:item.name||`本地视频 ${index+1}`,
    duration:item.duration||"本地",
    durationSeconds:item.durationSeconds||secondsFromDuration(item.duration)||30,
    image:item.thumbnailSrc||"/assets/king-club-logo-white.svg",
  })),[videos]);
  const assets=[...runtimeAssets,...SOURCE_ASSETS];
  const visibleAssets=assets.filter(item=>(assetType==="全部"||item.type===assetType)&&item.name.toLowerCase().includes(assetQuery.toLowerCase()));
  const selected=assets.find(item=>item.id===selectedAsset)??assets[0];
  const selectedEntry=findShowClip(project,selectedClip.trackId,selectedClip.clipId);
  const selectedProjectClip=selectedEntry?.clip??null;
  const deckOneStatus=playingDecks?.[1]?"播放中":deck1===null||deck1===undefined?"未装载":"已预载";
  const deckTwoStatus=cueDeck===2?"CUE 监听":playingDecks?.[2]?"播放中":deck2===null||deck2===undefined?"未装载":"已预载";
  const lightOwner=!playingDecks?.[1]&&!playingDecks?.[2]?"无播放":"Deck "+(playingDecks?.[2]&&(!playingDecks?.[1]||crossfade>=50)?2:1);
  useEffect(()=>{
    const draft=sessionDrafts.get(songKey);
    let next=draft?.project;let loaded=draft?.saved??false;
    setSaveError("");
    if(!next){
      try{const raw=JSON.parse(localStorage.getItem(storageKey)||"null");loaded=Boolean(raw);next=normalizeShowProject(raw,songKey,duration);}catch(error){setSaveError(`读取编排失败：${error.message}`);}
    }
    next=next||createDefaultShowProject(songKey,duration);
    activeSongRef.current=songKey;loadingProjectRef.current=next;
    setProject(next);setSaved(loaded);setDirty(draft?.dirty??false);setTimelinePlaying(false);setCurrentTime(0);setPreviewTimeline(false);
    const lane=next.tracks.find(item=>!item.locked&&item.id==="v1"&&item.clips.length);
    setSelectedClip(lane?{trackId:lane.id,clipId:lane.clips[0].id}:{trackId:"",clipId:""});
  },[songKey,duration,storageKey]);
  useEffect(()=>{
    if(loadingProjectRef.current&&project!==loadingProjectRef.current)return;
    loadingProjectRef.current=null;
    if(project.songKey===activeSongRef.current)sessionDrafts.set(project.songKey,{project,saved,dirty});
  },[project,saved,dirty]);
  useEffect(()=>{
    const warn=event=>{if(dirty){event.preventDefault();event.returnValue="";}};
    window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);
  },[dirty]);
  const applyProject=(next)=>{if(next===project)return;setProject(next);setSaved(false);setDirty(true);setSaveError("")};
  const selectClip=(trackId,clipId)=>setSelectedClip({trackId,clipId});
  const updateSelected=(patch)=>{
    if(!selectedProjectClip)return;
    applyProject(updateShowClip(project,selectedClip.trackId,selectedClip.clipId,patch));
  };
  const saveProject=()=>{
    const result=saveShowProject(localStorage,storageKey,project);
    setSaved(result.ok);setSaveError(result.error||"");
    if(result.ok){setProject(result.project);setDirty(false);}
  };
  const correctSourceDuration=(trackId,clipId,value)=>{
    const entry=findShowClip(project,trackId,clipId);
    if(entry&&Number.isFinite(value)&&value>0&&Math.abs((entry.clip.sourceDuration||0)-value)>.05){
      applyProject(updateShowClip(project,trackId,clipId,{sourceDuration:value}));
    }
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
      <div><FilmSlate weight="fill"/><span><b>演出编排</b><small>{saveError||`${track?.title||"请选择歌曲"} · ${track?.duration||"--:--"}`}</small></span></div>
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
        <button type="button" className="show-import" disabled title="请在首页素材目录中添加文件，扫描后在此选择"><Folders/>从素材库选择</button>
      </aside>

      <section className="show-monitor-bank">
        <div className="show-monitor-deckbar"><span className="deck-one"><b>DECK 1</b><em>{deckOneStatus}</em></span><span className="show-follow"><b>推杆值</b><strong>{100-crossfade} / {crossfade}</strong></span><span className="deck-two"><b>DECK 2</b><em>{deckTwoStatus}</em></span></div>
        <div className="show-monitor-grid"><Monitor kind="PVW" title={previewTimeline?"编排预览":"待播预览"} media={previewTimeline?{name:`编排 ${fmt(currentTime)}`}:previewMedia} renderMedia={renderMedia}>
          {previewTimeline?<TimelinePreview project={project} assets={assets} time={currentTime} playing={timelinePlaying} onDuration={correctSourceDuration}/>:undefined}
        </Monitor><Monitor kind="PGM" title="主屏" media={programMedia} renderMedia={renderMedia} readClock={readProgramClock}/></div>
        <div className="show-monitor-controls"><span><i className="status-dot"/>PGM 跟随已确认节目</span><span className="lighting-owner"><LightbulbFilament weight="fill"/><i>灯光主控</i><b>{lightOwner}</b><LockKey weight="fill"/></span><span>只预览 · 不触发现场</span></div>
      </section>

      <aside className="show-inspector">
        <div className="show-inspector-tabs"><button className="active">属性</button><button disabled title="效果编辑尚未接入">效果</button><button disabled title="灯光 Cue 执行尚未接入">灯光</button></div>
        <section><header><b>片段属性</b><small>{selectedProjectClip?.name||"请选择片段"}</small></header><div className="show-inspector-asset"><img src={selected?.image} alt=""/><span><b>{selectedProjectClip?.name||selected?.name}</b><small>{selectedEntry?.track?.label||"未选择片段"}</small></span>{selectedEntry&&!selectedEntry.track.locked&&<button type="button" className="show-delete-clip" onClick={deleteSelectedClip} title="从当前编排删除片段"><Trash/>删除</button>}</div></section>
        <section className="show-time-fields"><label><span>源入点（秒）</span><input aria-label="片段源入点秒数" type="number" min="0" max={Math.max(0,(selectedProjectClip?.sourceDuration||.1)-.1)} step="0.1" value={selectedProjectClip?.sourceIn??0} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({sourceIn:event.target.value})}/></label><label><span>源出点（秒）</span><input aria-label="片段源出点秒数" type="number" min="0.1" max={selectedProjectClip?.sourceDuration} step="0.1" value={selectedProjectClip?.sourceOut??0} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({sourceOut:event.target.value})}/></label><label><span>时间线（秒）</span><input aria-label="片段时间线时长秒数" type="number" min="0.1" max={duration} step="0.1" value={selectedProjectClip?.timelineDuration??0} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({timelineDuration:event.target.value})}/></label></section>
        <section className="show-loop-settings"><header><b>短视频填充方式</b><small>源时长与歌曲时长独立</small></header>{["循环到歌曲结束","循环到下一段","重复次数","尾帧保持","精确裁切"].map(mode=><label key={mode}><input type="radio" name="loop-mode" checked={selectedProjectClip?.loopMode===mode} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={()=>updateSelected({loopMode:mode})}/><span>{mode}</span>{mode==="重复次数"&&<input aria-label="片段重复次数" type="number" min="1" max="999" value={selectedProjectClip?.repeatCount??1} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({repeatCount:event.target.value})}/>}</label>)}</section>
        <section className="show-transform"><header><b>画面参数</b><SlidersHorizontal/></header><label><span>缩放</span><input type="range" min="25" max="200" value={(selectedProjectClip?.scale??1)*100} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({scale:Number(event.target.value)/100})}/></label><label><span>不透明度</span><input type="range" min="0" max="100" value={(selectedProjectClip?.opacity??1)*100} disabled={!selectedProjectClip||selectedEntry?.track.locked} onChange={event=>updateSelected({opacity:Number(event.target.value)/100})}/></label></section>
      </aside>
    </div>

    <div className="show-timeline-toolbar"><span><button type="button" disabled title="撤销尚未接入"><ArrowCounterClockwise/></button><button type="button" disabled title="重做尚未接入"><ArrowsClockwise/></button><button type="button" onClick={()=>seekPreview(0)} title="预览回到开头"><SkipBack/></button><button type="button" className="timeline-play" aria-label="播放或暂停编排预览" onClick={togglePreview}>{timelinePlaying?<Pause weight="fill"/>:<Play weight="fill"/>}</button><button type="button" onClick={()=>seekPreview(currentTime+5)} title="预览前进五秒"><SkipForward/></button><em>拖动片段排序；素材可直接拖入兼容轨道</em></span><strong>{fmt(currentTime)}<small> / {fmt(duration)}</small></strong><span><label>吸附<input type="checkbox" disabled title="吸附尚未接入"/></label><select defaultValue="1/4" disabled><option>1/4 拍</option><option>1/2 拍</option><option>1 拍</option></select><button type="button" onClick={()=>seekPreview(0)}>回到开头</button></span></div>
    <section className="show-timeline" style={{"--playhead":`${currentTime/duration}`}}>
      <div className="show-time-ruler"><span/><div className="show-time-ticks">{timeTicks.map((value,index)=><i key={index}>{fmt(value)}</i>)}</div></div>
      <div className="show-playhead" aria-hidden="true"><i/></div>
      {project.tracks.map((lane)=>{const LaneIcon=TRACK_ICONS[lane.id]??FilmSlate;return <div className={`show-lane lane-${lane.kind}`} key={lane.id}><header><LaneIcon weight={lane.locked?"fill":"regular"}/><span>{lane.label}</span>{lane.locked&&<LockKey weight="fill"/>}</header><div className="show-lane-clips" onDragOver={event=>{if(!lane.locked)event.preventDefault()}} onDrop={event=>acceptDrop(event,lane.id,lane.clips.length)}>{lane.kind==="wave"?<div className="show-waveform" title={track?.title}>{!waveform.length&&<small>尚无歌曲波形分析</small>}{waveform.map((height,index)=><i key={index} style={{height:Math.max(2,Math.min(42,Number(height)*42))}}/>)}</div>:lane.clips.map((clip,index)=><button type="button" draggable={!lane.locked} key={clip.id} className={selectedClip.trackId===lane.id&&selectedClip.clipId===clip.id?"active":""} onDragStart={event=>dragPayload(event,{kind:"clip",trackId:lane.id,clipId:clip.id})} onDragOver={event=>event.preventDefault()} onDrop={event=>acceptDrop(event,lane.id,index)} onClick={()=>selectClip(lane.id,clip.id)} title={`${clip.name} · ${clip.timelineDuration.toFixed(1)} 秒 · 拖动调整顺序`} style={{flex:`0 0 ${clip.timelineDuration/duration*100}%`}}><span>{clip.name}</span>{(lane.kind==="v1"||lane.kind==="v2")&&<ArrowsClockwise/>}</button>)}</div></div>})}
    </section>
    <footer className="show-editor-foot"><span>项目时长 <b>{fmt(duration)}</b></span><span>预览时钟 <b>{fmt(currentTime)}</b></span><span>Deck 2 <b>{deckTwoStatus}</b></span><span>编排执行 <b>仅本地预览，未连接现场</b></span></footer>
  </section>;
}
