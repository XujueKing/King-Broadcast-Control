import { deckOutputVolumePercent, equalPowerGains } from "./media-runtime.js";

export const QU16_DECK_CUE_TARGET = "st-3";
export const DECK_CUE_RECOVERY_STORAGE_KEY = "king.deckCue.recovery.v1";

export function normalizeDeckCueRecovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const {deck,mainFader} = value;
  if (![1,2].includes(deck) || typeof mainFader !== "number" || !Number.isFinite(mainFader)) return null;
  return { deck, mainFader:Math.min(1,Math.max(0,mainFader)) };
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

export function qu16DeckCueWrites(enabled, mainFaderValue = null) {
  if (!enabled) {
    if (!Number.isFinite(mainFaderValue)) throw new Error("关闭 CUE 前必须提供原主扩推子值");
    return [
      { key:`pafl:${QU16_DECK_CUE_TARGET}`, value:0 },
      { key:`fader:${QU16_DECK_CUE_TARGET}`, value:Math.min(1,Math.max(0,mainFaderValue)) },
    ];
  }
  return [
    // CUE routes the complete Deck mix, whatever it currently contains. ST3
    // leaves LR before PAFL opens; disabling CUE restores the captured LR level.
    { key:`fader:${QU16_DECK_CUE_TARGET}`, value:0 },
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
