export const SHOW_PROJECT_FORMAT="club.king.show-project";
export const SHOW_PROJECT_VERSION=1;

export const SHOW_TRACK_BLUEPRINTS=[
  {id:"markers",label:"标记 / 段落",kind:"marker",locked:false},
  {id:"audio",label:"歌曲（锁定）",kind:"wave",locked:true},
  {id:"v1",label:"V1 主视频",kind:"v1",locked:false},
  {id:"v2",label:"V2 叠加视频",kind:"v2",locked:false},
  {id:"image",label:"IMG 图片",kind:"image",locked:false},
  {id:"text",label:"TXT 文字",kind:"text",locked:false},
  {id:"light",label:"LGT 灯光 Cues",kind:"light",locked:false},
];

const DEFAULT_CLIPS={
  markers:["Intro","Drop 1","Verse 1","Drop 2","Breakdown","Drop 3","Outro"],
  audio:["歌曲波形"],
  v1:["Neon Stage","Neon Stage","Laser Tunnel","Neon Stage","Neon Stage"],
  v2:["Light Beam","Light Beam","Scan Line"],
  image:["King Backdrop"],
  text:["KING CLUB","NEON NIGHTS","FEEL THE BEAT"],
  light:["Intro Wash","Blue Strobe","Laser Sweep","Purple Effect","White Blast","Crowd Wash","Fade Out"],
};

const numberWithin=(value,min,max,fallback)=>{
  const number=Number(value);
  return Number.isFinite(number)?Math.min(max,Math.max(min,number)):fallback;
};

const defaultClipDuration=(trackId,index,projectDuration)=>{
  const count=Math.max(1,DEFAULT_CLIPS[trackId]?.length??1);
  if(trackId==="audio"||trackId==="image")return projectDuration;
  if(trackId==="v1")return Math.min(30,projectDuration/count);
  if(trackId==="v2")return Math.min(15,projectDuration/count);
  return projectDuration/count;
};

const createClip=(trackId,name,index,projectDuration)=>{
  const timelineDuration=defaultClipDuration(trackId,index,projectDuration);
  const sourceDuration=["v1","v2"].includes(trackId)?30:timelineDuration;
  return {
    id:`${trackId}-clip-${index+1}`,
    name,
    assetId:"",
    sourceDuration,
    sourceIn:0,
    sourceOut:sourceDuration,
    timelineDuration,
    loopMode:["v1","v2"].includes(trackId)?"循环到歌曲结束":"精确裁切",
    repeatCount:1,
  };
};

export const showProjectStorageKey=(song)=>{
  const identity=String(song?.path||song?.id||song?.title||"draft");
  let hash=2166136261;
  for(let index=0;index<identity.length;index+=1){hash^=identity.charCodeAt(index);hash=Math.imul(hash,16777619)}
  return `king.show-project.v1.${(hash>>>0).toString(16)}`;
};

export function createDefaultShowProject(songKey,durationSeconds=342){
  const duration=numberWithin(durationSeconds,1,24*60*60,342);
  return {
    format:SHOW_PROJECT_FORMAT,
    version:SHOW_PROJECT_VERSION,
    songKey:String(songKey||"draft"),
    durationSeconds:duration,
    nextClipId:100,
    updatedAt:0,
    tracks:SHOW_TRACK_BLUEPRINTS.map(track=>({
      ...track,
      clips:(DEFAULT_CLIPS[track.id]??[]).map((name,index)=>createClip(track.id,name,index,duration)),
    })),
  };
}

const normalizeClip=(clip,track,index,duration)=>{
  const fallback=createClip(track.id,String(clip?.name||`片段 ${index+1}`),index,duration);
  const sourceDuration=numberWithin(clip?.sourceDuration,.1,24*60*60,fallback.sourceDuration);
  const sourceIn=numberWithin(clip?.sourceIn,0,Math.max(0,sourceDuration-.1),0);
  const sourceOut=numberWithin(clip?.sourceOut,sourceIn+.1,sourceDuration,sourceDuration);
  return {
    ...fallback,
    ...clip,
    id:String(clip?.id||fallback.id),
    name:String(clip?.name||fallback.name),
    assetId:String(clip?.assetId||""),
    sourceDuration,
    sourceIn,
    sourceOut,
    timelineDuration:numberWithin(clip?.timelineDuration,.1,duration,fallback.timelineDuration),
    loopMode:String(clip?.loopMode||fallback.loopMode),
    repeatCount:Math.round(numberWithin(clip?.repeatCount,1,999,1)),
    opacity:numberWithin(clip?.opacity,0,1,1),
    scale:numberWithin(clip?.scale,.1,3,1),
  };
};

