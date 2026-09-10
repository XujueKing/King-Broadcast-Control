// Small, testable command coordinator. Operations delegate to the same desktop
// controls as local buttons, and await their actual player acknowledgements.
export async function executeSingerOperation(work, context) {
  const {deck,command,songKey}=work;
  const operation=command.operation;
  if(![1,2].includes(deck)||!context.ready())throw new Error("player_unavailable");
  if(context.cueActive())throw new Error("cue_active");
  const type=operation.type;
  if(!["select","next","play","pause","restart","vocal_mode","audio_level","acappella","pitch","playlist_select","temporary_select","auto_return_next","atmosphere"].includes(type))throw new Error("unsupported_operation");
  if(type==='atmosphere'){
    if(!['applause','cheer','scream','stop'].includes(operation.effect)||!Number.isInteger(operation.volume)||operation.volume<0||operation.volume>60)throw Error('invalid_effect');
    return context.atmosphere(operation.effect,operation.volume);
  }
  if(type==='auto_return_next'){
    if(typeof operation.enabled!=='boolean')throw Error('invalid_auto_return');
    return context.setAutoReturnNext(operation.enabled);
  }
  if(type==="playlist_select"||type==="temporary_select") {
    const index=context.findTrack(songKey);
    if(index<0)throw new Error("song_not_found");
    return context.selectFromLibrary(deck,index,work.playlistKey,type==="temporary_select");
  }
  if(type==="select"||type==="next") {
    const index=context.findTrack(songKey);
    if(index<0)throw new Error("song_not_found");
    await context.select(deck,index);
    return;
  }
  if(context.transitionBusy()||context.otherPlaying(deck))throw new Error("desktop_mix_active");
  if(type==="audio_level"||type==="acappella")return context.audio(deck,operation);
  if(!context.hasTrack(deck))throw new Error("no_song_selected");
  if(type==="pitch") {
    if(!Number.isInteger(operation.semitones)||Math.abs(operation.semitones)>6)throw new Error('invalid_pitch');
    return context.setPitch(deck,operation.semitones);
  }
  if(type==="pause")return context.setPaused(deck,true);
  if(type==="play")return context.setPaused(deck,false);
  if(type==="restart")return context.restart(deck);
  if(!["original","accompaniment"].includes(operation.mode))throw new Error("invalid_vocal_mode");
  if(operation.mode==="accompaniment"&&!context.hasAccompaniment(deck))throw new Error("accompaniment_unavailable");
  return context.setVocalMode(deck,operation.mode);
}
