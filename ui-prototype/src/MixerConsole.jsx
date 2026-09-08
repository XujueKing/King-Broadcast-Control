import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Headphones, SlidersHorizontal, Usb } from "@phosphor-icons/react";
import {
  QU16_MASTER_TARGETS,
  decodeQu16ParameterSnapshot,
  midiToUiValue,
  qu16IntentToWrite,
  qu16MasterTargetId,
  uiToMidiValue,
} from "./qu16-control.js";
import { qu16SurfaceInputSources, qu16SurfaceLayerDefinitions } from "./qu16-surface-map.js";
import qu16Brandbar from "./assets/hardware/allen-heath-qu16/qu16-brandbar-clean.png";
import { getQu16MeterSnapshot, subscribeQu16MeterSnapshot } from "./qu16-meter-store.js";

const levelSeed = [62, 48, 72, 55, 66, 44, 58, 70, 51, 64, 46, 60, 57, 68, 42, 54];
const peqBands = ["LF", "LM", "HM", "HF"];
const geqFrequencies = ["31.5", "40", "50", "63", "80", "100", "125", "160", "200", "250", "315", "400", "500", "630", "800", "1k", "1.25k", "1.6k", "2k", "2.5k", "3.15k", "4k", "5k", "6.3k", "8k", "10k", "12.5k", "16k"];
const mainMeterScale = ["Pk", "+12", "+6", "0", "-3", "-6", "-9", "-12", "-16", "-20", "-30", "-40"];
const mainMeterThresholdsDbfs = [-3, -6, -12, -18, -21, -24, -27, -30, -34, -38, -48, -58];
export const qu16MeterThresholdsDbfs = Object.freeze({ peak:-3, nominal:-18, signal:-48 });
const disconnectedMeter = Object.freeze({ levelDbfs:-120, peakDbfs:-120, leftDbfs:-120, rightDbfs:-120 });

function formatLiveParameterChange(key,value){
  const [kind,target,mix]=key.split(":");
  const targetLabel=target.startsWith("ch-")?`CH${target.slice(3)}`:target.replaceAll("-"," ").toUpperCase();
  if(kind==="fader"||kind==="send")return `${targetLabel} ${kind==="send"?mix:"Fader"} ${midiToUiValue(value)}% · LIVE`;
  return `${targetLabel} ${kind.toUpperCase()} ${value?"ON":"OFF"} · LIVE`;
}
const surfaceLayerDefinitions=qu16SurfaceLayerDefinitions;
const qu16MixSelectGroups=[
  {id:"fx",targets:["FX 1","FX 2"]},
  {id:"mono",targets:["Mix 1","Mix 2","Mix 3","Mix 4"]},
  {id:"stereo",targets:["Mix 5-6","Mix 7-8","Mix 9-10"]},
];
const allInputSources=qu16SurfaceInputSources;
const channelFaderMarks=[
  {label:"10",position:0},{label:"5",position:10},{label:"0",position:20},{label:"5",position:30},
  {label:"10",position:40},{label:"20",position:55},{label:"30",position:70},{label:"40",position:85},{label:"∞",position:100}
];
const geqFaderMarks=[
  {label:"12",position:0},{label:"6",position:25},{label:"0",position:50},{label:"6",position:75},{label:"12",position:100}
];
const screenBlockDefinitions = {
  PREAMP:{
    defaultParameter:"gain",
    defaults:{ gain:54, source:0, hpf:42, hpfIn:true, delay:8, polarity:0 },
    parameters:[
      { key:"gain", label:"Gain", format:"preampGain", meta:"Gain" },
      { key:"source", label:"Source", format:"source", meta:"Source" },
      { key:"hpf", label:"HPF", format:"hpfFrequency", meta:"HPF" },
      { key:"delay", label:"Delay", format:"delay", meta:"Delay" },
      { key:"polarity", label:"Polarity", format:"polarity", meta:"Polarity" }
    ]
  },
  GATE:{
    defaultParameter:"threshold",
    defaults:{ threshold:58, attack:24, hold:34, release:48, depth:76, in:false },
    parameters:[
      { key:"threshold", label:"Threshold", format:"gateThreshold", meta:"Thresh" },
      { key:"attack", label:"Attack", format:"gateAttack", meta:"Attack" },
      { key:"hold", label:"Hold", format:"gateHold", meta:"Hold" },
      { key:"release", label:"Release", format:"gateRelease", meta:"Release" },
      { key:"depth", label:"Depth", format:"depth", meta:"Depth" }
    ]
  },
  PEQ:{
    defaultParameter:"lm",
    defaults:{
      hpf:42,
      lf:0, lfWidth:28, lfGain:50,
      lm:67, lmWidth:40, lmGain:50,
      hm:70, hmWidth:52, hmGain:50,
      hf:90, hfWidth:64, hfGain:50,
      in:true
    },
    parameters:[
      { key:"hpf", label:"HPF", format:"hpfFrequency", meta:"HPF" },
      { key:"lf", label:"LF", format:"frequency" },
      { key:"lm", label:"LM", format:"frequency" },
      { key:"hm", label:"HM", format:"frequency" },
      { key:"hf", label:"HF", format:"frequency" }
    ]
  },
  COMP:{
    defaultParameter:"threshold",
    defaults:{ threshold:58, ratio:36, attack:30, release:52, makeup:17, in:true },
    parameters:[
      { key:"threshold", label:"Threshold", format:"compThreshold", meta:"Thresh" },
      { key:"ratio", label:"Ratio", format:"ratio", meta:"Ratio" },
      { key:"attack", label:"Attack", format:"compAttack", meta:"Attack" },
      { key:"release", label:"Release", format:"compRelease", meta:"Release" },
      { key:"makeup", label:"Makeup", format:"makeup", meta:"Gain" }
    ]
  }
};
const screenPageOptions = {
  Routing:["Inputs","Mix Sends","Direct Out","Patching"],
  Home:["User","Meters","Qu-Drive","System"],
  FX:["FX1 Reverb","FX2 Delay","FX3 Chorus","FX4 Room"],
  Scenes:["Current","Next","Safes","Recall Filter"],
  Setup:["Audio","Control","USB Data","Network"]
};
const screenFnLabels = { Processing:"Library",Routing:"Mute/DCA",Home:"User",FX:"Library",Scenes:"Scene",Setup:"Utility" };
const screenFnOptions = {
  Processing:["User Library","Factory Library"],
  Routing:["Mute Groups","DCA Groups"],
  Home:["User Screen","Meters"],
  FX:["User Library","Factory Library"],
  Scenes:["Scene List","Safes"],
  Setup:["Utility","Diagnostics"]
};

const createScreenBlockValues=()=>Object.fromEntries(Object.entries(screenBlockDefinitions).map(([block,definition])=>[block,{...definition.defaults}]));
const createChannelProcessingState=()=>({
  blocks:createScreenBlockValues(),
  pan:{ LR:50,"Mix 5-6":50,"Mix 7-8":50,"Mix 9-10":50 }
});
const createScreenParameterSelections=()=>Object.fromEntries(Object.entries(screenBlockDefinitions).map(([block,definition])=>[block,definition.defaultParameter]));
const createScreenAppliedOptions=()=>Object.fromEntries(Object.keys(screenPageOptions).map(page=>[page,0]));
const createSourceProcessing=()=>Object.fromEntries(allInputSources.map(source=>[source.id,createChannelProcessingState()]));
const createSurfaceLevels=(mixes)=>Object.fromEntries(mixes.map((mix,mixIndex)=>[
  mix,
  Object.fromEntries(allInputSources.map((source,index)=>{
    const seed=levelSeed[index%levelSeed.length];
    return [source.id,mix==="LR"?seed:Math.max(12,Math.min(78,seed-18+((mixIndex+index)%7)))];
  }))
]));
const createMasterStates=(mixes)=>Object.fromEntries(mixes.map((mix,index)=>[mix,{level:mix==="LR"?72:58+(index%4)*3,muted:false}]));
const createRoutingState=(mixes,preFade=false)=>Object.fromEntries(mixes.map(mix=>[
  mix,
  new Set(preFade&&mix!=="LR"?allInputSources.map(source=>source.id):preFade?[]:allInputSources.map(source=>source.id))
]));

const processingWireMap=Object.freeze({
  // The square key carries the USB icon, so it must follow the documented
  // channel USB source switch (0x12), not the Local/dSNAKE selector (0x57).
  "usb-source":["PREAMP","source","boolean-number"],
  "preamp-gain":["PREAMP","gain","number"],
  "digital-trim":["PREAMP","gain","number"],
  "stereo-trim":["PREAMP","gain","number"],
  polarity:["PREAMP","polarity","boolean-number"],
  "hpf-frequency":["PREAMP","hpf","number"],
  "hpf-in":["PREAMP","hpfIn","boolean"],
  "peq-in":["PEQ","in","boolean"],
  "gate-in":["GATE","in","boolean"],
  "comp-in":["COMP","in","boolean"],
  "comp-gain":["COMP","makeup","number"],
  ...Object.fromEntries(["lf","lm","hm","hf"].flatMap(band=>[
    [`peq-${band}-frequency`,["PEQ",band,"number"]],
    [`peq-${band}-width`,["PEQ",`${band}Width`,"number"]],
    [`peq-${band}-gain`,["PEQ",`${band}Gain`,"number"]],
  ])),
  ...Object.fromEntries(["attack","release","hold","threshold","depth"].map(parameter=>[
    `gate-${parameter}`,["GATE",parameter,"number"],
  ])),
  ...Object.fromEntries(["attack","release","ratio","threshold"].map(parameter=>[
    `comp-${parameter}`,["COMP",parameter,"number"],
  ])),
});

const processingUiMap=Object.freeze(Object.fromEntries(
  Object.entries(processingWireMap).map(([wire,[block,key,type]])=>[`${block}:${key}`,{wire,type}]),
));

function applyProcessingWirePatch(current,wirePatch){
  let next=current??createChannelProcessingState();
  let blocks=next.blocks;
  for(const [wire,value] of Object.entries(wirePatch??{})){
    const mapping=processingWireMap[wire];
    if(!mapping)continue;
    const [block,key,type]=mapping;
    const blockValue=type==="boolean-number"?(value?100:0):value;
    blocks={...blocks,[block]:{...blocks[block],[key]:blockValue}};
    if(wire==="hpf-frequency")blocks={...blocks,PEQ:{...blocks.PEQ,hpf:blockValue}};
  }
  return {...next,blocks};
}

function applyRoutingPatch(current,patch,reset){
  const next=reset?{}:{...current};
  for(const [targetMix,states] of Object.entries(patch??{})){
    const set=reset?new Set():new Set(next[targetMix]??[]);
    for(const [sourceId,active] of Object.entries(states))active?set.add(sourceId):set.delete(sourceId);
    next[targetMix]=set;
  }
  return next;
}

function formatScreenFrequency(value) {
  const hz=20*Math.pow(1000,value/100);
  return hz>=1000?`${(hz/1000).toFixed(2)}kHz`:`${hz.toFixed(hz>=100?1:2)}Hz`;
}

function formatHpfFrequency(value) {
  const normalized=Math.max(0,Math.min(100,Number(value)||0));
  const hz=20*Math.pow(100,normalized/100);
  return hz>=1000?`${(hz/1000).toFixed(2)}kHz`:`${hz.toFixed(hz>=100?1:2)}Hz`;
}

