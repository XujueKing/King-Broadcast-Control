export const kingclubGatlingProfile = Object.freeze({
  showName: "2024.12.28",
  groupTitanId: 17790,
  fixtureTitanId: 17636,
  baseDimmerPercent: 4,
  baseSpeedValue: 0.361,
  palettes: Object.freeze({
    neutral: 33207,
    red: 33207,
    // Only Colour 71 (red) and Colour 73 (blue) are physically verified for
    // Fixture 42. Colour 72 turned the Gatling completely off onsite, so
    // unverified video families are folded into a safe warm/cool pair.
    orange: 33207,
    yellow: 33207,
    green: 33219,
    cyan: 33219,
    blue: 33219,
    purple: 33219,
  }),
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export const createLatestOnlyAsyncQueue = () => {
  let running = false;
  let pending = null;

  const drain = async () => {
    if (running || !pending) return;
    const job = pending;
    pending = null;
    running = true;
    try {
      job.resolve(await job.task());
    } catch (error) {
      job.reject(error);
    } finally {
      running = false;
      if (pending) queueMicrotask(drain);
    }
  };

  return {
    push(task) {
      return new Promise((resolve, reject) => {
        if (pending) pending.resolve(false);
        pending = { task, resolve, reject };
        void drain();
      });
    },
    cancelPending() {
      if (pending) pending.resolve(false);
      pending = null;
    },
    isRunning: () => running,
  };
};

export const gatlingPaletteForVideoFamily = (
  family,
  profile = kingclubGatlingProfile,
) => profile.palettes[String(family || "neutral")] ?? profile.palettes.neutral;

// Fixture 42 exposes a normalized Speed control. The现场-confirmed quiet look
// reads 92/255, or 0.361. The runtime may use the fixture's full normalized
// range; the musical grid, rather than an arbitrary dark-scene ceiling, limits
// how frequently Titan receives changes.
export const gatlingSpeedForBpm = (bpm, profile = kingclubGatlingProfile) => {
  const numeric = Number(bpm);
  if (!Number.isFinite(numeric) || numeric < 30 || numeric > 300)
    return profile.baseSpeedValue;
  const bounded = clamp(numeric, 70, 180);
  return Number(
    clamp(
      profile.baseSpeedValue + (bounded - 128) * 0.0021,
      0,
      1,
    ).toFixed(3),
  );
};

export const gatlingPulseForRhythm = (
  event,
  profile = kingclubGatlingProfile,
) => {
  const bpm = Number(event?.bpm);
  const beatIndex = Math.max(0, Math.floor(Number(event?.beatIndex) || 0));
  const isBar = Boolean(event?.isBar || event?.type === "bar");
  const baseSpeed = gatlingSpeedForBpm(bpm, profile);
  const energy = clamp(Number(event?.energy) || 0.5, 0, 1);

  if (Number.isFinite(bpm) && bpm <= 100) {
    const logicalBar = isBar || beatIndex % 4 === 0;
    const slowSpeed = clamp(0.12 + (clamp(bpm, 60, 100) - 60) * 0.002, 0.12, 0.2);
    const peak = logicalBar
      ? 7 + energy * 4
      : beatIndex % 2 === 0
        ? 5 + energy * 2
        : 4 + energy;
    return {
      skip:false,
      look:logicalBar ? "gentle-bloom" : beatIndex % 2 === 0 ? "gentle-breathe" : "soft-sparkle",
      baseDimmerPercent:profile.baseDimmerPercent,
      peakDimmerPercent:Number(clamp(peak, 4, 12).toFixed(1)),
      speedValue:Number(clamp(slowSpeed + (logicalBar ? 0.02 : beatIndex % 2 === 0 ? 0.01 : 0), 0, 1).toFixed(3)),
    };
  }

  // Alternate high/low energy every beat so the pulse is physically visible.
  // Titan still receives at most one update per musical marker; there is no
  // free-running or random strobe loop outside the analysed beat grid.
  if (!isBar && beatIndex % 2 === 1) {
    return {
      skip:false,
      look:"beat-shadow",
      baseDimmerPercent:profile.baseDimmerPercent,
      peakDimmerPercent:2,
      speedValue:Number(clamp(baseSpeed * 0.64, 0, 1).toFixed(3)),
    };
  }

  if (isBar) {
    const alternateBar = Math.floor(beatIndex / 4) % 2 === 1;
    return alternateBar
      ? {
          skip:false,
          look:"meteor",
          baseDimmerPercent:profile.baseDimmerPercent,
          peakDimmerPercent:24,
          speedValue:Number(clamp(baseSpeed + 0.34, 0, 1).toFixed(3)),
        }
      : {
          skip:false,
          look:"light-speed",
          baseDimmerPercent:profile.baseDimmerPercent,
          peakDimmerPercent:30,
          speedValue:Number(clamp(baseSpeed + 0.62, 0, 1).toFixed(3)),
        };
  }

  return {
    skip:false,
    look:"stars",
    baseDimmerPercent:profile.baseDimmerPercent,
    peakDimmerPercent:14,
    speedValue:Number(clamp(baseSpeed + 0.12, 0, 1).toFixed(3)),
  };
};
