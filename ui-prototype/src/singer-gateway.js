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
export function useSingerGateway({desktopRuntime,tracks,getSnapshot,execute}) {
  const current=useRef({getSnapshot,execute});
  current.current={getSnapshot,execute};
  useEffect(()=>{
    if(!desktopRuntime)return;
    invoke("singer_gateway_catalog",{songs:singerCatalog(tracks)})
      .catch(error=>console.error("主唱曲库发布失败",error));
  },[desktopRuntime,tracks]);
  useEffect(()=>{
    if(!desktopRuntime)return;
    let disposed=false,timer;
    const poll=async()=>{
      let enabled=false;
      try {
        const response=await invoke("singer_gateway_exchange",{snapshot:current.current.getSnapshot()});
        enabled=response.enabled;
        if(response.work){
          const work=response.work;
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
      if(!disposed)timer=window.setTimeout(poll,enabled?200:1000);
    };
    void poll();
    return()=>{disposed=true;window.clearTimeout(timer)};
  },[desktopRuntime]);
}