function formatTimeRange(value,min,max) {
  const normalized=Math.max(0,Math.min(100,Number(value)||0));
  const milliseconds=min*Math.pow(max/min,normalized/100);
  if (milliseconds>=1000) return `${(milliseconds/1000).toFixed(milliseconds>=2000?1:2)}s`;
  if (milliseconds>=100) return `${Math.round(milliseconds)}ms`;
  return `${milliseconds.toFixed(milliseconds>=10?1:2)}ms`;
}

function formatPeqWidth(value) {
  const normalized=Math.max(0,Math.min(100,Number(value)||0));
  return `${(1.5-(1.5-1/9)*normalized/100).toFixed(2)} oct`;
}

function formatPeqGain(value) {
  const normalized=Math.max(0,Math.min(100,Number(value)||0));
  const gain=-15+30*normalized/100;
  return `${gain>=0?"+":""}${gain.toFixed(1)} dB`;
}

function formatScreenParameter(parameter,value) {
  const normalized=Math.max(0,Math.min(100,Number(value)||0));
  switch(parameter.format){
    case "frequency": return formatScreenFrequency(normalized);
    case "hpfFrequency": return formatHpfFrequency(normalized);
    case "preampGain": return `${(-5+65*normalized/100).toFixed(1)}dB`;
    case "source": return normalized<50?"Local":"USB";
    case "delay": return `${(85*normalized/100).toFixed(1)}ms`;
    case "polarity": return normalized<50?"Normal":"Reverse";
    case "gateThreshold": return `${(-72+90*normalized/100).toFixed(1)}dB`;
    case "compThreshold": return `${(-46+64*normalized/100).toFixed(1)}dB`;
    case "gateAttack": return formatTimeRange(normalized,.05,300);
    case "gateHold": return formatTimeRange(normalized,10,5000);
    case "gateRelease": return formatTimeRange(normalized,10,1000);
    case "compAttack": return formatTimeRange(normalized,.3,300);
    case "compRelease": return formatTimeRange(normalized,100,2000);
    case "depth": return `${Math.round(60*normalized/100)}dB`;
    case "ratio": return normalized>=100?"∞:1":`${(1/(1-normalized/100)).toFixed(normalized>=90?1:2)}:1`;
    case "makeup": return `${(18*normalized/100).toFixed(1)}dB`;
    default: return String(Math.round(normalized));
  }
}

function HardwareKnob({ label, caption = label, value = 54, className = "", onChange, disabled = false }) {
  const [level,setLevel]=useState(value);
  const knobRef=useRef(null);
  const levelRef=useRef(value);
  const commitLevel=(nextValue)=>{
    const next=Math.max(0,Math.min(100,Math.round(nextValue)));
    levelRef.current=next;
    const knob=knobRef.current;
    if (knob) {
      knob.dataset.value=String(next);
      knob.style.setProperty("--knob-angle",`${next*3.6}deg`);
      knob.setAttribute("aria-valuenow",String(next));
    }
    setLevel(next);
    onChange?.(next);
  };
  const levelFromPointer=(event)=>{
    if (disabled) return;
    const rect=event.currentTarget.getBoundingClientRect();
    const x=event.clientX-(rect.left+rect.width/2);
    const y=event.clientY-(rect.top+rect.height/2);
    const angle=(Math.atan2(y,x)*180/Math.PI+90+360)%360;
    commitLevel(angle/3.6);
  };
  useEffect(()=>{
    const knob=knobRef.current;
    if (!knob) return undefined;
    const turn=(event)=>{
      if (disabled) return;
      event.preventDefault();
      const step=event.shiftKey?5:1;
      commitLevel(levelRef.current+(event.deltaY<0?step:-step));
    };
    knob.addEventListener("wheel",turn,{passive:false});
    return ()=>knob.removeEventListener("wheel",turn);
  },[disabled]);
  useEffect(()=>{
    const next=Math.max(0,Math.min(100,Math.round(value)));
    if (levelRef.current===next) return;
    levelRef.current=next;
    const knob=knobRef.current;
    if (knob) {
      knob.dataset.value=String(next);
      knob.style.setProperty("--knob-angle",`${next*3.6}deg`);
      knob.setAttribute("aria-valuenow",String(next));
    }
    setLevel(next);
  },[value]);
  const onKeyDown=(event)=>{
    if (disabled) return;
    const keySteps={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1,PageUp:5,PageDown:-5};
    if (keySteps[event.key]) {event.preventDefault();commitLevel(levelRef.current+keySteps[event.key]);}
    if (event.key==="Home") {event.preventDefault();commitLevel(0);}
    if (event.key==="End") {event.preventDefault();commitLevel(100);}
  };
  return <div className={`qu-hardware-knob ${className}`.trim()} data-disabled={disabled?"true":"false"} title={disabled?`${label} · 当前目标不提供此参数`:`${label} ${level} · 围绕圆心旋转；滚轮微调；Shift + 滚轮粗调`}>
    <button ref={knobRef} type="button" className="qu-rotary-control" role="slider" tabIndex={disabled?-1:0} disabled={disabled} data-value={level} data-input-mode="rotary-360" style={{"--knob-angle":`${level*3.6}deg`}} aria-label={`${label} 360度旋钮`} aria-disabled={disabled} aria-valuemin="0" aria-valuemax="100" aria-valuenow={level} onPointerDown={event=>{if(disabled)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);levelFromPointer(event);}} onPointerMove={event=>{if(!disabled&&event.currentTarget.hasPointerCapture(event.pointerId)) levelFromPointer(event);}} onKeyDown={onKeyDown}>
      <span className="qu-knob-cap"><i/></span>
    </button>
    {caption ? <span className="qu-knob-caption">{caption}</span> : null}
  </div>;
}

function PanelLampKey({ label, controlId, active:controlledActive, defaultActive = false, indicator = false, disabled = false, known = true, title = label, onToggle }) {
  const [internalActive,setInternalActive]=useState(defaultActive);
  const active=known&&(controlledActive??internalActive);
  const toggle=()=>{
    const next=!active;
    if (controlledActive===undefined) setInternalActive(next);
    if(!disabled) onToggle?.(next);
  };
  return <div className="qu-panel-lamp-key"><span>{label}</span><button type="button" disabled={disabled} className={`qu-oval-key ${active ? "active" : ""} ${indicator ? "has-indicator" : ""}`.trim()} title={known?title:`${title} · 尚未收到真机状态`} aria-label={title} aria-pressed={active} aria-disabled={disabled} data-panel-key={controlId} data-lamp-state={known?(active ? "on" : "off"):"unknown"} data-parameter-known={known?"true":"false"} onClick={toggle}><i aria-hidden="true"/></button></div>;
}

function MainMeterColumn({ side, activeSegments }) {
  return <div className="qu-main-meter-column" data-side={side} aria-label={`${side} main meter`}>
    {mainMeterScale.map((_,index)=>{
      const active=index>=mainMeterScale.length-activeSegments;
      const range=index===0?"peak":index<4?"warning":"signal";
      return <i className={`qu-meter-segment ${range} ${active?"active":""}`.trim()} key={`${side}-${index}`}/>;
    })}
  </div>;
}

function TouchScreenCurve({ mode="peq", values }) {
  const canvasRef=useRef(null);
  useEffect(()=>{
    const canvas=canvasRef.current;
    if (!canvas) return undefined;
    const draw=()=>{
      const rect=canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const density=window.devicePixelRatio||1;
      canvas.width=Math.max(1,Math.round(rect.width*density));
      canvas.height=Math.max(1,Math.round(rect.height*density));
      const context=canvas.getContext("2d");
      context.setTransform(density,0,0,density,0,0);
      context.clearRect(0,0,rect.width,rect.height);
      context.fillStyle="#07090a";
      context.fillRect(0,0,rect.width,rect.height);
      context.lineWidth=.65;
      context.strokeStyle="#263238";
      for(let column=1;column<8;column+=1){const x=rect.width*column/8;context.beginPath();context.moveTo(x,0);context.lineTo(x,rect.height);context.stroke();}
      for(let row=1;row<5;row+=1){const y=rect.height*row/5;context.beginPath();context.moveTo(0,y);context.lineTo(rect.width,y);context.stroke();}
      context.lineWidth=1.25;
      context.strokeStyle=mode==="comp"?"#d8d84b":"#d8d944";
      context.beginPath();
      for(let pixel=0;pixel<=rect.width;pixel+=1){
        const progress=pixel/rect.width;
        let y;
        if(mode==="comp"){
          y=rect.height-(rect.height*(.12+.78*Math.pow(progress,.72)));
        }else{
          const lowShelf=5*(1-progress);
          const lowMid=7*Math.exp(-Math.pow((progress-(values.lm/100))/.14,2));
          const highMid=-4*Math.exp(-Math.pow((progress-(values.hm/100))/.1,2));
          const highShelf=3*Math.max(0,(progress-.7)/.3);
          y=rect.height*.52-lowShelf-lowMid-highMid-highShelf;
        }
        pixel===0?context.moveTo(pixel,y):context.lineTo(pixel,y);
      }
      context.stroke();
      if(mode==="peq"){
        context.lineWidth=.75;
        context.strokeStyle="#5ab66a";
        context.beginPath();context.moveTo(0,rect.height*.58);context.lineTo(rect.width,rect.height*.48);context.stroke();
        context.strokeStyle="#5278c7";
        context.beginPath();context.moveTo(0,rect.height*.44);context.lineTo(rect.width,rect.height*.54);context.stroke();
      }
    };
    draw();
    const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(draw):null;
    observer?.observe(canvas);
    return ()=>observer?.disconnect();
  },[mode,values]);
  return <canvas ref={canvasRef} className={`qu-lcd-curve ${mode}`} aria-hidden="true"/>;
}

function SurfaceKey({ kind, label, active = false, disabled = false, onClick, title, ...buttonProps }) {
  const typeClass=kind==="pafl"?"qu-pafl":`qu-key ${kind}`;
  return <button type="button" className={`qu-surface-key ${typeClass} ${active?"active":""}`.trim()} aria-pressed={active} aria-disabled={disabled} disabled={disabled} onClick={onClick} title={title} {...buttonProps}>
    <span>{label}</span><i className="qu-surface-key-face" aria-hidden="true"><b/></i>
  </button>;
}

function formatMixSurfaceLabel(target){
  return String(target).replace(/\s+/g,"");
}

function finiteDbfs(value, fallback = -120) {
  const numeric=Number(value);
  return Number.isFinite(numeric)?Math.max(-120,Math.min(24,numeric)):fallback;
}

function meterSegments(dbfs) {
  const value=finiteDbfs(dbfs);
  return mainMeterThresholdsDbfs.filter(threshold=>value>=threshold).length;
}

function ChannelSignalMeter({ meter = disconnectedMeter, label = "Channel meter", meterRole = null, rtaMode = false, rtaActive = false, rtaDbfs = -120 }) {
  const levelDbfs=rtaMode?finiteDbfs(rtaDbfs):finiteDbfs(meter?.levelDbfs);
  const peakDbfs=rtaMode?levelDbfs:finiteDbfs(meter?.peakDbfs,levelDbfs);
  const peakActive=rtaMode?rtaActive:peakDbfs>=qu16MeterThresholdsDbfs.peak;
  const nominalActive=!rtaMode&&levelDbfs>=qu16MeterThresholdsDbfs.nominal;
  const signalActive=!rtaMode&&levelDbfs>=qu16MeterThresholdsDbfs.signal;
  return <span className="qu-signal" role="meter" aria-label={label} aria-valuemin="-120" aria-valuemax="0" aria-valuenow={Math.min(0,levelDbfs)} aria-valuetext={`${levelDbfs.toFixed(1)} dBFS`} data-level-dbfs={levelDbfs.toFixed(2)} data-peak-dbfs={peakDbfs.toFixed(2)} data-meter-role={rtaMode?"rta-band":meterRole??meter?.meterRole??"channel"} data-rta-mode={rtaMode?"true":"false"} data-rta-active={rtaActive?"true":"false"}>
    <span><b>Pk</b><i className={peakActive?"active":""} data-meter-band="peak" data-lit={peakActive?"true":"false"}/></span>
    <span><b>0</b><i className={nominalActive?"active":""} data-meter-band="nominal" data-lit={nominalActive?"true":"false"}/></span>
    <span><b>Sig</b><i className={signalActive?"active":""} data-meter-band="signal" data-lit={signalActive?"true":"false"}/></span>
  </span>;
}

