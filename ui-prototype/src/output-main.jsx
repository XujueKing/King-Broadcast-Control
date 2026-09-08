import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { MediaOutputScreen } from "./App.jsx";
import { applyPreferredLyricsFont, registerCustomFonts } from "./font-runtime.js";
import "./styles.css";

const safeProgram = {
  media: { id:"safe-black", type:"image", name:"安全黑屏", src:null, background:"#000000" },
  transform: { x:0, y:0, scaleX:1, scaleY:1, fit:"cover", mode:"uniform" },
  lyrics: null,
};

function OutputApp() {
  const [program,setProgram]=React.useState(safeProgram);

  React.useEffect(()=>{
    let disposed=false;
    let unlisten=()=>{};
    invoke("get_program_state")
      .then((state)=>{if(!disposed&&state?.media)setProgram(state)})
      .catch(()=>{});
    listen("program-state",(event)=>{
      if(!disposed&&event.payload?.media)setProgram(event.payload);
    }).then((stop)=>{if(disposed)stop();else unlisten=stop});
    return ()=>{disposed=true;unlisten()};
  },[]);

  React.useEffect(()=>{
    const refresh=()=>invoke("font_library")
      .then(async (library)=>{await registerCustomFonts(library?.customFonts);applyPreferredLyricsFont(library)})
      .catch((error)=>console.error("LED 输出字体加载失败",error));
    refresh();
    const timer=window.setInterval(refresh,5000);
    return ()=>window.clearInterval(timer);
  },[]);

  return <main className="output-window-root" aria-label="KING CLUB LED 节目输出">
    <MediaOutputScreen media={program.media} lyrics={program.lyrics} transform={program.transform} playback={program.playback} onVideoEnded={(ended)=>emitTo("main","program-video-ended",ended).catch(error=>console.error("视频顺播通知失败",error))} allowAudio/>
  </main>;
}

createRoot(document.getElementById("root")).render(<OutputApp/>);