export function normalizeShowProject(raw,songKey,durationSeconds=342){
  const fallback=createDefaultShowProject(songKey,durationSeconds);
  if(!raw||raw.format!==SHOW_PROJECT_FORMAT||Number(raw.version)!==SHOW_PROJECT_VERSION)return fallback;
  const duration=numberWithin(durationSeconds||raw.durationSeconds,1,24*60*60,fallback.durationSeconds);
  const tracksById=new Map(Array.isArray(raw.tracks)?raw.tracks.map(track=>[track.id,track]):[]);
  return {
    ...fallback,
    songKey:String(songKey||raw.songKey||"draft"),
    durationSeconds:duration,
    nextClipId:Math.max(100,Math.floor(Number(raw.nextClipId)||100)),
    updatedAt:Number(raw.updatedAt)||0,
    tracks:SHOW_TRACK_BLUEPRINTS.map(track=>{
      const saved=tracksById.get(track.id);
      const clips=Array.isArray(saved?.clips)?saved.clips:fallback.tracks.find(item=>item.id===track.id).clips;
      return {...track,clips:clips.map((clip,index)=>normalizeClip(clip,track,index,duration))};
    }),
  };
}

export const findShowClip=(project,trackId,clipId)=>{
  const track=project?.tracks?.find(item=>item.id===trackId);
  const clip=track?.clips?.find(item=>item.id===clipId);
  return track&&clip?{track,clip}:null;
};

export function updateShowClip(project,trackId,clipId,patch){
  const duration=project.durationSeconds;
  if(project.tracks.find(track=>track.id===trackId)?.locked)return project;
  return {
    ...project,
    tracks:project.tracks.map(track=>track.id!==trackId?track:{
      ...track,
      clips:track.clips.map((clip,index)=>clip.id!==clipId?clip:normalizeClip({...clip,...patch},track,index,duration)),
    }),
  };
}

export const showTracksCompatible=(sourceTrackId,targetTrackId)=>{
  if(sourceTrackId===targetTrackId)return true;
  return ["v1","v2"].includes(sourceTrackId)&&["v1","v2"].includes(targetTrackId);
};

export function moveShowClip(project,sourceTrackId,targetTrackId,clipId,targetIndex){
  if(!showTracksCompatible(sourceTrackId,targetTrackId))return project;
  const source=project.tracks.find(track=>track.id===sourceTrackId);
  const target=project.tracks.find(track=>track.id===targetTrackId);
  const clip=source?.clips.find(item=>item.id===clipId);
  if(!source||!target||!clip||source.locked||target.locked)return project;
  const tracks=project.tracks.map(track=>({...track,clips:[...track.clips]}));
  const mutableSource=tracks.find(track=>track.id===sourceTrackId);
  const mutableTarget=tracks.find(track=>track.id===targetTrackId);
  const sourceIndex=mutableSource.clips.findIndex(item=>item.id===clipId);
  mutableSource.clips.splice(sourceIndex,1);
  let index=Math.max(0,Math.min(Number(targetIndex)||0,mutableTarget.clips.length));
  if(sourceTrackId===targetTrackId&&sourceIndex<index)index-=1;
  mutableTarget.clips.splice(index,0,clip);
  return {...project,tracks};
}

const trackAcceptsAsset=(trackId,type)=>{
  if(["v1","v2"].includes(trackId))return ["V1","V2","VIDEO"].includes(type);
  if(trackId==="image")return type==="IMG";
  if(trackId==="text")return type==="TXT";
  if(trackId==="light")return type==="LGT";
  return false;
};

export function addAssetToShowTrack(project,trackId,asset,targetIndex=Number.MAX_SAFE_INTEGER){
  const track=project.tracks.find(item=>item.id===trackId);
  if(!track||track.locked||!trackAcceptsAsset(trackId,String(asset?.type||"").toUpperCase()))return project;
  const sequence=project.nextClipId;
  const sourceDuration=numberWithin(asset?.durationSeconds,.1,24*60*60,30);
  const clip=normalizeClip({
    id:`show-clip-${sequence}`,
    name:String(asset?.name||`素材 ${sequence}`),
    assetId:String(asset?.id||""),
    sourcePath:String(asset?.path||""),
    sourceDuration,
    sourceIn:0,
    sourceOut:sourceDuration,
    timelineDuration:sourceDuration,
    loopMode:["v1","v2"].includes(trackId)?"循环到歌曲结束":"精确裁切",
    repeatCount:1,
  },track,track.clips.length,project.durationSeconds);
  const index=Math.max(0,Math.min(Number(targetIndex)||0,track.clips.length));
  return {
    ...project,
    nextClipId:sequence+1,
    tracks:project.tracks.map(item=>item.id!==trackId?item:{...item,clips:[...item.clips.slice(0,index),clip,...item.clips.slice(index)]}),
  };
}

export function removeShowClip(project,trackId,clipId){
  const track=project.tracks.find(item=>item.id===trackId);
  if(!track||track.locked)return project;
  return {...project,tracks:project.tracks.map(item=>item.id!==trackId?item:{...item,clips:item.clips.filter(clip=>clip.id!==clipId)})};
}