function FaderScale({ geq = false }) {
  const marks=geq?geqFaderMarks:channelFaderMarks;
  const minorMarks=marks.slice(0,-1).flatMap((mark,index)=>{
    const next=marks[index+1];
    return [1,2,3].map(step=>mark.position+(next.position-mark.position)*step/4);
  });
  return <span className={`qu-db-scale ${geq?"geq":"channel"}`} aria-hidden="true">
    {minorMarks.map((position,index)=><i className="minor" style={{"--fader-mark":`${position}%`}} key={`minor-${index}`}/>) }
    {marks.map((mark,index)=><i className="major" style={{"--fader-mark":`${mark.position}%`}} key={`${mark.label}-${index}`}><span/><b>{mark.label}</b><span/></i>)}
  </span>;
}

function FaderLane({ value, onChange, geq = false, label }) {
  return <div className="qu-fader-lane" data-fader-mode={geq?"geq":"level"}>
    <FaderScale geq={geq}/>
    <input className="qu-vertical-fader" type="range" min="0" max="100" value={value} onChange={event=>onChange(Number(event.target.value))} aria-label={label}/>
  </div>;
}

function QuChannel({ index, value, source, layerMode, selected, muted, pafl, meter, rtaActive = false, rtaDbfs = -120, selActive, selectDisabled = false, onSelect, onMute, onPafl, onChange, geqBand = null }) {
  const channel=index+1;
  const geqActive=Boolean(geqBand);
  const geqFlat=geqActive&&geqBand.value===50;
  const faderValue=geqActive?geqBand.value:value;
  const geqGain=-12+24*faderValue/100;
  const upper=surfaceLayerDefinitions.upper[index];
  const lower=surfaceLayerDefinitions.lower[index];
  const custom=surfaceLayerDefinitions.custom[index];
  const selectState=geqActive?geqFlat:selActive??selected;
  const rackFxInput=source.entityKind==="master"&&(source.masterTarget==="FX 1"||source.masterTarget==="FX 2");
  const meterLabel=geqActive
    ? `${geqBand.frequency}Hz RTA 频段`
    : rackFxInput||meter?.meterRole==="rack-fx-input"
      ? `${source.label} RackFX 实际输入（仅在同名 Mix→Return 默认 Patch 下等同 FX Send）`
      : `${source.label} 推子前电平`;
  const upperDetail=geqActive?"RTA":rackFxInput||meter?.meterRole==="rack-fx-input"?"FX IN":upper.detail;
  const customStripLabel=custom.stripLabel??custom.label;
  const lowerStripLabel=lower.stripLabel??lower.label;
  const customStripTitle=customStripLabel===custom.label?custom.label:`${custom.label} · ${customStripLabel}`;
  const lowerStripTitle=lowerStripLabel===lower.label?lower.label:`${lower.label} · ${lowerStripLabel}`;
  return <div className={`qu-channel ${selected&&!geqActive?"selected":""} ${geqActive?"geq-flip":""} ${geqFlat?"geq-flat":""}`.trim()} data-channel={channel} data-slot={channel} data-source-id={source.id} data-layer={layerMode} data-geq-frequency={geqBand?.frequency??""}>
    <SurfaceKey kind="mute" label="Mute" active={muted} onClick={onMute} title={`${source.label} Mute · 本地数字孪生状态`}/>
    <SurfaceKey kind="select" label="Sel" active={selectState} disabled={selectDisabled} onClick={geqActive?geqBand.onReset:onSelect} title={geqActive?`${geqBand.frequency}Hz GEQ：按 Sel 归零到 0dB`:source.entityKind==="master"?`选择 ${source.masterTarget} Master 处理`:`Sel：选择处理；Assign/Pre Fade 模式下切换当前 Mix 路由`}/>
    <SurfaceKey kind="pafl" label="PAFL" active={pafl} onClick={onPafl} title={`${source.label} PAFL · ${source.entityKind==="master"?"AFL":"PFL"} 本地状态`}/>
    <ChannelSignalMeter meter={meter} meterRole={rackFxInput?"rack-fx-input":null} rtaMode={geqActive} rtaActive={rtaActive} rtaDbfs={rtaDbfs} label={meterLabel}/>
    <div className="qu-strip-screen" aria-label={`Physical strip ${channel} layer labels`}>
      <span className={`upper ${layerMode==="upper"?"active":""}`}><b>{upper.label}</b><small>{upperDetail}</small></span>
      <span className={`custom ${layerMode==="custom"?"active":""}`} title={customStripTitle}><b>{layerMode==="custom"?customStripLabel:""}</b></span>
      <span className={`lower ${layerMode==="lower"?"active":""}`} title={lowerStripTitle}><b>{lowerStripLabel}</b></span>
    </div>
    <span className="qu-fader-head"><i className="qu-strip-screw"/>{geqActive?<b>{geqBand.frequency}Hz</b>:null}</span>
    <FaderLane value={faderValue} geq={geqActive} onChange={geqActive?geqBand.onChange:onChange} label={geqActive?`${geqBand.frequency}Hz GEQ 推子`:`${source.label} ${layerMode} 层推子`}/>
    <span className="qu-strip-index"><i className="qu-strip-screw"/><b>{geqActive?geqBand.frequency:channel}</b><small>{geqActive?`${geqGain>=0?"+":""}${geqGain.toFixed(1)}dB`:source.label}</small></span>
  </div>;
}

