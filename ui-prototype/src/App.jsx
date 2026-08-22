import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  equalPowerGains,
  formatDuration,
  getAdjacentPlayableTrack,
  getNextPlayableTrack,
  isPlayableVideoSource,
  mediaAssetFingerprint,
  parseDuration,
} from "./media-runtime.js";
import { collectRhythmEvents } from "./rhythm-runtime.js";
import { reconcileStableAssets } from "./media-scan-stability.js";
import { lyricAtTime, parseLrc, selectLyricsDeck } from "./lyrics-runtime.js";
import {
  nextConfiguredId,
  rhythmEventMatchesRule,
  rhythmRuleOptions,
  selectDominantDeck,
} from "./rhythm-automation.js";
import {
  House, MusicNotes, VideoCamera, LightbulbFilament, SlidersHorizontal,
  DiceFive, Play, Pause, SkipBack, SkipForward, Lightning, Clock,
  SpeakerHigh, SpeakerSlash, ArrowsClockwise, MonitorPlay, WifiHigh, CheckCircle,
  GearSix, FloppyDisk, MusicNoteSimple, RepeatOnce, ListNumbers, Shuffle,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";

const demoTracks = [
  { title: "Neon Nights", artist: "Cyberwave", duration: "03:42", bpm: 126, tag: "电子节奏" },
  { title: "Midnight Drive", artist: "Synth Pulse", duration: "04:18", bpm: 124, tag: "合成器" },
  { title: "Glow Up", artist: "Luna Wave", duration: "03:15", bpm: 116, tag: "流行电子" },
  { title: "Electric Soul", artist: "Bass Horizon", duration: "04:05", bpm: 132, tag: "低音律动" },
  { title: "Starlight", artist: "Echo Machine", duration: "03:58", bpm: 120, tag: "旋律电子" },
  { title: "After Hours", artist: "King Session", duration: "04:22", bpm: 128, tag: "深夜律动" },
  { title: "City Pulse", artist: "Nova Lane", duration: "03:46", bpm: 122, tag: "城市律动" },
  { title: "Velvet Motion", artist: "Mira Cloud", duration: "04:11", bpm: 118, tag: "氛围流行" },
  { title: "Night Signal", artist: "Static Blue", duration: "03:37", bpm: 126, tag: "电子舞曲" },
  { title: "Golden Hour", artist: "Solar Echo", duration: "04:02", bpm: 114, tag: "暖场流行" },
  { title: "Laser Hearts", artist: "Violet Run", duration: "03:29", bpm: 130, tag: "高能舞曲" },
  { title: "Moonlit Bass", artist: "Low Horizon", duration: "04:26", bpm: 124, tag: "低音律动" },
  { title: "Electric Rain", artist: "Aster Drive", duration: "03:54", bpm: 121, tag: "合成器流行" },
  { title: "Open Floor", artist: "Club District", duration: "04:08", bpm: 128, tag: "派对舞曲" },
  { title: "Crystal Beat", artist: "Prism House", duration: "03:33", bpm: 125, tag: "浩室音乐" },
  { title: "Midnight Call", artist: "Rina North", duration: "04:17", bpm: 119, tag: "都市流行" },
  { title: "Neon River", artist: "Glass Avenue", duration: "03:51", bpm: 123, tag: "旋律电子" },
  { title: "High Voltage", artist: "Red Circuit", duration: "03:24", bpm: 132, tag: "高能电子" },
  { title: "Slow Orbit", artist: "Lunar Club", duration: "04:35", bpm: 108, tag: "舒缓氛围" },
  { title: "Flashback", artist: "Retro State", duration: "03:44", bpm: 120, tag: "复古舞曲" },
  { title: "Blue Frequency", artist: "Wave Union", duration: "04:06", bpm: 127, tag: "渐进电子" },
  { title: "Last Dance", artist: "Afterlight", duration: "04:28", bpm: 116, tag: "收场歌曲" },
  { title: "King's Arrival", artist: "Royal Sound", duration: "03:18", bpm: 129, tag: "欢迎音乐" },
  { title: "Morning Fade", artist: "Dawn Sequence", duration: "04:14", bpm: 112, tag: "结束氛围" },
];
const emptyDeckTrack = { title:"未装载歌曲", artist:"请从左侧曲库装载", duration:"00:00", bpm:"—", tag:"READY" };

const videos = [
  { name: "霓虹舞台", category: "舞台", duration: "04:20", src: "/assets/neon-stage.png" },
  { name: "红色激光", category: "激光", duration: "03:36", src: "/assets/red-laser.png" },
  { name: "绿色隧道", category: "氛围", duration: "05:08", src: "/assets/green-geometry.png" },
];
const blackScreenImage = { id: "black-screen", name: "黑屏", category: "全部", src: null, locked: true };
const resolutionTestImage = { id: "resolution-test", name: "清晰度测试图", category: "全部", src: "/assets/led-resolution-test.svg" };
const textPrograms = [
  { id: "text-welcome", name: "欢迎", text: "欢迎光临 KING CLUB", elements: [
    { id: "welcome-logo", kind: "svg", src: "/assets/king-club-logo-white.svg", x: 50, y: 31, scale: .72, color: "#25e3a0" },
    { id: "welcome-title", kind: "text", content: "欢迎光临 KING CLUB", x: 50, y: 59, scale: 1, color: "#ffffff" },
  ] },
  { id: "text-birthday", name: "生日", text: "生日快乐", elements: [
    { id: "birthday-title", kind: "text", content: "生日快乐", x: 50, y: 45, scale: 1.35, color: "#ffd76a" },
    { id: "birthday-name", kind: "text", content: "HAPPY BIRTHDAY", x: 50, y: 59, scale: .62, color: "#ffffff" },
  ] },
  { id: "text-celebrate", name: "庆祝", text: "今晚共同庆祝", elements: [
    { id: "celebrate-title", kind: "text", content: "今晚共同庆祝", x: 50, y: 46, scale: 1.15, color: "#ffffff" },
    { id: "celebrate-subtitle", kind: "text", content: "KING CLUB", x: 50, y: 59, scale: .56, color: "#25e3a0" },
  ] },
  { id: "text-logo", name: "品牌", text: "KING CLUB", elements: [
    { id: "brand-image", kind: "image", src: "/assets/neon-stage.png", x: 50, y: 43, scale: .58, color: "#7d5cff" },
    { id: "brand-title", kind: "text", content: "KING CLUB", x: 50, y: 68, scale: .8, color: "#ffffff" },
  ] },
];
const mediaTypes = [
  { id: "video", label: "视频", hint: "持续预览 · 点击上屏" },
  { id: "image", label: "图片", hint: "持续预览 · 点击上屏" },
  { id: "text", label: "文字", hint: "持续编辑 · 点击上屏" },
];
const mediaCategories = {
  video: ["全部", "舞台", "激光", "氛围", "节日", "宣传"],
  image: ["全部", "背景", "海报", "欢迎", "生日", "活动"],
};
const fallbackFontFamilies = ["Microsoft YaHei","Microsoft YaHei UI","SimHei","SimSun","FangSong","KaiTi","Arial","Arial Black","Georgia","Times New Roman"];
const loadRhythmRule = (key, fallback) => {
  try {
    const saved = window.localStorage.getItem(key);
    return rhythmRuleOptions.some(([id])=>id===saved) ? saved : fallback;
  } catch {
    return fallback;
  }
};

const weekdayPlaylists = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const specialPlaylists = ["情人节", "七夕", "万圣节", "圣诞节", "跨年", "店庆", "活动"];
// 首版先以本地示例预设展示；名称、时长与循环方式后续由“灯光管理”页面配置并保存。
const lights = [
  { id: 0, label: "绿色律动", duration: "01:20", loop: true },
  { id: 1, label: "紫色激光", duration: "00:48", loop: false },
  { id: 2, label: "暖场", duration: "02:00", loop: true },
  { id: 3, label: "全场闪烁", duration: "00:16", loop: false },
  { id: 4 },
  { id: 5, label: "舞台聚光", duration: "00:36", loop: true },
  { id: 6, label: "安静模式", duration: "03:00", loop: false },
  { id: 7 },
  { id: 8 },
  { id: 9 },
];
const fixtureControls = [
  { id: "beam", label: "光束", color: { r: 32, g: 232, b: 154 } },
  { id: "gatling", label: "加特林", color: { r: 255, g: 159, b: 72 } },
  { id: "moving-wash", label: "摇头染色", color: { r: 168, g: 88, b: 255 } },
  { id: "led", label: "LED", color: { r: 70, g: 167, b: 255 } },
];
const isLightColor = ({ r, g, b }) => (Number(r) * 0.299 + Number(g) * 0.587 + Number(b) * 0.114) > 172;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const rgbToHsv = ({ r, g, b }) => {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min;
  let hue = 0;
  if (delta) hue = max === red ? 60 * (((green - blue) / delta) % 6) : max === green ? 60 * ((blue - red) / delta + 2) : 60 * ((red - green) / delta + 4);
  return { h: (hue + 360) % 360, s: max ? delta / max : 0, v: max };
};
const hsvToRgb = ({ h, s, v }) => {
  const chroma = v * s, section = h / 60, x = chroma * (1 - Math.abs(section % 2 - 1)), match = v - chroma;
  const [red, green, blue] = section < 1 ? [chroma, x, 0] : section < 2 ? [x, chroma, 0] : section < 3 ? [0, chroma, x] : section < 4 ? [0, x, chroma] : section < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return { r: Math.round((red + match) * 255), g: Math.round((green + match) * 255), b: Math.round((blue + match) * 255) };
};
const defaultScreenTargets = [
  { name: "主 LED 屏", short: "主屏", status: "在线", endpoint: "DISPLAY-LED-MAIN" },
  { name: "DJ 台条屏", short: "条屏", status: "预留", endpoint: "DISPLAY-DJ-STRIP" },
  { name: "扩展屏幕 1", short: "扩展 1", status: "预留", endpoint: "" },
  { name: "扩展屏幕 2", short: "扩展 2", status: "预留", endpoint: "" },
];
const defaultMonitorTargets = [
  { name: "舞台全景", short: "舞台", status: "连接", source: "CAMERA-STAGE", src: "/assets/neon-stage.png" },
  { name: "DJ 台监控", short: "DJ 台", status: "连接", source: "CAMERA-DJ", src: "/assets/red-laser.png" },
  { name: "观众区监控", short: "观众区", status: "连接", source: "CAMERA-AUDIENCE", src: "/assets/green-geometry.png" },
  { name: "备用监控机位", short: "备用", status: "连接", source: "", src: "/assets/neon-stage.png" },
];
const nav = [
  ["首页", House], ["音乐管理", MusicNotes], ["视频管理", VideoCamera],
  ["灯光管理", LightbulbFilament], ["调音台", SlidersHorizontal], ["Avolites Tiger Touch Pro", DiceFive], ["设置", GearSix],
];
const playbackModes = [
  ["single", "单曲播放", MusicNoteSimple],
  ["repeat-one", "单曲循环", RepeatOnce],
  ["sequence", "顺序播放", ListNumbers],
  ["shuffle", "随机播放", Shuffle],
];
// 使用真实歌曲进度；固定秒数的 DJ 时间窗口只改变屏幕上的显示尺度，不改变歌曲速度。
// 峰值仅作为数据缓存，Canvas 只绘制当前可见窗口，避免数千个 DOM 柱状元素造成掉帧。
// A fixed real-time window makes a four-minute song and a one-hour mix move at
// the same pixels-per-second speed. Peak density grows with duration and is cached.
const WAVEFORM_WINDOW_SECONDS = 12;
const WAVEFORM_PEAK_COUNT = 1920;
const WAVEFORM_MAX_PEAK_COUNT = 65536;
const waveformPeakCount = (durationSeconds) => Math.min(
  WAVEFORM_MAX_PEAK_COUNT,
  Math.max(WAVEFORM_PEAK_COUNT, Math.ceil((Number(durationSeconds) || 0) * 16)),
);
const waveformWindowSeconds = (durationSeconds) => Math.min(
  Math.max(0, Number(durationSeconds) || 0),
  WAVEFORM_WINDOW_SECONDS,
);
const audioAnalysisKey = (track) => track?.path
  ? `${track.path}|${track.sizeBytes ?? 0}|${track.modifiedUnixMs ?? 0}`
  : null;

const loadTargetSettings = (key, defaults) => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key));
    return Array.isArray(saved) && saved.length === 4 ? saved : defaults;
  } catch {
    return defaults;
  }
};

