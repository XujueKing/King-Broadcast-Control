export const rhythmRuleOptions = [
  ["off", "关闭"],
  ["beat", "每拍"],
  ["beat-2", "每 2 拍"],
  ["beat-4", "每 4 拍"],
  ["beat-8", "每 8 拍"],
  ["downbeat", "强拍"],
  ["bar", "小节"],
];

export const selectDominantDeck = (playingDecks, crossfade) => {
  const deckOnePlaying = Boolean(playingDecks?.[1]);
  const deckTwoPlaying = Boolean(playingDecks?.[2]);
  if (deckOnePlaying && !deckTwoPlaying) return 1;
  if (deckTwoPlaying && !deckOnePlaying) return 2;
  if (!deckOnePlaying && !deckTwoPlaying) return null;
  return Number(crossfade) < 50 ? 1 : 2;
};
export const rhythmEventMatchesRule = (rule, event) => {
  if (!event || rule === "off") return false;
  if (rule === "bar") return Boolean(event.isBar || event.type === "bar");
  if (rule === "downbeat") return Boolean(event.isDownbeat || event.type === "downbeat" || event.type === "bar");
  const beatIndex = Number(event.beatIndex);
  if (!Number.isInteger(beatIndex) || beatIndex < 0) return false;
  if (rule === "beat") return true;
  const interval = Number(rule.match(/^beat-(2|4|8)$/)?.[1]);
  return Number.isInteger(interval) && beatIndex % interval === 0;
};

export const nextConfiguredId = (configuredIds, currentId) => {
  const ids = [...new Set((configuredIds ?? []).filter((id) => id !== null && id !== undefined))];
  if (!ids.length) return null;
  const currentIndex = ids.indexOf(currentId);
  return ids[(currentIndex + 1 + ids.length) % ids.length];
};
