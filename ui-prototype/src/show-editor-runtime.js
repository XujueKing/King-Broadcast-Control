export function saveShowProject(storage,key,project,now=Date.now()) {
  const stored={...project,updatedAt:now};
  try { storage.setItem(key,JSON.stringify(stored));return {ok:true,project:stored,error:null}; }
  catch(error){return {ok:false,project,error:`保存失败：${error?.message||String(error)}。编排仍未保存。`};}
}

export function clipAtTime(lane,time,duration) {
  let start=0;
  for(const clip of lane?.clips??[]) {
    const end=Math.min(duration,start+clip.timelineDuration);
    if(time>=start&&time<end)return {clip,start,elapsed:time-start};
    start=end;
  }
  return null;
}

export function clipSourceTime(clip,elapsed) {
  const length=clip.sourceOut-clip.sourceIn;
  if(!(length>0))return null;
  if(clip.loopMode==="精确裁切"&&elapsed>=length)return null;
  if(clip.loopMode==="重复次数"&&elapsed>=length*clip.repeatCount)return null;
  if(clip.loopMode==="尾帧保持")return clip.sourceIn+Math.min(elapsed,Math.max(0,length-.04));
  return clip.sourceIn+elapsed%length;
}

export function advancePreviewClock(start,elapsed,duration) {
  const seconds=Math.min(Math.max(0,start+elapsed),Math.max(0,duration));
  return {seconds,playing:seconds<duration};
}

export function readProgramClockSnapshot(snapshot,playback,now=performance.now()) {
  if(!snapshot||snapshot.mediaId!==playback?.mediaId||snapshot.token!==playback?.token)return null;
  const age=now-snapshot.receivedAt;
  if(age<0||age>1500||!Number.isFinite(snapshot.seconds)||snapshot.seconds<0)return null;
  return {seconds:snapshot.seconds+(snapshot.playing?age/1000:0),playing:snapshot.playing===true};
}