const formatDateTime = (date) => {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

function MediaThumbnail({ item }) {
  const [duration, setDuration] = useState(item.duration ?? "--:--");
  if (!isPlayableVideoSource(item.src)) return <><img src={item.src} alt=""/><span>{duration}</span></>;
  return <>
    <video
      src={item.src}
      muted
      preload="metadata"
      playsInline
      onLoadedMetadata={(event)=>setDuration(formatDuration(event.currentTarget.duration))}
    />
    <span>{duration}</span>
  </>;
}

const buildWaveformPeaks = (key, count = 120) => {
  const offset = [...key].reduce((total, char) => total + char.charCodeAt(0), 0) % 29;
  return Array.from({ length: count }, (_, index) => {
    const position = index + offset;
    const primary = Math.abs(Math.sin(position * 0.23));
    const detail = Math.abs(Math.sin(position * 0.61));
    const envelope = 0.58 + Math.abs(Math.sin(position * 0.105)) * 0.42;
    return Math.round(12 + (primary * 0.5 + detail * 0.5) * envelope * 84);
  });
};

function WaveformCanvas({ peaks, beats = [], downbeats = [], bars = [], bpm = 0, progress, durationSeconds, side, seeking }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(0);
  const drawRef = useRef(() => {});
  const progressRef = useRef(progress);
  const amplitudeRange = useMemo(() => {
    if (!peaks?.length) return { floor:0, ceiling:1 };
    // v4 cache already contains an RMS/transient envelope in linear display space.
    const linear = peaks.map((value) => Math.max(0, Number(value) || 0) / 100).sort((a,b)=>a-b);
    const percentile = (ratio) => linear[Math.min(linear.length - 1, Math.floor((linear.length - 1) * ratio))] ?? 0;
    const floor = Math.max(0, percentile(0.04) * 0.72);
    const ceiling = Math.max(floor + 0.035, percentile(0.985));
    return { floor, ceiling };
  }, [peaks]);
  const modelRef = useRef({ peaks, beats, downbeats, bars, bpm, durationSeconds, side, amplitudeRange });
  const sizeRef = useRef({ width: 0, height: 0, pixelRatio: 1 });

  modelRef.current = { peaks, beats, downbeats, bars, bpm, durationSeconds, side, amplitudeRange };

  drawRef.current = (seconds) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const { width, height, pixelRatio } = sizeRef.current;
    const { peaks: sourcePeaks, beats: beatTimes, downbeats: downbeatTimes, bars: barTimes, bpm: detectedBpm, durationSeconds: duration, side: channel, amplitudeRange: range } = modelRef.current;
    if (!canvas || !context || !width || !height) return;
    context.clearRect(0, 0, width, height);
    if (!duration || sourcePeaks.length === 0) return;

    const safeProgress = Math.min(duration, Math.max(0, Number(seconds) || 0));
    const visibleDuration = waveformWindowSeconds(duration);
    const startSeconds = safeProgress - visibleDuration / 2;
    const endSeconds = startSeconds + visibleDuration;
    const centerY = height / 2;
    const isDeckTwo = channel === "two";
    const bright = isDeckTwo ? "#55aaff" : "#40eeb0";
    const dim = isDeckTwo ? "#1e5d92" : "#177957";
    const glow = isDeckTwo ? "rgba(55,151,255,.25)" : "rgba(32,232,154,.22)";
    const gradient = context.createLinearGradient(0, 0, 0, height);

    gradient.addColorStop(0, dim);
    gradient.addColorStop(0.44, bright);
    gradient.addColorStop(0.56, bright);
    gradient.addColorStop(1, dim);

    const drawTimeMarkers = (times, color, markerWidth, topRatio = 0.08) => {
      if (!Array.isArray(times) || !times.length || visibleDuration <= 0) return;
      context.save();
      context.strokeStyle = color;
      context.lineWidth = Math.max(pixelRatio * markerWidth, 1);
      context.beginPath();
      for (const time of times) {
        if (time < startSeconds || time > endSeconds) continue;
        const x = ((time - startSeconds) / visibleDuration) * width;
        context.moveTo(x, height * topRatio);
        context.lineTo(x, height * (1 - topRatio));
      }
      context.stroke();
      context.restore();
    };

    // Each cached peak owns a fixed timestamp. We move those fixed points past
    // the playhead instead of re-sampling new heights at fixed screen columns;
    // this is what prevents the waveform from visually boiling while scrolling.
    const envelope = [];
    const lastPeakIndex = Math.max(1, sourcePeaks.length - 1);
    const peakStepSeconds = duration / lastPeakIndex;
    const firstVisibleIndex = Math.max(0, Math.floor(Math.max(0,startSeconds) / peakStepSeconds) - 2);
    const lastVisibleIndex = Math.min(sourcePeaks.length - 1, Math.ceil(Math.min(duration,endSeconds) / peakStepSeconds) + 2);
    const normalizedAt = (index) => {
      const safeIndex=Math.min(sourcePeaks.length-1,Math.max(0,index));
      const linearPeak=Math.max(0,Number(sourcePeaks[safeIndex])||0)/100;
      return Math.min(1,Math.max(0,(linearPeak-range.floor)/(range.ceiling-range.floor)));
    };
    for (let peakIndex=firstVisibleIndex;peakIndex<=lastVisibleIndex;peakIndex+=1) {
      const level=normalizedAt(peakIndex);
      const neighbors=(normalizedAt(peakIndex-1)+normalizedAt(peakIndex+1))/2;
      const transient=Math.max(0,level-neighbors);
      const stableLevel=Math.min(1,Math.max(0,level*0.88+neighbors*0.12+transient*0.62));
      const sampleTime=peakIndex*peakStepSeconds;
      const x=((sampleTime-startSeconds)/visibleDuration)*width;
      envelope.push({x,halfHeight:Math.max(pixelRatio*0.65,Math.pow(stableLevel,1.12)*height*0.47)});
    }

    // A translucent continuous envelope makes quiet passages, phrases and
    // drum transients readable; fine vertical strokes preserve the DJ-deck look.
    if (envelope.length) {
      context.save();
      context.fillStyle = gradient;
      context.globalAlpha = 0.24;
      context.shadowColor = glow;
      context.shadowBlur = Math.min(4 * pixelRatio, 6);
      context.beginPath();
      context.moveTo(envelope[0].x, centerY - envelope[0].halfHeight);
      for (const point of envelope) context.lineTo(point.x, centerY - point.halfHeight);
      for (let index = envelope.length - 1; index >= 0; index -= 1) {
        const point = envelope[index];
        context.lineTo(point.x, centerY + point.halfHeight);
      }
      context.closePath();
      context.fill();
      context.restore();
    }

    context.save();
    context.strokeStyle = gradient;
    context.globalAlpha = 0.76;
    context.lineWidth = Math.max(1, pixelRatio * 0.72);
    context.lineCap = "butt";
    context.shadowColor = glow;
    context.shadowBlur = Math.min(3 * pixelRatio, 5);
    context.beginPath();
    for (const point of envelope) {
      context.moveTo(point.x, centerY - point.halfHeight);
      context.lineTo(point.x, centerY + point.halfHeight);
    }
    context.stroke();
    context.restore();

    // Draw rhythm above the envelope so beats remain visible on loud/mastered tracks.
    let displayBeatTimes = beatTimes;
    let displayDownbeatTimes = downbeatTimes;
    let displayBarTimes = barTimes;
    let displayBpm = Number(detectedBpm) || 0;
    if (duration >= 600 && displayBpm >= 52 && displayBpm < 80) displayBpm *= 2;
    if (displayBpm >= 45 && displayBpm <= 220) {
      const interval = 60 / displayBpm;
      const visibleDetected = beatTimes.filter((time)=>time>=startSeconds&&time<=endSeconds).length;
      const expectedVisible = visibleDuration / interval;
      if (visibleDetected < expectedVisible * 0.58) {
        const anchor = downbeatTimes[0] ?? beatTimes[0] ?? 0;
        const firstIndex = Math.floor((startSeconds-anchor)/interval)-1;
        const generatedBeats=[];
        const generatedDownbeats=[];
        for(let index=firstIndex;index<=firstIndex+Math.ceil(expectedVisible)+3;index+=1){
          const time=anchor+index*interval;
          if(time<startSeconds||time>endSeconds||time<0||time>duration)continue;
          generatedBeats.push(time);
          if(((index%4)+4)%4===0)generatedDownbeats.push(time);
        }
        displayBeatTimes=generatedBeats;
        displayDownbeatTimes=generatedDownbeats;
        displayBarTimes=generatedDownbeats;
      }
    }
    drawTimeMarkers(displayBeatTimes, isDeckTwo ? "rgba(85,170,255,.46)" : "rgba(64,238,176,.46)", 0.72, 0.3);
    drawTimeMarkers(displayDownbeatTimes, isDeckTwo ? "rgba(110,190,255,.82)" : "rgba(95,255,195,.82)", 1.05, 0.13);
    drawTimeMarkers(displayBarTimes, "rgba(245,255,252,.96)", 1.25, 0.03);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const syncSize = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * pixelRatio));
      const height = Math.max(1, Math.round(bounds.height * pixelRatio));
      sizeRef.current = { width, height, pixelRatio };
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      drawRef.current(progressRef.current);
    };

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncSize);
    observer?.observe(canvas);
    window.addEventListener("resize", syncSize);
    syncSize();

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncSize);
    };
  }, []);

  useEffect(() => {
    window.cancelAnimationFrame(frameRef.current);
    const nextProgress = Math.min(durationSeconds, Math.max(0, Number(progress) || 0));
    const previousProgress = progressRef.current;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const shouldSnap = seeking || reducedMotion || Math.abs(nextProgress - previousProgress) > 1;

    if (shouldSnap) {
      progressRef.current = nextProgress;
      drawRef.current(nextProgress);
      return undefined;
    }

    const startedAt = performance.now();
    const animate = (now) => {
      const ratio = Math.min(1, (now - startedAt) / 240);
      const interpolatedProgress = previousProgress + (nextProgress - previousProgress) * ratio;
      progressRef.current = interpolatedProgress;
      drawRef.current(interpolatedProgress);
      if (ratio < 1) frameRef.current = window.requestAnimationFrame(animate);
    };

    frameRef.current = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frameRef.current);
  }, [progress, durationSeconds, peaks, beats, downbeats, bars, seeking]);

  useEffect(() => () => window.cancelAnimationFrame(frameRef.current), []);

  return <canvas ref={canvasRef} className={`track-waveform-canvas track-waveform-canvas-${side}`} aria-hidden="true" />;
}

function Deck({ number, track, analysis, onRhythmCorrection, playing, onPlay, onPrevious, onReplay, onNext, active, side, level, progress, onSeek, playbackMode, onPlaybackModeChange, lyricsEnabled, lyricsAvailable, vocalMode, accompanimentAvailable, onLyricsToggle, onVocalToggle }) {
  const demoWaveformPeaks = useMemo(() => buildWaveformPeaks(track.title, WAVEFORM_PEAK_COUNT), [track.title]);
  const dragRef = useRef(null);
  const [seekPreview, setSeekPreview] = useState(null);
  const [rhythmEditorOpen, setRhythmEditorOpen] = useState(false);
  const [rhythmSaving, setRhythmSaving] = useState(false);
  const [rhythmError, setRhythmError] = useState("");
  const [rhythmDraft, setRhythmDraft] = useState({ bpm:"120", firstDownbeatSeconds:"0", beatsPerBar:"4" });
  const durationSeconds = parseDuration(track.duration);
  const displayedProgress = Math.min(durationSeconds, Math.max(0, seekPreview ?? progress));
  const waveformPeaks = analysis?.peaks?.length ? analysis.peaks : track.path ? [] : demoWaveformPeaks;
  const analyzedBpm = Number(analysis?.bpm) > 0 ? Number(analysis.bpm).toFixed(1).replace(/\.0$/, "") : track.bpm;

  const openRhythmEditor = () => {
    const firstDownbeat = analysis?.correction?.firstDownbeatSeconds
      ?? analysis?.bars?.[0]
      ?? displayedProgress;
    setRhythmDraft({
      bpm:String(Number(analysis?.correction?.bpm ?? analysis?.bpm ?? 120).toFixed(2)).replace(/0+$/, "").replace(/\.$/, ""),
      firstDownbeatSeconds:Number(firstDownbeat).toFixed(3),
      beatsPerBar:String(analysis?.correction?.beatsPerBar ?? 4),
    });
    setRhythmError("");
    setRhythmEditorOpen(true);
  };

  const saveRhythmEditor = async () => {
    if (!onRhythmCorrection || rhythmSaving) return;
    const bpm = Number(rhythmDraft.bpm);
    const firstDownbeatSeconds = Number(rhythmDraft.firstDownbeatSeconds);
    const beatsPerBar = Number(rhythmDraft.beatsPerBar);
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300 || !Number.isFinite(firstDownbeatSeconds) || firstDownbeatSeconds < 0) {
      setRhythmError("请输入有效的 BPM 与第一拍时间");
      return;
    }
    setRhythmSaving(true);
    setRhythmError("");
    try {
      await onRhythmCorrection({
        bpm,
        firstDownbeatSeconds,
        beatsPerBar,
      });
      setRhythmEditorOpen(false);
    } catch (error) {
      setRhythmError(String(error));
    } finally {
      setRhythmSaving(false);
    }
  };

  useEffect(() => {
    dragRef.current = null;
    setSeekPreview(null);
    setRhythmEditorOpen(false);
  }, [track.title]);

  const previewSeek = (clientX) => {
    const drag = dragRef.current;
    if (!drag) return displayedProgress;
    const deltaSeconds = (clientX - drag.startX) / drag.width * waveformWindowSeconds(durationSeconds);
    const nextProgress = Math.min(durationSeconds, Math.max(0, drag.startProgress - deltaSeconds));
    setSeekPreview(nextProgress);
    return nextProgress;
  };

  const handleSeekStart = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const width = event.currentTarget.getBoundingClientRect().width;
    if (width <= 0) return;
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startProgress: displayedProgress,
      width,
    };
    setSeekPreview(displayedProgress);
  };

  const handleSeekMove = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    previewSeek(event.clientX);
  };

  const handleSeekEnd = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    const nextProgress = previewSeek(event.clientX);
    onSeek(nextProgress);
    dragRef.current = null;
    setSeekPreview(null);
    if (typeof event.currentTarget.hasPointerCapture === "function" && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleSeekCancel = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setSeekPreview(null);
  };

  const handleSeekKeyDown = (event) => {
    const step = event.shiftKey ? 10 : 2;
    let nextProgress = null;
    if (event.key === "ArrowLeft") nextProgress = displayedProgress - step;
    if (event.key === "ArrowRight") nextProgress = displayedProgress + step;
    if (event.key === "Home") nextProgress = 0;
    if (event.key === "End") nextProgress = durationSeconds;
    if (nextProgress === null) return;
    event.preventDefault();
    onSeek(Math.min(durationSeconds, Math.max(0, nextProgress)));
  };

  return <section className={`deck deck-channel-${side} ${active ? "deck-active" : ""}`}>
    <div className="deck-head"><span className="deck-number">DECK {number}</span><button type="button" className={`deck-play-toggle ${playing?"on":"paused"}`} onClick={onPlay} aria-label={`Deck ${number} ${playing?"暂停":"播放"}`} aria-pressed={playing} title={playing?"暂停":"播放"}>{playing?<Pause weight="fill"/>:<Play weight="fill"/>}</button></div>
    <div className="deck-track"><div className={`cover cover-${side}`}><MusicNotes weight="fill" /></div><div><h3>{track.title}</h3><p>{track.artist} · <button type="button" className="deck-bpm-button" disabled={!track.path||!analysis} onClick={openRhythmEditor} title="校正 BPM 与小节第一拍">{analyzedBpm} BPM</button>{analysis?.correction&&<span className="rhythm-corrected">已校正</span>}</p></div></div>
    <div className="waveform" role="progressbar" aria-label={`Deck ${number} 音量`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={level}><span style={{ width: `${level}%` }} /></div>
    <div
      className={`track-waveform track-waveform-${side} ${playing?"is-playing":""} ${seekPreview!==null?"is-seeking":""}`}
      role="slider"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={`Deck ${number} 播放进度，按住左右拖动调节`}
      aria-valuemin="0"
      aria-valuemax={durationSeconds}
      aria-valuenow={Math.round(displayedProgress)}
      aria-valuetext={`${formatDuration(displayedProgress)} / ${track.duration}`}
      title="按住并左右拖动调节播放进度"
      onPointerDown={handleSeekStart}
      onPointerMove={handleSeekMove}
      onPointerUp={handleSeekEnd}
      onPointerCancel={handleSeekCancel}
      onLostPointerCapture={handleSeekCancel}
      onKeyDown={handleSeekKeyDown}
    ><WaveformCanvas key={track.title} peaks={waveformPeaks} beats={analysis?.beats} downbeats={analysis?.downbeats} bars={analysis?.bars} bpm={analysis?.bpm} progress={displayedProgress} durationSeconds={durationSeconds} side={side} seeking={seekPreview!==null} />{track.path&&!analysis&&<span className="waveform-pending">波形与节拍分析中</span>}</div>
    <div className="time-row"><span>{formatDuration(displayedProgress)}</span><span>{track.duration}</span></div>
    <div className="deck-bottom-controls">
      <div className="transport" role="group" aria-label={`Deck ${number} 曲目控制`}><button type="button" className="track-step previous" aria-label={`Deck ${number} 装载上一首并暂停`} title="装载上一首（暂停）" onClick={onPrevious}><SkipBack weight="fill" /></button><button type="button" className="track-step replay" aria-label={`Deck ${number} 从头重放当前歌曲`} title="从头重放" onClick={onReplay}><ArrowCounterClockwise weight="bold" /></button><button type="button" className="cue" aria-label={`Deck ${number} CUE 预留`} title="CUE 耳机预听将在接入独立监听声卡后启用" disabled><Clock /> CUE</button><button type="button" className="track-step next" aria-label={`Deck ${number} 装载下一首并暂停`} title="装载下一首（暂停）" onClick={onNext}><SkipForward weight="fill" /></button><button type="button" className={`deck-extra-toggle lyrics-toggle ${lyricsEnabled?"active":""} ${!lyricsAvailable?"missing":""}`} aria-label={`Deck ${number} ${lyricsAvailable?(lyricsEnabled?"关闭":"打开"):"未找到"}歌词`} aria-pressed={lyricsEnabled&&lyricsAvailable} onClick={onLyricsToggle} title={lyricsAvailable?(lyricsEnabled?"关闭歌词":"打开歌词"):"未找到同名 LRC 歌词文件"}>{lyricsAvailable?"词":"无词"}</button></div>
      <div className="deck-playback-modes" role="group" aria-label={`Deck ${number} 播放模式`}>{playbackModes.map(([id,label,Icon])=><button type="button" key={id} className={playbackMode===id?"active":""} aria-label={label} aria-pressed={playbackMode===id} onClick={()=>onPlaybackModeChange(id)} title={label}><Icon weight={playbackMode===id?"fill":"regular"}/></button>)}<button type="button" className="active vocal-toggle" aria-label={`Deck ${number} 当前${vocalMode==="original"?"原唱":"伴唱"}，点击切换`} aria-pressed={vocalMode==="accompaniment"} disabled={!accompanimentAvailable} onClick={onVocalToggle} title={!accompanimentAvailable?"伴唱音轨尚未生成":vocalMode==="original"?"当前原唱，点击切换为伴唱":"当前伴唱，点击切换为原唱"}>{vocalMode==="original"?"原唱":"伴唱"}</button></div>
    </div>
    {rhythmEditorOpen&&<div className={`rhythm-editor rhythm-editor-${side}`} role="dialog" aria-label={`Deck ${number} 节拍网格校正`}>
      <header><b>节拍网格校正</b><button type="button" onClick={()=>setRhythmEditorOpen(false)}>关闭</button></header>
      <label><span>BPM</span><input type="number" min="30" max="300" step="0.01" value={rhythmDraft.bpm} onChange={event=>setRhythmDraft(current=>({...current,bpm:event.target.value}))}/></label>
      <label><span>小节第一拍（秒）</span><input type="number" min="0" step="0.001" value={rhythmDraft.firstDownbeatSeconds} onChange={event=>setRhythmDraft(current=>({...current,firstDownbeatSeconds:event.target.value}))}/></label>
      <div className="rhythm-nudge"><button type="button" onClick={()=>setRhythmDraft(current=>({...current,firstDownbeatSeconds:(Math.max(0,Number(current.firstDownbeatSeconds)-.01)).toFixed(3)}))}>−10 ms</button><button type="button" onClick={()=>setRhythmDraft(current=>({...current,firstDownbeatSeconds:displayedProgress.toFixed(3)}))}>当前播放位置设为第一拍</button><button type="button" onClick={()=>setRhythmDraft(current=>({...current,firstDownbeatSeconds:(Number(current.firstDownbeatSeconds)+.01).toFixed(3)}))}>+10 ms</button></div>
      <label><span>每小节拍数</span><select value={rhythmDraft.beatsPerBar} onChange={event=>setRhythmDraft(current=>({...current,beatsPerBar:event.target.value}))}><option value="3">3/4</option><option value="4">4/4</option><option value="6">6/8</option></select></label>
      {rhythmError&&<p className="rhythm-error" role="alert">{rhythmError}</p>}
      <footer><small>保存后波形、灯光与视频统一使用此网格</small><button type="button" disabled={rhythmSaving} onClick={saveRhythmEditor}>{rhythmSaving?"保存中":"保存校正"}</button></footer>
    </div>}
  </section>;
}

const defaultMediaTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, fit: "cover", mode: "uniform" };
const LED_LOGICAL_WIDTH = 2048;
const LED_LOGICAL_HEIGHT = 2304;
// The editor exposes familiar point-like values (28, 36, ...), while all output
// surfaces render from one fixed LED coordinate system. 3.2 preserves the
// existing size on the 640 CSS-pixel-wide output and makes smaller previews a
// true proportional representation instead of a second, independently sized UI.
const LED_TEXT_UNIT_SCALE = 3.2;

export function MediaOutputScreen({ media, track, lyrics = null, transform = defaultMediaTransform, allowAudio = false, editable = false, selectedElementId = null, selectedElementIds = [], onElementSelect, onElementChange, onEditStart }) {
  const screenRef = useRef(null);
  const overlayDragRef = useRef(null);
  const inlineEditorRef = useRef(null);
  const [inlineEditingId,setInlineEditingId] = useState(null);
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    let frame = 0;
    const updateLogicalScale = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = screen.getBoundingClientRect();
        const scale = Math.min(rect.width / LED_LOGICAL_WIDTH, rect.height / LED_LOGICAL_HEIGHT);
        if (Number.isFinite(scale) && scale > 0) screen.style.setProperty("--led-logical-scale", String(scale));
      });
    };
    updateLogicalScale();
    const observer = new ResizeObserver(updateLogicalScale);
    observer.observe(screen);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  },[]);
  useEffect(() => {
    const editor = inlineEditorRef.current;
    if (!editor || !inlineEditingId) return;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  },[inlineEditingId]);
  const beginElementDrag = (element, kind, event) => {
    if (!editable) return;
    event.preventDefault();
    event.stopPropagation();
    onElementSelect?.(element.id,{toggle:event.ctrlKey||event.shiftKey,preserve:selectedElementIds.includes(element.id)&&!event.ctrlKey&&!event.shiftKey});
    const canvas = event.currentTarget.closest(".led-text-canvas");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const centerX = rect.left + rect.width * element.x / 100;
    const centerY = rect.top + rect.height * element.y / 100;
    const elementRect = event.currentTarget.closest(".text-overlay-element")?.getBoundingClientRect();
    overlayDragRef.current = {
      pointerId:event.pointerId, element, kind, rect,
      startX:event.clientX, startY:event.clientY,
      startDistance:Math.max(12,Math.hypot(event.clientX-centerX,event.clientY-centerY)),
      elementRect,
      scaleX:element.scaleX ?? element.scale ?? 1,
      scaleY:element.scaleY ?? element.scale ?? 1,
      remembered:false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveElementDrag = (event) => {
    const drag = overlayDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.remembered) {
      if (Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY) < 1) return;
      onEditStart?.();
      drag.remembered = true;
    }
    if (drag.kind === "move") {
      onElementChange?.(drag.element.id,{
        x:clamp(drag.element.x+(event.clientX-drag.startX)/drag.rect.width*100,0,100),
        y:clamp(drag.element.y+(event.clientY-drag.startY)/drag.rect.height*100,0,100),
      });
      return;
    }
    const position = drag.kind.replace("resize-","");
    if (["nw","ne","se","sw"].includes(position)) {
      const centerX = drag.rect.left + drag.rect.width * drag.element.x / 100;
      const centerY = drag.rect.top + drag.rect.height * drag.element.y / 100;
      const distance = Math.hypot(event.clientX-centerX,event.clientY-centerY);
      const factor = distance / drag.startDistance;
      onElementChange?.(drag.element.id,{scaleX:clamp(drag.scaleX*factor,.2,3),scaleY:clamp(drag.scaleY*factor,.2,3)});
      return;
    }
    if (position === "e" || position === "w") {
      const direction = position === "e" ? 1 : -1;
      const factor = 1 + direction * (event.clientX-drag.startX) * 2 / Math.max(20,drag.elementRect?.width ?? 20);
      onElementChange?.(drag.element.id,{scaleX:clamp(drag.scaleX*factor,.2,4)});
      return;
    }
    const direction = position === "s" ? 1 : -1;
    const factor = 1 + direction * (event.clientY-drag.startY) * 2 / Math.max(20,drag.elementRect?.height ?? 20);
    onElementChange?.(drag.element.id,{scaleY:clamp(drag.scaleY*factor,.2,4)});
  };
  const endElementDrag = (event) => {
    if (overlayDragRef.current?.pointerId !== event.pointerId) return;
    overlayDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const baseMedia = media.type === "text" ? media.baseMedia ?? { type: "image", src: null } : media;
  const style = !baseMedia.src ? { background: baseMedia.background ?? "#000" } : undefined;
  return <div ref={screenRef} className={`led-screen ${baseMedia.type === "image" && !baseMedia.src ? "black-output" : ""}`} style={style}>
    {baseMedia.src&&(isPlayableVideoSource(baseMedia.src)
      ? <video className={`media-source fit-${transform.fit}`} src={baseMedia.src} autoPlay loop playsInline muted={!allowAudio||baseMedia.muted!==false} draggable="false" style={{left:`${50+transform.x}%`,top:`${50+transform.y}%`,transform:`translate(-50%,-50%) scale(${transform.scaleX},${transform.scaleY})`}}/>
      : <img className={`media-source fit-${transform.fit}`} src={baseMedia.src} alt="" draggable="false" style={{left:`${50+transform.x}%`,top:`${50+transform.y}%`,transform:`translate(-50%,-50%) scale(${transform.scaleX},${transform.scaleY})`}}/>)}
    {media.type === "text"&&<div className={`led-text-canvas ${editable?"is-editable":""}`} onPointerDown={editable?(event)=>{if(event.target===event.currentTarget)onElementSelect?.(null)}:undefined} onPointerMove={moveElementDrag} onPointerUp={endElementDrag} onPointerCancel={endElementDrag}>
      {editable && !(media.elements ?? []).length && <div className="text-empty-editor-hint"><b>新图文画面</b><small>请从右侧选择预设模板后开始编辑</small></div>}
      {(media.elements ?? []).map((element)=>{const scaleX=element.scaleX??element.scale??1;const scaleY=element.scaleY??element.scale??1;const shadowEnabled=element.kind!=="image"&&element.shadowEnabled!==false;return <div
        key={element.id}
        role={editable?"button":undefined}
        tabIndex={editable?0:undefined}
        className={`text-overlay-element kind-${element.kind} ${selectedElementIds.includes(element.id)?"selected":""} ${inlineEditingId===element.id?"inline-editing":""} ${element.enterAnimation==="fly-in"?"animate-fly-in":""}`}
        style={{left:`${element.x}%`,top:`${element.y}%`,transform:`translate(-50%,-50%) scale(${scaleX},${scaleY})`,color:element.color,"--element-shadow":shadowEnabled?(element.shadowColor??"#000000"):"transparent","--handle-scale-x":1/scaleX,"--handle-scale-y":1/scaleY}}
        onPointerDown={editable?(event)=>{if(inlineEditingId===element.id){event.stopPropagation();return}beginElementDrag(element,"move",event)}:undefined}
        onClick={editable?(event)=>event.stopPropagation():undefined}
        onDoubleClick={editable&&element.kind==="text"?(event)=>{event.preventDefault();event.stopPropagation();onElementSelect?.(element.id);onEditStart?.();setInlineEditingId(element.id)}:undefined}
        onKeyDown={editable?(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onElementSelect?.(element.id)}}:undefined}
      >
        {element.kind==="text"&&<b
          ref={inlineEditingId===element.id?inlineEditorRef:undefined}
          contentEditable={inlineEditingId===element.id}
          suppressContentEditableWarning
          spellCheck="false"
          style={{fontFamily:element.fontFamily??"inherit",fontSize:`${(element.fontSize??28)*LED_TEXT_UNIT_SCALE}px`,fontWeight:element.fontWeight??(element.bold?800:undefined),fontStyle:element.italic?"italic":undefined,textShadow:shadowEnabled?`0 0 ${10*LED_TEXT_UNIT_SCALE}px ${element.shadowColor??"#000000"}`:"none"}}
          onPointerDown={inlineEditingId===element.id?(event)=>event.stopPropagation():undefined}
          onDoubleClick={inlineEditingId===element.id?(event)=>event.stopPropagation():undefined}
          onBlur={inlineEditingId===element.id?(event)=>{onElementChange?.(element.id,{content:event.currentTarget.textContent??""});setInlineEditingId(null)}:undefined}
          onKeyDown={inlineEditingId===element.id?(event)=>{event.stopPropagation();if(event.key==="Enter"){event.preventDefault();event.currentTarget.blur()}else if(event.key==="Escape"){event.preventDefault();event.currentTarget.textContent=element.content;event.currentTarget.blur()}}:undefined}
        >{element.content}</b>}
        {element.kind==="svg"&&<i className="text-overlay-svg" style={{backgroundColor:element.color,maskImage:`url(${element.src})`,WebkitMaskImage:`url(${element.src})`}}/>}
        {element.kind==="image"&&<span className="text-overlay-image"><img src={element.src} alt=""/></span>}
        {editable&&selectedElementId===element.id&&inlineEditingId!==element.id&&<span className="text-resize-handles" aria-hidden="true">{["nw","n","ne","e","se","s","sw","w"].map((position)=><i key={position} className={`text-resize-handle handle-${position}`} onPointerDown={(event)=>beginElementDrag(element,`resize-${position}`,event)}/>)}</span>}
      </div>})}
    </div>}
    {lyrics?.text&&<div className={`led-lyrics-overlay lyrics-deck-${lyrics.deck}`} aria-live="off"><b>{lyrics.text}</b>{lyrics.nextText&&<small>{lyrics.nextText}</small>}</div>}
  </div>;
}

function FontFamilyPicker({ fonts, value, disabled, onChange }) {
  const [open,setOpen] = useState(false);
  const [query,setQuery] = useState("");
  const filtered = useMemo(()=>fonts.filter((font)=>font.toLowerCase().includes(query.trim().toLowerCase())).slice(0,120),[fonts,query]);
  return <div className="font-family-picker">
    <button type="button" className="font-picker-trigger" disabled={disabled} onClick={()=>setOpen((current)=>!current)} title={value}><span style={{fontFamily:value}}>{value}</span><i>⌄</i></button>
    {open&&<div className="font-picker-popup"><input autoFocus value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="搜索系统字体" onKeyDown={(event)=>{if(event.key==="Escape")setOpen(false)}}/><div className="font-picker-list">{filtered.map((font)=><button type="button" key={font} className={font===value?"active":""} style={{fontFamily:font}} onClick={()=>{onChange(font);setOpen(false);setQuery("")}}>{font}</button>)}{filtered.length===0&&<small>未找到字体</small>}</div></div>}
  </div>;
}

function TextProgramThumbnail({ program, slot }) {
  return <span className="text-thumb text-program-thumbnail">
    {slot&&<em>{slot}</em>}
    {(program.elements??[]).map((element)=>{const scaleX=element.scaleX??element.scale??1;const scaleY=element.scaleY??element.scale??1;return <i key={element.id} className={`thumb-element thumb-${element.kind}`} style={{left:`${element.x}%`,top:`${element.y}%`,transform:`translate(-50%,-50%) scale(${scaleX},${scaleY})`,color:element.color,fontFamily:element.fontFamily??"inherit",fontWeight:element.fontWeight??(element.bold?800:600),fontStyle:element.italic?"italic":undefined}}>{element.kind==="text"?element.content:element.kind==="svg"?<span style={{backgroundColor:element.color,maskImage:`url(${element.src})`,WebkitMaskImage:`url(${element.src})`}}/>:<img src={element.src} alt=""/>}</i>})}
    {!program.elements?.length&&<strong>{program.text??"空"}</strong>}
  </span>;
}

function TextFormatToolbar({ elements, fonts, onApply, onAlign, onUpload, saveSlot, onSave }) {
  const graphicInputRef = useRef(null);
  const primary = elements.at(-1) ?? {};
  const hasText = elements.some((element)=>element.kind==="text");
  const hasElements = elements.length > 0;
  const shadowElements = elements.filter((element)=>element.kind!=="image");
  const hasShadowElements = shadowElements.length > 0;
  const allShadowsEnabled = hasShadowElements && shadowElements.every((element)=>element.shadowEnabled!==false);
  const allFlyIn = hasElements && elements.every((element)=>element.enterAnimation==="fly-in");
  const allFadeOut = hasElements && elements.every((element)=>element.exitAnimation==="fade-out");
  return <div className="text-format-toolbar" role="toolbar" aria-label="图文元素编辑工具栏">
    <span className="text-selection-count">{hasElements?`已选 ${elements.length}`:"新图文"}</span>
    <label className="toolbar-color" title="元素颜色"><span>颜色</span><input type="color" disabled={!hasElements} value={primary.color??"#ffffff"} onChange={(event)=>onApply({color:event.target.value})}/></label>
    <div className="toolbar-group alignment-tools" aria-label="元素对齐">
      <button type="button" disabled={!hasElements} onClick={()=>onAlign("left")} title="左对齐" aria-label="左对齐"><i className="align-icon align-left"><span/><span/></i></button><button type="button" disabled={!hasElements} onClick={()=>onAlign("center-x")} title="水平居中" aria-label="水平居中"><i className="align-icon align-center-x"><span/><span/></i></button><button type="button" disabled={!hasElements} onClick={()=>onAlign("right")} title="右对齐" aria-label="右对齐"><i className="align-icon align-right"><span/><span/></i></button>
      <button type="button" disabled={!hasElements} onClick={()=>onAlign("top")} title="顶部对齐" aria-label="顶部对齐"><i className="align-icon align-top"><span/><span/></i></button><button type="button" disabled={!hasElements} onClick={()=>onAlign("center-y")} title="垂直居中" aria-label="垂直居中"><i className="align-icon align-center-y"><span/><span/></i></button><button type="button" disabled={!hasElements} onClick={()=>onAlign("bottom")} title="底部对齐" aria-label="底部对齐"><i className="align-icon align-bottom"><span/><span/></i></button>
    </div>
    <FontFamilyPicker fonts={fonts} value={primary.fontFamily??"Microsoft YaHei"} disabled={!hasText} onChange={(fontFamily)=>onApply({fontFamily},true)}/>
    <select className="font-weight-picker" aria-label="字体字重" value={String(primary.fontWeight??(primary.bold?800:400))} disabled={!hasText} onChange={(event)=>onApply({fontWeight:Number(event.target.value),bold:Number(event.target.value)>=700},true)}><option value="300">Light</option><option value="400">Regular</option><option value="500">Medium</option><option value="600">SemiBold</option><option value="700">Bold</option><option value="900">Heavy</option></select>
    <label className="toolbar-font-size"><span>字号</span><input type="number" min="10" max="96" value={primary.fontSize??28} disabled={!hasText} onChange={(event)=>onApply({fontSize:clamp(Number(event.target.value),10,96)},true)}/><em>pt</em></label>
    <button type="button" className={primary.bold?"active text-style-button":"text-style-button"} disabled={!hasText} aria-pressed={Boolean(primary.bold)} onClick={()=>onApply({bold:!primary.bold},true)} title="加粗"><b>B</b></button>
    <button type="button" className={primary.italic?"active text-style-button":"text-style-button"} disabled={!hasText} aria-pressed={Boolean(primary.italic)} onClick={()=>onApply({italic:!primary.italic},true)} title="斜体"><i>I</i></button>
    <button type="button" className={allShadowsEnabled?"active":""} disabled={!hasShadowElements} aria-pressed={allShadowsEnabled} onClick={()=>onApply({shadowEnabled:!allShadowsEnabled},false,true)} title={allShadowsEnabled?"关闭阴影":"打开阴影"}>阴影</button>
    <label className="toolbar-color" title="阴影颜色"><span>颜色</span><input type="color" disabled={!hasShadowElements||!allShadowsEnabled} value={shadowElements.at(-1)?.shadowColor??"#000000"} onChange={(event)=>onApply({shadowColor:event.target.value},false,true)}/></label>
    <button type="button" disabled={!hasElements} className={allFlyIn?"active":""} aria-pressed={allFlyIn} onClick={()=>onApply({enterAnimation:allFlyIn?null:"fly-in"})}>飞入</button>
    <button type="button" disabled={!hasElements} className={allFadeOut?"active":""} aria-pressed={allFadeOut} onClick={()=>onApply({exitAnimation:allFadeOut?null:"fade-out"})}>淡出</button>
    <div className="toolbar-group toolbar-upload-group" aria-label="图形素材">
      <input ref={graphicInputRef} type="file" accept="image/png,image/svg+xml,.png,.svg" hidden onChange={(event)=>{const file=event.target.files?.[0];if(file)onUpload(file);event.target.value="";}}/>
      <button type="button" className="toolbar-upload-graphic" onClick={()=>graphicInputRef.current?.click()} title="上传 PNG 或 SVG 图形" aria-label="上传 PNG 或 SVG 图形">PNG/SVG</button>
    </div>
    {saveSlot!==null&&<button type="button" className="toolbar-save-draft" onClick={onSave}>保存暂存 {saveSlot+1}</button>}
  </div>;
}