export function MixerConsole({ model, meterSnapshot = null, parameterSnapshot = null, controlMode = "local-ui-only", onWriteParameters = null }) {
  const mixTargets=model?.ui?.mixes??["LR"];
  const [layerMode,setLayerMode]=useState(()=>["lower","upper","custom"].includes(model?.ui?.defaultLayer)?model.ui.defaultLayer:"lower");
  const [selectedChannel, setSelectedChannel] = useState(0);
  const [selectedTargetKind,setSelectedTargetKind]=useState("source");
  const [selectedMasterTarget,setSelectedMasterTarget]=useState("LR");
  const [selectedMasterOrigin,setSelectedMasterOrigin]=useState("master-strip");
  const [surfaceLevels,setSurfaceLevels]=useState(()=>createSurfaceLevels(mixTargets));
  const [mutedSources,setMutedSources]=useState(()=>new Set());
  const [mix, setMix] = useState("LR");
  const [masterStates,setMasterStates]=useState(()=>createMasterStates(mixTargets));
  const [paflTargets,setPaflTargets]=useState(()=>new Set());
  const [surfaceMode,setSurfaceMode]=useState("select");
  const [assignedByMix,setAssignedByMix]=useState(()=>createRoutingState(mixTargets));
  const [preFadeByMix,setPreFadeByMix]=useState(()=>createRoutingState(mixTargets,true));
  const [muteGroupStates,setMuteGroupStates]=useState(()=>Array(4).fill(false));
  const [talkActive,setTalkActive] = useState(false);
  const [phonesLevel,setPhonesLevel] = useState(61);
  const [altOutLevel,setAltOutLevel] = useState(54);
  const [screenPage, setScreenPage] = useState("Processing");
  const [screenBlock,setScreenBlock] = useState("PEQ");
  const [screenParameterSelections,setScreenParameterSelections] = useState(createScreenParameterSelections);
  const [sourceProcessing,setSourceProcessing]=useState(createSourceProcessing);
  const [masterProcessing,setMasterProcessing]=useState(()=>Object.fromEntries(mixTargets.map(target=>[target,createChannelProcessingState()])));
  const [screenClipboard,setScreenClipboard] = useState({});
  const [screenFnOpen,setScreenFnOpen] = useState(false);
  const [screenFnSelections,setScreenFnSelections] = useState({});
  const [screenMenuIndex,setScreenMenuIndex] = useState(0);
  const [screenAppliedOptions,setScreenAppliedOptions] = useState(createScreenAppliedOptions);
  const [screenAction,setScreenAction] = useState("idle");
  const [screenStatus,setScreenStatus] = useState("");
  const [geqFaderMode,setGeqFaderMode] = useState("off");
  const [geqByMix,setGeqByMix] = useState(()=>Object.fromEntries(mixTargets.map(item=>[item,Array(geqFrequencies.length).fill(50)])));
  const [meterClock,setMeterClock]=useState(()=>Date.now());
  const pendingFaderWritesRef=useRef(new Map());
  const faderFlushTimerRef=useRef(null);
  const writeParametersRef=useRef(onWriteParameters);
  const controlModeRef=useRef(controlMode);
  const lastParameterFrameRef=useRef({host:null,sessionId:null,revision:-1});
  const observedParameterBaselineRef=useRef({host:null,sessionId:null,parameters:null});
  const optimisticParametersRef=useRef(new Map());
  const [lastHardwareChange,setLastHardwareChange]=useState(null);
  const [writeFailureTick,setWriteFailureTick]=useState(0);
  const activeLayerSources=surfaceLayerDefinitions[layerMode];
  const selectedSource=activeLayerSources[selectedChannel]??activeLayerSources[0];
  const selectedTargetLabel=selectedTargetKind==="master"?`${selectedMasterTarget} Master`:selectedSource.label;
  const selectedTargetId=selectedTargetKind==="master"?qu16MasterTargetId(selectedMasterTarget):selectedSource.id;
  const selectedProcessing=selectedTargetKind==="master"?(masterProcessing[selectedMasterTarget]??createChannelProcessingState()):(sourceProcessing[selectedSource.id]??createChannelProcessingState());
  const screenBlockValues=selectedProcessing.blocks;
  const panEnabled=selectedTargetKind==="source"&&(mix==="LR"||mix==="Mix 5-6"||mix==="Mix 7-8"||mix==="Mix 9-10");
  const panValue=selectedProcessing.pan[mix]??50;
  const panTick = Math.round((panValue / 100) * 6);
  const activeMaster=masterStates[mix]??{level:72,muted:false};
  const meterAgeMs=Math.max(0,meterClock-(Number(meterSnapshot?.updatedAtMs)||0));
  const meterLive=Boolean(meterSnapshot?.connected)&&meterAgeMs<1500;
  const meterTransport=meterLive?(meterSnapshot?.source||"qu16-tcp-midi"):meterSnapshot?.connected?"stale":"disconnected";
  const sourceMeters=meterLive?(meterSnapshot?.channels??{}):{};
  const masterMeters=meterLive?(meterSnapshot?.masters??{}):{};
  const masterMeter=masterMeters[mix]??disconnectedMeter;
  const selectedMeter=selectedTargetKind==="master"?(masterMeters[selectedMasterTarget]??disconnectedMeter):(sourceMeters[selectedSource.id]??disconnectedMeter);
  const selectedPeakActive=meterLive&&Math.max(selectedMeter.peakDbfs??-120,selectedMeter.levelDbfs??-120)>=qu16MeterThresholdsDbfs.peak;
  const masterPeakActive=meterLive&&Math.max(masterMeter.peakDbfs??-120,masterMeter.levelDbfs??-120)>=qu16MeterThresholdsDbfs.peak;
  const observedParameterMap=parameterSnapshot?.parameters&&typeof parameterSnapshot.parameters==="object"
    ? parameterSnapshot.parameters
    : {};
  const pendingParameterMap=parameterSnapshot?.pendingDetails&&typeof parameterSnapshot.pendingDetails==="object"
    ? parameterSnapshot.pendingDetails
    : {};
  const hardwareParameterKnown=(key)=>controlMode!=="hardware-live"
    ||Object.hasOwn(observedParameterMap,key)
    ||Object.hasOwn(pendingParameterMap,key);
  const selectedProcessingKnown=(wire)=>hardwareParameterKnown(`process:${selectedTargetId}:${wire}`);

  const activeRoutingSet=surfaceMode==="preFade"?(preFadeByMix[mix]??new Set()):(assignedByMix[mix]??new Set());
  const masterSelectActive=surfaceMode==="select"?selectedTargetKind==="master"&&selectedMasterTarget===mix:allInputSources.every(source=>activeRoutingSet.has(source.id));
  // The hardware Monitor L/R pair already follows the console's real PAFL/LR
  // bus. Prefer it whenever live so a PAFL pressed on the physical surface is
  // reflected even when the local digital-twin selection differs.
  const localPaflIds=[...paflTargets];
  const localPaflId=localPaflIds[localPaflIds.length-1]??null;
  const localPaflMaster=QU16_MASTER_TARGETS.find(target=>target.id===localPaflId);
  const monitoredMeter=meterLive&&meterSnapshot?.monitor
    ? meterSnapshot.monitor
    : localPaflMaster?(masterMeters[localPaflMaster.label]??disconnectedMeter)
      : localPaflId?(sourceMeters[localPaflId]??disconnectedMeter)
        :(masterMeters.LR??disconnectedMeter);
  const leftMeterSegments=meterSegments(monitoredMeter.leftDbfs??monitoredMeter.levelDbfs);
  const rightMeterSegments=meterSegments(monitoredMeter.rightDbfs??monitoredMeter.levelDbfs);
  const screenDefinition=screenBlockDefinitions[screenBlock];
  const screenParameters=screenDefinition.parameters;
  const screenParameter=screenParameterSelections[screenBlock];
  const screenParameterValues=screenBlockValues[screenBlock];
  const screenRotaryValue=screenParameterValues[screenParameter];
  const screenFnSelection=screenFnSelections[screenPage]??"";
  const screenAppliedIndex=screenAppliedOptions[screenPage]??0;
  const geqRangeStart=geqFaderMode==="high"?12:0;
  const activeGeq=geqByMix[mix]??Array(geqFrequencies.length).fill(50);
  const geqAvailable=!mix.startsWith("FX ");
  const liveRtaDbfs=meterLive&&Array.isArray(meterSnapshot?.rtaDbfs)?meterSnapshot.rtaDbfs:[];
  // Qu publishes 31 RTA bands (20 Hz–20 kHz), while the GEQ owns 28 bands
  // (31.5 Hz–16 kHz). The first physical GEQ strip therefore starts at RTA
  // bin 2, not bin 0.
  const geqRtaDbfs=liveRtaDbfs.slice(2,2+geqFrequencies.length);
  const strongestRtaDbfs=geqRtaDbfs.length?Math.max(...geqRtaDbfs.map(value=>finiteDbfs(value))):-120;
  const dominantRtaIndex=strongestRtaDbfs>-120
    ? geqRtaDbfs.findIndex(value=>finiteDbfs(value)===strongestRtaDbfs)
    :-1;

  useEffect(()=>{
    if(selectedTargetKind==="master"&&(screenBlock==="PREAMP"||screenBlock==="GATE")) setScreenBlock("PEQ");
  },[screenBlock,selectedTargetKind]);

  useEffect(()=>{
    const timer=window.setInterval(()=>setMeterClock(Date.now()),500);
    return ()=>window.clearInterval(timer);
  },[]);

  writeParametersRef.current=onWriteParameters;
  controlModeRef.current=controlMode;

  useEffect(()=>()=>{
    if(faderFlushTimerRef.current!==null)window.clearTimeout(faderFlushTimerRef.current);
    faderFlushTimerRef.current=null;
    pendingFaderWritesRef.current.clear();
    optimisticParametersRef.current.clear();
  },[]);

  useEffect(()=>{
    if(controlMode==="hardware-live")return;
    if(faderFlushTimerRef.current!==null)window.clearTimeout(faderFlushTimerRef.current);
    faderFlushTimerRef.current=null;
    pendingFaderWritesRef.current.clear();
    optimisticParametersRef.current.clear();
  },[controlMode]);

  useEffect(()=>{
    if(!parameterSnapshot?.connected||!parameterSnapshot?.synced||!parameterSnapshot.parameters)return;
    const revision=Number(parameterSnapshot.revision);
    const sessionId=Number(parameterSnapshot.sessionId);
    if(!Number.isSafeInteger(revision)||revision<0||!Number.isFinite(sessionId))return;
    const previous=lastParameterFrameRef.current;
    const sameSession=previous.host===parameterSnapshot.host&&previous.sessionId===sessionId;
    if(sameSession&&revision<previous.revision)return;
    if(!sameSession)optimisticParametersRef.current.clear();
    let patch;
    const observedParameters=parameterSnapshot.parameters;
    const pendingDetails=parameterSnapshot.pendingDetails&&typeof parameterSnapshot.pendingDetails==="object"&&!Array.isArray(parameterSnapshot.pendingDetails)
      ? parameterSnapshot.pendingDetails
      : {};
    try{
      const pendingParameters=Object.fromEntries(Object.entries(pendingDetails)
          .filter(([,pending])=>pending&&typeof pending==="object"&&"expectedValue" in pending)
          .map(([key,pending])=>[key,pending.expectedValue]));
      const responseValues=parameterSnapshot.writeResponseValues&&typeof parameterSnapshot.writeResponseValues==="object"&&!Array.isArray(parameterSnapshot.writeResponseValues)
        ? parameterSnapshot.writeResponseValues
        : {};
      const optimisticParameters={};
      for(const [key,optimistic] of optimisticParametersRef.current){
        const hasPending=Object.hasOwn(pendingParameters,key);
        if(hasPending&&pendingParameters[key]===optimistic.value)optimistic.acknowledged=true;
        const matchingResponse=Object.hasOwn(responseValues,key)&&responseValues[key]===optimistic.value;
        if(matchingResponse)optimistic.acknowledged=true;
        const observedMatches=Object.hasOwn(observedParameters,key)&&observedParameters[key]===optimistic.value;
        const resolved=!hasPending&&(matchingResponse||optimistic.acknowledged||(observedMatches&&revision>optimistic.afterRevision));
        if(resolved)optimisticParametersRef.current.delete(key);
        else optimisticParameters[key]=optimistic.value;
      }
      patch=decodeQu16ParameterSnapshot({...parameterSnapshot,parameters:{...observedParameters,...pendingParameters,...optimisticParameters}});
    }catch(error){
      console.warn("忽略无效的 Qu-16 参数快照",error);
      return;
    }
    const observationBaseline=observedParameterBaselineRef.current;
    const sameObservationSession=observationBaseline.host===parameterSnapshot.host&&observationBaseline.sessionId===sessionId;
    if(sameObservationSession&&observationBaseline.parameters){
      const changed=Object.entries(observedParameters).filter(([key,value])=>
        observationBaseline.parameters[key]!==value&&!Object.hasOwn(pendingDetails,key)
      );
      const latest=changed.at(-1);
      if(latest){
        const [key,value]=latest;
        const liveChange={key,value,revision};
        setLastHardwareChange(liveChange);
        setScreenStatus(formatLiveParameterChange(key,value));
      }
    }
    observedParameterBaselineRef.current={host:parameterSnapshot.host,sessionId,parameters:{...observedParameters}};
    lastParameterFrameRef.current={host:parameterSnapshot.host,sessionId,revision};
    setSurfaceLevels(current=>{
      const next={...current};
      for(const [targetMix,levels] of Object.entries(patch.levels))next[targetMix]={...(current[targetMix]??{}),...levels};
      return next;
    });
    setMasterStates(current=>{
      const next={...current};
      for(const [targetMix,state] of Object.entries(patch.master))next[targetMix]={...(current[targetMix]??{}),...state};
      return next;
    });
    setMutedSources(current=>{
      const next=new Set(current);
      for(const [target,muted] of Object.entries(patch.mute))muted?next.add(target):next.delete(target);
      return next;
    });
    setPaflTargets(new Set(patch.paflTargets.map(target=>target.id)));
    setMuteGroupStates(patch.muteGroups);
    setAssignedByMix(current=>applyRoutingPatch(current,patch.assign,!sameSession));
    setPreFadeByMix(current=>applyRoutingPatch(current,patch.pre,!sameSession));
    setSourceProcessing(current=>{
      const next={...current};
      for(const [targetId,wirePatch] of Object.entries(patch.processing)){
        if(!targetId.endsWith("-master")&&!targetId.endsWith("-send"))next[targetId]=applyProcessingWirePatch(next[targetId],wirePatch);
      }
      for(const [targetMix,states] of Object.entries(patch.pan)){
        for(const [targetId,value] of Object.entries(states)){
          const processing=next[targetId]??createChannelProcessingState();
          next[targetId]={...processing,pan:{...processing.pan,[targetMix]:value}};
        }
      }
      return next;
    });
    setMasterProcessing(current=>{
      const next={...current};
      for(const [targetId,wirePatch] of Object.entries(patch.processing)){
        const target=QU16_MASTER_TARGETS.find(item=>item.id===targetId);
        if(target)next[target.label]=applyProcessingWirePatch(next[target.label],wirePatch);
      }
      return next;
    });
  },[parameterSnapshot,writeFailureTick]);

  const dispatchHardwareWrites=(writes)=>{
    const writer=writeParametersRef.current;
    if(controlModeRef.current!=="hardware-live"||typeof writer!=="function"||!writes.length)return;
    const rollback=error=>{
      let changed=false;
      for(const write of writes){
        const optimistic=optimisticParametersRef.current.get(write.key);
        if(optimistic?.value===write.value){
          optimisticParametersRef.current.delete(write.key);
          changed=true;
        }
      }
      if(changed){
        // React can batch the pointer/input state update with a synchronously
        // rejected transport promise. Re-apply the authoritative snapshot in
        // the next task so the optimistic UI value cannot win that batch.
        window.setTimeout(()=>setWriteFailureTick(current=>current+1),0);
      }
      if(error)console.warn("Qu-16 参数写入失败",error);
    };
    Promise.resolve(writer(writes)).then(result=>{
      if(result?.accepted===false)rollback(result.error??result.mode??"write rejected");
    },rollback);
  };
  const flushFaderWrites=()=>{
    faderFlushTimerRef.current=null;
    if(controlModeRef.current!=="hardware-live"){
      pendingFaderWritesRef.current.clear();
      return;
    }
    const writes=[...pendingFaderWritesRef.current.values()];
    pendingFaderWritesRef.current.clear();
    dispatchHardwareWrites(writes);
  };
  const queueFaderWrite=(intent)=>{
    if(controlModeRef.current!=="hardware-live"||typeof writeParametersRef.current!=="function")return;
    const {key,value}=qu16IntentToWrite(intent);
    pendingFaderWritesRef.current.set(key,{key,value});
    optimisticParametersRef.current.set(key,{value,afterRevision:lastParameterFrameRef.current.revision,acknowledged:false});
    if(faderFlushTimerRef.current===null)faderFlushTimerRef.current=window.setTimeout(flushFaderWrites,38);
  };
  const writeBinaryControl=(intent)=>{
    if(controlModeRef.current!=="hardware-live"||typeof writeParametersRef.current!=="function")return;
    const {key,value}=qu16IntentToWrite(intent);
    optimisticParametersRef.current.set(key,{value,afterRevision:lastParameterFrameRef.current.revision,acknowledged:false});
    dispatchHardwareWrites([{key,value}]);
  };

  const updateSelectedProcessing=(updater)=>{
    if(selectedTargetKind==="master"){
      setMasterProcessing(current=>({...current,[selectedMasterTarget]:updater(current[selectedMasterTarget]??createChannelProcessingState())}));
      return;
    }
    setSourceProcessing(current=>({...current,[selectedSource.id]:updater(current[selectedSource.id]??createChannelProcessingState())}));
  };
  const updateBlockValues=(block,updater)=>updateSelectedProcessing(processing=>{
    const currentBlock=processing.blocks[block];
    const nextBlock=typeof updater==="function"?updater(currentBlock):{...currentBlock,...updater};
    let blocks={...processing.blocks,[block]:nextBlock};
    if ((block==="PREAMP"||block==="PEQ")&&nextBlock.hpf!==currentBlock.hpf) {
      const linkedBlock=block==="PREAMP"?"PEQ":"PREAMP";
      blocks={...blocks,[linkedBlock]:{...blocks[linkedBlock],hpf:nextBlock.hpf}};
    }
    return {...processing,blocks};
  });
  const updatePan=(next)=>{
    updateSelectedProcessing(processing=>({...processing,pan:{...processing.pan,[mix]:next}}));
    if(panEnabled)queueFaderWrite({kind:"pan",target:selectedTargetId,mix,value:next});
  };
  const updateSurfaceFader=(source,next)=>{
    if(source.entityKind==="master"){
      setMasterStates(current=>({...current,[source.masterTarget]:{...current[source.masterTarget],level:next}}));
      queueFaderWrite({kind:"fader",target:source.masterTarget,value:next});
      return;
    }
    setSurfaceLevels(current=>({...current,[mix]:{...current[mix],[source.id]:next}}));
    queueFaderWrite(mix==="LR"
      ? {kind:"fader",target:source.id,value:next}
      : {kind:"send",target:source.id,mix,value:next});
  };
  const updateMaster=(next)=>{
    setMasterStates(current=>({...current,[mix]:{...current[mix],level:next}}));
    queueFaderWrite({kind:"fader",target:mix,value:next});
  };
  const updateMute=(target,currentMuted)=>{
    const nextMuted=!currentMuted;
    if(target.entityKind==="master")setMasterStates(current=>({...current,[target.masterTarget]:{...current[target.masterTarget],muted:nextMuted}}));
    else setMutedSources(current=>{const next=new Set(current);nextMuted?next.add(target.id):next.delete(target.id);return next});
    writeBinaryControl({kind:"mute",target:target.entityKind==="master"?target.masterTarget:target.id,value:nextMuted});
  };
  const updatePafl=(targetId,currentActive)=>{
    const nextActive=!currentActive;
    setPaflTargets(current=>{const next=new Set(current);nextActive?next.add(targetId):next.delete(targetId);return next});
    writeBinaryControl({kind:"pafl",target:targetId,value:nextActive});
  };
  const toggleSetMember=(setter,targetMix,sourceId)=>setter(current=>{
    const nextSet=new Set(current[targetMix]??[]);
    nextSet.has(sourceId)?nextSet.delete(sourceId):nextSet.add(sourceId);
    return {...current,[targetMix]:nextSet};
  });
  const handleStripSelect=(index,source)=>{
    if(surfaceMode==="assign"){
      if(source.entityKind!=="input") return;
      const nextAssigned=!assignedByMix[mix]?.has(source.id);
      toggleSetMember(setAssignedByMix,mix,source.id);
      writeBinaryControl({kind:"assign",target:source.id,mix,value:nextAssigned});
      setScreenStatus(`${mix} · ${source.label} ${nextAssigned?"Assigned":"Unassigned"} · ${controlModeRef.current==="hardware-live"?"LIVE":"Local"}`);
      return;
    }
    if(surfaceMode==="preFade"){
      if(source.entityKind!=="input"||mix==="LR") return;
      const nextPre=!preFadeByMix[mix]?.has(source.id);
      toggleSetMember(setPreFadeByMix,mix,source.id);
      writeBinaryControl({kind:"pre",target:source.id,mix,value:nextPre});
      setScreenStatus(`${mix} · ${source.label} ${nextPre?"Pre Fade":"Post Fade"} · ${controlModeRef.current==="hardware-live"?"LIVE":"Local"}`);
      return;
    }
    setSelectedChannel(index);
    if(source.entityKind==="master"){
      setSelectedTargetKind("master");
      setSelectedMasterTarget(source.masterTarget);
      setSelectedMasterOrigin("layer");
      setScreenStatus(`${source.masterTarget} Master selected · Local`);
    }else{
      setSelectedTargetKind("source");
      setScreenStatus(`${source.label} selected · Local`);
    }
  };
  const handleMasterSelect=()=>{
    if(surfaceMode==="assign"||surfaceMode==="preFade"){
      const setter=surfaceMode==="assign"?setAssignedByMix:setPreFadeByMix;
      setter(current=>{
        const currentSet=current[mix]??new Set();
        const allActive=allInputSources.every(source=>currentSet.has(source.id));
        return {...current,[mix]:allActive?new Set():new Set(allInputSources.map(source=>source.id))};
      });
      setScreenStatus(`${mix} · all sources ${surfaceMode==="assign"?"assignment":"pre/post"} toggled · Local`);
      return;
    }
    setSelectedTargetKind("master");
    setSelectedMasterTarget(mix);
    setSelectedMasterOrigin("master-strip");
    setScreenStatus(`${mix} Master selected · Local`);
  };
  const changeLayer=(nextLayer)=>{
    setLayerMode(nextLayer);
    setSelectedTargetKind("source");
    setSurfaceMode("select");
    setScreenStatus(`${nextLayer==="lower"?"CH1–CH16":nextLayer==="upper"?"ST / FX / Mix Masters":"Custom"} layer · Local`);
  };
  const chooseMix=(target)=>{
    const next=target===mix&&target!=="LR"?"LR":target;
    if(selectedTargetKind==="master"&&selectedMasterOrigin==="master-strip") setSelectedMasterTarget(next);
    setMix(next);
    if(next.startsWith("FX ")) setGeqFaderMode("off");
    setSurfaceMode("select");
    setScreenStatus(`${next} · sends on faders · Local`);
  };
  const updateGeqBand=(bandIndex,next)=>{
    setGeqByMix(current=>({...current,[mix]:(current[mix]??Array(geqFrequencies.length).fill(50)).map((value,index)=>index===bandIndex?next:value)}));
    const gain=-12+24*next/100;
    setScreenStatus(`${mix} · GEQ ${geqFrequencies[bandIndex]}Hz ${gain>=0?"+":""}${gain.toFixed(1)}dB · Local`);
  };
  const cycleGeqFaderMode=()=>{
    if(!geqAvailable){
      setScreenStatus(`${mix} 不提供 GEQ Fader Flip · Local`);
      return;
    }
    const next=geqFaderMode==="off"?"low":geqFaderMode==="low"?"high":"off";
    setGeqFaderMode(next);
    setScreenStatus(next==="off"?`${mix} · GEQ Fader Flip Off · Local`:`${mix} · GEQ Fader Flip ${next==="low"?"31.5Hz–1kHz":"500Hz–16kHz"} · Local`);
  };
  const updateHardwareParameter=(block,key,next,status)=>{
    updateBlockValues(block,current=>({...current,[key]:next}));
    let mapping=processingUiMap[`${block}:${key}`];
    if(block==="PREAMP"&&key==="gain"){
      mapping=selectedTargetKind==="source"&&selectedSource.id.startsWith("ch-")
        ? {wire:"preamp-gain",type:"number"}
        : selectedTargetKind==="source"&&selectedSource.id.startsWith("st-")
          ? {wire:"stereo-trim",type:"number"}
          : null;
    }
    // Source switching on Qu combines Local/dSNAKE and USB patching. Keep the
    // simplified square key read-only until that routing UI is modelled fully.
    if(block==="PREAMP"&&key==="source")mapping=null;
    if(mapping){
      const value=mapping.type==="boolean"?Boolean(next):mapping.type==="boolean-number"?Number(next)>=50:next;
      const intent={kind:"process",target:selectedTargetId,parameter:mapping.wire,value};
      mapping.type==="number"?queueFaderWrite(intent):writeBinaryControl(intent);
    }
    if (status) setScreenStatus(`${selectedTargetLabel} · ${status} · ${mapping&&controlModeRef.current==="hardware-live"?"LIVE":"Local"}`);
  };
  const peqParameterPresentation=(parameter)=>{
    if (screenBlock!=="PEQ"||!peqBands.map(band=>band.toLowerCase()).includes(parameter.key)) return {meta:parameter.meta,note:parameter.note};
    return {
      meta:`W ${formatPeqWidth(screenParameterValues[`${parameter.key}Width`]).replace(" oct","")}`,
      note:`G ${formatPeqGain(screenParameterValues[`${parameter.key}Gain`]).replace(" dB","dB")}`
    };
  };

  const selectScreenBlock=(block)=>{
    setScreenBlock(block);
    setScreenFnOpen(false);
    setScreenStatus(`Local block: ${block}`);
  };
  const selectScreenParameter=(parameter)=>setScreenParameterSelections(current=>({...current,[screenBlock]:parameter}));
  const updateScreenParameter=(next)=>{
    updateHardwareParameter(
      screenBlock,
      screenParameter,
      next,
      `${screenBlock} ${screenParameter.toUpperCase()} ${formatScreenParameter(screenParameters.find(parameter=>parameter.key===screenParameter),next)}`,
    );
  };
  const copyScreenBlock=()=>{
    setScreenClipboard(current=>({...current,[screenBlock]:{...screenParameterValues}}));
    setScreenStatus(`Copied locally: ${screenBlock}`);
  };
  const pasteScreenBlock=()=>{
    const copied=screenClipboard[screenBlock];
    if (!copied) return;
    updateBlockValues(screenBlock,()=>({...copied}));
    setScreenStatus(`Pasted locally: ${screenBlock}`);
  };
  const resetScreenBlock=()=>{
    updateBlockValues(screenBlock,()=>({...screenDefinition.defaults}));
    setScreenStatus(`Reset locally: ${screenBlock}`);
  };
  const applyScreenOption=()=>{
    const option=screenPageOptions[screenPage]?.[screenMenuIndex];
    if (!option) return;
    setScreenAppliedOptions(current=>({...current,[screenPage]:screenMenuIndex}));
    setScreenAction("applied");
    setScreenStatus(`Applied locally: ${option}`);
  };
  const cancelScreenOption=()=>{
    const option=screenPageOptions[screenPage]?.[screenAppliedIndex];
    setScreenMenuIndex(screenAppliedIndex);
    setScreenAction("cancelled");
    setScreenStatus(`Cancelled locally: ${option}`);
  };
  const chooseScreenFnOption=(option)=>{
    setScreenFnSelections(current=>({...current,[screenPage]:option}));
    setScreenStatus(`Local ${screenFnLabels[screenPage]}: ${option}`);
    setScreenFnOpen(false);
  };
  const changeScreenPage=(page)=>{
    setScreenPage(page);
    setScreenMenuIndex(screenAppliedOptions[page]??0);
    setScreenAction("idle");
    setScreenStatus("");
    setScreenFnOpen(false);
  };

  return <div className="qu-console" aria-label={`${model.displayName} 参数状态数字孪生调音台`}>
    <div className="qu-console-brandbar" aria-label={`Allen & Heath Qu-16 · USB-B Audio · Ethernet Control · TCP ${model.control.tcpPort}`}>
      <img className="qu-brandbar-art" src={qu16Brandbar} alt="ALLEN&HEATH · Qu-16"/>
      <span className="qu-brandbar-transport">USB-B AUDIO · ETHERNET CONTROL · TCP {model.control.tcpPort}</span>
    </div>

    <section className="qu-superstrip" aria-label="SuperStrip 通道处理">
      <div className="qu-knob-bank">
        <div className="qu-super-column narrow">
          <section className="qu-hardware-block preamp" data-applicable={selectedTargetKind==="source"?"true":"false"}><h3>Preamp</h3><div className="qu-preamp-body"><button type="button" disabled className={`qu-square-key ${selectedProcessingKnown("usb-source")&&screenBlockValues.PREAMP.source>=50?"active":""}`.trim()} data-parameter-known={selectedProcessingKnown("usb-source")?"true":"false"} data-lamp-state={selectedProcessingKnown("usb-source")?(screenBlockValues.PREAMP.source>=50?"on":"off"):"unknown"} title="USB Source 真机状态；完整 Local/dSNAKE/USB 路由界面完成前禁止从简化按钮写入" aria-label="USB source status" aria-pressed={selectedProcessingKnown("usb-source")&&screenBlockValues.PREAMP.source>=50}><Usb weight="bold"/></button><span>Gain</span><HardwareKnob label="Preamp Gain" caption="" disabled={selectedTargetKind==="master"} value={screenBlockValues.PREAMP.gain} onChange={next=>updateHardwareParameter("PREAMP","gain",next,`Preamp Gain ${formatScreenParameter(screenBlockDefinitions.PREAMP.parameters[0],next)}`)}/><i className={`qu-pk-led ${selectedPeakActive?"active":""}`.trim()}>Pk</i></div></section>
          <section className="qu-hardware-block hpf" data-applicable={selectedTargetKind==="source"?"true":"false"}><h3>HPF</h3><div className="qu-hpf-body"><HardwareKnob label="HPF Frequency" caption="" disabled={selectedTargetKind==="master"} value={screenBlockValues.PREAMP.hpf} onChange={next=>updateHardwareParameter("PREAMP","hpf",next,`HPF ${formatHpfFrequency(next)}`)}/><PanelLampKey label="In" controlId="hpf-in" disabled={selectedTargetKind==="master"||!selectedProcessingKnown("hpf-in")} known={selectedProcessingKnown("hpf-in")} active={screenBlockValues.PREAMP.hpfIn} title={`HPF In（${controlMode==="hardware-live"?"真机同步":"本地"}）`} onToggle={next=>updateHardwareParameter("PREAMP","hpfIn",next,`HPF ${next?"In":"Out"}`)}/></div></section>
        </div>
        <section className="qu-hardware-block parametric-eq"><h3>Parametric EQ</h3><div className="qu-peq-grid"><i className="qu-peq-pk">Pk</i>{peqBands.map(band=>{
          const bandKey=band.toLowerCase();
          const widthKey=`${bandKey}Width`;
          const gainKey=`${bandKey}Gain`;
          return <div className="qu-peq-band" key={band}><HardwareKnob label={`${band} Width`} caption="" value={screenBlockValues.PEQ[widthKey]} onChange={next=>updateHardwareParameter("PEQ",widthKey,next,`${band} Width ${formatPeqWidth(next)}`)}/><span>Width</span><HardwareKnob label={`${band} Frequency`} caption="" value={screenBlockValues.PEQ[bandKey]} onChange={next=>updateHardwareParameter("PEQ",bandKey,next,`${band} Freq ${formatScreenFrequency(next)}`)}/><span>Freq</span><HardwareKnob label={`${band} Gain`} caption="" value={screenBlockValues.PEQ[gainKey]} onChange={next=>updateHardwareParameter("PEQ",gainKey,next,`${band} Gain ${formatPeqGain(next)}`)}/><span>Gain</span><b>{band}</b></div>;
        })}<div className="qu-peq-in"><PanelLampKey label="In" controlId="peq-in" disabled={!selectedProcessingKnown("peq-in")} known={selectedProcessingKnown("peq-in")} active={screenBlockValues.PEQ.in} title={`Parametric EQ In（${controlMode==="hardware-live"?"真机同步":"本地"}）`} onToggle={next=>updateHardwareParameter("PEQ","in",next,`PEQ ${next?"In":"Out"}`)}/></div></div></section>
        <div className="qu-dynamics-bank">
          <div className="qu-dynamics-top">
            <section className="qu-hardware-block gate" data-applicable={selectedTargetKind==="source"?"true":"false"}><h3>Gate</h3><div className="qu-dynamics-body"><div className="qu-threshold-knob"><span>Thresh</span><HardwareKnob label="Gate Threshold" caption="" disabled={selectedTargetKind==="master"} value={screenBlockValues.GATE.threshold} className="large" onChange={next=>updateHardwareParameter("GATE","threshold",next,`Gate Threshold ${formatScreenParameter(screenBlockDefinitions.GATE.parameters[0],next)}`)}/><i className="qu-gr-led" title="Qu 控制协议不回传实时 Gate GR，保持熄灭">GR</i></div><PanelLampKey label="In" controlId="gate-in" disabled={selectedTargetKind==="master"||!selectedProcessingKnown("gate-in")} known={selectedProcessingKnown("gate-in")} active={screenBlockValues.GATE.in} indicator title={`Gate In（${controlMode==="hardware-live"?"真机同步":"本地"}）`} onToggle={next=>updateHardwareParameter("GATE","in",next,`Gate ${next?"In":"Out"}`)}/></div></section>
            <section className="qu-hardware-block comp"><h3>Comp</h3><div className="qu-dynamics-body"><i className={`qu-pk-led ${selectedPeakActive?"active":""}`.trim()}>Pk</i><div className="qu-threshold-knob"><span>Thresh</span><HardwareKnob label="Comp Threshold" caption="" value={screenBlockValues.COMP.threshold} className="large" onChange={next=>updateHardwareParameter("COMP","threshold",next,`Comp Threshold ${formatScreenParameter(screenBlockDefinitions.COMP.parameters[0],next)}`)}/><i className="qu-comp-gr" data-comp-gr="off" title="Qu 控制协议不回传实时 Compressor GR，保持熄灭">GR</i></div><PanelLampKey label="In" controlId="comp-in" disabled={!selectedProcessingKnown("comp-in")} known={selectedProcessingKnown("comp-in")} active={screenBlockValues.COMP.in} title={`Comp In（${controlMode==="hardware-live"?"真机同步":"本地"}）；GR 仅在取得真实衰减电平后点亮`} onToggle={next=>updateHardwareParameter("COMP","in",next,`Comp ${next?"In":"Out"}`)}/></div></section>
          </div>
          <div className="qu-dynamics-bottom">
            <section className="qu-hardware-block geq" data-geq-range={geqFaderMode} data-applicable={geqAvailable?"true":"false"}><h3>GEQ</h3><div className="qu-switch-body"><i className={`qu-pk-led ${masterPeakActive?"active":""}`.trim()}>Pk</i><PanelLampKey label="Fader Flip" controlId="geq-fader-flip" active={geqFaderMode!=="off"} disabled={!geqAvailable} indicator title={geqAvailable?`GEQ Fader Flip：本地导航；${geqFaderMode==="off"?"正常 Mix 模式":geqFaderMode==="low"?"低频段 31.5Hz–1kHz":"高频段 500Hz–16kHz"}；再次点击切换范围`:`${mix} 不提供 GEQ Fader Flip`} onToggle={cycleGeqFaderMode}/></div></section>
            <section className="qu-hardware-block pan" data-pan-enabled={panEnabled?"true":"false"}><h3>Pan</h3><div className="qu-pan-body"><div className="qu-pan-leds" aria-hidden="true" data-pan-tick={panTick}>{Array.from({length:7},(_,index)=><i className={index===panTick?"active":""} data-pan-index={index} key={index}/>)}</div><span className="qu-pan-sides"><i>L</i><i>R</i></span><HardwareKnob label={`Pan：${mix==="LR"?"LR 主声像":panEnabled?`${mix} 发送声像`:`${mix} 为单声道 Mix，Pan 禁用`}`} caption="" value={panValue} className="large" disabled={!panEnabled} onChange={next=>{updatePan(next);setScreenStatus(`${selectedTargetLabel} · ${mix} Pan ${next} · Local`)}}/></div></section>
          </div>
        </div>
      </div>
      <div className="qu-touchscreen" aria-label="Qu Touch Screen">
        <span className="qu-touchscreen-label">Touch Screen</span>
        <div className="qu-lcd-panel" data-screen-page={screenPage} data-screen-block={screenBlock} data-sync-mode="local-ui-only" data-sync-channel={selectedChannel+1} data-sync-source={selectedTargetKind==="master"?`master:${selectedMasterTarget}`:selectedSource.id} data-sync-target={selectedTargetKind} data-fn-selection={screenFnSelection}>
          {screenPage==="Processing"?<>
            <div className="qu-lcd-overview">
              <button type="button" disabled={selectedTargetKind==="master"} className={`qu-lcd-channel ${screenBlock==="PREAMP"?"active":""}`} onClick={()=>selectScreenBlock("PREAMP")} title={selectedTargetKind==="master"?"Mix Master 不提供 Preamp":"TouchChannel：选择前级处理"}>
                <strong>{selectedTargetKind==="master"?selectedMasterTarget:selectedSource.label}</strong><small>{selectedTargetKind==="master"?"MASTER":selectedSource.detail}</small><i/><span>{selectedTargetKind==="master"?"OUTPUT":formatScreenParameter(screenBlockDefinitions.PREAMP.parameters[0],screenBlockValues.PREAMP.gain)}</span><b>{selectedTargetKind==="master"?"MIX":formatScreenParameter(screenBlockDefinitions.PREAMP.parameters[1],screenBlockValues.PREAMP.source)}</b><em>{selectedTargetKind==="master"?"":screenBlockValues.PREAMP.hpfIn?"HPF":"OUT"}</em>
              </button>
              <button type="button" disabled={selectedTargetKind==="master"} className={`qu-lcd-gate ${screenBlock==="GATE"?"active":""}`} onClick={()=>selectScreenBlock("GATE")} title={selectedTargetKind==="master"?"Mix Master 不提供 Gate":"Touch Gate processing block"}>
                <strong>GATE</strong><small>{screenBlockValues.GATE.in?"IN":"OUT"}</small><span><i/></span>
              </button>
              <button type="button" className={`qu-lcd-chart ${screenBlock==="PEQ"?"active":""}`} onClick={()=>selectScreenBlock("PEQ")} title="Touch PEQ processing block">
                <strong>PEQ</strong><small>{screenBlockValues.PEQ.in?"IN":"OUT"}</small><TouchScreenCurve values={screenBlockValues.PEQ}/>
              </button>
              <button type="button" className={`qu-lcd-comp ${screenBlock==="COMP"?"active":""}`} onClick={()=>selectScreenBlock("COMP")} title="Touch Compressor processing block">
                <strong>COMP</strong><small>{screenBlockValues.COMP.in?"IN":"OUT"}</small><TouchScreenCurve mode="comp" values={screenBlockValues.COMP}/>
              </button>
            </div>
            <div className="qu-lcd-parameters" aria-label={`${screenBlock} Touch Screen parameter boxes`} data-parameter-block={screenBlock}>
              {screenParameters.map(parameter=>{
                const presentation=peqParameterPresentation(parameter);
                return <button type="button" key={parameter.key} data-screen-parameter={parameter.key} className={screenParameter===parameter.key?"active":""} onClick={()=>selectScreenParameter(parameter.key)} aria-pressed={screenParameter===parameter.key} title={`${screenBlock} ${parameter.label} parameter`}><strong>{formatScreenParameter(parameter,screenParameterValues[parameter.key])}</strong>{presentation.meta?<span>{presentation.meta}</span>:null}{presentation.note?<small>{presentation.note}</small>:null}</button>;
              })}
            </div>
          </>:<>
            <div className="qu-lcd-alt-page" data-selected-option={screenPageOptions[screenPage][screenMenuIndex]} data-applied-option={screenPageOptions[screenPage][screenAppliedIndex]}>
              <header><strong>{screenPage}</strong><span>{selectedTargetLabel}</span><small>{mix}</small></header>
              <div>{screenPageOptions[screenPage].map((option,index)=><button type="button" key={option} className={screenMenuIndex===index?"active":""} onClick={()=>{setScreenMenuIndex(index);setScreenAction("draft");setScreenStatus(`Preview locally: ${option}`)}} aria-pressed={screenMenuIndex===index}>{option}</button>)}</div>
            </div>
            <div className="qu-lcd-alt-detail" data-action-state={screenAction}><strong>{screenPageOptions[screenPage][screenMenuIndex]}</strong><span>{screenStatus||"Touch a parameter to select"}</span><button type="button" onClick={applyScreenOption}>Apply</button><button type="button" onClick={cancelScreenOption}>Cancel</button></div>
          </>}
          <div className="qu-lcd-status" data-local-status={screenStatus}><button type="button" onClick={()=>setScreenFnOpen(current=>!current)}>{screenFnLabels[screenPage]}</button><span>Curr:15 Polly</span><span>{screenStatus||"Next:16 Abee"}</span><i className={`qu-lcd-talk-status ${talkActive?"active":""}`} aria-label={talkActive?"Talk active":"Talk inactive"}>T</i><b>dS</b><Usb weight="bold"/></div>
          {screenFnOpen?<div className="qu-lcd-popup" role="dialog" aria-label={`${screenPage} options`}><strong>{screenPage} · {screenFnLabels[screenPage]}</strong>{screenFnOptions[screenPage].map(option=><button type="button" key={option} data-fn-option={option} onClick={()=>chooseScreenFnOption(option)}>{option}</button>)}<button type="button" onClick={()=>{setScreenStatus("Fn closed locally");setScreenFnOpen(false)}}>Close</button></div>:null}
        </div>
        <div className="qu-screen-controls" aria-label="Touch Screen hardware controls">
          <label className="qu-screen-fn"><span>Fn</span><button type="button" className={screenFnOpen?"active":""} aria-pressed={screenFnOpen} onClick={()=>setScreenFnOpen(current=>!current)} title="Function key：打开当前页面相关功能"/></label>
          <div className="qu-screen-edit-keys">
            <label><span>Copy</span><button type="button" onClick={copyScreenBlock} title={`Copy ${screenBlock} locally`}/></label>
            <label><span>Paste</span><button type="button" className="red" disabled={!screenClipboard[screenBlock]} onClick={pasteScreenBlock} title={`Paste ${screenBlock} locally`}/></label>
            <label><span>Reset</span><button type="button" className="red" onClick={resetScreenBlock} title={`Reset ${screenBlock} locally`}/></label>
          </div>
          <div className="qu-screen-rotary"><i/><HardwareKnob key={`screen-${selectedTargetKind}-${selectedTargetKind==="master"?selectedMasterTarget:selectedSource.id}-${screenBlock}-${screenParameter}`} label={`Screen Rotary ${selectedTargetLabel} ${screenBlock} ${screenParameter}`} caption="" value={screenRotaryValue} onChange={updateScreenParameter}/></div>
        </div>
      </div>
      <div className="qu-processing">
        {["Processing","Routing","Home","FX","Scenes","Setup"].map((item,index)=><label className={index<2?"green":""} key={item}><span>{item}</span><button className={screenPage===item?"active":""} type="button" aria-pressed={screenPage===item} onClick={()=>changeScreenPage(item)} title={{Processing:"所选通道的处理页面",Routing:"所选通道的路由页面",Home:"主页与用户层",FX:"4 组 RackFX 前后面板",Scenes:"场景存储与调用",Setup:"音频、控制、USB、I/O 与系统设置"}[item]}><i/></button></label>)}
      </div>
      <div className="qu-meter-bank" data-meter-source={meterLive?"qu16-monitor":localPaflMaster?`master:${localPaflMaster.label}`:localPaflId?`source:${localPaflId}`:"lr"} data-meter-transport={meterTransport} data-meter-age-ms={Math.round(meterAgeMs)} aria-label="L R 主电平表与 Talk">
        <div className="qu-main-meter">
          <div className="qu-main-meter-head"><span>L</span><b>dB</b><span>R</span></div>
          <div className="qu-main-meter-body">
            <MainMeterColumn side="L" activeSegments={leftMeterSegments}/>
            <div className="qu-main-meter-scale" aria-hidden="true">{mainMeterScale.map(label=><span key={label}>{label}</span>)}</div>
            <MainMeterColumn side="R" activeSegments={rightMeterSegments}/>
          </div>
          <div className={`qu-main-meter-pafl ${paflTargets.size?"active":""}`} data-lamp-state={paflTargets.size?"on":"off"}><i/><span>PAFL</span></div>
        </div>
        <div className="qu-talk-block"><span>Talk</span><button type="button" className={`qu-talk-key ${talkActive?"active":""}`} data-talk-state={talkActive?"on":"off"} aria-pressed={talkActive} title="Talk：默认按住讲话，松开关闭" onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);setTalkActive(true)}} onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);setTalkActive(false)}} onPointerCancel={()=>setTalkActive(false)} onBlur={()=>setTalkActive(false)} onKeyDown={event=>{if(event.key===" "||event.key==="Enter"){event.preventDefault();setTalkActive(true)}}} onKeyUp={event=>{if(event.key===" "||event.key==="Enter"){event.preventDefault();setTalkActive(false)}}}><i/></button></div>
      </div>
      <div className="qu-monitor-panel" aria-label="ST3 Qu-Drive Phones 与 Alt Out">
        <div className="qu-monitor-connectors">
          <div className="qu-st3-input"><span>ST3 IN</span><i className="qu-st3-jack" role="img" aria-label="ST3 3.5 毫米立体声输入插孔"/></div>
          <div className="qu-drive-port"><Usb weight="bold"/><i className="qu-drive-socket" role="img" aria-label="Qu-Drive USB Type-A 插口"/><span>Qu-Drive</span></div>
        </div>
        <div className="qu-phones-section">
          <div className="qu-phones-output"><Headphones weight="bold"/><i className="qu-phones-jack" role="img" aria-label="6.35 毫米耳机插孔"/></div>
          <div className="qu-monitor-level" data-monitor-control="phones"><span>Phones</span><HardwareKnob label="Phones Level" caption="" value={phonesLevel} className="monitor" onChange={setPhonesLevel}/><small><b>0</b><b>10</b></small></div>
        </div>
        <div className="qu-alt-out-section"><div className="qu-monitor-level" data-monitor-control="alt-out"><span>Alt Out</span><HardwareKnob label="Alt Out Level" caption="" value={altOutLevel} className="monitor" onChange={setAltOutLevel}/><small><b>0</b><b>10</b></small></div></div>
      </div>
    </section>

    <section className="qu-surface" aria-label="Qu-16 Layers、16 路电动推子、Master 与 Mix Select" data-sync-mode={controlMode} data-navigation-sync="local-ui-only" data-layer={layerMode} data-surface-mode={surfaceMode} data-active-mix={mix} data-last-hardware-key={lastHardwareChange?.key??""} data-last-hardware-value={lastHardwareChange?.value??""} data-last-hardware-revision={lastHardwareChange?.revision??""}>
      <div className="qu-channel-bank">
       <aside className="qu-layer-rail" aria-label="Mix Assign 与 Layers">
        <div className="qu-mix-assign">
          <SurfaceKey kind="modifier pre-fade" label="Pre Fade" active={surfaceMode==="preFade"} disabled={geqFaderMode!=="off"||mix==="LR"} onClick={()=>setSurfaceMode(current=>current==="preFade"?"select":"preFade")} title={mix==="LR"?"LR 不提供 Pre/Post 发送切换":"Pre Fade：点击锁定查看模式，再按各输入 Sel 切换当前 Mix 的 Pre/Post；再次点击退出（桌面鼠标辅助模式）"} data-surface-modifier="pre-fade"/>
          <SurfaceKey kind="modifier assign" label="Assign" active={surfaceMode==="assign"} disabled={geqFaderMode!=="off"} onClick={()=>setSurfaceMode(current=>current==="assign"?"select":"assign")} title="Assign：点击锁定查看模式，再按各 Sel 切换当前 Mix 分配；再次点击退出" data-surface-modifier="assign"/>
          <small>+ press Sel</small>
        </div>
        <div className="qu-layer-selector" data-layer={layerMode}>
          <strong>Layers</strong>
          <button type="button" className={`qu-layer-key upper ${layerMode==="upper"?"active":""}`} data-layer-select="upper" aria-label="Upper layer: ST, FX and Mix masters" aria-pressed={layerMode==="upper"} onClick={event=>changeLayer(event.shiftKey?"custom":"upper")} title="上层：ST、FX Return/Send 与 Mix Master；Shift+点击模拟同时按两层键进入 Custom"><i/><b/></button>
          <button type="button" className={`qu-custom-layer ${layerMode==="custom"?"active":""}`} data-layer-select="custom" aria-pressed={layerMode==="custom"} onClick={()=>changeLayer("custom")} title="Custom 指示/桌面快捷区：真机由上下两个 Layer 键同时按下进入"><span>Custom</span><b/></button>
          <button type="button" className={`qu-layer-key lower ${layerMode==="lower"?"active":""}`} data-layer-select="lower" aria-label="Lower layer: CH1 to CH16" aria-pressed={layerMode==="lower"} onClick={event=>changeLayer(event.shiftKey?"custom":"lower")} title="下层：CH1–CH16；Shift+点击模拟同时按两层键进入 Custom"><i/><b/></button>
        </div>
        <div className="qu-fader-legend" aria-hidden="true"><b>GEQ→</b><span>31 / 500</span><i>10</i><i>5</i><i>0</i><i>5</i><b>GEQ→</b></div>
        <span className="qu-layer-foot"><i className="qu-strip-screw"/></span>
       </aside>
       <div className="qu-channels">
        {activeLayerSources.map((source,index)=>{
          const bandIndex=geqRangeStart+index;
          const geqBand=geqFaderMode==="off"?null:{frequency:geqFrequencies[bandIndex],value:activeGeq[bandIndex],onChange:next=>updateGeqBand(bandIndex,next),onReset:()=>updateGeqBand(bandIndex,50)};
          const entityMaster=source.entityKind==="master"?(masterStates[source.masterTarget]??{level:50,muted:false}):null;
          const value=entityMaster?.level??surfaceLevels[mix]?.[source.id]??50;
          const selActive=source.entityKind==="input"?(surfaceMode==="assign"?(assignedByMix[mix]?.has(source.id)??false):surfaceMode==="preFade"?(preFadeByMix[mix]?.has(source.id)??false):undefined):undefined;
          const selected=source.entityKind==="master"?selectedTargetKind==="master"&&selectedMasterTarget===source.masterTarget:selectedTargetKind==="source"&&selectedSource.id===source.id;
          const muted=source.entityKind==="master"?entityMaster.muted:mutedSources.has(source.id);
          const paflId=source.entityKind==="master"?qu16MasterTargetId(source.masterTarget):source.id;
          const pafl=paflTargets.has(paflId);
          const meter=source.entityKind==="master"?(masterMeters[source.masterTarget]??disconnectedMeter):(sourceMeters[source.id]??disconnectedMeter);
          const rtaValue=finiteDbfs(geqRtaDbfs[bandIndex]);
          const rtaActive=Boolean(geqBand&&bandIndex===dominantRtaIndex);
          const selectDisabled=source.entityKind==="master"&&surfaceMode!=="select";
          const toggleMute=()=>updateMute(source,muted);
          const togglePafl=()=>updatePafl(paflId,pafl);
          return <QuChannel key={`${layerMode}-${source.id}-${source.masterTarget??"input"}`} index={index} value={value} source={source} layerMode={layerMode} selected={selected} muted={muted} pafl={pafl} meter={meter} rtaActive={rtaActive} rtaDbfs={rtaValue} selActive={selActive} selectDisabled={selectDisabled} onSelect={()=>handleStripSelect(index,source)} onMute={toggleMute} onPafl={togglePafl} onChange={next=>updateSurfaceFader(source,next)} geqBand={geqBand}/>;
        })}
       </div>
      </div>
      <div className="qu-master-bank">
       <aside className="qu-master-strip" data-master-mix={mix}>
        <SurfaceKey kind="mute" label="Mute" active={activeMaster.muted} onClick={()=>updateMute({entityKind:"master",masterTarget:mix},activeMaster.muted)} title={`Mute ${mix} Master · ${controlMode==="hardware-live"?"真机同步":"本地数字孪生状态"}`}/>
        <SurfaceKey kind="select" label="Sel" active={masterSelectActive} onClick={handleMasterSelect} title={surfaceMode==="select"?`选择 ${mix} Master Processing / Routing`:`切换 ${mix} 的全部输入 ${surfaceMode==="assign"?"Assign":"Pre/Post"}`}/>
        <SurfaceKey kind="pafl" label="PAFL" active={paflTargets.has(qu16MasterTargetId(mix))} onClick={()=>{const targetId=qu16MasterTargetId(mix);updatePafl(targetId,paflTargets.has(targetId))}} title={`PAFL ${mix} Master：默认 AFL；GEQ Fader Flip 时驱动 RTA 表`}/>
        <ChannelSignalMeter meter={masterMeter} meterRole={mix==="FX 1"||mix==="FX 2"?"rack-fx-input":null} label={mix==="FX 1"||mix==="FX 2"?`${mix} RackFX 实际输入（仅在同名 Mix→Return 默认 Patch 下等同 FX Send）`:`${mix} Master 推子后电平`}/>
        <div className="qu-master-ident"><button type="button" className={`qu-lr-key ${mix==="LR"?"active":""}`} data-mix-select="LR" aria-pressed={mix==="LR"} onClick={()=>chooseMix("LR")}><span>LR</span><i><b/></i></button><small>{mix==="FX 1"||mix==="FX 2"?"FX IN":"Master"}</small></div>
        <span className="qu-fader-head"><i className="qu-strip-screw"/></span>
        <FaderLane value={activeMaster.level} onChange={updateMaster} label={`${mix} Master 推子`}/>
        <span className="qu-strip-index"><i className="qu-strip-screw"/><b>M</b><small>{mix}</small></span>
       </aside>
       <aside className="qu-mix-select" aria-label="SoftKeys 与 Mix Select">
        <div className="qu-softkeys">{[1,2,3,4].map(key=>{
          const hardwareLive=controlMode==="hardware-live";
          return <button type="button" key={key} data-softkey={key} data-assignment={`mute-group-${key}`} data-sync-origin={hardwareLive?"mute-group-readback":"local-ui"} data-group-state={muteGroupStates[key-1]?"muted":"open"} className={muteGroupStates[key-1]?"active":""} aria-pressed={muteGroupStates[key-1]} disabled={hardwareLive} onClick={()=>setMuteGroupStates(current=>current.map((state,index)=>index===key-1?!state:state))} title={hardwareLive?`Mute Group ${key} 真机状态；Qu 协议不回传实体 Soft ${key} 的分配，只有真机将该 SoftKey 配成 MG${key} 时两者才对应`:`Soft ${key} · 本地演示 Mute Group ${key}`}><span>Soft {key}</span><i><b/></i></button>;
        })}</div>
        <strong><span>Mix</span><span>Select</span></strong>
        <div className="qu-mix-groups">
          {qu16MixSelectGroups.map(group=><div className={`qu-mix-group ${group.id}`} data-mix-group={group.id} key={group.id}>{group.targets.filter(item=>mixTargets.includes(item)).map(item=><button type="button" key={item} data-mix-select={item} data-mix-family={group.id} className={`qu-mix-key ${mix===item?"active":""}`} aria-pressed={mix===item} onClick={()=>chooseMix(item)} title={`选择 ${item}：Master 跟随，16 路电动推子切换为对应发送；再次点击返回 LR`}><span>{formatMixSurfaceLabel(item)}</span><i><b/></i></button>)}</div>)}
        </div>
       </aside>
       <span className="qu-master-mix-link" aria-hidden="true"/>
      </div>
    </section>
  </div>;
}

