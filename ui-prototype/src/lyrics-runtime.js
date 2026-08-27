const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

const fractionToSeconds = (value = "") => {
  if (!value) return 0;
  return Number(value) / (10 ** value.length);
};

const estimatedLyricDuration = (text) => {
  const normalized=String(text??"").replace(/\s+/g," ").trim();
  const vocalCharacters=[...normalized.replace(/[^\p{L}\p{N}]/gu,"")].length;
  const wordCount=normalized ? normalized.split(/\s+/).length : 0;
  const hasCjk=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalized);
  const estimated=hasCjk
    ? 1.2+vocalCharacters*.38
    : 1.4+Math.max(wordCount,vocalCharacters/5)*.42;
  return Math.max(2.2,Math.min(7.2,estimated));
};

const splitLongLyric = (text, maxCharacters = 28) => {
  const chunks=[];
  let current="";
  for(const character of String(text).replace(/\s+/g," ").trim()){
    current+=character;
    if((/[，。！？；：,.!?;:]/.test(character)&&current.trim().length>=6)||current.length>=maxCharacters){
      chunks.push(current.trim());
      current="";
    }
  }
  if(current.trim()) chunks.push(current.trim());
  return chunks;
};

const expandCoarseLines = (lines) => lines.flatMap((line,index)=>{
  const next=lines[index+1];
  const duration=next ? next.atSeconds-line.atSeconds : 0;
  const compactLength=line.text.replace(/\s+/g,"").length;
  if(compactLength<=28||duration<=0) return [line];
  const chunks=splitLongLyric(line.text);
  if(chunks.length<2) return [line];
  const weights=chunks.map((chunk)=>Math.max(1,chunk.replace(/\s+/g,"").length));
  const total=weights.reduce((sum,value)=>sum+value,0);
  let elapsed=0;
  return chunks.map((chunk,chunkIndex)=>{
    const atSeconds=line.atSeconds+duration*elapsed/total;
    elapsed+=weights[chunkIndex];
    return {atSeconds,text:chunk};
  });
});

export const parseLrc = (source) => {
  const text = String(source ?? "").replace(/^\uFEFF/, "");
  let offsetSeconds = 0;
  const offsetMatch = text.match(/\[offset:([+-]?\d+)\]/i);
  if (offsetMatch) offsetSeconds = Number(offsetMatch[1]) / 1000;

  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(TIME_TAG)];
    if (!timestamps.length) continue;
    const content = rawLine.replace(TIME_TAG, "").trim();
    if (!content) continue;
    for (const match of timestamps) {
      const atSeconds = Number(match[1]) * 60 + Number(match[2]) + fractionToSeconds(match[3]) + offsetSeconds;
      if (Number.isFinite(atSeconds)) lines.push({ atSeconds:Math.max(0,atSeconds), text:content });
    }
  }

  lines.sort((left,right)=>left.atSeconds-right.atSeconds);
  const unique=lines.filter((line,index)=>index===0||line.atSeconds!==lines[index-1].atSeconds||line.text!==lines[index-1].text);
  return expandCoarseLines(unique);
};

export const lyricAtTime = (lines, seconds) => {
  if (!Array.isArray(lines) || !lines.length) return null;
  const time = Math.max(0,Number(seconds)||0);
  let low = 0;
  let high = lines.length - 1;
  let index = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].atSeconds <= time) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (index < 0) return null;
  const current=lines[index];
  const next=lines[index+1] ?? null;
  const naturalEnd=current.atSeconds+estimatedLyricDuration(current.text);
  const endSeconds=next&&next.atSeconds<=naturalEnd+1.5 ? next.atSeconds : naturalEnd;
  return { index, current, next, endSeconds, visible:time<endSeconds };
};

export const selectLyricsDeck = ({ playingDecks, enabledDecks, availableDecks, crossfade }) => {
  const canShow = (deck)=>Boolean(enabledDecks?.[deck]&&availableDecks?.[deck]);
  const playing = [1,2].filter((deck)=>playingDecks?.[deck]);
  if (playing.length) {
    const active = playing.length===1 ? playing[0] : (Number(crossfade)>50 ? 2 : 1);
    return canShow(active) ? active : null;
  }
  const available = [1,2].filter(canShow);
  if (!available.length) return null;
  if (available.length===1) return available[0];
  return Number(crossfade)>50 ? 2 : 1;
};
