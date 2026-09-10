// One temporary song may replace another; the original bookmark is kept.
// EOF is claimed once, and explicit local selection invalidates the bookmark.
export class SingerInterlude {
  constructor(){this.entries={};this.revisions={1:0,2:0};}
  begin(deck,original,temporarySongKey){
    const previous=this.entries[deck];
    this.entries[deck]={original:previous?.original??original,temporarySongKey,restoring:false};
  }
  cancel(deck){delete this.entries[deck];}
  claim(deck,songKey){
    const entry=this.entries[deck];
    if(!entry||entry.restoring||entry.temporarySongKey!==songKey)return null;
    entry.restoring=true;return entry;
  }
  complete(deck,entry){
    if(this.entries[deck]!==entry)return false;
    delete this.entries[deck];this.revisions[deck]++;return true;
  }
}
export const singerPlaylistKey=source=>source?.kind==='playlist'?`${source.libraryKey}:${source.playlistId}`:null;
export function singerCompletionBookmark({enabled,deck,singerDeck,mode,songKey,source,seconds,vocalMode,pitch}) {
  if(!enabled||deck!==singerDeck||mode!=='single'||!songKey||!singerPlaylistKey(source))return null;
  return {songKey,source,seconds,vocalMode,pitch};
}
export function singerReturnPlan(original,libraries,tracks,autoNext){
  const originalIndex=tracks.findIndex(t=>t.path===original.songKey);
  if(originalIndex<0)throw Error('return_song_unavailable');
  if(!autoNext)return {index:originalIndex,seconds:original.seconds,autoplay:false,vocalMode:original.vocalMode,pitch:original.pitch};
  const source=original.source;
  const playlist=source?.kind==='playlist'?libraries.libraries[source.libraryKey]?.playlists.find(p=>p.id===source.playlistId):null;
  if(!playlist)throw Error('return_playlist_unavailable');
  const position=playlist.trackPaths.indexOf(original.songKey);
  if(position<0)throw Error('return_song_not_in_playlist');
  for(const path of playlist.trackPaths.slice(position+1)){
    const index=tracks.findIndex(t=>t.path===path&&!t.demo);
    if(index>=0)return {index,seconds:0,autoplay:true,vocalMode:'original',pitch:0};
  }
  return {index:originalIndex,seconds:original.seconds,autoplay:false,vocalMode:original.vocalMode,pitch:original.pitch};
}
export function singerPlaylistSource(libraries,key,songKey){
  for(const [libraryKey,management] of Object.entries(libraries.libraries)){
    const playlist=management.playlists.find(p=>`${libraryKey}:${p.id}`===key);
    if(playlist){
      if(!playlist.trackPaths.includes(songKey))throw Error('song_not_in_playlist');
      return {kind:'playlist',libraryKey,playlistId:playlist.id};
    }
  }
  throw Error('playlist_not_found');
}
