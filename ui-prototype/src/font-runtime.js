import { convertFileSrc } from "@tauri-apps/api/core";

const loadedFontKeys = new Set();
const PREFERRED_LYRICS_FONT = "汉仪清雅体简";

const isPreferredLyricsFont = (font) => {
  const filename=String(font?.filename??"")
    .replace(/\.(?:ttf|otf|ttc|otc|woff2?)$/i,"");
  return filename.startsWith(PREFERRED_LYRICS_FONT)&&!filename.includes("预览子集");
};

export const registerCustomFonts = async (fonts) => {
  if (typeof FontFace==="undefined"||!document?.fonts) return [];
  const loaded=[];
  await Promise.all((Array.isArray(fonts)?fonts:[]).map(async (font)=>{
    const families=[font.family,...(isPreferredLyricsFont(font)?[PREFERRED_LYRICS_FONT]:[])];
    await Promise.all([...new Set(families)].map(async (family)=>{
      const key=`${family}|${font.path}`;
      if(loadedFontKeys.has(key)){
        loaded.push(family);
        return;
      }
      try{
        const face=new FontFace(family,`url("${convertFileSrc(font.path)}")`);
        await face.load();
        document.fonts.add(face);
        loadedFontKeys.add(key);
        loaded.push(family);
      }catch(error){
        console.error(`自定义字体加载失败：${font.filename??font.path}`,error);
      }
    }));
  }));
  return loaded;
};

export const applyPreferredLyricsFont = (library) => {
  const enabled=(library?.customFonts??[]).some(isPreferredLyricsFont);
  const root=document.documentElement;
  if(enabled){
    root.style.setProperty("--king-lyrics-font-family",`"${PREFERRED_LYRICS_FONT}", "Microsoft YaHei", sans-serif`);
    root.style.setProperty("--king-lyrics-font-weight","400");
  }else{
    root.style.removeProperty("--king-lyrics-font-family");
    root.style.removeProperty("--king-lyrics-font-weight");
  }
  return enabled;
};

export const mergeFontFamilies = (library, fallback=[]) => {
  const values=[
    ...(library?.customFonts??[]).map((font)=>font.family),
    ...(library?.systemFamilies??[]),
    ...fallback,
  ];
  return values.filter((family,index)=>family&&values.findIndex((item)=>item?.toLowerCase()===family.toLowerCase())===index);
};
