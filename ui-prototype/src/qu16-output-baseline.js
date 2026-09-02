export const KINGCLUB_QU16_OUTPUT_BASELINE_ID = "kingclub-2026-08-26-st3-lr";
export const KINGCLUB_QU16_OUTPUT_BASELINE_LABEL = "8/26 主输出基准";

// The 2026-08-26 close-of-day hardware note identifies ST3 as the primary
// KINGCLUB computer USB return. Qu MIDI protocol page 13 defines raw 0x62 as
// the fader's physical 0 dB position. Keep this list deliberately narrow: no
// microphone input, preamp/48V, processing, DCA, mute-group or fallback
// CH11/CH12 state is inferred or changed here.
const baselineWrites = Object.freeze([
  Object.freeze({key:"pafl:st-3",value:0}),
  Object.freeze({key:"fader:st-3",value:0x62}),
  Object.freeze({key:"fader:lr-master",value:0x62}),
  Object.freeze({key:"assign:st-3:LR",value:1}),
  Object.freeze({key:"mute:st-3",value:0}),
  Object.freeze({key:"mute:lr-master",value:0}),
]);

export function kingClubQu16OutputBaselineWrites() {
  return baselineWrites.map((write)=>({...write}));
}

export function kingClubQu16OutputBaselineDifferences(snapshot) {
  const parameters=snapshot?.parameters;
  if(!parameters||typeof parameters!=="object")return kingClubQu16OutputBaselineWrites();
  return baselineWrites
    .filter((write)=>Number(parameters[write.key])!==write.value||Boolean(snapshot.pendingDetails?.[write.key]))
    .map((write)=>({...write,actual:parameters[write.key]??null}));
}
