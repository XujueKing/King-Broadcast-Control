export const kingclubGatlingProfile = Object.freeze({
  showName: "2024.12.28",
  groupTitanId: 17790,
  fixtureTitanId: 17636,
  baseDimmerPercent: 10,
  baseSpeedValue: 0.361,
  palettes: Object.freeze({
    neutral: 33207,
    red: 33207,
    orange: 33227,
    yellow: 33227,
    green: 33214,
    cyan: 33240,
    blue: 33219,
    purple: 33234,
  }),
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

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

  // Alternate high/low energy every beat so the pulse is physically visible.
  // Titan still receives at most one update per musical marker; there is no
  // free-running or random strobe loop outside the analysed beat grid.
  if (!isBar && beatIndex % 2 === 1) {
    return {
      skip:false,
      look:"beat-shadow",
      baseDimmerPercent:profile.baseDimmerPercent,
      peakDimmerPercent:3,
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
          peakDimmerPercent:72,
          speedValue:Number(clamp(baseSpeed + 0.34, 0, 1).toFixed(3)),
        }
      : {
          skip:false,
          look:"light-speed",
          baseDimmerPercent:profile.baseDimmerPercent,
          peakDimmerPercent:100,
          speedValue:Number(clamp(baseSpeed + 0.62, 0, 1).toFixed(3)),
        };
  }

  return {
    skip:false,
    look:"stars",
    baseDimmerPercent:profile.baseDimmerPercent,
    peakDimmerPercent:42,
    speedValue:Number(clamp(baseSpeed + 0.12, 0, 1).toFixed(3)),
  };
};