function MediaTransformEditor({ value, onChange }) {
  const dragRef = useRef(null);
  const beginDrag = (kind, event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.closest(".preview-pane").getBoundingClientRect();
    dragRef.current = { kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect, value };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.kind === "move") {
      onChange({ ...drag.value, x: clamp(drag.value.x + dx / drag.rect.width * 100, -100, 100), y: clamp(drag.value.y + dy / drag.rect.height * 100, -100, 100) });
      return;
    }
    if (drag.kind === "scale-x") {
      onChange({ ...drag.value, scaleX: clamp(drag.value.scaleX + dx / drag.rect.width * 2, .15, 4) });
      return;
    }
    if (drag.kind === "scale-y") {
      onChange({ ...drag.value, scaleY: clamp(drag.value.scaleY + dy / drag.rect.height * 2, .15, 4) });
      return;
    }
    if (drag.kind === "scale-free") {
      onChange({ ...drag.value, scaleX: clamp(drag.value.scaleX + dx / drag.rect.width * 2, .15, 4), scaleY: clamp(drag.value.scaleY + dy / drag.rect.height * 2, .15, 4) });
      return;
    }
    const delta = (dx / drag.rect.width + dy / drag.rect.height);
    const scale = clamp(drag.value.scaleX + delta, .15, 4);
    onChange({ ...drag.value, scaleX: scale, scaleY: scale });
  };
  const endDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.target.releasePointerCapture?.(event.pointerId);
  };
  const setMode = (fit) => {
    if (fit === "stretch") return onChange({ ...value, fit, mode: "free" });
    if (fit === "cover") {
      const scale = (value.scaleX + value.scaleY) / 2;
      return onChange({ ...value, fit, mode: "uniform", scaleX: scale, scaleY: scale });
    }
    onChange({ ...value, fit, mode: "uniform", x: 0, y: 0, scaleX: 1, scaleY: 1 });
  };
  return <div className="media-transform-editor" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
    <div className="media-transform-surface" onPointerDown={(event)=>beginDrag("move",event)} title="按住拖动，上下左右移动素材"/>
    <div className="media-transform-toolbar" role="group" aria-label="预览画面变换">
      <span>拖动移动</span>
      <button type="button" className={value.fit==="stretch"?"active":""} onClick={()=>setMode("stretch")}>自由拉伸</button>
      <button type="button" className={value.fit==="cover"?"active":""} onClick={()=>setMode("cover")}>等比</button>
      <button type="button" className={value.fit==="width"?"active":""} onClick={()=>setMode("width")}>锁宽</button>
      <button type="button" className={value.fit==="height"?"active":""} onClick={()=>setMode("height")}>锁高</button>
      <button type="button" onClick={()=>onChange(defaultMediaTransform)}>重置</button>
    </div>
    {value.mode==="free"&&<><button type="button" className="transform-handle handle-x" aria-label="横向拉伸" onPointerDown={(event)=>beginDrag("scale-x",event)}/><button type="button" className="transform-handle handle-y" aria-label="纵向拉伸" onPointerDown={(event)=>beginDrag("scale-y",event)}/></>}
    <button type="button" className="transform-handle handle-corner" aria-label={value.mode==="free"?"自由拉伸宽高":"等比缩放"} onPointerDown={(event)=>beginDrag(value.mode==="free"?"scale-free":"scale-uniform",event)}/>
  </div>;
}

function SettingsView({ screenTargets, monitorTargets, onScreenChange, onMonitorChange, onSave, dirty }) {
  return <section className="settings-view" aria-label="屏幕与监控设置">
    <header className="settings-header">
      <div><GearSix weight="fill"/><span><b>屏幕与监控按钮设置</b><small>左侧 4 个输出屏，右侧预览开关与 3 个监控机位</small></span></div>
      <button className="settings-save" onClick={onSave} disabled={!dirty}><FloppyDisk weight="fill"/>{dirty ? "保存配置" : "配置已保存"}</button>
    </header>
    <div className="settings-columns">
      <section className="settings-group">
        <div className="settings-group-title"><MonitorPlay weight="fill"/><b>输出屏幕</b><span>左侧 4 个固定位置</span></div>
        <div className="settings-list">
          {screenTargets.map((target, index) => <div className="settings-row" key={`screen-${index}`}>
            <strong>{String(index + 1).padStart(2, "0")}</strong>
            <label><span>按钮文字</span><input value={target.short} onChange={event=>onScreenChange(index,"short",event.target.value)} /></label>
            <label><span>屏幕名称</span><input value={target.name} onChange={event=>onScreenChange(index,"name",event.target.value)} /></label>
            <label><span>状态文字</span><input value={target.status} onChange={event=>onScreenChange(index,"status",event.target.value)} /></label>
            <label><span>输出设备 ID</span><input value={target.endpoint ?? ""} placeholder="未配置" onChange={event=>onScreenChange(index,"endpoint",event.target.value)} /></label>
          </div>)}
        </div>
      </section>
      <section className="settings-group">
        <div className="settings-group-title"><VideoCamera weight="fill"/><b>监控机位</b><span>右侧第 1 个位置固定为预览，其余 3 个可配置</span></div>
        <div className="settings-list monitor-settings">
          {monitorTargets.slice(1).map((target, offset) => {const index=offset+1;return <div className="settings-row" key={`monitor-${index}`}>
            <strong>{String(offset + 1).padStart(2, "0")}</strong>
            <label><span>按钮文字</span><input value={target.short} onChange={event=>onMonitorChange(index,"short",event.target.value)} /></label>
            <label><span>机位名称</span><input value={target.name} onChange={event=>onMonitorChange(index,"name",event.target.value)} /></label>
            <label><span>状态文字</span><input value={target.status} onChange={event=>onMonitorChange(index,"status",event.target.value)} /></label>
            <label><span>视频流地址 / 设备 ID</span><input value={target.source ?? ""} placeholder="未配置" onChange={event=>onMonitorChange(index,"source",event.target.value)} /></label>
          </div>})}
        </div>
      </section>
    </div>
  </section>;
}

