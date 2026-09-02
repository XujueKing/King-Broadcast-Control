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

const gridNeedsRegularizing = (analysis) => {
  const beats = Array.isArray(analysis?.beats) ? analysis.beats : [];
  const bpm = Number(analysis?.bpm);
  if (beats.length < 4 || !Number.isFinite(bpm) || bpm < 30 || bpm > 300) return false;
  const expectedInterval = 60 / bpm;
  const sampleCount = Math.min(beats.length - 1, 96);
  let irregular = 0;
  for (let index = 1; index <= sampleCount; index += 1) {
    const interval = Number(beats[index]) - Number(beats[index - 1]);
    if (!Number.isFinite(interval) || Math.abs(interval - expectedInterval) > expectedInterval * 0.28) irregular += 1;
  }
  return irregular / sampleCount > 0.18;
};

const collectRegularGridEvents = (analysis, previous, current) => {
  const bpm = Number(analysis.bpm);
  const interval = 60 / bpm;
  const anchor = Number(analysis.downbeats?.[0] ?? analysis.beats?.[0] ?? 0);
  if (!Number.isFinite(anchor) || !Number.isFinite(interval) || interval <= 0) return [];
  const firstIndex = Math.max(0, Math.floor((previous - anchor) / interval) + 1);
  const lastIndex = Math.floor((current - anchor) / interval);
  const events = [];
  for (let beatIndex = firstIndex; beatIndex <= lastIndex; beatIndex += 1) {
    const atSeconds = anchor + beatIndex * interval;
    const isBar = beatIndex % 4 === 0;
    events.push({
      type:isBar ? "bar" : "beat",
      beatIndex,
      atSeconds,
      isDownbeat:isBar,
      isBar,
      regularized:true,
    });
  }
  return events;
};
/**
 * Returns every rhythm marker crossed by the player clock. Unreliable detector
 * grids fall back to the analysed BPM, and a small look-ahead can compensate
 * for the command latency between this runtime and Titan.
 */
export const collectRhythmEvents = (analysis, previousSeconds, currentSeconds, options = {}) => {
  const beats = Array.isArray(analysis?.beats) ? analysis.beats : [];
  const lookAheadSeconds = Math.max(0, Math.min(0.3, Number(options.lookAheadSeconds) || 0));
  const previous = Number(previousSeconds) + lookAheadSeconds;
  const current = Number(currentSeconds) + lookAheadSeconds;
  const maxCatchupSeconds = Number(options.maxCatchupSeconds ?? 0.8);
  if (!beats.length || !Number.isFinite(previous) || !Number.isFinite(current)) return [];
  if (current <= previous || current - previous > maxCatchupSeconds) return [];

  if (gridNeedsRegularizing(analysis)) return collectRegularGridEvents(analysis, previous, current);

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
