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
  const beatMs = Number.isFinite(bpm) && bpm > 0 ? 60_000 / bpm : 500;
  const strong = Boolean(
    event?.isBar ||
    event?.isDownbeat ||
    event?.type === "bar" ||
    event?.type === "downbeat",
  );
  return {
    // A live Titan update takes roughly one tenth of a second on the venue
    // console.  The previous 1.5%-2.5% pulse often returned to the 10% base
    // level before the ceiling wash was perceptible.  Keep the ambience dark
    // and within the backend's 15% safety ceiling, but give each beat enough
    // contrast and dwell time to remain visible in the room.
    peakDimmerPercent: strong ? 15 : 13.5,
    baseDimmerPercent: profile.baseDimmerPercent,
    releaseAfterMs: Math.round(clamp(beatMs * 0.45, 140, 220)),
    speedValue: gatlingSpeedForBpm(bpm, profile),
  };
};