export const MixerWorkspace = memo(function MixerWorkspace({ model, meterSnapshot = null, meterStatus = null, parameterSnapshot = null, controlStatus = null, onWriteParameters = null, outputRestoreStatus = null, onRestoreOutputBaseline = null }) {
  const streamedMeterSnapshot=useSyncExternalStore(subscribeQu16MeterSnapshot,getQu16MeterSnapshot,getQu16MeterSnapshot);
  const effectiveMeterSnapshot=streamedMeterSnapshot??meterSnapshot;
  const meterAgeMs=Math.max(0,Date.now()-(Number(effectiveMeterSnapshot?.updatedAtMs)||0));
  const live=Boolean(effectiveMeterSnapshot?.connected)&&meterAgeMs<1500;
  const controlMode=controlStatus?.mode??"local-ui-only";
  const badgeLabel=controlMode==="hardware-live"
    ? live?"表计 + 参数 LIVE · 导航本地":"参数 LIVE · 表计超时 · 导航本地"
    : controlMode==="hardware-syncing"
      ? "控制同步中"
      : live
        ? "表计 LIVE · 控制本地"
        : effectiveMeterSnapshot?.connected?"表计超时 · 控制本地":controlStatus?.title??meterStatus?.title??"控制本地";
  const badgeTitle=[meterStatus?.message,controlStatus?.message].filter(Boolean).join(" · ");
  const reverbKey="send:ch-1:FX 1";
  const pendingReverb=parameterSnapshot?.pendingDetails?.[reverbKey]??null;
  const observedReverbRaw=Number(parameterSnapshot?.parameters?.[reverbKey]);
  const pendingReverbRaw=Number(pendingReverb?.expectedValue);
  const reverbRaw=Number.isInteger(pendingReverbRaw)?pendingReverbRaw:observedReverbRaw;
  const observedReverbValue=Number.isInteger(reverbRaw)&&reverbRaw>=0&&reverbRaw<=127?midiToUiValue(reverbRaw):null;
  const [reverbDraft,setReverbDraft]=useState(null);
  const [reverbWriteState,setReverbWriteState]=useState("idle");
  const reverbDraftRef=useRef(null);
  const reverbReady=controlMode==="hardware-live"
    && Boolean(parameterSnapshot?.connected)
    && Boolean(parameterSnapshot?.synced)
    && observedReverbValue!==null;
  const reverbValue=reverbDraft??observedReverbValue??0;
  useEffect(()=>{
    if(!pendingReverb&&reverbDraft!==null&&observedReverbValue===reverbDraft){
      reverbDraftRef.current=null;
      setReverbDraft(null);
      setReverbWriteState("confirmed");
    }
  },[observedReverbValue,pendingReverb,reverbDraft]);
  useEffect(()=>()=>{reverbDraftRef.current=null},[]);
  const commitReverb=async()=>{
    const next=reverbDraftRef.current;
    if(!reverbReady||next===null||next===observedReverbValue)return;
    setReverbWriteState("writing");
    const result=await onWriteParameters?.([{key:reverbKey,value:uiToMidiValue(next)}]);
    if(!result?.accepted){
      reverbDraftRef.current=null;
      setReverbDraft(null);
      setReverbWriteState("error");
      return;
    }
    setReverbWriteState("pending");
  };
  const updateReverbDraft=(event)=>{
    const next=Number(event.target.value);
    reverbDraftRef.current=next;
    setReverbDraft(next);
    setReverbWriteState("dirty");
  };
  const reverbTitle=!reverbReady
    ? "等待 Qu-16 完成真机参数同步"
    : reverbWriteState==="error"
      ? "CH1 混响写入失败，已恢复真机读数"
      : pendingReverb||reverbWriteState==="pending"
        ? `CH1/CH2 → FX1 ${reverbValue}% · 已发送，等待真机回读`
        : `CH1/CH2 → FX1 ${reverbValue}% · 真机回读`;
  return <section className="mixer-workspace" aria-label={`${model.displayName} 调音台工作区`} data-control-mode={controlMode}>
    <header><SlidersHorizontal weight="fill"/><div><b>{model.displayName}</b><small>音频 USB-B {model.audio.usbOutputs}×{model.audio.usbReturns} · 控制 Ethernet TCP {model.control.tcpPort}</small></div><span className={`mixer-model-badge ${live||controlMode==="hardware-live"?"live":""}`} title={badgeTitle}>{badgeLabel}</span><label className={`mixer-ch1-reverb ${pendingReverb||reverbWriteState==="pending"?"pending":""} ${reverbWriteState==="error"?"error":""}`} title={reverbTitle}><span>CH1/CH2 话筒混响</span><input style={{"--reverb-level":`${reverbValue}%`}} type="range" min="0" max="100" step="1" value={reverbValue} disabled={!reverbReady} aria-label="CH1/CH2 话筒混响大小" aria-valuetext={`${reverbValue}%`} onChange={updateReverbDraft} onPointerUp={commitReverb} onPointerCancel={commitReverb} onKeyUp={commitReverb} onBlur={commitReverb}/><em>{reverbReady?`${reverbValue}%`:"--"}</em></label><button type="button" className={`mixer-output-restore ${outputRestoreStatus?.state??"idle"}`} disabled={controlMode!=="hardware-live"||outputRestoreStatus?.busy} title={outputRestoreStatus?.message??"恢复 8/26 ST3 → LR 主输出基准"} onClick={onRestoreOutputBaseline}>{outputRestoreStatus?.busy?"恢复中…":"恢复 8/26 主输出"}</button></header>
    <div className="mixer-workspace-body"><MixerConsole model={model} meterSnapshot={effectiveMeterSnapshot} parameterSnapshot={parameterSnapshot} controlMode={controlMode} onWriteParameters={onWriteParameters}/></div>
  </section>;
});
