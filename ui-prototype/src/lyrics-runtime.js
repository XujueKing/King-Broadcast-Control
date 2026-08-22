const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

const fractionToSeconds = (value = "") => {
  if (!value) return 0;
  return Number(value) / (10 ** value.length);
};

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
  return lines.filter((line,index)=>index===0||line.atSeconds!==lines[index-1].atSeconds||line.text!==lines[index-1].text);
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
  return { index, current:lines[index], next:lines[index+1] ?? null };
};

export const selectLyricsDeck = ({ playingDecks, enabledDecks, availableDecks, crossfade }) => {
  const available = [1,2].filter((deck)=>enabledDecks?.[deck]&&availableDecks?.[deck]);
  if (!available.length) return null;
  const playing = available.filter((deck)=>playingDecks?.[deck]);
  const candidates = playing.length ? playing : available;
  if (candidates.length === 1) return candidates[0];
  return Number(crossfade) > 50 ? 2 : 1;
};
