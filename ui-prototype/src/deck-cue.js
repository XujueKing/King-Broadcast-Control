import { deckOutputVolumePercent, equalPowerGains } from "./media-runtime.js";

export const QU16_DECK_CUE_TARGET = "st-3";
export const DECK_CUE_RECOVERY_STORAGE_KEY = "king.deckCue.recovery.v1";
export const QU16_DECK_CUE_LR_ASSIGN_KEY = `assign:${QU16_DECK_CUE_TARGET}:LR`;

export function normalizeDeckCueRecovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const {deck,mainAssigned} = value;
  if (![1,2].includes(deck) || ![0,1].includes(mainAssigned)) return null;
  return { deck, mainAssigned };
}

export function loadDeckCueRecovery(storage = null) {
  try {
    const target = storage ?? globalThis.localStorage;
    return normalizeDeckCueRecovery(JSON.parse(target.getItem(DECK_CUE_RECOVERY_STORAGE_KEY)));
  } catch {
    return null;
  }
}

export function persistDeckCueRecovery(recovery, storage = null) {
  const normalized = normalizeDeckCueRecovery(recovery);
  if (!normalized) return false;
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(DECK_CUE_RECOVERY_STORAGE_KEY,JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function clearDeckCueRecovery(storage = null) {
  try {
    const target = storage ?? globalThis.localStorage;
    target.removeItem(DECK_CUE_RECOVERY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function qu16DeckCueWrites(enabled, mainAssignedValue = null) {
  if (!enabled) {
    if (![0,1].includes(mainAssignedValue)) throw new Error("关闭 CUE 前必须提供原 LR Assign 真值");
    return [
      { key:`pafl:${QU16_DECK_CUE_TARGET}`, value:0 },
      { key:QU16_DECK_CUE_LR_ASSIGN_KEY, value:mainAssignedValue },
    ];
  }
  return [
    // Route the complete ST3 Deck mix away from LR and into PAFL without ever
    // changing the venue's calibrated ST3 or LR fader levels.
    { key:QU16_DECK_CUE_LR_ASSIGN_KEY, value:0 },
    { key:`pafl:${QU16_DECK_CUE_TARGET}`, value:1 },
  ];
}

export function qu16WritesConfirmed(snapshot,writes) {
  if(!snapshot?.connected||!snapshot?.synced||!Array.isArray(writes)||writes.length===0)return false;
  return writes.every((write)=>
    Number(snapshot.parameters?.[write.key])===Number(write.value)
      && !snapshot.pendingDetails?.[write.key],
  );
}

export function deckCueMix(crossfade, masterVolume, headphoneVolume, cueDeck) {
  if (cueDeck === 1 || cueDeck === 2) {
    const cueVolume = Math.min(100,Math.max(0,Number(headphoneVolume)||0));
    return {
      deck1Gain:cueDeck === 1 ? 1 : 0,
      deck2Gain:cueDeck === 2 ? 1 : 0,
      outputVolume:cueVolume,
    };
  }
  const { deck1,deck2 } = equalPowerGains(crossfade);
  return {
    deck1Gain:deck1,
    deck2Gain:deck2,
    outputVolume:Math.min(100,Math.max(0,Number(masterVolume)||0)),
  };
}

export function deckRescuePreviewPlans({
  crossfade,
  masterVolume,
  headphoneVolume,
  cueDeck,
  playingDecks,
  vocalModes,
  rescueEnabled,
  referenceStatus,
  physicalAudioStarted,
}) {
  const mix = deckCueMix(crossfade,masterVolume,headphoneVolume,cueDeck);
  return [1,2].map((deck)=>{
    const status=referenceStatus?.[deck];
    const enabled=!physicalAudioStarted
      && vocalModes?.[deck]==="accompaniment"
      && Boolean(rescueEnabled?.[deck])
      && Boolean(status?.ready)
      && Boolean(status?.referenceVocalPath);
    const deckGain=deck===1?mix.deck1Gain:mix.deck2Gain;
    return {
      deck,
      path:status?.referenceVocalPath||".",
      enabled,
      playing:enabled&&Boolean(playingDecks?.[deck]),
      volume:enabled
        ? deckOutputVolumePercent(deckGain,mix.outputVolume,"accompaniment")
        : 0,
    };
  });
}
