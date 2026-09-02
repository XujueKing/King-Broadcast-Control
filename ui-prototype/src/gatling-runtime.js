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
// reads 92/255, or 0.361. Keep music tracking in a deliberately narrow band so
// an unusually high BPM cannot turn the ceiling ambience into a strobe look.
export const gatlingSpeedForBpm = (bpm, profile = kingclubGatlingProfile) => {
  const numeric = Number(bpm);
  if (!Number.isFinite(numeric) || numeric < 30 || numeric > 300)
    return profile.baseSpeedValue;
  const bounded = clamp(numeric, 70, 180);
  return Number(
    clamp(
      profile.baseSpeedValue + (bounded - 128) * 0.0021,
      0.22,
      0.47,
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

  // Do not use the ceiling fixture as a one-shot strobe.  The fixture's own
  // animation keeps moving between updates; KING changes its speed/energy on
  // the musical grid to form longer looks.  Ordinary beats are deliberately
  // reduced to half-rate commands so Titan's programmer queue remains ahead
  // of the music and video-colour commands are not starved.
  if (!isBar && beatIndex % 2 === 1) {
    return {
      skip:true,
      look:"hold",
      baseDimmerPercent:profile.baseDimmerPercent,
      peakDimmerPercent:profile.baseDimmerPercent,
      speedValue:baseSpeed,
    };
  }

  if (isBar) {
    const alternateBar = Math.floor(beatIndex / 4) % 2 === 1;
    return alternateBar
      ? {
          skip:false,
          look:"meteor",
          baseDimmerPercent:profile.baseDimmerPercent,
          peakDimmerPercent:13.2,
          speedValue:Number(clamp(baseSpeed + 0.035, 0.22, 0.47).toFixed(3)),
        }
      : {
          skip:false,
          look:"light-speed",
          baseDimmerPercent:profile.baseDimmerPercent,
          peakDimmerPercent:15,
          speedValue:Number(clamp(baseSpeed + 0.09, 0.22, 0.47).toFixed(3)),
        };
  }

  return {
    skip:false,
    look:"stars",
    baseDimmerPercent:profile.baseDimmerPercent,
    peakDimmerPercent:beatIndex % 4 === 0 ? 11.6 : 10.8,
    speedValue:Number(clamp(baseSpeed - 0.1, 0.22, 0.47).toFixed(3)),
  };
};
