const markerKey = (seconds) => Math.round(Number(seconds) * 1000);

// Beat detectors often report a slow song at double-time. When confidence is
// weak, prefer the musically useful half-time pulse instead of driving venue
// lighting at twice the perceived tempo. Explicit operator corrections carry
// confidence 1 and are never altered here.
export const effectiveRhythmBpm = (analysis) => {
  const bpm = Number(analysis?.bpm);
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) return 0;
  const confidence = Number(analysis?.bpmConfidence ?? analysis?.confidence);
  return bpm >= 145 && Number.isFinite(confidence) && confidence < 0.55
    ? bpm / 2
    : bpm;
};

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
  const bpm = effectiveRhythmBpm(analysis);
  if (beats.length < 4 || !Number.isFinite(bpm) || bpm < 30 || bpm > 300) return false;
  const expectedInterval = 60 / bpm;
  const duration = Number(analysis?.durationSeconds);
  const lastBeat = Number(beats[beats.length - 1]);
  // Long mixes are analysed from a bounded high-resolution window to avoid
  // multi-gigabyte allocations. Extend their stable BPM grid across the full
  // playback duration instead of going dark after the analysed window.
  if (Number.isFinite(duration) && Number.isFinite(lastBeat) && duration > lastBeat + expectedInterval * 2) return true;
  const sampleCount = Math.min(beats.length - 1, 96);
  let irregular = 0;
  for (let index = 1; index <= sampleCount; index += 1) {
    const interval = Number(beats[index]) - Number(beats[index - 1]);
    if (!Number.isFinite(interval) || Math.abs(interval - expectedInterval) > expectedInterval * 0.28) irregular += 1;
  }
  return irregular / sampleCount > 0.18;
};

const collectRegularGridEvents = (analysis, previous, current) => {
  const bpm = effectiveRhythmBpm(analysis);
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

/**
 * Samples the already-cached waveform around one musical marker. Peaks are
 * normalized to 0-100 by the desktop analyser, so this is a cheap local energy
 * estimate and never opens a second audio device or playback stream.
 */
export const rhythmEnergyAt = (analysis, atSeconds) => {
  const peaks = Array.isArray(analysis?.peaks) ? analysis.peaks : [];
  const duration = Number(analysis?.durationSeconds);
  const seconds = Number(atSeconds);
  if (!peaks.length || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(seconds)) return 0;
  const center = Math.round(Math.min(1, Math.max(0, seconds / duration)) * (peaks.length - 1));
  const radius = Math.max(1, Math.round(peaks.length / 900));
  let total = 0;
  let count = 0;
  for (let index = Math.max(0, center - radius); index <= Math.min(peaks.length - 1, center + radius); index += 1) {
    const value = Number(peaks[index]);
    if (!Number.isFinite(value)) continue;
    total += Math.min(100, Math.max(0, value));
    count += 1;
  }
  return count ? Number((total / count / 100).toFixed(3)) : 0;
};
