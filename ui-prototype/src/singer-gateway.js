import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseLrc } from "./lyrics-runtime.js";
import { parseDuration } from "./media-runtime.js";

export function singerCatalog(tracks) {
  return tracks.filter(track=>track.path&&!track.demo).map(track=>({
    key:track.path, title:track.title, artist:track.artist,
    durationSeconds:parseDuration(track.duration), accompanimentAvailable:Boolean(track.accompanimentPath),
    lyrics:parseLrc(track.lyrics),
  }));
}

// This bridge stays mounted on every desktop page. Only this bridge can claim
// LAN commands; the output WebView and tablet never create another player.
export function singerPlaylists(libraries,tracks) {
  const available=new Set(tracks.filter(t=>t.path&&!t.demo).map(t=>t.path));
  return Object.entries(libraries.libraries).flatMap(([library,management])=>management.playlists.map(p=>({
    key:`${library}:${p.id}`,name:p.name,kind:p.kind,library:Number(library),songKeys:p.trackPaths.filter(path=>available.has(path)),
  })));
}
export function useSingerGateway({desktopRuntime,tracks,playlistLibraries,getSnapshot,execute,onConfiguration}) {
  const current=useRef({getSnapshot,execute,onConfiguration});
  current.current={getSnapshot,execute,onConfiguration};
  useEffect(()=>{
    if(!desktopRuntime)return;
    invoke("singer_gateway_catalog",{songs:singerCatalog(tracks),playlists:singerPlaylists(playlistLibraries,tracks)})
      .catch(error=>console.error("主唱曲库发布失败",error));
  },[desktopRuntime,tracks,playlistLibraries]);
  useEffect(()=>{
    if(!desktopRuntime)return;
    let disposed=false,timer,audioActiveUntil=0;
    const poll=async()=>{
      let enabled=false;
      try {
        const response=await invoke("singer_gateway_exchange",{snapshot:current.current.getSnapshot()});
        enabled=response.enabled;
        current.current.onConfiguration?.(response);
        if(response.work){
          const work=response.work;
          if(work.command.operation.type==="audio_level")audioActiveUntil=Date.now()+2000;
          void (async()=>{
            let error=null;
            try {
              if(disposed)throw new Error("controller_reloaded");
              await current.current.execute(work);
            }catch(cause){error=String(cause);console.error("主唱操作未完成",cause)}
            await invoke("singer_gateway_complete",{id:work.command.id,error,snapshot:current.current.getSnapshot()});
          })().catch(error=>console.error("主唱操作回执未送达，请检查中控",error));
        }
      }catch(error){console.error("主唱局域网桥接失败",error)}
      if(!disposed)timer=window.setTimeout(poll,enabled?(Date.now()<audioActiveUntil?40:200):1000);
    };
    void poll();
    return()=>{disposed=true;window.clearTimeout(timer)};
  },[desktopRuntime]);
}
