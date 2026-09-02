export const kingclubBeamProfile = Object.freeze({
  showName:"2024.12.28",
  groupTitanId:15735,
  fixtureTitanIds:Object.freeze([
    3511,3512,3513,3514,3515,3516,3517,3518,3519,3520,
    3521,3522,3523,3524,3525,3526,3527,3528,3529,3530,
    3703,3704,3705,3706,15676,
  ]),
  baseDimmerPercent:25,
  shadowDimmerPercent:20,
  beatDimmerPercent:50,
  barDimmerPercent:70,
});

export const beamPulseForRhythm = (event, profile = kingclubBeamProfile) => {
  const beatIndex = Math.max(0, Math.floor(Number(event?.beatIndex) || 0));
  const isBar = Boolean(event?.isBar || event?.type === "bar");
  if (isBar) return {look:"beam-bar",dimmerPercent:profile.barDimmerPercent};
  if (beatIndex % 2 === 1) return {look:"beam-shadow",dimmerPercent:profile.shadowDimmerPercent};
  return {look:"beam-beat",dimmerPercent:profile.beatDimmerPercent};
};