export function App() {
  const desktopRuntime = Boolean(window.__TAURI_INTERNALS__);
  const workspaceRef = useRef(null);
  const previewPanelRef = useRef(null);
  const lightPanelRef = useRef(null);
  const [library, setLibrary] = useState(1);
  const [playlist, setPlaylist] = useState("周六");
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [deck1, setDeck1] = useState(0);
  const [deck2, setDeck2] = useState(1);
  // 首屏默认由 Deck 1 播放；Deck 2 是待播位，只有操作员手动点击播放才会出声。
  const [playingDecks, setPlayingDecks] = useState(() => desktopRuntime ? { 1: false, 2: false } : { 1: true, 2: false });
  const [deckProgress, setDeckProgress] = useState(() => desktopRuntime ? { 1: 0, 2: 0 } : { 1: 136, 2: 0 });
  const [crossfade, setCrossfade] = useState(28);
  const [deckPlaybackModes, setDeckPlaybackModes] = useState({ 1: "sequence", 2: "sequence" });
  const [deckLyricsEnabled, setDeckLyricsEnabled] = useState({ 1: true, 2: true });
  const [deckVocalModes, setDeckVocalModes] = useState({ 1: "original", 2: "original" });
  const [video, setVideo] = useState(0);
  const [videoAssets, setVideoAssets] = useState([]);
  const [audioAssets, setAudioAssets] = useState([]);
  const audioAssetsRef = useRef([]);
  const audioScanStabilityRef = useRef(new Map());
  const deckSelectionRef = useRef({ 1:null, 2:null });
  const [audioAnalyses, setAudioAnalyses] = useState({});
  const audioAnalysesRef = useRef({});
  const audioAnalysisPendingRef = useRef(new Set());
  const audioAnalysisQueueRef = useRef([]);
  const audioAnalysisWorkerRef = useRef(false);
  const audioAiQueuedRef = useRef(new Set());
  const audioAiQueueChainRef = useRef(Promise.resolve());
  const [mpvRuntime, setMpvRuntime] = useState({ available:false, checked:!desktopRuntime, version:null, message:desktopRuntime?"正在检测 mpv":"浏览器原型模式" });
  const deckOneAudioRef = useRef(null);
  const deckTwoAudioRef = useRef(null);
  const realAudioInitializedRef = useRef(false);
  const mpvLoadedPathsRef = useRef({ 1:null, 2:null });
  const mpvAutoplayAfterLoadRef = useRef({ 1:false, 2:false });
  const mpvEndingRef = useRef({ 1:false, 2:false });
  const mpvEofHandledRef = useRef({ 1:false, 2:false });
  const rhythmCursorRef = useRef({ 1:{ trackKey:null, seconds:0 }, 2:{ trackKey:null, seconds:0 } });
  const mpvEnabled = desktopRuntime && mpvRuntime.available;
  const tracks = useMemo(() => audioAssets.length ? audioAssets.map((item)=>({
    id:item.id,
    title:item.title || item.name,
    artist:item.artist || "未知歌手",
    duration:formatDuration(item.durationSeconds ?? 0),
    bpm:"—",
    tag:item.album || item.category || "本地音乐",
    src:item.src,
    path:item.path,
    sizeBytes:item.sizeBytes,
    modifiedUnixMs:item.modifiedUnixMs,
    lyrics:item.lyrics ?? "",
    lyricsPath:item.lyricsPath ?? null,
    lyricsModifiedUnixMs:item.lyricsModifiedUnixMs ?? null,
    vocalsPath:item.vocalsPath ?? null,
    accompanimentPath:item.accompanimentPath ?? null,
  })) : demoTracks.map((item)=>({...item,demo:true,tag:`演示 · ${item.tag}`})), [audioAssets]);
  const deckLyricsLines = useMemo(() => ({
    1:parseLrc(tracks[deck1]?.lyrics),
    2:parseLrc(tracks[deck2]?.lyrics),
  }), [tracks,deck1,deck2]);
  const lyricsDeck = selectLyricsDeck({
    playingDecks,
    enabledDecks:deckLyricsEnabled,
    availableDecks:{ 1:deckLyricsLines[1].length>0, 2:deckLyricsLines[2].length>0 },
    crossfade,
  });
  const activeLyrics = useMemo(() => {
    if (!lyricsDeck) return null;
    const line=lyricAtTime(deckLyricsLines[lyricsDeck],deckProgress[lyricsDeck]);
    if (!line) return null;
    return {
      deck:lyricsDeck,
      trackId:tracks[lyricsDeck===1?deck1:deck2]?.id ?? null,
      index:line.index,
      text:line.current.text,
      nextText:line.next?.text ?? "",
    };
  },[lyricsDeck,deckLyricsLines,deckProgress,tracks,deck1,deck2]);
  const audioAnalysisFingerprint = useMemo(
    () => audioAssets.map((item)=>audioAnalysisKey(item)).filter(Boolean).join("\n"),
    [audioAssets],
  );
  useEffect(() => {
    audioAssetsRef.current = audioAssets;
    deckSelectionRef.current = {
      1:tracks[deck1] ? { id:tracks[deck1].id, path:tracks[deck1].path } : null,
      2:tracks[deck2] ? { id:tracks[deck2].id, path:tracks[deck2].path } : null,
    };
  }, [audioAssets, deck1, deck2, tracks]);
  const [mediaLibraryDirectories, setMediaLibraryDirectories] = useState({ rootDirectory:"", videoDirectory:"", audioDirectory:"" });
  const [imageAssets, setImageAssets] = useState([]);
  const [systemFonts, setSystemFonts] = useState(fallbackFontFamilies);
  const [imageLibraryDirectory, setImageLibraryDirectory] = useState("");
  const [selectedImage, setSelectedImage] = useState(blackScreenImage.id);
  const [outputMedia, setOutputMedia] = useState({ ...blackScreenImage, type:"image" });
  const [hoverMedia, setHoverMedia] = useState(null);
  const [stagedMedia, setStagedMedia] = useState(null);
  const [stagedTransform, setStagedTransform] = useState(null);
  const [mediaTransforms, setMediaTransforms] = useState({});
  const [selectedTextElement, setSelectedTextElement] = useState(null);
  const [selectedTextElements, setSelectedTextElements] = useState([]);
  const [activeTextDraftSlot, setActiveTextDraftSlot] = useState(null);
  const [textDraftClearSlot, setTextDraftClearSlot] = useState(null);
  const textUndoRef = useRef([]);
  const copiedTextElementRef = useRef(null);
  const [textDrafts, setTextDrafts] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("king.textDrafts"));
      return Array.isArray(saved) ? [...saved.slice(0,4),...Array(4).fill(null)].slice(0,4) : Array(4).fill(null);
    } catch {
      return Array(4).fill(null);
    }
  });
  const [videoAudioEnabled, setVideoAudioEnabled] = useState(false);
  const [mediaType, setMediaType] = useState("video");
  const [mediaCategory, setMediaCategory] = useState("全部");
  const [light, setLight] = useState(0);
  const [autoLightPreset, setAutoLightPreset] = useState(0);
  const [lightRhythmRule, setLightRhythmRule] = useState(()=>loadRhythmRule("king.rhythm.lighting","bar"));
  const [videoRhythmRule, setVideoRhythmRule] = useState(()=>loadRhythmRule("king.rhythm.video","off"));
  const automationVideoIndexRef = useRef(-1);
  const [lightingEnabled, setLightingEnabled] = useState(true);
  const [lightPlaybackModes, setLightPlaybackModes] = useState(() => Object.fromEntries(lights.filter((item) => item.label).map((item) => [item.id, item.loop ? "loop" : "once"])));
  const [fixtureColorEditor, setFixtureColorEditor] = useState(null);
  const [fixtureColors, setFixtureColors] = useState(() => Object.fromEntries(fixtureControls.map((fixture) => [fixture.id, fixture.color])));
  const [screenTargets, setScreenTargets] = useState(() => loadTargetSettings("king.screenTargets", defaultScreenTargets));
  const [monitorTargets, setMonitorTargets] = useState(() => loadTargetSettings("king.monitorTargets", defaultMonitorTargets));
  const [screenTarget, setScreenTarget] = useState(0);
  const [monitorTarget, setMonitorTarget] = useState(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [ledOutputStatus, setLedOutputStatus] = useState({ connected: false, previewMode: false, message: "正在检测 LED 第二屏" });
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [activeNav, setActiveNav] = useState("首页");
  const [now, setNow] = useState(() => new Date());
  const effectiveLight = light === null ? autoLightPreset : light;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!desktopRuntime) return undefined;
    let disposed = false;
    invoke("mpv_runtime_status")
      .then((status)=>{if(!disposed)setMpvRuntime({...status,checked:true})})
      .catch((error)=>{if(!disposed)setMpvRuntime({available:false,checked:true,version:null,message:String(error)})});
    return ()=>{disposed=true};
  }, [desktopRuntime]);
  useEffect(() => {
    if (!audioAssets.length) return;
    setDeck1((current)=>Number.isInteger(current)&&current>=0&&current<audioAssets.length?current:0);
    setDeck2((current)=>Number.isInteger(current)&&current>=0&&current<audioAssets.length?current:(audioAssets.length>1?1:null));
    if (!realAudioInitializedRef.current) {
      realAudioInitializedRef.current = true;
      setDeckProgress({ 1:0, 2:0 });
      setPlayingDecks({ 1:false, 2:false });
    }
  },[audioAssets.length]);
  useEffect(() => {
    if (!desktopRuntime || !audioAssets.length) return undefined;
    const loadedPaths = new Set(Object.values(deckSelectionRef.current).map((item)=>item?.path).filter(Boolean));
    const orderedAssets = [...audioAssets].sort((left,right)=>Number(loadedPaths.has(right.path))-Number(loadedPaths.has(left.path)));
    for (const item of orderedAssets) {
      const key = audioAnalysisKey(item);
      const peakCount = waveformPeakCount(item.durationSeconds ?? Number(item.durationMs ?? 0) / 1000);
      const existing = audioAnalysesRef.current[key];
      if (!key || existing?.peaks?.length === peakCount || audioAnalysisPendingRef.current.has(key)) continue;
      audioAnalysisPendingRef.current.add(key);
      audioAnalysisQueueRef.current.push({ item, key, peakCount });
    }
    if (audioAnalysisWorkerRef.current) return undefined;
    audioAnalysisWorkerRef.current = true;
    const drainAnalysisQueue = async () => {
      // 单一常驻队列：扫描新增文件只追加任务，不取消正在解码的歌曲，也不并发分析大文件。
      while (audioAnalysisQueueRef.current.length) {
        const { item, key, peakCount } = audioAnalysisQueueRef.current.shift();
        try {
          const analysis = await invoke("analyze_audio_waveform", {
            path:item.path,
            sampleCount:peakCount,
          });
          if (analysis?.peaks?.length) {
            audioAnalysesRef.current = { ...audioAnalysesRef.current, [key]:analysis };
            setAudioAnalyses(audioAnalysesRef.current);
          }
        } catch (error) {
          console.error(`音频后台分析失败：${item.name ?? item.path}`, error);
        } finally {
          audioAnalysisPendingRef.current.delete(key);
        }
      }
      audioAnalysisWorkerRef.current = false;
    };
    drainAnalysisQueue();
    return undefined;
  }, [desktopRuntime, audioAnalysisFingerprint]);
  const saveTrackRhythmCorrection = async (track, correction) => {
    if (!track?.path) throw new Error("当前 Deck 没有可校正的本地歌曲");
    const analysis = await invoke("save_rhythm_correction", {
      path:track.path,
      sampleCount:waveformPeakCount(parseDuration(track.duration)),
      bpm:correction.bpm,
      firstDownbeatSeconds:correction.firstDownbeatSeconds,
      beatsPerBar:correction.beatsPerBar,
    });
    const key = audioAnalysisKey(track);
    audioAnalysesRef.current = { ...audioAnalysesRef.current, [key]:analysis };
    setAudioAnalyses(audioAnalysesRef.current);
    return analysis;
  };
  useEffect(() => {
    for (const [deckNumber, trackIndex] of [[1, deck1], [2, deck2]]) {
      const track = tracks[trackIndex];
      const trackKey = audioAnalysisKey(track);
      const analysis = audioAnalyses[trackKey];
      const currentSeconds = Number(deckProgress[deckNumber]) || 0;
      const cursor = rhythmCursorRef.current[deckNumber];
      if (!trackKey || cursor.trackKey !== trackKey || !playingDecks[deckNumber]) {
        rhythmCursorRef.current[deckNumber] = { trackKey, seconds:currentSeconds };
        continue;
      }
      const events = collectRhythmEvents(analysis, cursor.seconds, currentSeconds);
      rhythmCursorRef.current[deckNumber] = { trackKey, seconds:currentSeconds };
      for (const rhythmEvent of events) {
        window.dispatchEvent(new CustomEvent("king:rhythm", { detail:{
          ...rhythmEvent,
          deck:deckNumber,
          trackId:track.id,
          trackPath:track.path,
          observedAtSeconds:currentSeconds,
          lateByMs:Math.max(0, Math.round((currentSeconds - rhythmEvent.atSeconds) * 1000)),
          bpm:Number(analysis?.bpm) || 0,
          confidence:Number(analysis?.bpmConfidence) || 0,
        } }));
      }
    }
  }, [deckProgress, deck1, deck2, playingDecks, tracks, audioAnalyses]);
  useEffect(() => {
    const { deck1: deckOneGain, deck2: deckTwoGain } = equalPowerGains(crossfade);
    if (mpvEnabled) {
      if (mpvLoadedPathsRef.current[1]) invoke("mpv_deck_set_volume",{deck:1,volume:deckOneGain*100}).catch((error)=>console.error("Deck 1 mpv 音量设置失败",error));
      if (mpvLoadedPathsRef.current[2]) invoke("mpv_deck_set_volume",{deck:2,volume:deckTwoGain*100}).catch((error)=>console.error("Deck 2 mpv 音量设置失败",error));
      return;
    }
    if (deckOneAudioRef.current) deckOneAudioRef.current.volume = deckOneGain;
    if (deckTwoAudioRef.current) deckTwoAudioRef.current.volume = deckTwoGain;
  },[crossfade,tracks,mpvEnabled]);
  useEffect(() => {
    window.localStorage.setItem("king.textDrafts", JSON.stringify(textDrafts));
  }, [textDrafts]);
  useEffect(() => {
    window.localStorage.setItem("king.rhythm.lighting", lightRhythmRule);
    window.localStorage.setItem("king.rhythm.video", videoRhythmRule);
  }, [lightRhythmRule, videoRhythmRule]);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    invoke("scan_image_library")
      .then((library) => {
        setImageLibraryDirectory(library.directory ?? "");
        setImageAssets((library.items ?? []).map((item) => ({ ...item, id: item.path, src: convertFileSrc(item.path) })));
      })
      .catch((error) => console.error("扫描图片目录失败", error));
  }, []);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let disposed = false;
    const scan = () => invoke("scan_media_library")
      .then((library) => {
        if (disposed) return;
        setMediaLibraryDirectories({
          rootDirectory: library.rootDirectory ?? "",
          videoDirectory: library.videoDirectory ?? "",
          audioDirectory: library.audioDirectory ?? "",
        });
        const nextVideos = (library.videos ?? []).map((item) => ({
          ...item,
          id: `local-video:${item.path}`,
          type: "video",
          src: convertFileSrc(item.path),
          durationSeconds: Number(item.durationMs ?? 0) / 1000,
          duration: item.durationMs ? formatDuration(Number(item.durationMs) / 1000) : "--:--",
        }));
        const loadedPaths = Object.values(deckSelectionRef.current).map((item)=>item?.path).filter(Boolean);
        const stableAudio = reconcileStableAssets(
          audioAssetsRef.current,
          library.audio ?? [],
          audioScanStabilityRef.current,
          { preservePaths:loadedPaths, requiredUnchangedScans:1, minimumAgeMs:10_000 },
        );
        const nextAudio = stableAudio.map((item) => ({
          ...item,
          id: `local-audio:${item.path}`,
          type: "audio",
          src: convertFileSrc(item.path),
          durationSeconds: Number(item.durationMs ?? 0) / 1000,
        }));
        for (const item of nextAudio) {
          const sourceVersion = `${item.path}|${item.sizeBytes ?? 0}|${item.modifiedUnixMs ?? 0}`;
          if (audioAiQueuedRef.current.has(sourceVersion)) continue;
          audioAiQueuedRef.current.add(sourceVersion);
          // Keep fingerprinting and persistent AI-job creation strictly serial. This
          // only registers work; model inference runs in the separate Python worker.
          audioAiQueueChainRef.current = audioAiQueueChainRef.current
            .then(() => invoke("queue_audio_ai_analysis", { path:item.path }))
            .catch((error) => {
              audioAiQueuedRef.current.delete(sourceVersion);
              console.error(`AI 分析任务登记失败：${item.name ?? item.path}`, error);
            });
        }
        setVideoAssets((current)=>mediaAssetFingerprint(current)===mediaAssetFingerprint(nextVideos)?current:nextVideos);
        if (mediaAssetFingerprint(audioAssetsRef.current) !== mediaAssetFingerprint(nextAudio)) {
          const previousDecks = deckSelectionRef.current;
          const findTrackIndex = (selection, fallback) => {
            const matched = nextAudio.findIndex((item)=>item.path===selection?.path || item.id===selection?.id);
            if (matched >= 0) return matched;
            return nextAudio.length ? Math.min(Math.max(0, fallback ?? 0), nextAudio.length - 1) : null;
          };
          const nextDeck1 = findTrackIndex(previousDecks[1], 0);
          const nextDeck2 = findTrackIndex(previousDecks[2], nextAudio.length > 1 ? 1 : 0);
          audioAssetsRef.current = nextAudio;
          setDeck1(nextDeck1);
          setDeck2(nextDeck2 === nextDeck1 && nextAudio.length > 1 ? (nextDeck1 + 1) % nextAudio.length : nextDeck2);
          setAudioAssets(nextAudio);
        }
      })
      .catch((error) => console.error("扫描本地音视频目录失败", error));
    scan();
    const timer = window.setInterval(scan, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    invoke("list_system_fonts")
      .then((fonts)=>setSystemFonts(Array.isArray(fonts)&&fonts.length?fonts:fallbackFontFamilies))
      .catch((error)=>console.error("读取 Windows 系统字体失败",error));
  },[]);
  useEffect(() => {
    let lastTickAt = performance.now();
    const timer = window.setInterval(() => {
      const tickAt = performance.now();
      const elapsedSeconds = Math.max(0, (tickAt - lastTickAt) / 1000);
      lastTickAt = tickAt;
      setDeckProgress(current => {
        const next = { ...current };
        let changed = false;
        [[1, deck1], [2, deck2]].forEach(([deckNumber, trackIndex]) => {
          if (!playingDecks[deckNumber]) return;
          const track = tracks[trackIndex];
          if (!track || track.src) return;
          const duration = parseDuration(track.duration);
          const currentProgress = current[deckNumber] ?? 0;
          if (currentProgress >= duration) return;
          next[deckNumber] = Math.min(duration, currentProgress + elapsedSeconds);
          changed = true;
        });
        return changed ? next : current;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [deck1, deck2, playingDecks, tracks]);
  useEffect(() => {
    const finishDeck = (deckNumber, trackIndex, excludedIndex, setTrack) => {
      if (!playingDecks[deckNumber]) return trackIndex;
      const track = tracks[trackIndex];
      if (!track) {
        setPlayingDecks(current => ({ ...current, [deckNumber]: false }));
        return trackIndex;
      }
      if (track.src) return trackIndex;
      const duration = parseDuration(track.duration);
      if ((deckProgress[deckNumber] ?? 0) < duration) return trackIndex;
      const mode = deckPlaybackModes[deckNumber];
      if (mode === "repeat-one") {
        setDeckProgress(current => ({ ...current, [deckNumber]: 0 }));
        return trackIndex;
      }
      if (mode === "sequence" || mode === "shuffle") {
        const nextTrack = getNextPlayableTrack(tracks.length, trackIndex, excludedIndex, mode === "shuffle");
        if (nextTrack !== null) {
          setTrack(nextTrack);
          setDeckProgress(current => ({ ...current, [deckNumber]: 0 }));
          return nextTrack;
        }
      }
      setPlayingDecks(current => ({ ...current, [deckNumber]: false }));
      return trackIndex;
    };
    const resolvedDeck1 = finishDeck(1, deck1, deck2, setDeck1);
    finishDeck(2, deck2, resolvedDeck1, setDeck2);
  }, [deckProgress, deck1, deck2, playingDecks, deckPlaybackModes, tracks]);
  useEffect(() => {
    const workspace = workspaceRef.current;
    const preview = previewPanelRef.current;
    if (!workspace || !preview) return undefined;
    let lastWidth = -1;
    const syncPreviewWidth = () => {
      const height = preview.getBoundingClientRect().height;
      const width = Math.round((height * 8 / 9) * 100) / 100;
      if (width <= 0 || width === lastWidth) return;
      lastWidth = width;
      workspace.style.setProperty("--led-preview-width", `${width}px`);
    };
    const observer = new ResizeObserver(syncPreviewWidth);
    observer.observe(preview);
    syncPreviewWidth();
    return () => {
      observer.disconnect();
      workspace.style.removeProperty("--led-preview-width");
    };
  }, [activeNav]);
  const isTrackLoaded = (index) => index===deck1||index===deck2;
  const prepareTrack = (deck, index) => {
    if (index===null||isTrackLoaded(index)) return;
    if (deck === 1) {
      setDeck1(index);
    } else {
      setDeck2(index);
    }
    // 装载只是备歌：不改变交叉推子，也不会把这首歌自动送到大厅。
    setDeckProgress(current => ({ ...current, [deck]: 0 }));
    setPlayingDecks(current => ({ ...current, [deck]: false }));
    setSelectedTrack(null);
  };
  const loadTrack = (index) => prepareTrack(library, index);
  const loadSelected = () => loadTrack(selectedTrack);
  const updateScreenTarget = (index, key, value) => {
    setScreenTargets(current => current.map((target, targetIndex) => targetIndex === index ? { ...target, [key]: value } : target));
    setSettingsDirty(true);
  };
  const updateMonitorTarget = (index, key, value) => {
    setMonitorTargets(current => current.map((target, targetIndex) => targetIndex === index ? { ...target, [key]: value } : target));
    setSettingsDirty(true);
  };
  const saveTargetSettings = () => {
    window.localStorage.setItem("king.screenTargets", JSON.stringify(screenTargets));
    window.localStorage.setItem("king.monitorTargets", JSON.stringify(monitorTargets));
    setSettingsDirty(false);
  };
  const insertTrack = (deck, index) => prepareTrack(deck, index);
  const getDeckAudio = (deckNumber) => deckNumber === 1 ? deckOneAudioRef.current : deckTwoAudioRef.current;
  const playbackPathForDeck = (deckNumber, track) => (
    deckVocalModes[deckNumber] === "accompaniment" && track?.accompanimentPath
      ? track.accompanimentPath
      : track?.path
  );
  const applyMpvDeckState = (state) => {
    if (!state?.deck) return;
    setDeckProgress((current)=>({...current,[state.deck]:Math.max(0,Number(state.timePos)||0)}));
    setPlayingDecks((current)=>({...current,[state.deck]:!state.paused}));
  };
  const ensureMpvDeckLoaded = async (deckNumber, trackIndex) => {
    const track = tracks[trackIndex];
    const playbackPath = playbackPathForDeck(deckNumber, track);
    if (!mpvEnabled || !playbackPath) return null;
    if (mpvLoadedPathsRef.current[deckNumber] === playbackPath) return null;
    const state = await invoke("mpv_deck_load",{deck:deckNumber,path:playbackPath});
    mpvLoadedPathsRef.current[deckNumber] = playbackPath;
    mpvEofHandledRef.current[deckNumber] = false;
    const { deck1: deckOneGain, deck2: deckTwoGain } = equalPowerGains(crossfade);
    const volume = (deckNumber===1?deckOneGain:deckTwoGain)*100;
    await invoke("mpv_deck_set_volume",{deck:deckNumber,volume});
    applyMpvDeckState(state);
    return state;
  };
  const switchDeckVocalMode = async (deckNumber, trackIndex) => {
    const track = tracks[trackIndex];
    if (!track?.accompanimentPath) return;
    const currentMode = deckVocalModes[deckNumber];
    const nextMode = currentMode === "original" ? "accompaniment" : "original";
    const nextPath = nextMode === "accompaniment" ? track.accompanimentPath : track.path;
    if (!nextPath) return;
    if (mpvEnabled) {
      try {
        if (!mpvLoadedPathsRef.current[deckNumber]) {
          await ensureMpvDeckLoaded(deckNumber, trackIndex);
        }
        const state = await invoke("mpv_deck_switch_source", {
          deck:deckNumber,
          path:nextPath,
        });
        mpvLoadedPathsRef.current[deckNumber] = nextPath;
        setDeckVocalModes((current)=>({...current,[deckNumber]:nextMode}));
        applyMpvDeckState(state);
      } catch (error) {
        console.error(`Deck ${deckNumber} 原唱/伴唱切换失败`, error);
      }
      return;
    }
    const audio = getDeckAudio(deckNumber);
    const wasPlaying = Boolean(playingDecks[deckNumber]);
    const seconds = audio?.currentTime ?? deckProgress[deckNumber] ?? 0;
    setDeckVocalModes((current)=>({...current,[deckNumber]:nextMode}));
    if (audio) {
      audio.pause();
      audio.src = convertFileSrc(nextPath);
      audio.load();
      audio.currentTime = Math.max(0, Number(seconds) || 0);
      if (wasPlaying) audio.play().catch((error)=>console.error(`Deck ${deckNumber} 伴唱播放失败`,error));
    }
  };
  const updateAudioMetadata = (deckNumber, trackIndex, event) => {
    const durationSeconds = Number(event.currentTarget.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    const trackId = tracks[trackIndex]?.id;
    setAudioAssets((current)=>current.map((item)=>item.id===trackId&&item.durationSeconds!==durationSeconds?{...item,durationSeconds}:item));
    setDeckProgress((current)=>({...current,[deckNumber]:Math.min(current[deckNumber]??0,durationSeconds)}));
  };
  const seekDeck = (deckNumber, seconds) => {
    const safeSeconds = Math.max(0,Number(seconds)||0);
    mpvEofHandledRef.current[deckNumber] = false;
    if (mpvEnabled) {
      const trackIndex = deckNumber===1?deck1:deck2;
      ensureMpvDeckLoaded(deckNumber,trackIndex)
        .then(()=>invoke("mpv_deck_seek",{deck:deckNumber,seconds:safeSeconds}))
        .then(applyMpvDeckState)
        .catch((error)=>console.error(`Deck ${deckNumber} mpv Seek 失败`,error));
      setDeckProgress((current)=>({...current,[deckNumber]:safeSeconds}));
      return;
    }
    const audio = getDeckAudio(deckNumber);
    if (audio && tracks[deckNumber===1?deck1:deck2]?.src) audio.currentTime = Math.min(safeSeconds,Number.isFinite(audio.duration)?audio.duration:safeSeconds);
    setDeckProgress((current)=>({...current,[deckNumber]:safeSeconds}));
  };
  const loadAdjacentDeckTrack = (deckNumber, direction) => {
    const currentIndex = deckNumber===1?deck1:deck2;
    const excludedIndex = deckNumber===1?deck2:deck1;
    if(currentIndex===null||currentIndex===undefined)return;
    const nextIndex = getAdjacentPlayableTrack(tracks.length,currentIndex,excludedIndex,direction);
    if (nextIndex===null) return;
    const audio = getDeckAudio(deckNumber);
    audio?.pause();
    if (mpvEnabled&&mpvLoadedPathsRef.current[deckNumber]) invoke("mpv_deck_set_paused",{deck:deckNumber,paused:true}).catch((error)=>console.error(`Deck ${deckNumber} mpv 暂停失败`,error));
    mpvLoadedPathsRef.current[deckNumber]=null;
    mpvEofHandledRef.current[deckNumber]=false;
    if (deckNumber===1) setDeck1(nextIndex); else setDeck2(nextIndex);
    setDeckProgress((current)=>({...current,[deckNumber]:0}));
    setPlayingDecks((current)=>({...current,[deckNumber]:false}));
  };
  const replayDeck = (deckNumber) => seekDeck(deckNumber,0);
  const finishRealAudio = async (deckNumber, trackIndex) => {
    const mode = deckPlaybackModes[deckNumber];
    const audio = getDeckAudio(deckNumber);
    if (mode === "repeat-one" && audio) {
      audio.currentTime = 0;
      setDeckProgress((current)=>({...current,[deckNumber]:0}));
      try {
        await audio.play();
      } catch (error) {
        console.error(`Deck ${deckNumber} 无法循环播放`,error);
        setPlayingDecks((current)=>({...current,[deckNumber]:false}));
      }
      return;
    }
    if (mode === "sequence" || mode === "shuffle") {
      const excludedIndex = deckNumber === 1 ? deck2 : deck1;
      const nextTrack = getNextPlayableTrack(tracks.length,trackIndex,excludedIndex,mode === "shuffle");
      if (nextTrack !== null) {
        if (deckNumber === 1) setDeck1(nextTrack); else setDeck2(nextTrack);
        setDeckProgress((current)=>({...current,[deckNumber]:0}));
        return;
      }
    }
    setPlayingDecks((current)=>({...current,[deckNumber]:false}));
  };
  const toggleDeckPlayback = async (deckNumber, trackIndex) => {
    const track = tracks[trackIndex];
    if(!track)return;
    if (mpvEnabled&&track?.path) {
      try {
        await ensureMpvDeckLoaded(deckNumber,trackIndex);
        if (!playingDecks[deckNumber] && (deckProgress[deckNumber] ?? 0) >= parseDuration(track.duration) - .05) {
          await invoke("mpv_deck_seek",{deck:deckNumber,seconds:0});
          mpvEofHandledRef.current[deckNumber]=false;
        }
        const state=await invoke("mpv_deck_set_paused",{deck:deckNumber,paused:Boolean(playingDecks[deckNumber])});
        applyMpvDeckState(state);
      } catch(error) {
        console.error(`Deck ${deckNumber} mpv 播放控制失败`,error);
        setPlayingDecks((current)=>({...current,[deckNumber]:false}));
      }
      return;
    }
    const audio = getDeckAudio(deckNumber);
    if (track?.src && audio) {
      if (playingDecks[deckNumber]) {
        audio.pause();
        setPlayingDecks((current)=>({...current,[deckNumber]:false}));
        return;
      }
      if (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration - .05) {
        audio.currentTime = 0;
        setDeckProgress((current)=>({...current,[deckNumber]:0}));
      }
      try {
        await audio.play();
        setPlayingDecks((current)=>({...current,[deckNumber]:true}));
      } catch (error) {
        console.error(`Deck ${deckNumber} 无法播放本地音频`,error);
        setPlayingDecks((current)=>({...current,[deckNumber]:false}));
      }
      return;
    }
    if (!playingDecks[deckNumber] && (deckProgress[deckNumber] ?? 0) >= parseDuration(track.duration)) {
      setDeckProgress(current => ({ ...current, [deckNumber]: 0 }));
    }
    setPlayingDecks(current => ({ ...current, [deckNumber]: !current[deckNumber] }));
  };
  const finishMpvDeck = async (deckNumber, trackIndex) => {
    if (mpvEndingRef.current[deckNumber]) return;
    mpvEndingRef.current[deckNumber]=true;
    try {
      const mode=deckPlaybackModes[deckNumber];
      if(mode==="repeat-one") {
        mpvEofHandledRef.current[deckNumber]=false;
        await invoke("mpv_deck_seek",{deck:deckNumber,seconds:0});
        const state=await invoke("mpv_deck_set_paused",{deck:deckNumber,paused:false});
        applyMpvDeckState(state);
        return;
      }
      if(mode==="sequence"||mode==="shuffle") {
        const excludedIndex=deckNumber===1?deck2:deck1;
        const nextTrack=getNextPlayableTrack(tracks.length,trackIndex,excludedIndex,mode==="shuffle");
        if(nextTrack!==null) {
          mpvEofHandledRef.current[deckNumber]=false;
          mpvAutoplayAfterLoadRef.current[deckNumber]=true;
          mpvLoadedPathsRef.current[deckNumber]=null;
          if(deckNumber===1)setDeck1(nextTrack);else setDeck2(nextTrack);
          setDeckProgress((current)=>({...current,[deckNumber]:0}));
          return;
        }
      }
      const state=await invoke("mpv_deck_set_paused",{deck:deckNumber,paused:true});
      applyMpvDeckState(state);
    } catch(error) {
      console.error(`Deck ${deckNumber} mpv 曲终处理失败`,error);
      setPlayingDecks((current)=>({...current,[deckNumber]:false}));
    } finally {
      mpvEndingRef.current[deckNumber]=false;
    }
  };
  const deckOnePath=playbackPathForDeck(1,tracks[deck1])??null;
  const deckTwoPath=playbackPathForDeck(2,tracks[deck2])??null;
  useEffect(()=>{
    if(!mpvEnabled)return undefined;
    let disposed=false;
    const load=async(deckNumber,trackIndex,path)=>{
      if(!path)return;
      try {
        await ensureMpvDeckLoaded(deckNumber,trackIndex);
        if(disposed)return;
        if(mpvAutoplayAfterLoadRef.current[deckNumber]) {
          mpvAutoplayAfterLoadRef.current[deckNumber]=false;
          const state=await invoke("mpv_deck_set_paused",{deck:deckNumber,paused:false});
          if(!disposed)applyMpvDeckState(state);
        }
      } catch(error) {
        if(!disposed) {
          const message=`Deck ${deckNumber} mpv 装载失败：${String(error)}`;
          console.error(message,error);
          setMpvRuntime((current)=>({...current,message,error:message}));
        }
      }
    };
    load(1,deck1,deckOnePath);
    load(2,deck2,deckTwoPath);
    return()=>{disposed=true};
  },[mpvEnabled,deck1,deck2,deckOnePath,deckTwoPath]);
  useEffect(()=>{
    if(!mpvEnabled)return undefined;
    let disposed=false;
    let polling=false;
    const poll=async()=>{
      if(polling||disposed)return;
      polling=true;
      try {
        for(const [deckNumber,trackIndex,path] of [[1,deck1,deckOnePath],[2,deck2,deckTwoPath]]) {
          if(!path||mpvLoadedPathsRef.current[deckNumber]!==path)continue;
          const state=await invoke("mpv_deck_state",{deck:deckNumber});
          if(disposed)return;
          applyMpvDeckState(state);
          const reachedEnd=Boolean(state.eofReached)||(state.duration>0&&state.timePos>=state.duration-.06);
          if(!reachedEnd) {
            mpvEofHandledRef.current[deckNumber]=false;
          } else if(!mpvEofHandledRef.current[deckNumber]) {
            mpvEofHandledRef.current[deckNumber]=true;
            void finishMpvDeck(deckNumber,trackIndex);
          }
        }
      } catch(error) {
        if(!disposed)console.error("读取 mpv 播放状态失败",error);
      } finally {
        polling=false;
      }
    };
    poll();
    const timer=window.setInterval(poll,100);
    return()=>{disposed=true;window.clearInterval(timer)};
  },[mpvEnabled,deck1,deck2,deckOnePath,deckTwoPath,deckPlaybackModes,tracks.length]);
  const activeMediaType = mediaTypes.find(type => type.id === mediaType) ?? mediaTypes[0];
  const activeMediaCategories = mediaCategories[mediaType] ?? [];
  const availableVideos = useMemo(() => videoAssets.length
    ? videoAssets
    : desktopRuntime
      ? []
      : videos.map((item,index)=>({ ...item, id:`demo-video-${index}`, type:"video", index })), [videoAssets, desktopRuntime]);
  const visibleVideos = mediaCategory === "全部" ? availableVideos : availableVideos.filter((item) => item.category === mediaCategory);
  const visibleImages = [
    blackScreenImage,
    resolutionTestImage,
    ...imageAssets.filter((item) => mediaCategory === "全部" || item.category === mediaCategory),
  ];
  const displayMedia = hoverMedia ?? stagedMedia ?? outputMedia;
  const outputTransform = mediaTransforms[outputMedia.id] ?? defaultMediaTransform;
  const displayTransform = stagedMedia?.id === displayMedia.id && stagedTransform
    ? stagedTransform
    : mediaTransforms[displayMedia.id] ?? defaultMediaTransform;
  // Media and transforms are updated immutably. Sharing the committed snapshot
  // reference makes the dirty check constant-time, even when a text composition
  // contains large PNG data URLs.
  const previewPending = Boolean(stagedMedia) && (
    stagedMedia !== outputMedia || (stagedTransform ?? defaultMediaTransform) !== outputTransform
  );
  useEffect(() => {
    const configuredLightIds = lights.filter((preset)=>preset.label).map((preset)=>preset.id);
    const handleRhythmAutomation = (event) => {
      const rhythmEvent = event.detail;
      const dominantDeck = selectDominantDeck(playingDecks, crossfade);
      if (!dominantDeck || rhythmEvent?.deck !== dominantDeck) return;

      if (lightingEnabled && light === null && rhythmEventMatchesRule(lightRhythmRule, rhythmEvent)) {
        setAutoLightPreset((current)=>{
          const next = nextConfiguredId(configuredLightIds, current);
          if (next !== null) {
            window.dispatchEvent(new CustomEvent("king:lighting-cue", { detail:{
              presetId:next,
              source:"rhythm",
              rule:lightRhythmRule,
              rhythm:rhythmEvent,
            } }));
          }
          return next ?? current;
        });
      }

      if (rhythmEventMatchesRule(videoRhythmRule, rhythmEvent) && availableVideos.length) {
        automationVideoIndexRef.current = (automationVideoIndexRef.current + 1) % availableVideos.length;
        const source = availableVideos[automationVideoIndexRef.current];
        const candidate = { ...source, id:source.id, type:"video", name:source.name, src:source.src };
        setHoverMedia(null);
        setStagedMedia(candidate);
        setStagedTransform({ ...(mediaTransforms[candidate.id] ?? defaultMediaTransform) });
        setSelectedTextElement(null);
        setSelectedTextElements([]);
        setPreviewMode(true);
        setMonitorTarget(null);
        window.dispatchEvent(new CustomEvent("king:video-cue", { detail:{
          mediaId:candidate.id,
          source:"rhythm-preview",
          rule:videoRhythmRule,
          rhythm:rhythmEvent,
        } }));
      }
    };
    window.addEventListener("king:rhythm", handleRhythmAutomation);
    return () => window.removeEventListener("king:rhythm", handleRhythmAutomation);
  }, [availableVideos, crossfade, light, lightingEnabled, lightRhythmRule, mediaTransforms, playingDecks, videoRhythmRule]);
  const connectLedOutput = async () => {
    if (!window.__TAURI_INTERNALS__) return;
    setLedOutputStatus((current)=>current.previewMode
      ? { ...current, message:"正在检测 LED 第二屏" }
      : { ...current, connected:false, previewMode:false, message:"正在连接节目输出" });
    try {
      const status = await invoke("open_output_window", { monitorIndex:null });
      setLedOutputStatus(status);
    } catch (error) {
      setLedOutputStatus({ connected:false, previewMode:false, message:String(error) });
    }
  };
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const programMedia = outputMedia.type === "video"
      ? { ...outputMedia, muted:!videoAudioEnabled }
      : outputMedia;
    invoke("set_program_state", { program:{ media:programMedia, transform:outputTransform, lyrics:activeLyrics } })
      .catch((error)=>console.error("同步 LED 节目画面失败",error));
  },[outputMedia,outputTransform,videoAudioEnabled,activeLyrics]);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    connectLedOutput();
    const timer=window.setInterval(async()=>{
      try {
        const status=await invoke("output_window_status");
        setLedOutputStatus(status);
        if(!status.connected) await connectLedOutput();
      } catch(error) {
        setLedOutputStatus({connected:false,previewMode:false,message:String(error)});
        await connectLedOutput();
      }
    },5000);
    return ()=>window.clearInterval(timer);
  },[]);
  const chosenTextElements = stagedMedia?.type === "text" ? stagedMedia.elements.filter((element)=>selectedTextElements.includes(element.id)) : [];
  const outputLabel = outputMedia.name;
  const stageMedia = (candidate) => {
    setTextDraftClearSlot(null);
    const stagedCandidate = candidate.type === "text"
      ? { ...candidate, baseMedia: outputMedia.type === "text" ? outputMedia.baseMedia : outputMedia, elements: (candidate.elements ?? []).map((element)=>({...element})) }
      : candidate;
    setStagedMedia(stagedCandidate);
    textUndoRef.current = [];
    setStagedTransform({ ...(mediaTransforms[candidate.id] ?? defaultMediaTransform) });
    const firstTextElement = stagedCandidate.type === "text" ? stagedCandidate.elements?.[0]?.id ?? null : null;
    setSelectedTextElement(firstTextElement);
    setSelectedTextElements(firstTextElement?[firstTextElement]:[]);
    if (stagedCandidate.type === "text") {
      setPreviewMode(true);
      setMonitorTarget(null);
    }
  };
  const selectTextElement = (elementId, options = {}) => {
    if (!elementId) {
      setSelectedTextElement(null);
      setSelectedTextElements([]);
      return;
    }
    if (options.preserve) {
      setSelectedTextElement(elementId);
      return;
    }
    if (options.toggle) {
      setSelectedTextElements((current)=>{
        const next = current.includes(elementId) ? current.filter((id)=>id!==elementId) : [...current,elementId];
        setSelectedTextElement(next.at(-1)??null);
        return next;
      });
      return;
    }
    setSelectedTextElement(elementId);
    setSelectedTextElements([elementId]);
  };
  const rememberTextState = () => {
    if (stagedMedia?.type !== "text") return;
    textUndoRef.current = [...textUndoRef.current.slice(-39), structuredClone(stagedMedia)];
  };
  const updateTextElement = (changes) => {
    if (!selectedTextElement) return;
    rememberTextState();
    setStagedMedia((current)=>current?.type === "text" ? { ...current, elements: current.elements.map((element)=>element.id===selectedTextElement?{...element,...changes}:element) } : current);
  };
  const updateTextElementById = (elementId, changes) => {
    setStagedMedia((current)=>current?.type === "text" ? { ...current, elements: current.elements.map((element)=>element.id===elementId?{...element,...changes}:element) } : current);
  };
  const deleteTextElement = () => {
    if (!selectedTextElements.length) return;
    rememberTextState();
    setStagedMedia((current)=>current?.type === "text" ? { ...current, elements: current.elements.filter((element)=>!selectedTextElements.includes(element.id)) } : current);
    setSelectedTextElement(null);
    setSelectedTextElements([]);
  };
  const undoTextEdit = () => {
    const previous = textUndoRef.current.at(-1);
    if (!previous) return;
    textUndoRef.current = textUndoRef.current.slice(0,-1);
    setStagedMedia(previous);
    setSelectedTextElements((current)=>current.filter((id)=>previous.elements.some((element)=>element.id===id)));
    setSelectedTextElement((current)=>previous.elements.some((element)=>element.id===current)?current:null);
  };
  const copyTextElement = () => {
    const elements = stagedMedia?.type === "text" ? stagedMedia.elements.filter((item)=>selectedTextElements.includes(item.id)) : [];
    if (elements.length) copiedTextElementRef.current = structuredClone(elements);
  };
  const pasteTextElement = () => {
    const copied = copiedTextElementRef.current;
    if (!copied?.length || stagedMedia?.type !== "text") return;
    rememberTextState();
    const pasteKey = Date.now();
    const pasted = copied.map((element,index)=>({ ...structuredClone(element), id:`${element.id}-copy-${pasteKey}-${index}`, x:clamp(element.x+4,0,100), y:clamp(element.y+4,0,100) }));
    setStagedMedia((current)=>current?.type === "text" ? { ...current, elements:[...current.elements,...pasted] } : current);
    setSelectedTextElements(pasted.map((element)=>element.id));
    setSelectedTextElement(pasted.at(-1).id);
  };
  const applyTextSelection = (changes, textOnly = false, shadowCapableOnly = false) => {
    if (!selectedTextElements.length) return;
    rememberTextState();
    setStagedMedia((current)=>current?.type === "text" ? { ...current, elements:current.elements.map((element)=>selectedTextElements.includes(element.id)&&(!textOnly||element.kind==="text")&&(!shadowCapableOnly||element.kind!=="image")?{...element,...changes}:element) } : current);
  };
  const uploadTextGraphic = (file) => {
    if (!file || stagedMedia?.type !== "text") return;
    const kind = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg") ? "svg" : "image";
    const reader = new FileReader();
    reader.onload = () => {
      const id = `uploaded-${kind}-${Date.now()}`;
      const element = {
        id,
        kind,
        src: String(reader.result),
        x: 50,
        y: 50,
        scale: kind === "svg" ? .72 : .64,
        color: "#ffffff",
      };
      rememberTextState();
      setStagedMedia((current)=>current?.type === "text" ? { ...current, elements:[...(current.elements??[]),element] } : current);
      setSelectedTextElement(id);
      setSelectedTextElements([id]);
    };
    reader.readAsDataURL(file);
  };
  const alignTextSelection = (alignment) => {
    if (!selectedTextElements.length || stagedMedia?.type !== "text") return;
    const chosen = stagedMedia.elements.filter((element)=>selectedTextElements.includes(element.id));
    const xs = chosen.map((element)=>element.x), ys = chosen.map((element)=>element.y);
    const target = alignment==="left"?(chosen.length>1?Math.min(...xs):10):alignment==="center-x"?(chosen.length>1?(Math.min(...xs)+Math.max(...xs))/2:50):alignment==="right"?(chosen.length>1?Math.max(...xs):90):alignment==="top"?(chosen.length>1?Math.min(...ys):10):alignment==="center-y"?(chosen.length>1?(Math.min(...ys)+Math.max(...ys))/2:50):(chosen.length>1?Math.max(...ys):90);
    rememberTextState();
    setStagedMedia((current)=>current?.type === "text" ? { ...current, elements:current.elements.map((element)=>selectedTextElements.includes(element.id)?{...element,...(["left","center-x","right"].includes(alignment)?{x:target}:{y:target})}:element) } : current);
  };
  const saveTextDraft = (index) => {
    const source = stagedMedia?.type === "text" ? stagedMedia : outputMedia?.type === "text" ? outputMedia : null;
    if (!source) return;
    const saved = { ...source, id:`text-draft-${index}`, name:`暂存 ${index+1}`, baseMedia:undefined, elements:(source.elements??[]).map((element)=>({...element})) };
    setTextDrafts((current)=>current.map((draft,draftIndex)=>draftIndex===index?saved:draft));
  };
  const openTextDraft = (index) => {
    if (textDrafts[index]) {
      setActiveTextDraftSlot(index);
      stageMedia({...textDrafts[index],type:"text"});
      return;
    }
    setActiveTextDraftSlot(index);
    stageMedia({
      id:`text-new-${index}`,
      type:"text",
      name:`新图文 · 暂存 ${index+1}`,
      text:"",
      elements:[],
    });
  };
  const saveActiveTextDraft = () => {
    if (activeTextDraftSlot === null) return;
    saveTextDraft(activeTextDraftSlot);
  };
  const clearSelectedTextDraft = () => {
    if (textDraftClearSlot === null) return;
    setTextDrafts((current)=>current.map((draft,index)=>index===textDraftClearSlot?null:draft));
    setTextDraftClearSlot(null);
  };
  const confirmStagedMedia = () => {
    if (!stagedMedia) return;
    const committedMedia = structuredClone(stagedMedia);
    const committedTransform = { ...(stagedTransform ?? defaultMediaTransform) };
    setMediaTransforms((current)=>({...current,[committedMedia.id]:committedTransform}));
    // 上屏后保留一份独立的 PVW 副本，让操作员可立即继续编辑下一版。
    setOutputMedia(committedMedia);
    setStagedMedia(committedMedia);
    setStagedTransform(committedTransform);
    if (committedMedia.type === "video") setVideo(committedMedia.index);
    if (committedMedia.type === "image") setSelectedImage(committedMedia.id);
    setHoverMedia(null);
    textUndoRef.current = [];
    setTextDraftClearSlot(null);
  };
  const resetMediaPreview = () => {
    setHoverMedia(null);
    setStagedMedia(outputMedia);
    setStagedTransform(outputTransform);
    setSelectedTextElement(null);
    setSelectedTextElements([]);
    textUndoRef.current = [];
    setTextDraftClearSlot(null);
  };
  const togglePersistentPreview = () => {
    setMonitorTarget(null);
    setPreviewMode((enabled)=>{
      if (!enabled && !stagedMedia) {
        setStagedMedia(outputMedia);
        setStagedTransform(outputTransform);
      }
      return !enabled;
    });
  };
  const openFixtureColorPicker = (fixtureId, event) => {
    const panelRect = lightPanelRef.current?.getBoundingClientRect();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const rawLeft = panelRect ? buttonRect.left - panelRect.left + buttonRect.width / 2 : 150;
    setFixtureColorEditor({ id: fixtureId, left: panelRect ? clamp(rawLeft, 155, panelRect.width - 155) : rawLeft, hue: rgbToHsv(fixtureColors[fixtureId]).h });
  };
  const updateFixtureColor = (color) => {
    if (!fixtureColorEditor) return;
    setFixtureColors((current) => ({ ...current, [fixtureColorEditor.id]: color }));
  };
  const updatePickerSV = (event) => {
    if (!fixtureColorEditor) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hue = fixtureColorEditor.hue;
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture?.(event.pointerId);
    updateFixtureColor(hsvToRgb({ h: hue, s: clamp((event.clientX - rect.left) / rect.width, 0, 1), v: 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1) }));
  };
  const updatePickerHue = (event) => {
    if (!fixtureColorEditor) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const current = rgbToHsv(fixtureColors[fixtureColorEditor.id]);
    const hue = clamp((event.clientY - rect.top) / rect.height * 360, 0, 359.99);
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture?.(event.pointerId);
    setFixtureColorEditor((editor) => ({ ...editor, hue }));
    updateFixtureColor(hsvToRgb({ h: hue, s: current.s, v: current.v }));
  };
  useEffect(() => {
    const handleTextShortcut = (event) => {
      if (stagedMedia?.type !== "text") return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoTextEdit();
      } else if (modifier && event.key.toLowerCase() === "c") {
        if (!selectedTextElement) return;
        event.preventDefault();
        copyTextElement();
      } else if (modifier && event.key.toLowerCase() === "v") {
        if (!copiedTextElementRef.current) return;
        event.preventDefault();
        pasteTextElement();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedTextElements.length) {
        event.preventDefault();
        deleteTextElement();
      }
    };
    window.addEventListener("keydown",handleTextShortcut);
    return () => window.removeEventListener("keydown",handleTextShortcut);
  }, [stagedMedia,selectedTextElement,selectedTextElements]);

  return <div className="app-shell">
    <div className="media-audio-engine" aria-hidden="true">
      <audio ref={deckOneAudioRef} src={mpvEnabled?undefined:(deckOnePath?convertFileSrc(deckOnePath):undefined)} preload="metadata" autoPlay={Boolean(!mpvEnabled&&deckOnePath&&playingDecks[1])} onLoadedMetadata={(event)=>updateAudioMetadata(1,deck1,event)} onTimeUpdate={(event)=>setDeckProgress((current)=>({...current,1:event.currentTarget.currentTime}))} onEnded={()=>finishRealAudio(1,deck1)} onError={()=>setPlayingDecks((current)=>({...current,1:false}))}/>
      <audio ref={deckTwoAudioRef} src={mpvEnabled?undefined:(deckTwoPath?convertFileSrc(deckTwoPath):undefined)} preload="metadata" autoPlay={Boolean(!mpvEnabled&&deckTwoPath&&playingDecks[2])} onLoadedMetadata={(event)=>updateAudioMetadata(2,deck2,event)} onTimeUpdate={(event)=>setDeckProgress((current)=>({...current,2:event.currentTarget.currentTime}))} onEnded={()=>finishRealAudio(2,deck2)} onError={()=>setPlayingDecks((current)=>({...current,2:false}))}/>
    </div>
    <header className="topbar">
      <div className="brand"><img src="/assets/king-club-logo-white.svg" alt="King Club"/><div><strong>Broadcast Control</strong></div></div>
      <div className="system-status"><span><WifiHigh /> 本机控制</span><span className={ledOutputStatus.connected?"led-connected":"led-disconnected"} title={ledOutputStatus.message}><MonitorPlay /> {ledOutputStatus.previewMode?"单屏 · C1 预览":ledOutputStatus.connected?"第二屏 + C1 预览":"LED 主屏未连接"}</span><span className="clock">{formatDateTime(now)}</span></div>
    </header>

    <main ref={workspaceRef} className={`workspace ${previewMode?"preview-layout":""}`}>
      {activeNav === "设置" ? <SettingsView
        screenTargets={screenTargets}
        monitorTargets={monitorTargets}
        onScreenChange={updateScreenTarget}
        onMonitorChange={updateMonitorTarget}
        onSave={saveTargetSettings}
        dirty={settingsDirty}
      /> : <>
      <aside className="panel library-panel">
        <div className="panel-title"><MusicNotes weight="fill"/><div><b>播放曲库</b><small title={mpvRuntime.message}>{audioAssets.length?`${playlist}常规歌单 · ${tracks.length} 首 · ${mpvEnabled?"mpv 播放引擎":"兼容引擎"}`:`${playlist}常规歌单 · 当前为演示数据`}</small></div></div>
        <div className="library-switch"><button className={library===1?"active":""} onClick={()=>setLibrary(1)}>1号曲库</button><button className={library===2?"active":""} onClick={()=>setLibrary(2)}>2号曲库</button></div>
        <div className="playlist-tabs" aria-label="歌单选择">
          <div className="playlist-row weekday-row">{weekdayPlaylists.map(p=><button key={p} className={playlist===p?"active":""} onClick={()=>setPlaylist(p)}>{p}</button>)}</div>
          <div className="playlist-row special-row">{specialPlaylists.map(p=><button key={p} className={playlist===p?"active":""} onClick={()=>setPlaylist(p)}>{p}</button>)}</div>
        </div>
        <div className="table-head"><span>歌曲</span><span>歌手</span><span>BPM</span><span>时长</span></div>
        <div className="track-list">{tracks.map((t,i)=>{
          const trackAnalysis = audioAnalyses[audioAnalysisKey(t)];
          const trackBpm = Number(trackAnalysis?.bpm) > 0 ? Number(trackAnalysis.bpm).toFixed(1).replace(/\.0$/, "") : t.bpm;
          const inDeck1 = i===deck1;
          const inDeck2 = i===deck2;
          const onAirDeck1 = playingDecks[1]&&inDeck1;
          const onAirDeck2 = playingDecks[2]&&inDeck2;
          const onAir = onAirDeck1||onAirDeck2;
          const bothOnAir = onAirDeck1&&onAirDeck2;
          const locked = inDeck1||inDeck2;
          const rowSelected = !locked&&selectedTrack===i;
          return <div key={t.id??`${t.title}-${i}`} role="button" aria-disabled={locked} tabIndex={locked?-1:0} className={`track-row ${rowSelected?"selected":""} ${locked?"deck-locked":""} ${inDeck1?"deck-one":""} ${inDeck2?"deck-two":""} ${onAir?"on-air":""} ${bothOnAir?"on-air-both":""}`} onClick={()=>{if(!locked)setSelectedTrack(i)}} onDoubleClick={()=>{if(!locked)loadTrack(i)}} onKeyDown={event=>{if(event.key==="Enter"&&!locked)setSelectedTrack(i)}}>
            <span className={`track-index ${inDeck1||inDeck2?"deck-indicators":""}`}>{inDeck1||inDeck2?[inDeck1&&<SpeakerHigh key="deck-1" className="deck-one-indicator" weight={onAirDeck1?"fill":"regular"}/>,inDeck2&&<SpeakerHigh key="deck-2" className="deck-two-indicator" weight={onAirDeck2?"fill":"regular"}/>]:String(i+1).padStart(2,"0")}</span><span className="track-info"><b>{t.title}</b><small>{t.tag}</small></span><span className="track-artist" title={t.artist}>{t.artist}</span><span>{trackBpm}</span><span>{t.duration}</span>
            {onAir&&<span className="track-playing-decks" aria-label={`正在由${bothOnAir?" Deck 1 和 Deck 2":` Deck ${onAirDeck1?1:2}`}播放`}>{onAirDeck1&&<span className="track-playing-badge deck-one-label">1</span>}{onAirDeck2&&<span className="track-playing-badge deck-two-label">2</span>}</span>}
            <button className="track-insert" aria-label="装载到 1 号 Deck，不自动播放" title="装载到 1 号 Deck（不自动播放）" onClick={event=>{event.stopPropagation();insertTrack(1,i)}} onDoubleClick={event=>event.stopPropagation()}>1</button>
            <button className="track-insert" aria-label="装载到 2 号 Deck，不自动播放" title="装载到 2 号 Deck（不自动播放）" onClick={event=>{event.stopPropagation();insertTrack(2,i)}} onDoubleClick={event=>event.stopPropagation()}>2</button>
          </div>;
        })}</div>
      </aside>

      <section className="center-column">
        <div ref={previewPanelRef} className="panel preview-panel">
          <div className="c1-side-rail screen-rail" aria-label="输出屏幕选择">
            {screenTargets.map((target, index) => <button key={`screen-${index}`} className={monitorTarget===null&&screenTarget===index?"active":""} onClick={()=>{setScreenTarget(index);setMonitorTarget(null);if(index===0&&!ledOutputStatus.connected)connectLedOutput()}} aria-pressed={monitorTarget===null&&screenTarget===index} title={index===0?ledOutputStatus.message:target.name}>
              <MonitorPlay weight={monitorTarget===null&&screenTarget===index?"fill":"regular"}/><b>{target.short}</b><small>{index===0?(ledOutputStatus.previewMode?"C1 预览":ledOutputStatus.connected?"双路中":"未连接"):target.status}</small>
            </button>)}
          </div>
          <div className="preview-meta"><span><span className="live-dot"/> {monitorTarget===null?previewMode?"PGM / PVW 双屏预览":`${screenTargets[screenTarget].name}预览`:monitorTargets[monitorTarget].name}</span><span>{monitorTarget===null?"2048 × 2304 · 8:9":"LIVE · 演示画面"}</span></div>
          <div className={`led-stage ${previewMode&&monitorTarget===null?"dual-preview-stage":""}`}>
            {monitorTarget===null
              ? previewMode
                ? <><div className="dual-screen-pane program-pane"><span className="screen-role-label">PGM · 当前上屏</span><MediaOutputScreen media={outputMedia} track={tracks[deck1]} lyrics={activeLyrics} transform={outputTransform}/></div><div className="dual-screen-pane preview-pane"><span className="screen-role-label">{previewPending?"PVW · 编辑中":"PVW · 已同步"}</span><MediaOutputScreen media={displayMedia} track={tracks[deck1]} transform={displayTransform} editable={stagedMedia?.type==="text"&&stagedMedia.id===displayMedia.id} selectedElementId={selectedTextElement} selectedElementIds={selectedTextElements} onElementSelect={selectTextElement} onElementChange={updateTextElementById} onEditStart={rememberTextState}/>{stagedMedia?.id===displayMedia.id&&stagedMedia.src&&<MediaTransformEditor value={displayTransform} onChange={setStagedTransform}/>}<svg className="preview-visible-outline" viewBox="0 0 2048 2304" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="M512 0h1024v1152h512v1152H0V1152h512z"/></svg></div></>
                : <MediaOutputScreen media={displayMedia} track={tracks[deck1]} lyrics={activeLyrics} transform={displayTransform}/>
              : <div className="monitor-feed" style={{backgroundImage:`linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.28)),url(${monitorTargets[monitorTarget].src})`}}><div className="monitor-live"><span className="live-dot"/> LIVE</div><b>{monitorTargets[monitorTarget].name}</b><small>摄像机视频流接口预留</small></div>}
          </div>
          {previewMode&&monitorTarget===null&&stagedMedia?.type==="text"&&<TextFormatToolbar elements={chosenTextElements} fonts={systemFonts} onApply={applyTextSelection} onAlign={alignTextSelection} onUpload={uploadTextGraphic} saveSlot={activeTextDraftSlot} onSave={saveActiveTextDraft}/>}
          {textDraftClearSlot!==null&&<div className="text-draft-dialog" role="alertdialog" aria-modal="true" aria-label={`清空暂存 ${textDraftClearSlot+1} 确认`}><b>清空暂存 {textDraftClearSlot+1}</b><span>此操作会移除该暂存内容，是否继续？</span><div><button type="button" onClick={()=>setTextDraftClearSlot(null)}>取消</button><button type="button" className="draft-clear" onClick={clearSelectedTextDraft}>清空暂存</button></div></div>}
          {monitorTarget===null&&previewMode&&stagedMedia&&<div className={`media-preview-confirm ${previewPending?"is-pending":"is-synced"}`}><span>{previewPending?"PVW · 有修改":"PVW · 与 PGM 一致"}</span><button type="button" className="reset" onClick={resetMediaPreview}>重置</button><button type="button" className="take" onClick={confirmStagedMedia}>上屏</button></div>}
          <div className="preview-footer">
            <span><CheckCircle weight="fill"/> {monitorTarget===null?(ledOutputStatus.previewMode?"单屏模式 · C1 实时预览":ledOutputStatus.connected?"第二屏输出正常 · C1 实时预览":"第二屏等待连接"):"监控已选择"}</span>
            <span>{monitorTarget===null?`${outputMedia.type === "image" ? "图片" : outputMedia.type === "text" ? "文字" : "视频"}：${outputLabel}`:"等待摄像机接入"}</span>
            <span>{monitorTarget===null?`灯光：${light===null?`自动 · ${lights[effectiveLight]?.label??"等待节拍"}`:lights[effectiveLight]?.label??"未配置"}`:"延迟：-- ms"}</span>
          </div>
          <div className="c1-side-rail monitor-rail" aria-label="监控画面选择">
            <button type="button" className={previewMode?"active preview-toggle":"preview-toggle"} onClick={togglePersistentPreview} aria-pressed={previewMode}>
              <MonitorPlay weight={previewMode?"fill":"regular"}/><b>预览</b><small>{previewMode?"双屏":"开启"}</small>
            </button>
            {monitorTargets.slice(1).map((target, offset) => {const index=offset+1;return <button key={`monitor-${index}`} className={monitorTarget===index?"active":""} onClick={()=>{setPreviewMode(false);setMonitorTarget(index)}} aria-pressed={monitorTarget===index}>
              <VideoCamera weight={monitorTarget===index?"fill":"regular"}/><b>{target.short}</b><small>{monitorTarget===index?"已选择":target.status}</small>
            </button>})}
          </div>
        </div>

        <div className="panel mixer-panel">
          <div className="decks">
            <Deck
              number={1}
              track={tracks[deck1]??emptyDeckTrack}
              analysis={audioAnalyses[audioAnalysisKey(tracks[deck1])]}
              onRhythmCorrection={correction=>saveTrackRhythmCorrection(tracks[deck1],correction)}
              playing={playingDecks[1]}
              active={crossfade<50}
              side="one"
              level={playingDecks[1]?100-crossfade:0}
              progress={deckProgress[1]}
              onSeek={seconds=>seekDeck(1,seconds)}
              onPrevious={()=>loadAdjacentDeckTrack(1,-1)}
              onReplay={()=>replayDeck(1)}
              onNext={()=>loadAdjacentDeckTrack(1,1)}
              playbackMode={deckPlaybackModes[1]}
              onPlaybackModeChange={mode=>setDeckPlaybackModes(current=>({...current,1:mode}))}
              lyricsEnabled={deckLyricsEnabled[1]}
              lyricsAvailable={deckLyricsLines[1].length>0}
              vocalMode={deckVocalModes[1]}
              accompanimentAvailable={Boolean(tracks[deck1]?.accompanimentPath)}
              onLyricsToggle={()=>setDeckLyricsEnabled(current=>({...current,1:!current[1]}))}
              onVocalToggle={()=>switchDeckVocalMode(1,deck1)}
              onPlay={()=>toggleDeckPlayback(1,deck1)}
            />
            <Deck
              number={2}
              track={tracks[deck2]??emptyDeckTrack}
              analysis={audioAnalyses[audioAnalysisKey(tracks[deck2])]}
              onRhythmCorrection={correction=>saveTrackRhythmCorrection(tracks[deck2],correction)}
              playing={playingDecks[2]}
              active={crossfade>=50}
              side="two"
              level={playingDecks[2]?crossfade:0}
              progress={deckProgress[2]}
              onSeek={seconds=>seekDeck(2,seconds)}
              onPrevious={()=>loadAdjacentDeckTrack(2,-1)}
              onReplay={()=>replayDeck(2)}
              onNext={()=>loadAdjacentDeckTrack(2,1)}
              playbackMode={deckPlaybackModes[2]}
              onPlaybackModeChange={mode=>setDeckPlaybackModes(current=>({...current,2:mode}))}
              lyricsEnabled={deckLyricsEnabled[2]}
              lyricsAvailable={deckLyricsLines[2].length>0}
              vocalMode={deckVocalModes[2]}
              accompanimentAvailable={Boolean(tracks[deck2]?.accompanimentPath)}
              onLyricsToggle={()=>setDeckLyricsEnabled(current=>({...current,2:!current[2]}))}
              onVocalToggle={()=>switchDeckVocalMode(2,deck2)}
              onPlay={()=>toggleDeckPlayback(2,deck2)}
            />
          </div>
          <div className="crossfader"><div className="crossfader-side crossfader-side-one"><span className="track-playing-badge deck-one-label" aria-hidden="true">1</span><span className="crossfader-percent">{100-crossfade}</span></div><div className="crossfader-control" style={{"--crossfade-position":`${crossfade}%`}}><div className="crossfader-scale" aria-hidden="true">{Array.from({length:17},(_,index)=><i key={index} className={index===8?"center":index%4===0?"major":""}/>)}</div><input aria-label="双曲交叉推子" type="range" min="0" max="100" value={crossfade} onChange={e=>setCrossfade(Number(e.target.value))}/></div><div className="crossfader-side crossfader-side-two"><span className="crossfader-percent">{crossfade}</span><span className="track-playing-badge deck-two-label" aria-hidden="true">2</span></div></div>
        </div>
      </section>

      <aside className="right-column">
        <section className={`panel video-panel ${activeMediaCategories.length?"has-categories":""}`}>
          <div className="panel-title compact"><VideoCamera weight="fill"/><div><b>视频快速选择</b><small>{activeMediaType.hint}</small></div>{mediaType==="video"&&<label className="rhythm-rule-control" title="按当前主导 Deck 的节拍自动预选到 PVW，不会直接上屏"><Lightning weight="fill"/><select aria-label="视频节拍预选规则" value={videoRhythmRule} onChange={(event)=>setVideoRhythmRule(event.target.value)}>{rhythmRuleOptions.map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label>}{mediaType==="video"&&<button type="button" className={`video-audio-toggle ${videoAudioEnabled?"enabled":"muted"}`} aria-pressed={videoAudioEnabled} onClick={()=>setVideoAudioEnabled((enabled)=>!enabled)} title={videoAudioEnabled?"关闭视频自身声音，仅保留画面":"开启视频自身声音"}>{videoAudioEnabled?<SpeakerHigh weight="fill"/>:<SpeakerSlash weight="fill"/>}<span>{videoAudioEnabled?"视频声音":"已静音"}</span></button>}</div>
          <div className="media-type-switch" role="tablist" aria-label="大屏素材类型">{mediaTypes.map(type=><button key={type.id} type="button" role="tab" aria-selected={mediaType===type.id} className={mediaType===type.id?"active":""} onClick={()=>{setMediaType(type.id);setMediaCategory("全部");setHoverMedia(null)}}>{type.label}</button>)}</div>
          {activeMediaCategories.length>0&&<div className="media-category-switch" role="radiogroup" aria-label={`${activeMediaType.label}分类`}>{activeMediaCategories.map((category)=><button key={category} type="button" role="radio" aria-checked={mediaCategory===category} className={mediaCategory===category?"active":""} onClick={()=>setMediaCategory(category)}>{category}</button>)}</div>}
          <div className={mediaType==="image"?"video-grid image-grid":mediaType==="text"?"text-workspace":"video-grid"}>
            {mediaType==="video"?(visibleVideos.length?visibleVideos.map((item)=>{const candidate={...item,id:item.id,type:"video",name:item.name,src:item.src};return <button key={item.id} type="button" className={`${outputMedia.id===candidate.id?"active":""} ${stagedMedia?.id===candidate.id?"staged":""}`} onMouseEnter={()=>setHoverMedia(candidate)} onMouseLeave={()=>setHoverMedia(null)} onFocus={()=>setHoverMedia(candidate)} onBlur={()=>setHoverMedia(null)} onClick={()=>stageMedia(candidate)} aria-label={`预览视频 ${item.name}`}><MediaThumbnail item={item}/>{outputMedia.id===candidate.id&&<i><Play weight="fill"/></i>}</button>}):<div className="media-empty"><b>该分类暂无视频</b><small>将 MP4 放入本地视频目录后自动出现。</small></div>)
            :mediaType==="image"?visibleImages.map((item)=>{const candidate={id:item.id,type:"image",name:item.name,src:item.src};return <button key={item.id} type="button" className={`${outputMedia.id===candidate.id?"active":""} ${stagedMedia?.id===candidate.id?"staged":""} ${item.locked?"black-screen-tile":""}`} onMouseEnter={()=>setHoverMedia(candidate)} onMouseLeave={()=>setHoverMedia(null)} onFocus={()=>setHoverMedia(candidate)} onBlur={()=>setHoverMedia(null)} onClick={()=>stageMedia(candidate)} aria-label={item.locked?"预览固定黑屏，不可删除":`预览图片 ${item.name}`} title={item.locked?"固定黑屏 · 不可移动 · 不可删除":item.name}>{item.src?<img src={item.src} alt=""/>:<strong>黑屏</strong>}{item.locked&&<em>固定</em>}</button>})
            :<><section className="text-template-section"><header><b>预设模板</b><small>选择后在 PVW 画面编辑</small></header><div className="text-template-row">{textPrograms.map((item)=>{const candidate={...item,type:"text"};return <button key={item.id} type="button" className={`${stagedMedia?.id===candidate.id?"staged":""}`} onClick={()=>stageMedia(candidate)} aria-label={`选择${item.name}模板`}><TextProgramThumbnail program={item}/></button>})}</div></section><section className="text-draft-section"><header><b>暂存</b><small>4 个可视暂存位</small></header><div className="text-draft-row">{textDrafts.map((draft,index)=><div className={`text-draft-slot ${draft?"filled":"empty"}`} key={index}><button type="button" className="text-draft-main" onClick={()=>openTextDraft(index)} onContextMenu={(event)=>{event.preventDefault();if(draft)setTextDraftClearSlot(index)}} aria-label={draft?`暂存 ${index+1}，点击调取；右键清空`:`暂存 ${index+1}，点击新建图文`}>{draft?<TextProgramThumbnail program={draft} slot={index+1}/>:<span className="empty-draft-preview"><b>{index+1}</b><small>新建</small></span>}</button></div>)}</div></section></>}
          </div>
          {mediaType==="video"&&videoAssets.length===0&&<small className="image-library-hint">{mediaLibraryDirectories.videoDirectory?`将 MP4 放入：${mediaLibraryDirectories.videoDirectory}`:"桌面版启动后自动建立视频目录"}</small>}
          {mediaType==="image"&&imageAssets.length===0&&<small className="image-library-hint">{imageLibraryDirectory?`将图片放入：${imageLibraryDirectory}`:"桌面版启动后自动扫描图片目录"}</small>}
        </section>
        <section ref={lightPanelRef} className={`panel light-panel ${lightingEnabled ? "lighting-on" : "lighting-off"}`}>
          <div className="panel-title compact"><LightbulbFilament weight="fill"/><div><b>Avolites Tiger Touch Pro</b></div><label className="rhythm-rule-control lighting-rhythm-rule" title="自动模式只跟随当前实际占主导声音的 Deck"><Lightning weight="fill"/><select aria-label="灯光节拍联动规则" value={lightRhythmRule} onChange={(event)=>setLightRhythmRule(event.target.value)}>{rhythmRuleOptions.map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label><button type="button" className="lighting-power-toggle" aria-pressed={lightingEnabled} title={lightingEnabled ? "点击关闭全部灯光" : "点击重新开启灯光"} onClick={()=>setLightingEnabled((enabled)=>!enabled)}><span className="live-dot"/>{lightingEnabled ? "灯光开启" : "灯光关闭"}</button></div>
          <div className="light-grid">{lights.map((lightPreset)=>{const configured=Boolean(lightPreset.label);const isActive=effectiveLight===lightPreset.id;const mode=lightPlaybackModes[lightPreset.id];return <div className={`light-preset ${configured?"configured":"empty"} ${isActive?"active":""} ${light===null&&isActive?"rhythm-active":""}`} key={lightPreset.id}><button type="button" className="light-preset-main" disabled={!configured} onClick={()=>setLight(lightPreset.id)} aria-label={configured?`触发 ${lightPreset.label}`:`${lightPreset.id} 号灯光预设未配置`} title={configured?lightPreset.label:"未配置"}><span className="light-number">{lightPreset.id}</span>{configured&&<span className="light-name">{lightPreset.label}</span>}{configured&&<span className="light-duration">{lightPreset.duration}</span>}</button>{configured&&<button type="button" className="light-mode-toggle" onClick={()=>setLightPlaybackModes((current)=>({...current,[lightPreset.id]:mode==="loop"?"once":"loop"}))} aria-label={`${lightPreset.label}${mode==="loop"?"循环播放":"单次播放"}`} title={mode==="loop"?"循环播放：点击改为单次":"单次播放：点击改为循环"}>{mode==="loop"?<ArrowsClockwise weight="bold"/>:<span className="light-once">1</span>}</button>}</div>})}</div>
          <div className="quick-actions">
            <button type="button" className={light===null?"auto active":"auto"} aria-pressed={light===null} onClick={()=>setLight(null)}>自动</button>
            {fixtureControls.map((fixture)=>{const color=fixtureColors[fixture.id];const colorValue=`rgb(${color.r}, ${color.g}, ${color.b})`;return <button type="button" key={fixture.id} className="fixture-control" style={{"--fixture-color":colorValue,"--fixture-text":isLightColor(color)?"#07100e":"#ffffff"}} onDoubleClick={(event)=>openFixtureColorPicker(fixture.id,event)} title="双击打开 RGB 调色板"><span className="fixture-color-dot"/>{fixture.label}</button>})}
          </div>
          {fixtureColorEditor&&(()=>{const color=fixtureColors[fixtureColorEditor.id];const hsv=rgbToHsv(color);const hue=fixtureColorEditor.hue;return <div className="fixture-color-editor" style={{left:fixtureColorEditor.left}} role="dialog" aria-label="RGB 调色板"><div className="fixture-color-editor-head"><b>{fixtureControls.find((fixture)=>fixture.id===fixtureColorEditor.id)?.label} 调色板</b><button type="button" onClick={()=>setFixtureColorEditor(null)}>关闭</button></div><div className="fixture-picker-body" style={{display:"grid",gridTemplateColumns:"minmax(0, 1fr) 18px 64px",gap:"8px",alignItems:"stretch",justifyItems:"stretch"}}><div className="fixture-sv-field" style={{width:"100%",height:"155px",background:`linear-gradient(to bottom, transparent, #000), linear-gradient(to right, #fff, hsl(${hue}, 100%, 50%))`}} onPointerDown={updatePickerSV} onPointerMove={(event)=>event.buttons&&updatePickerSV(event)}><i className="fixture-sv-cursor" style={{left:`calc(${hsv.s*100}% - 6px)`,top:`calc(${(1-hsv.v)*100}% - 6px)`}}/></div><div className="fixture-hue-field" style={{width:"18px",height:"155px",background:"linear-gradient(to bottom, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)"}} onPointerDown={updatePickerHue} onPointerMove={(event)=>event.buttons&&updatePickerHue(event)}><i className="fixture-hue-cursor" style={{top:`calc(${hue/3.6}% - 4px)`}}/></div><div className="fixture-picker-preview" style={{width:"64px",height:"155px",backgroundColor:`rgb(${color.r}, ${color.g}, ${color.b})`,color:isLightColor(color)?"#07100e":"#ffffff",textShadow:isLightColor(color)?"none":"0 1px 1px #000"}}><span>R {color.r}</span><span>G {color.g}</span><span>B {color.b}</span></div></div></div>})()}
        </section>
      </aside>
      </>}
    </main>

    <nav className="bottom-nav" aria-label="主导航">{nav.map(([label,Icon])=><button key={label} className={activeNav===label?"active":""} onClick={()=>setActiveNav(label)}><Icon weight={activeNav===label?"fill":"regular"}/><span>{label}</span></button>)}</nav>
  </div>;
}
