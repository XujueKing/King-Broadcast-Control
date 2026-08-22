const markerKey = (seconds) => Math.round(Number(seconds) * 1000);

const lowerBound = (values, target) => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (Number(values[middle]) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
};
/**
 * Returns every rhythm marker crossed by the real player clock.
 * Large jumps are treated as seek operations and intentionally emit nothing.
 */
export const collectRhythmEvents = (analysis, previousSeconds, currentSeconds, options = {}) => {
  const beats = Array.isArray(analysis?.beats) ? analysis.beats : [];
  const previous = Number(previousSeconds);
  const current = Number(currentSeconds);
  const maxCatchupSeconds = Number(options.maxCatchupSeconds ?? 0.8);
  if (!beats.length || !Number.isFinite(previous) || !Number.isFinite(current)) return [];
  if (current <= previous || current - previous > maxCatchupSeconds) return [];

  const downbeats = new Set((analysis.downbeats ?? []).map(markerKey));
  const bars = new Set((analysis.bars ?? []).map(markerKey));
  const startIndex = lowerBound(beats, previous);
  const events = [];
  for (let index = startIndex; index < beats.length; index += 1) {
    const atSeconds = Number(beats[index]);
    if (!Number.isFinite(atSeconds) || atSeconds > current) break;
    const key = markerKey(atSeconds);
    const isBar = bars.has(key);
    const isDownbeat = isBar || downbeats.has(key);
    events.push({
      type:isBar ? "bar" : isDownbeat ? "downbeat" : "beat",
      beatIndex:index,
      atSeconds,
      isDownbeat,
      isBar,
    });
  }
  return events;
};
