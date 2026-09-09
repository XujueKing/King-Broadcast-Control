// Small, testable command coordinator. Operations delegate to the same desktop
// controls as local buttons, and await their actual player acknowledgements.
export async function executeSingerOperation(work, context) {
  const {deck,command,songKey}=work;
  const operation=command.operation;
  if(![1,2].includes(deck)||!context.ready())throw new Error("player_unavailable");
  if(context.cueActive())throw new Error("cue_active");
  const type=operation.type;
  if(!["select","next","play","pause","restart","vocal_mode"].includes(type))throw new Error("unsupported_operation");
  if(type==="select"||type==="next") {
    const index=context.findTrack(songKey);
    if(index<0)throw new Error("song_not_found");
    await context.select(deck,index);
    return;
  }
  if(context.transitionBusy()||context.otherPlaying(deck))throw new Error("desktop_mix_active");
  if(!context.hasTrack(deck))throw new Error("no_song_selected");
  if(type==="pause")return context.setPaused(deck,true);
  if(type==="play")return context.setPaused(deck,false);
  if(type==="restart")return context.restart(deck);
  if(!["original","accompaniment"].includes(operation.mode))throw new Error("invalid_vocal_mode");
  if(operation.mode==="accompaniment"&&!context.hasAccompaniment(deck))throw new Error("accompaniment_unavailable");
  return context.setVocalMode(deck,operation.mode);
}
