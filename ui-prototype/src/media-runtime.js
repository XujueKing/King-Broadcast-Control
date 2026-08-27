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

export const equalPowerGains = (crossfade) => {
  const position = Math.min(1,Math.max(0,Number(crossfade)||0)/100)*Math.PI/2;
  return { deck1:Math.cos(position), deck2:Math.sin(position) };
};

export const ACCOMPANIMENT_GAIN_DB = 4;

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
