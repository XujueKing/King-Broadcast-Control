export const kingclubBeamProfile = Object.freeze({
  showName:"2024.12.28",
  groupTitanId:15735,
  fixtureTitanIds:Object.freeze([
    3511,3512,3513,3514,3515,3516,3517,3518,3519,3520,
    3521,3522,3523,3524,3525,3526,3527,3528,3529,3530,
    3703,3704,3705,3706,15676,
  ]),
  baseDimmerPercent:0,
  showEnergyThreshold:0.5,
  slowShowEnergyThreshold:0.2,
  minimumTrackBeat:8,
  showLengthBeats:6,
  showCooldownBeats:64,
  slowShowLengthBeats:6,
  slowShowCooldownBeats:32,
  fixedPanValue:0.5,
  fixedTiltValue:0.5,
});

const holdCue = () => ({
  skip:true,
  look:"beam-hold",
  bpm:null,
  beats:null,
  rows:null,
});

export const createBeamShowController = (profile = kingclubBeamProfile) => {
  let trackKey = null;
  let lastShowBeat = Number.NEGATIVE_INFINITY;

  const reset = () => {
    trackKey = null;
    lastShowBeat = Number.NEGATIVE_INFINITY;
  };

  const next = (event) => {
    const nextTrackKey = String(event?.trackId || event?.trackPath || "unknown");
    const beatIndex = Math.max(0, Math.floor(Number(event?.beatIndex) || 0));
    const isBar = Boolean(event?.isBar || event?.type === "bar");
    const energy = Math.min(1, Math.max(0, Number(event?.energy) || 0));
    const rawBpm = Number(event?.bpm);
    const bpm = Number.isFinite(rawBpm) && rawBpm >= 60 && rawBpm <= 200 ? rawBpm : 128;
    const slowSong = bpm <= 100;
    const energyThreshold = slowSong ? profile.slowShowEnergyThreshold : profile.showEnergyThreshold;
    const cooldownBeats = slowSong ? profile.slowShowCooldownBeats : profile.showCooldownBeats;
    if (nextTrackKey !== trackKey) {
      trackKey = nextTrackKey;
      lastShowBeat = Number.NEGATIVE_INFINITY;
    }

    const cooledDown = beatIndex - lastShowBeat >= cooldownBeats;
    if (
      !isBar
      || beatIndex < profile.minimumTrackBeat
      || energy < energyThreshold
      || !cooledDown
    ) return holdCue();

    lastShowBeat = beatIndex;
    return {
      skip:false,
      look:slowSong ? "beam-gentle-south-north" : "beam-walk-south-north",
      bpm,
      beats:slowSong ? profile.slowShowLengthBeats : profile.showLengthBeats,
      rows:6,
    };
  };

  return {next,reset};
};
