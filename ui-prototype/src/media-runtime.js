export const parseDuration = (duration) => {
  if (typeof duration === "number") return Math.max(0,duration);
  const parts = String(duration ?? "0").split(":").map(Number);
  if (parts.some((value)=>!Number.isFinite(value))) return 0;
  return parts.reduce((total,value)=>total*60+value,0);
};

export const formatDuration = (seconds) => {
  const safeSeconds = Math.max(0,Math.floor(Number(seconds)||0));
  const hours = Math.floor(safeSeconds/3600);
  const minutes = Math.floor((safeSeconds%3600)/60);
  const remainder = safeSeconds%60;
  return hours
    ? `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(remainder).padStart(2,"0")}`
    : `${String(minutes).padStart(2,"0")}:${String(remainder).padStart(2,"0")}`;
};

export const isPlayableVideoSource = (source) => typeof source === "string" && /\.(mp4|m4v|mov|webm)(?:$|[?#])/i.test(source);

export const mediaAssetFingerprint = (items) => items.map((item)=>[
  item.path,
  item.modifiedUnixMs,
  item.sizeBytes,
  item.durationMs,
  item.title,
  item.artist,
  item.album,
  item.lyricsPath,
  item.lyricsModifiedUnixMs,
  item.vocalsPath,
  item.accompanimentPath,
  item.thumbnailPath,
].join(":")).join("|");

export const describeReadyStemProgress = (accompanimentAvailable, job) => {
  if (!accompanimentAvailable) return null;
  const status = String(job?.status ?? "");
  const stage = String(job?.stage ?? "");
  if (status === "ready") {
    return { label:"全部制作完成", actionLabel:"已完成" };
  }
  if (status === "running") {
    const detail = stage === "analyzing-reference"
      ? "补音参考制作中"
      : ["transcribing", "reusing-lyrics", "publishing"].includes(stage)
        ? "歌词分析中"
        : stage === "restoring-moss"
          ? "补音服务恢复中"
          : "后续分析中";
    return { label:`伴奏已就绪 · ${detail}`, actionLabel:"伴奏可用" };
  }
  if (status === "paused") {
    return { label:"伴奏已就绪 · 后续制作暂停", actionLabel:"伴奏可用" };
  }
  if (status === "failed") {
    return { label:"伴奏已就绪 · 后续分析失败", actionLabel:null };
  }
  if (status === "queued") {
    return { label:"伴奏已就绪 · 等待后续分析", actionLabel:null };
  }
  return { label:"伴奏已就绪", actionLabel:"伴奏可用" };
};

export const equalPowerGains = (crossfade) => {
  const position = Math.min(1,Math.max(0,Number(crossfade)||0)/100)*Math.PI/2;
  return { deck1:Math.cos(position), deck2:Math.sin(position) };
};

// Source switching must not silently alter the Deck level. Per-track loudness
// normalization belongs to imported asset metadata, not to a persistent mode.
export const ACCOMPANIMENT_GAIN_DB = 0;

export const resetDeckVocalModeForTrackChange = (modes, deckNumber) => {
  if (!modes || modes[deckNumber] === "original") return modes;
  return { ...modes, [deckNumber]:"original" };
};

export const deckOutputVolumePercent = (deckGain,masterVolume,vocalMode="original") => {
  const safeDeckGain = Math.min(1,Math.max(0,Number(deckGain)||0));
  const safeMasterVolume = Math.min(100,Math.max(0,Number(masterVolume)||0));
  const vocalGain = vocalMode === "accompaniment"
    ? 10 ** (ACCOMPANIMENT_GAIN_DB / 20)
    : 1;
  return Math.min(100,safeDeckGain*safeMasterVolume*vocalGain);
};

export const deckOutputVolumeScalar = (deckGain,masterVolume,vocalMode="original") => (
  deckOutputVolumePercent(deckGain,masterVolume,vocalMode)/100
);

export const getNextPlayableTrack = (trackCount,currentIndex,excludedIndex,shuffle=false,random=Math.random) => {
  const count = Math.max(0,Number(trackCount)||0);
  const candidates = Array.from({length:count},(_,index)=>index)
    .filter((index)=>index!==excludedIndex&&(!shuffle||index!==currentIndex));
  if (!candidates.length) return null;
  if (shuffle) return candidates[Math.floor(random()*candidates.length)];
  for (let offset=1;offset<=count;offset+=1) {
    const nextIndex=(currentIndex+offset)%count;
    if (nextIndex!==excludedIndex) return nextIndex;
  }
  return null;
};

export const getAdjacentPlayableTrack = (trackCount,currentIndex,excludedIndex,direction=1) => {
  const count = Math.max(0,Number(trackCount)||0);
  if (!count) return null;
  const step = direction < 0 ? -1 : 1;
  const start = Number.isInteger(currentIndex) ? currentIndex : (step > 0 ? -1 : 0);
  for (let offset=1;offset<=count;offset+=1) {
    const candidate=(start+step*offset+count*2)%count;
    if (candidate!==excludedIndex) return candidate;
  }
  return null;
};

const normalizedPlaybackQueue = (queue) => [...new Set((Array.isArray(queue) ? queue : [])
  .filter((index) => Number.isInteger(index) && index >= 0))];

export const resolvePlaybackChainForDeck = ({
  deckNumber,
  currentIndex,
  queueSources,
  queueIndexes,
}) => {
  const otherDeck=deckNumber===1?2:1;
  for(const ownerDeck of [deckNumber,otherDeck]){
    const source=queueSources?.[ownerDeck]??null;
    const queue=normalizedPlaybackQueue(queueIndexes?.[ownerDeck]);
    if(source&&queue.includes(currentIndex))return {ownerDeck,source,queue};
  }
  return {ownerDeck:null,source:null,queue:[]};
};

export const getNextPlayableTrackInQueue = (queue,currentIndex,excludedIndex,shuffle=false,random=Math.random) => {
  const ordered=normalizedPlaybackQueue(queue);
  const candidates=ordered.filter((index)=>index!==currentIndex&&index!==excludedIndex);
  if(!candidates.length)return null;
  if(shuffle)return candidates[Math.floor(random()*candidates.length)];
  const currentPosition=ordered.indexOf(currentIndex);
  const start=currentPosition>=0?currentPosition:-1;
  for(let offset=1;offset<=ordered.length;offset+=1){
    const candidate=ordered[(start+offset)%ordered.length];
    if(candidate!==currentIndex&&candidate!==excludedIndex)return candidate;
  }
  return null;
};

export const getAdjacentPlayableTrackInQueue = (queue,currentIndex,excludedIndex,direction=1) => {
  const ordered=normalizedPlaybackQueue(queue);
  if(!ordered.length)return null;
  const step=direction<0?-1:1;
  const currentPosition=ordered.indexOf(currentIndex);
  const start=currentPosition>=0?currentPosition:(step>0?-1:0);
  for(let offset=1;offset<=ordered.length;offset+=1){
    const candidatePosition=(start+step*offset+ordered.length*2)%ordered.length;
    const candidate=ordered[candidatePosition];
    if(candidate!==currentIndex&&candidate!==excludedIndex)return candidate;
  }
  return null;
};

export const AUTO_DJ_PRELOAD_SECONDS = 15;
export const AUTO_DJ_CROSSFADE_SECONDS = 6;

export const planDeckOperatorArbitration = ({
  mode,
  targetDeck,
  targetPlaying=false,
  cueDeck=null,
}) => {
  if(!["sequence","shuffle"].includes(mode))return {automationAllowed:false,eofAction:"mode-owned",reason:"playback-mode"};
  if(cueDeck===targetDeck)return {automationAllowed:false,eofAction:"continue-source",reason:"cue-occupied"};
  if(targetPlaying)return {automationAllowed:false,eofAction:"continue-source",reason:"operator-independent-playback"};
  return {automationAllowed:true,eofAction:"continue-source",reason:"automatic"};
};

export const planDeckAutoTransition = ({
  queue,
  currentIndex,
  mode,
  remainingSeconds,
  preparedTargetIndex=null,
  otherDeckPlaying=false,
  random=Math.random,
}) => {
  if(otherDeckPlaying||!["sequence","shuffle"].includes(mode))return {action:"none",nextIndex:null};
  const remaining=Number(remainingSeconds);
  if(!Number.isFinite(remaining)||remaining<0)return {action:"none",nextIndex:null};
  const nextIndex=getNextPlayableTrackInQueue(queue,currentIndex,-1,mode==="shuffle",random);
  if(nextIndex===null)return {action:"none",nextIndex:null};
  if(preparedTargetIndex===nextIndex){
    return {action:remaining<=AUTO_DJ_CROSSFADE_SECONDS?"crossfade":"wait",nextIndex};
  }
  return {action:remaining<=AUTO_DJ_PRELOAD_SECONDS?"preload":"wait",nextIndex};
};
