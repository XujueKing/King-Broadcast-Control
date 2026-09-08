import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AUTO_DJ_CROSSFADE_SECONDS,
  AUTO_DJ_PRELOAD_SECONDS,
  deckOutputVolumePercent,
  deckOutputVolumeScalar,
  describeReadyStemProgress,
  equalPowerGains,
  formatDuration,
  getAdjacentPlayableTrackInQueue,
  getNextPlayableTrackInQueue,
  isPlayableVideoSource,
  mediaAssetFingerprint,
  parseDuration,
  planDeckAutoTransition,
  planDeckOperatorArbitration,
  resolvePlaybackChainForDeck,
  resetDeckVocalModeForTrackChange,
} from "./media-runtime.js";
import { collectRhythmEvents, effectiveRhythmBpm, rhythmEnergyAt } from "./rhythm-runtime.js";
import { reconcileStableAssets } from "./media-scan-stability.js";
import { captureVideoQueue, nextProgramVideo } from "./video-playback.js";
import { lyricAtTime, parseLrc, selectLyricsDeck } from "./lyrics-runtime.js";
import { applyPreferredLyricsFont, mergeFontFamilies, registerCustomFonts } from "./font-runtime.js";
import {
  createOfflineVocalStatus,
  describeVocalFailover,
  formatVocalMetric,
  normalizeVocalResponse,
  updatePreviewVocalPreset,
  vocalLaneLabels,
  vocalPresetOptions,
} from "./vocal-runtime.js";
import { createOfflineRoutingStatus, normalizeRoutingResponse, routingStageLabel } from "./vocal-routing.js";
import { createCalibrationStatus, normalizeCalibrationReport } from "./vocal-calibration.js";
import {
  clearDeckCueRecovery,
  deckCueMix,
  deckRescuePreviewPlans,
  loadDeckCueRecovery,
  persistDeckCueRecovery,
  qu16DeckCueWrites,
  qu16WritesConfirmed,
} from "./deck-cue.js";
import { kingClubQu16OutputBaselineWrites } from "./qu16-output-baseline.js";
import { homeMicrophoneBindings, microphoneFaderReadback, microphoneFaderWrites } from "./microphone-control.js";
import { MixerWorkspace } from "./MixerConsole.jsx";
import { clearQu16MeterSnapshot, publishQu16MeterSnapshot } from "./qu16-meter-store.js";
import { LightingConsoleWorkspace } from "./LightingConsoleWorkspace.jsx";
import { ShowEditorWorkspace } from "./ShowEditorWorkspace.jsx";
import {
  PLAYLIST_MANAGEMENT_STORAGE_KEY,
  addPlaylistCategory,
  createPlaylistPlaybackSource,
  createDefaultPlaylistLibraries,
  currentWeekdayPlaylistName,
  movePlaylistWithinKind,
  movePlaylistTrack,
  normalizePlaylistLibraries,
  playlistWeekdays,
  removePlaylistTrack,
  removePlaylistCategory,
  renamePlaylistCategory,
  resolvePlaybackQueuePaths,
  resolveWeekdayDeckStartupSelections,
  seedPlaylistManagement,
  updatePlaylistLibrary,
  updatePlaylistTracks,
} from "./playlist-management.js";
import { getPersistentVideoThumbnail } from "./video-thumbnail-cache.js";
import {
  MEDIA_SCAN_INTERVAL_MS,
  VIDEO_GRID_INITIAL_LIMIT,
  nextVideoRenderLimit,
  shouldExtendVideoGrid,
  shouldQueueAudioAiAnalysis,
} from "./ui-performance.js";
import { defaultMixerModelId, mixerModelById, mixerModels } from "./mixer-models/index.js";
import {
  rhythmEventMatchesRule,
  rhythmRuleOptions,
  selectDominantDeck,
} from "./rhythm-automation.js";
import { createLightingAutomationState, lightingCueIsAuthorized, planLightingCue } from "./lighting-automation.js";
import { sampleVideoColor } from "./video-color-runtime.js";
import {
  createLatestOnlyAsyncQueue,
  gatlingPaletteForVideoFamily,
  gatlingPulseForRhythm,
  kingclubGatlingProfile,
} from "./gatling-runtime.js";
import { createBeamShowController, kingclubBeamProfile } from "./beam-runtime.js";
import { createLightingPackage, normalizeLightingPackage } from "./lighting-package.js";
import {
  clearTitanSimulator,
  createTitanSimulatorState,
  isTitanPresetSimulated,
  simulateTitanCue,
} from "./titan-simulator.js";
import {
  House, MusicNotes, VideoCamera, LightbulbFilament, SlidersHorizontal,
  DiceFive, Play, Pause, SkipBack, SkipForward, Lightning,
  SpeakerHigh, SpeakerSlash, ArrowsClockwise, MonitorPlay, WifiHigh, CheckCircle,
  GearSix, FloppyDisk, MusicNoteSimple, RepeatOnce, ListNumbers, Shuffle,
  ArrowCounterClockwise, Headphones, Microphone,
  MagnifyingGlass, X, Plus, Trash, ArrowUp, ArrowDown,
  CalendarBlank, PencilSimple, FolderOpen, Folders, DownloadSimple, UploadSimple, FilmSlate,
} from "@phosphor-icons/react";

function useStableCallback(callback) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args) => callbackRef.current(...args), []);
}

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

const MPV_VOLUME_WRITE_INTERVAL_MS = 34;
const createMpvVolumeWriter = () => {
  let pending = null;
  let timer = 0;
  let inFlight = false;
  let lastWriteAt = 0;

  const schedule = () => {
    if (timer || inFlight || !pending) return;
    const elapsed = performance.now() - lastWriteAt;
    timer = window.setTimeout(flush, Math.max(0, MPV_VOLUME_WRITE_INTERVAL_MS - elapsed));
  };
  const flush = async () => {
    timer = 0;
    if (inFlight || !pending) return schedule();
    const batch = pending;
    pending = null;
    inFlight = true;
    lastWriteAt = performance.now();
    try {
      await Promise.all(batch.map((payload)=>invoke("mpv_deck_set_volume",payload)));
    } catch (error) {
      console.error("mpv 推子音量设置失败",error);
    } finally {
      inFlight = false;
      schedule();
    }
  };

  return {
    enqueue(batch) {
      pending = batch;
      schedule();
    },
    clear() {
      pending = null;
      if (timer) window.clearTimeout(timer);
      timer = 0;
    },
  };
};

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
const loadMixerNumber = (key, fallback) => {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;
  } catch {
    return fallback;
  }
};
// 首版先以本地示例预设展示；名称、时长与循环方式后续由“灯光管理”页面配置并保存。
const lights = [
  { id: 0, label: "暗红加特林", duration: "视频色彩 · 音乐节拍", loop: true },
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
const loadTitanMappings = () => {
  try {
    const saved = JSON.parse(window.localStorage.getItem("king.lighting.titanMappings"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved)
      .map(([presetId,titanId])=>[Number(presetId),Number(titanId)])
      .filter(([presetId,titanId])=>Number.isInteger(presetId)&&presetId>=0&&presetId<=9&&Number.isSafeInteger(titanId)&&titanId>0));
  } catch {
    return {};
  }
};
const loadTitanEffectRegistry = () => {
  try {
    const saved = JSON.parse(window.localStorage.getItem("king.lighting.effectRegistry"));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
};
const loadLightPlaybackModes = () => {
  const fallback = Object.fromEntries(lights
    .filter((item) => item.label)
    .map((item) => [item.id, item.loop ? "loop" : "once"]));
  try {
    const saved = JSON.parse(window.localStorage.getItem("king.lighting.playbackModes"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return fallback;
    return {
      ...fallback,
      ...Object.fromEntries(Object.entries(saved)
        .map(([presetId,mode])=>[Number(presetId),mode])
        .filter(([presetId,mode])=>Number.isInteger(presetId)&&presetId>=0&&presetId<=9&&(mode==="once"||mode==="loop"))),
    };
  } catch {
    return fallback;
  }
};
const SITE_TITAN_IDENTITY = {deviceName:"TT-00608"};
const loadTitanIdentity = () => {
  try {
    const saved=JSON.parse(window.localStorage.getItem("king.lighting.titanIdentity"));
    return saved&&typeof saved==="object"&&!Array.isArray(saved)?saved:null;
  } catch {
    return null;
  }
};
const titanIdentityFromStatus = (status) => ({
  serial:Number.isSafeInteger(Number(status?.serial))&&Number(status.serial)>0?Number(status.serial):null,
  hardwareIdentifier:String(status?.hardwareIdentifier||"").trim(),
  deviceName:String(status?.deviceName||"").trim(),
});
const titanIdentityMatches = (expected, current) => {
  if(!expected)return true;
  if(expected.serial&&current.serial)return expected.serial===current.serial;
  if(expected.deviceName)return Boolean(current.deviceName)&&expected.deviceName===current.deviceName;
  if(expected.hardwareIdentifier)return Boolean(current.hardwareIdentifier)&&expected.hardwareIdentifier===current.hardwareIdentifier;
  return true;
};
const titanPlaybackLabel = (playback) => {
  const location = [playback.group,Number.isFinite(playback.page)?`P${playback.page+1}`:"",Number.isFinite(playback.index)?`#${playback.index+1}`:""]
    .filter(Boolean).join(" · ");
  const userNumber = playback.userNumbers?.length ? `U${playback.userNumbers.join("/")}` : "";
  return [playback.legend||`Playback ${playback.titanId}`,userNumber,location].filter(Boolean).join(" · ");
};
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
  ["首页", House], ["音乐管理", MusicNotes], ["演出编排", FilmSlate],
  ["调音台", SlidersHorizontal], ["Avolites Tiger Touch Pro", DiceFive], ["设置", GearSix],
];
const playbackModes = [
  ["single", "单曲播放", MusicNoteSimple],
  ["repeat-one", "单曲循环", RepeatOnce],
  ["sequence", "顺序播放 · 双 Deck 自动衔接", ListNumbers],
  ["shuffle", "随机播放 · 双 Deck 自动衔接", Shuffle],
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
  const playableVideo = isPlayableVideoSource(item.src);
  const suppliedThumbnailUrl = playableVideo ? item.thumbnailSrc ?? "" : item.src;
  const [thumbnailUrl, setThumbnailUrl] = useState(suppliedThumbnailUrl);
  const frameRef = useRef(null);
  const duration = item.duration ?? "--:--";

  useEffect(() => {
    let disposed = false;
    let observer = null;
    setThumbnailUrl(suppliedThumbnailUrl);
    if (!playableVideo || suppliedThumbnailUrl || !item.path) return undefined;

    const loadThumbnail = () => {
      void getPersistentVideoThumbnail(item)
        .then((url) => {
          if (!disposed && url) setThumbnailUrl(url);
        })
        .catch((error) => console.error(`生成视频缩略图失败：${item.name ?? item.path}`, error));
    };

    if (typeof IntersectionObserver === "undefined") {
      loadThumbnail();
      return () => { disposed = true; };
    }

    observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer?.disconnect();
      loadThumbnail();
    }, { rootMargin:"160px" });
    if (frameRef.current) observer.observe(frameRef.current);
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [item.path, item.sizeBytes, item.modifiedUnixMs, item.name, playableVideo, suppliedThumbnailUrl]);

  return <>
    <div ref={frameRef} className={`media-thumbnail-frame ${thumbnailUrl ? "ready" : "pending"}`}>
      {thumbnailUrl ? <img src={thumbnailUrl} alt="" loading="lazy" decoding="async"/> : <b aria-hidden="true"/>}
    </div>
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

const deckSignalPercent = (peaks, seconds, durationSeconds, outputPercent) => {
  if (!peaks?.length || !(durationSeconds > 0) || !(outputPercent > 0)) return 0;
  const position = clamp(seconds / durationSeconds, 0, 1) * (peaks.length - 1);
  const index = Math.round(position);
  const sample = (offset) => Math.max(0, Number(peaks[clamp(index + offset, 0, peaks.length - 1)]) || 0) / 100;
  // A short weighted window suppresses single-sample flicker while preserving kicks.
  const sourceLinear = sample(-1) * .2 + sample(0) * .55 + sample(1) * .25;
  if (sourceLinear <= .0001) return 0;
  const sourceDbfs = 20 * Math.log10(sourceLinear);
  const sourcePercent = clamp((sourceDbfs + 48) / 48 * 100, 0, 100);
  // The fader position is the meter's current full scale, not another dB gain
  // applied before display conversion. A 50% fader therefore caps motion at 50%.
  return sourcePercent * clamp(outputPercent / 100, 0, 1);
};

function RuntimeClock() {
  const [clock,setClock]=useState(()=>new Date());
  useEffect(()=>{
    const timer=window.setInterval(()=>setClock(new Date()),1000);
    return()=>window.clearInterval(timer);
  },[]);
  return <span className="clock">{formatDateTime(clock)}</span>;
}

function DeckSignalMeter({ number, side, peaks, progress, durationSeconds, playing, outputPercent, motionPaused }) {
  const rootRef = useRef(null);
  const fillRef = useRef(null);
  const modelRef = useRef({ peaks, progress, durationSeconds, playing, outputPercent, motionPaused });
  const progressAnchorRef = useRef({ seconds:progress, at:performance.now() });
  modelRef.current = { peaks, progress, durationSeconds, playing, outputPercent, motionPaused };

  useEffect(() => {
    progressAnchorRef.current = { seconds:Number(progress) || 0, at:performance.now() };
  },[progress,peaks,playing,durationSeconds]);

  useEffect(() => {
    if (!motionPaused) return;
    const heldPercent = clamp(outputPercent,0,100);
    fillRef.current?.style.removeProperty("transform");
    fillRef.current?.style.setProperty("clip-path",`inset(0 ${100-heldPercent}% 0 0)`);
    rootRef.current?.setAttribute("aria-valuenow",String(Math.round(heldPercent)));
  },[motionPaused,outputPercent]);

  useEffect(() => {
    let frame = 0;
    let lastFrameAt = 0;
    let displayed = 0;
    let lastAriaValue = -1;
    const animate = (now) => {
      frame = window.requestAnimationFrame(animate);
      if (now - lastFrameAt < 33) return;
      lastFrameAt = now;
      const model = modelRef.current;
      if (model.motionPaused) {
        // While the operator holds the fader, replace the animated signal with
        // an exact position readout that follows every fader value change.
        displayed = clamp(model.outputPercent,0,100);
      } else {
        const anchor = progressAnchorRef.current;
        const estimatedSeconds = model.playing
          ? Math.min(model.durationSeconds, anchor.seconds + Math.max(0, now - anchor.at) / 1000)
          : anchor.seconds;
        const target = model.playing
          ? deckSignalPercent(model.peaks, estimatedSeconds, model.durationSeconds, model.outputPercent)
          : 0;
        const response = target > displayed ? .52 : .16;
        displayed += (target - displayed) * response;
      }
      if (displayed < .08) displayed = 0;
      fillRef.current?.style.removeProperty("transform");
      fillRef.current?.style.setProperty("clip-path",`inset(0 ${100-displayed}% 0 0)`);
      const ariaValue = Math.round(displayed);
      if (ariaValue !== lastAriaValue) {
        rootRef.current?.setAttribute("aria-valuenow",String(ariaValue));
        lastAriaValue = ariaValue;
      }
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  },[]);

  return <div ref={rootRef} className={`waveform deck-signal-meter deck-signal-meter-${side} ${playing?"is-live":""}`} data-motion-paused={motionPaused?"true":"false"} role="meter" aria-label={`Deck ${number} 实时输出电平`} aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span ref={fillRef}/></div>;
}

const AI_RESCUE_FEATURE_ENABLED=false;

function Deck({ number, track, analysis, onRhythmCorrection, playing, onPlay, onPrevious, onReplay, onNext, active, side, level, progress, onSeek, playbackMode, onPlaybackModeChange, automationOwner, lyricsEnabled, lyricsAvailable, vocalMode, accompanimentAvailable, aiRescueEnabled, aiReferenceStatus, onAiRescueToggle, onLyricsToggle, onVocalToggle, cueActive, cueAvailable, cueBusy, cueMessage, onCueToggle, meterMotionPaused }) {
  const demoWaveformPeaks = useMemo(() => buildWaveformPeaks(track.title, WAVEFORM_PEAK_COUNT), [track.title]);
  const dragRef = useRef(null);
  const [seekPreview, setSeekPreview] = useState(null);
  const [rhythmEditorOpen, setRhythmEditorOpen] = useState(false);
  const [rhythmSaving, setRhythmSaving] = useState(false);
  const [rhythmError, setRhythmError] = useState("");
  const [rhythmDraft, setRhythmDraft] = useState({ bpm:"120", firstDownbeatSeconds:"0", beatsPerBar:"4" });
  const [coverFailed, setCoverFailed] = useState(false);
  const durationSeconds = parseDuration(track.duration);
  const displayedProgress = Math.min(durationSeconds, Math.max(0, seekPreview ?? progress));
  const waveformPeaks = analysis?.peaks?.length ? analysis.peaks : track.path ? [] : demoWaveformPeaks;
  const effectiveBpm = effectiveRhythmBpm(analysis);
  const analyzedBpm = effectiveBpm > 0 ? effectiveBpm.toFixed(1).replace(/\.0$/, "") : track.bpm;
  const aiReferenceBusy = ["checking","binding"].includes(aiReferenceStatus?.state);
  const aiReferenceReady = Boolean(aiReferenceStatus?.ready);
  const aiReferenceBound = Boolean(aiReferenceStatus?.bound);
  const aiRescueActive = AI_RESCUE_FEATURE_ENABLED&&vocalMode==="accompaniment"&&aiReferenceReady&&aiRescueEnabled;
  const showCover = Boolean(track.coverSrc)&&!coverFailed;
  const aiRescueTitle = !AI_RESCUE_FEATURE_ENABLED
    ? "补音功能暂时关闭；伴唱只播放纯伴奏"
    : vocalMode!=="accompaniment"
    ? "先开启伴唱模式，再使用 AI 补音"
    : aiReferenceBusy
      ? aiReferenceStatus?.message||"正在检查歌手补音参考"
      : !aiReferenceReady
        ? aiReferenceStatus?.message||"请先在音乐管理为此歌生成补音参考"
        : aiRescueEnabled
          ? aiReferenceBound
            ? `${aiReferenceStatus?.displayName||"歌手"}补音已开启；实时参考已绑定，点击关闭`
            : `${aiReferenceStatus?.displayName||"歌手"}本地补音参考层已开启；实时自适应链路尚未武装，点击关闭`
            : `${aiReferenceStatus?.displayName||"歌手"}补音参考已就绪；点击打开`;

  const openRhythmEditor = () => {
    const firstDownbeat = analysis?.correction?.firstDownbeatSeconds
      ?? analysis?.bars?.[0]
      ?? displayedProgress;
    setRhythmDraft({
      bpm:String(Number(analysis?.correction?.bpm ?? (effectiveBpm || 120)).toFixed(2)).replace(/0+$/, "").replace(/\.$/, ""),
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
  useEffect(() => setCoverFailed(false), [track.coverSrc]);

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
    <div className="deck-head"><span className="deck-number">DECK {number}</span>{automationOwner==="operator"?<span className="deck-automation-owner held" title="人工播放或 CUE 时保持独立；停止且无 CUE 后可被自动衔接使用">人工运行 · 空闲后自动</span>:<span className="deck-automation-owner" title="该 Deck 空闲时可由自动衔接使用">AUTO 待命</span>}<div className="deck-primary-actions"><button type="button" className={`deck-cue-toggle ${cueActive?"active":""}`} aria-label={`Deck ${number} ${cueActive?"关闭":"开启"} Qu-16 耳机 CUE`} aria-pressed={cueActive} title={cueMessage} disabled={!cueAvailable||cueBusy} onClick={onCueToggle}>{cueBusy&&cueActive?"…":"CUE"}</button><button type="button" className={`deck-play-toggle ${playing?"on":"paused"}`} onClick={onPlay} aria-label={`Deck ${number} ${playing?"暂停":"播放"}`} aria-pressed={playing} title={playing?"暂停":"播放"}>{playing?<Pause weight="fill"/>:<Play weight="fill"/>}</button></div></div>
    <div className="deck-track"><div className={`cover cover-${side} ${showCover?"has-artwork":""}`}>{showCover?<img src={track.coverSrc} alt="" decoding="async" onError={()=>setCoverFailed(true)}/>:<MusicNotes weight="fill" />}</div><div><h3>{track.title}</h3><p>{track.artist} · <button type="button" className="deck-bpm-button" disabled={!track.path||!analysis} onClick={openRhythmEditor} title="校正 BPM 与小节第一拍">{analyzedBpm} BPM</button>{analysis?.correction&&<span className="rhythm-corrected">已校正</span>}</p></div></div>
    <DeckSignalMeter key={`fixed-tick-meter-v2-${number}`} number={number} side={side} peaks={waveformPeaks} progress={displayedProgress} durationSeconds={durationSeconds} playing={playing} outputPercent={level} motionPaused={meterMotionPaused}/>
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
      <div className="transport" role="group" aria-label={`Deck ${number} 曲目控制`}><button type="button" className="track-step previous" aria-label={`Deck ${number} 装载上一首并暂停`} title="装载上一首（暂停）" onClick={onPrevious}><SkipBack weight="fill" /></button><button type="button" className="track-step replay" aria-label={`Deck ${number} 从头重放当前歌曲`} title="从头重放" onClick={onReplay}><ArrowCounterClockwise weight="bold" /></button><button type="button" className={`vocal-rescue-toggle ${aiRescueActive?"active":""} ${aiReferenceReady?"ready":"missing"} ${aiReferenceBusy?"busy":""}`} aria-label={`Deck ${number} AI 补音暂时关闭`} aria-pressed={aiRescueActive} disabled={!AI_RESCUE_FEATURE_ENABLED||vocalMode!=="accompaniment"||!aiReferenceReady||aiReferenceBusy} onClick={onAiRescueToggle} title={aiRescueTitle}>{AI_RESCUE_FEATURE_ENABLED?(aiReferenceBusy?"准备":aiReferenceReady?"补音✓":"补音"):"补音停"}</button><button type="button" className="track-step next" aria-label={`Deck ${number} 装载下一首并暂停`} title="装载下一首（暂停）" onClick={onNext}><SkipForward weight="fill" /></button><button type="button" className={`deck-extra-toggle lyrics-toggle ${lyricsEnabled?"active":""} ${!lyricsAvailable?"missing":""}`} aria-label={`Deck ${number} ${lyricsAvailable?(lyricsEnabled?"关闭":"打开"):"未找到"}歌词`} aria-pressed={lyricsEnabled&&lyricsAvailable} onClick={onLyricsToggle} title={lyricsAvailable?(lyricsEnabled?"关闭歌词":"打开歌词"):"未找到同名 LRC 歌词文件"}>{lyricsAvailable?"词":"无词"}</button></div>
      <div className="deck-playback-modes" role="group" aria-label={`Deck ${number} 播放模式`}>{playbackModes.map(([id,label,Icon])=><button type="button" key={id} className={playbackMode===id?"active":""} aria-label={label} aria-pressed={playbackMode===id} onClick={()=>onPlaybackModeChange(id)} title={label}><Icon weight={playbackMode===id?"fill":"regular"}/></button>)}<button type="button" className="active vocal-toggle" aria-label={`Deck ${number} 当前${vocalMode==="original"?"原唱":"伴唱"}，点击切换`} aria-pressed={vocalMode==="accompaniment"} disabled={!accompanimentAvailable} onClick={onVocalToggle} title={!accompanimentAvailable?"伴唱音轨尚未生成":vocalMode==="original"?"当前原唱，点击切换为伴唱（保持 Deck 当前音量）":"当前伴唱（保持 Deck 当前音量），点击切换为原唱"}>{vocalMode==="original"?"原唱":"伴唱"}</button></div>
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
const resolveBaseMedia = (media) => media?.type === "text"
  ? media.baseMedia ?? { ...blackScreenImage, type:"image" }
  : media;
const cloneOverlayElements = (media) => (media?.elements ?? []).map((element)=>({ ...element }));
const placeOverlayOnMedia = (baseMedia, overlayMedia) => overlayMedia?.type === "text"
  ? { ...overlayMedia, baseMedia, elements:cloneOverlayElements(overlayMedia) }
  : baseMedia;
const LED_LOGICAL_WIDTH = 2048;
const LED_LOGICAL_HEIGHT = 2304;
// The editor exposes familiar point-like values (28, 36, ...), while all output
// surfaces render from one fixed LED coordinate system. 3.2 preserves the
// existing size on the 640 CSS-pixel-wide output and makes smaller previews a
// true proportional representation instead of a second, independently sized UI.
const LED_TEXT_UNIT_SCALE = 3.2;

export function MediaOutputScreen({ media, track, lyrics = null, transform = defaultMediaTransform, allowAudio = false, videoRef = null, playback = null, onVideoEnded, editable = false, selectedElementId = null, selectedElementIds = [], onElementSelect, onElementChange, onEditStart }) {
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
  const baseMedia = resolveBaseMedia(media);
  const style = !baseMedia.src ? { background: baseMedia.background ?? "#000" } : undefined;
  const lyricRows = lyrics?.text ? (lyrics.visible===false ? [
    { role:"expired", text:lyrics.text, offset:0 },
    lyrics.nextText && { role:"following", text:lyrics.nextText, offset:1 },
  ] : [
    lyrics.previousText && { role:"previous", text:lyrics.previousText, offset:-1 },
    { role:"current", text:lyrics.text, offset:0 },
    lyrics.nextText && { role:"next", text:lyrics.nextText, offset:1 },
    lyrics.followingText && { role:"following", text:lyrics.followingText, offset:2 },
  ]).filter(Boolean) : [];
  const lyricFitScale = (text) => Math.max(.5,Math.min(1,27/Math.max(27,[...String(text).replace(/\s+/g," ").trim()].length)));
  return <div ref={screenRef} className={`led-screen ${baseMedia.type === "image" && !baseMedia.src ? "black-output" : ""}`}>
    <div className="led-physical-canvas" style={style}>
    {baseMedia.src&&(isPlayableVideoSource(baseMedia.src)
      ? <video key={`${baseMedia.id}:${playback?.token??"preview"}`} ref={videoRef} className={`media-source fit-${transform.fit}`} src={baseMedia.src} crossOrigin="anonymous" autoPlay loop={!playback||playback.mode!=="sequence"} onEnded={()=>onVideoEnded?.({mediaId:baseMedia.id,token:playback?.token})} playsInline muted={!allowAudio||baseMedia.muted!==false} draggable="false" style={{left:`${50+transform.x}%`,top:`${50+transform.y}%`,transform:`translate(-50%,-50%) scale(${transform.scaleX},${transform.scaleY})`}}/>
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
    {lyricRows.length>0&&<div className={`led-lyrics-overlay lyrics-deck-${lyrics.deck}`} aria-live="off">{lyricRows.map((row)=><span key={`${lyrics.trackId??"track"}:${lyrics.index+row.offset}`} className={`led-lyric-line is-${row.role}`}><span style={{fontSize:`${lyricFitScale(row.text)}em`}}>{row.text}</span></span>)}</div>}
    </div>
  </div>;
}

function FontFamilyPicker({ fonts, value, disabled, directory="", customCount=0, onChange, onOpenDirectory, onRefresh }) {
  const [open,setOpen] = useState(false);
  const [query,setQuery] = useState("");
  const filtered = useMemo(()=>fonts.filter((font)=>font.toLowerCase().includes(query.trim().toLowerCase())).slice(0,120),[fonts,query]);
  return <div className="font-family-picker">
    <button type="button" className="font-picker-trigger" disabled={disabled} onClick={()=>setOpen((current)=>!current)} title={value}><span style={{fontFamily:value}}>{value}</span><i>⌄</i></button>
    {open&&<div className="font-picker-popup"><div className="font-picker-tools" title={directory}><button type="button" onClick={onOpenDirectory}>字体目录</button><button type="button" onClick={onRefresh}>刷新</button><small>软件字体 {customCount} 个 · 含系统字体</small></div><input autoFocus value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="搜索软件或系统字体" onKeyDown={(event)=>{if(event.key==="Escape")setOpen(false)}}/><div className="font-picker-list">{filtered.map((font)=><button type="button" key={font} className={font===value?"active":""} style={{fontFamily:font}} onClick={()=>{onChange(font);setOpen(false);setQuery("")}}>{font}</button>)}{filtered.length===0&&<small>未找到字体</small>}</div></div>}
  </div>;
}

function TextProgramThumbnail({ program, slot }) {
  return <span className="text-thumb text-program-thumbnail">
    {slot&&<em>{slot}</em>}
    {(program.elements??[]).map((element)=>{const scaleX=element.scaleX??element.scale??1;const scaleY=element.scaleY??element.scale??1;return <i key={element.id} className={`thumb-element thumb-${element.kind}`} style={{left:`${element.x}%`,top:`${element.y}%`,transform:`translate(-50%,-50%) scale(${scaleX},${scaleY})`,color:element.color,fontFamily:element.fontFamily??"inherit",fontWeight:element.fontWeight??(element.bold?800:600),fontStyle:element.italic?"italic":undefined}}>{element.kind==="text"?element.content:element.kind==="svg"?<span style={{backgroundColor:element.color,maskImage:`url(${element.src})`,WebkitMaskImage:`url(${element.src})`}}/>:<img src={element.src} alt=""/>}</i>})}
    {!program.elements?.length&&<strong>{program.text??"空"}</strong>}
  </span>;
}

function TextFormatToolbar({ elements, fonts, fontDirectory, customFontCount, onOpenFontDirectory, onRefreshFonts, onApply, onAlign, onUpload, saveSlot, onSave }) {
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
    <FontFamilyPicker fonts={fonts} value={primary.fontFamily??"Microsoft YaHei"} disabled={!hasText} directory={fontDirectory} customCount={customFontCount} onOpenDirectory={onOpenFontDirectory} onRefresh={onRefreshFonts} onChange={(fontFamily)=>onApply({fontFamily},true)}/>
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

const vocalProfilePrompts = [
  {id:"low",label:"低音",instruction:"用舒适低音唱“啊—哦—嗯”，保持连贯，不要压嗓"},
  {id:"mid",label:"中音",instruction:"用中音唱一段熟悉旋律，吐字清楚、音高自然"},
  {id:"high",label:"高音",instruction:"用安全高音唱“啊—咿—呜”，不要硬顶或喊叫"},
  {id:"sustain",label:"长音",instruction:"唱 2–3 个 4 至 6 秒长音，保留自然颤音"},
  {id:"articulation",label:"咬字",instruction:"唱一段节奏稍快的中文歌词，辅音和收尾清楚"},
  {id:"dynamics",label:"强弱",instruction:"同一句从轻到强，再从强到轻唱两遍"},
];

const VOCAL_PROFILE_DEVICE_STORAGE_KEY="king.vocalProfile.inputDevice";
const VOCAL_PROFILE_SONG_STORAGE_KEY="king.vocalProfile.targetSongPath";
const VOCAL_PROFILE_SELECTED_STORAGE_KEY="king.vocalProfile.selectedId";
const createDeckReferenceStatus=(state="idle",message="尚未绑定歌手补音参考")=>({state,ready:false,bound:false,message});
const loadSelectedVocalProfileId=()=>{
  try{return localStorage.getItem(VOCAL_PROFILE_SELECTED_STORAGE_KEY)||""}catch{return ""}
};
const normalizeSongPickerText=value=>String(value??"").trim().toLocaleLowerCase().replace(/\s+/g,"");
const managedTrackIdentity=(track,index)=>track?.path??(track?.demo?`demo:${index}`:null);
const managedSongFolder=(song)=>{
  const rawPath=String(song?.path??"");
  if(!rawPath||rawPath.startsWith("demo:"))return "演示歌曲";
  const parts=rawPath.replace(/\//g,"\\").split("\\").filter(Boolean);
  let folders=parts.slice(0,-1);
  const audioRootIndex=folders.map((part)=>part.toLocaleLowerCase()).lastIndexOf("audio");
  if(audioRootIndex>=0)folders=folders.slice(audioRootIndex+1);
  else folders=folders.slice(-2);
  if(folders[0]?.toLocaleLowerCase()===".king-imported")folders=folders.slice(1);
  return folders.length?folders.join(" / "):"根目录";
};
const vocalProfileDeviceScore=(device)=>{
  const name=String(device?.name||"").toLowerCase();
  let score=0;
  if(name.includes("麦克风")||name.includes("microphone")||name.includes("headset"))score+=40;
  if(name.includes("realtek"))score+=20;
  if(name.includes("耳麦")||name.includes("headset"))score+=30;
  if(name.includes("阵列")||name.includes("array"))score-=25;
  if(name.includes("nahimic")||name.includes("virtual")||name.includes("vad"))score-=80;
  return score;
};

function MusicManagementView({ leftPanel, activeLibrary, onActiveLibraryChange, vocalProfiles, vocalProfileDevices, vocalProfileBusy, vocalProfileMessage, songs, videos, lightingEffects, playlistManagement, onPlaylistManagementChange, activePlaylistName, onActivePlaylistNameChange, onLoadTrackToDeck, onOpenShowEditor, runtimeMode, packageMessage, packageDirectories, packageReadyPaths, onExportPackage, onImportPackage, onOpenPackageDirectory, selectedProfileId, onSelectedProfileIdChange, onCreateVocalProfile, onRecordVocalProfileSample, onDeleteVocalProfile, onPrepareVocalProfileSong }) {
  const [activeSection,setActiveSection]=useState("all");
  const [libraryQuery,setLibraryQuery]=useState("");
  const [libraryFolder,setLibraryFolder]=useState("");
  const [selectedManagedSongPath,setSelectedManagedSongPath]=useState("");
  const [categoryName,setCategoryName]=useState("");
  const [categoryKind,setCategoryKind]=useState("event");
  const [editingCategoryId,setEditingCategoryId]=useState("");
  const [profileName,setProfileName]=useState("");
  const [profileConsent,setProfileConsent]=useState(false);
  const [profileDevice,setProfileDevice]=useState(()=>{
    try{return localStorage.getItem(VOCAL_PROFILE_DEVICE_STORAGE_KEY)||""}catch{return ""}
  });
  const [profileChannel,setProfileChannel]=useState(0);
  const [songQuery,setSongQuery]=useState("怎么说我不爱你");
  const [selectedSongPath,setSelectedSongPath]=useState(()=>{
    try{return localStorage.getItem(VOCAL_PROFILE_SONG_STORAGE_KEY)||""}catch{return ""}
  });
  const songsByPath=useMemo(()=>new Map(songs.map(song=>[song.path,song])),[songs]);
  const selectedPlaylist=playlistManagement.playlists.find(item=>item.name===activePlaylistName)??playlistManagement.playlists[0]??null;
  const playlistGroups=useMemo(()=>[
    {id:"weekday",label:"每周分类",items:playlistManagement.playlists.filter(item=>item.kind==="weekday")},
    {id:"event",label:"节日活动",items:playlistManagement.playlists.filter(item=>item.kind==="event")},
    {id:"custom",label:"自定义分类",items:playlistManagement.playlists.filter(item=>item.kind==="custom")},
  ],[playlistManagement.playlists]);
  const libraryFolders=useMemo(()=>{
    const counts=new Map();
    songs.forEach((song)=>{
      const folder=managedSongFolder(song);
      counts.set(folder,(counts.get(folder)??0)+1);
    });
    return [...counts.entries()]
      .map(([name,count])=>({name,count}))
      .sort((left,right)=>left.name.localeCompare(right.name,"zh-CN",{numeric:true}));
  },[songs]);
  const folderLibrarySongs=useMemo(
    ()=>libraryFolder?songs.filter((song)=>managedSongFolder(song)===libraryFolder):songs,
    [songs,libraryFolder],
  );
  const filteredLibrarySongs=useMemo(()=>{
    const query=normalizeSongPickerText(libraryQuery);
    return folderLibrarySongs.filter(song=>!query||normalizeSongPickerText(`${song.title} ${song.artist} ${song.path}`).includes(query)).slice(0,200);
  },[folderLibrarySongs,libraryQuery]);
  const selectedManagedSong=songsByPath.get(selectedManagedSongPath)??songs[0]??null;
  const selectedBinding=selectedManagedSong?.path?playlistManagement.trackBindings[selectedManagedSong.path]??{}:{};
  const todayName=currentWeekdayPlaylistName();
  useEffect(()=>{
    if(selectedManagedSongPath&&songsByPath.has(selectedManagedSongPath))return;
    setSelectedManagedSongPath(songs[0]?.path??"");
  },[selectedManagedSongPath,songs,songsByPath]);
  useEffect(()=>{
    if(!libraryFolder||libraryFolders.some((folder)=>folder.name===libraryFolder))return;
    setLibraryFolder("");
  },[libraryFolder,libraryFolders]);
  useEffect(()=>{
    setEditingCategoryId("");
    setCategoryName("");
  },[activeLibrary]);
  const choosePlaylist=(playlistItem)=>{
    onActivePlaylistNameChange(playlistItem.name);
    setSelectedManagedSongPath(playlistItem.trackPaths[0]??"");
  };
  const submitCategory=()=>{
    const name=categoryName.trim();
    if(!name)return;
    if(playlistManagement.playlists.some(item=>item.id!==editingCategoryId&&item.name.toLocaleLowerCase()===name.toLocaleLowerCase())){window.alert("已存在同名分类");return}
    if(editingCategoryId){
      const current=playlistManagement.playlists.find((item)=>item.id===editingCategoryId);
      const updated=renamePlaylistCategory(playlistManagement,editingCategoryId,name);
      onPlaylistManagementChange(updated);
      if(current?.name===activePlaylistName)onActivePlaylistNameChange(name);
      setEditingCategoryId("");
      setCategoryName("");
      return;
    }
    const item={id:`playlist:${categoryKind}:${Date.now()}`,name,kind:categoryKind,trackPaths:[]};
    onPlaylistManagementChange(addPlaylistCategory(playlistManagement,item));
    setCategoryName("");
    choosePlaylist(item);
  };
  const beginRenameCategory=(playlistItem)=>{
    if(!playlistItem||playlistItem.kind==="weekday")return;
    setEditingCategoryId(playlistItem.id);
    setCategoryKind(playlistItem.kind);
    setCategoryName(playlistItem.name);
  };
  const cancelCategoryEdit=()=>{
    setEditingCategoryId("");
    setCategoryName("");
  };
  const deleteCategory=(playlistItem)=>{
    if(!playlistItem||playlistItem.kind==="weekday")return;
    if(!window.confirm(`删除分类“${playlistItem.name}”？歌曲文件不会被删除。`))return;
    const updated=removePlaylistCategory(playlistManagement,playlistItem.id);
    onPlaylistManagementChange(updated);
    if(activePlaylistName===playlistItem.name)choosePlaylist(updated.playlists.find((item)=>item.name===currentWeekdayPlaylistName())??updated.playlists[0]);
    if(editingCategoryId===playlistItem.id)cancelCategoryEdit();
  };
  const addSongToSelectedCategory=(path)=>{
    if(!selectedPlaylist||!path)return;
    onPlaylistManagementChange(updatePlaylistTracks(playlistManagement,selectedPlaylist.id,paths=>paths.includes(path)?paths:[...paths,path]));
    setSelectedManagedSongPath(path);
  };
  const moveCategory=(playlistItem,direction)=>onPlaylistManagementChange(movePlaylistWithinKind(playlistManagement,playlistItem.id,direction));
  const updateBinding=(patch)=>{
    if(!selectedManagedSong?.path)return;
    onPlaylistManagementChange({...playlistManagement,trackBindings:{...playlistManagement.trackBindings,[selectedManagedSong.path]:{...selectedBinding,...patch}}});
  };
  const updateDailySchedule=(day,playlistId)=>onPlaylistManagementChange({...playlistManagement,dailySchedule:{...playlistManagement.dailySchedule,[day]:playlistId}});
  useEffect(()=>{
    if(!selectedProfileId&&vocalProfiles[0]?.id)onSelectedProfileIdChange(vocalProfiles[0].id);
    if(selectedProfileId&&!vocalProfiles.some(profile=>profile.id===selectedProfileId))onSelectedProfileIdChange(vocalProfiles[0]?.id??"");
  },[vocalProfiles,selectedProfileId,onSelectedProfileIdChange]);
  useEffect(()=>{
    if(vocalProfileDevices.length===0)return;
    if(profileDevice&&vocalProfileDevices.some(device=>device.name===profileDevice))return;
    let savedDevice="";
    try{savedDevice=localStorage.getItem(VOCAL_PROFILE_DEVICE_STORAGE_KEY)||""}catch{}
    const preferred=vocalProfileDevices.find(device=>device.name===savedDevice)
      ??[...vocalProfileDevices].sort((left,right)=>vocalProfileDeviceScore(right)-vocalProfileDeviceScore(left))[0];
    if(preferred?.name)setProfileDevice(preferred.name);
  },[vocalProfileDevices,profileDevice]);
  useEffect(()=>{
    if(!profileDevice)return;
    try{localStorage.setItem(VOCAL_PROFILE_DEVICE_STORAGE_KEY,profileDevice)}catch{}
    const channels=vocalProfileDevices.find(device=>device.name===profileDevice)?.channels??1;
    if(profileChannel>=channels)setProfileChannel(0);
  },[profileDevice,profileChannel,vocalProfileDevices]);
  useEffect(()=>{
    if(!songs.length)return;
    const selectedStillExists=selectedSongPath&&songs.some(song=>song.path===selectedSongPath);
    if(selectedStillExists)return;
    let savedPath="";
    try{savedPath=localStorage.getItem(VOCAL_PROFILE_SONG_STORAGE_KEY)||""}catch{}
    const saved=songs.find(song=>song.path===savedPath);
    const requested=songs.find(song=>normalizeSongPickerText(song.title).includes("怎么说我不爱你"));
    const fallback=saved??requested??null;
    if(fallback?.path){
      setSelectedSongPath(fallback.path);
      setSongQuery(fallback.title||"");
    }
  },[songs,selectedSongPath]);
  useEffect(()=>{
    if(!selectedSongPath)return;
    try{localStorage.setItem(VOCAL_PROFILE_SONG_STORAGE_KEY,selectedSongPath)}catch{}
  },[selectedSongPath]);
  const selectedProfile=vocalProfiles.find(profile=>profile.id===selectedProfileId)??null;
  const selectedSong=songs.find(song=>song.path===selectedSongPath)??null;
  const filteredSongs=useMemo(()=>{
    const query=normalizeSongPickerText(songQuery);
    const matches=query
      ? songs.filter(song=>normalizeSongPickerText(`${song.title} ${song.artist}`).includes(query))
      : songs;
    const limited=matches.slice(0,100);
    if(selectedSong&&!limited.some(song=>song.path===selectedSong.path))return [selectedSong,...limited];
    return limited;
  },[songs,songQuery,selectedSong]);
  return <section className="music-management-view" aria-label="音乐管理">
    {leftPanel}
    <div className="music-management-main">
      <header className="music-management-header">
        <div><MusicNotes weight="fill"/><span><b>音乐管理</b><small>管理歌单、每日播放顺序，以及歌曲的视频与灯光编排</small></span></div>
        <span><b>{songs.length}</b> 首可用歌曲 · 今日计划 <strong>{playlistManagement.playlists.find(item=>item.id===playlistManagement.dailySchedule[todayName])?.name??"未设置"}</strong></span>
      </header>
      <div className="music-management-tabs" role="tablist" aria-label="音乐管理功能">
        {[["all","全部歌单",ListNumbers],["categories","分类管理",Folders],["schedule","每日播放",CalendarBlank],["editor","歌曲编辑",PencilSimple],["packages","导入导出",FolderOpen],["vocal","歌手包",Microphone]].map(([id,label,Icon])=><button type="button" key={id} role="tab" aria-selected={activeSection===id} className={activeSection===id?"active":""} onClick={()=>setActiveSection(id)}><Icon weight={activeSection===id?"fill":"regular"}/>{label}</button>)}
      </div>
      <section className="music-management-content">
        {activeSection==="all"&&<section className="playlist-arrangement-workspace all-playlists-workspace">
          <header className="playlist-editor-header"><span><b>全部歌单</b><small>从完整曲库选择歌曲，插入左侧当前分类；不会自动装载或播放</small></span><strong className="current-category-target">{activeLibrary}号曲库 / {selectedPlaylist?.name??"未选择"} · {selectedPlaylist?.trackPaths.length??0} 首</strong></header>
          <div className="playlist-library-adder all-playlists-search"><label className="all-playlists-folder"><Folders weight="fill"/><select aria-label="按歌曲文件夹分类" value={libraryFolder} onChange={event=>setLibraryFolder(event.target.value)}><option value="">全部文件夹 · {songs.length} 首</option>{libraryFolders.map(folder=><option value={folder.name} key={folder.name}>{folder.name} · {folder.count} 首</option>)}</select></label><label className="all-playlists-query"><MagnifyingGlass weight="bold"/><input aria-label="搜索全部歌单中的歌曲或歌手" type="search" value={libraryQuery} onChange={event=>setLibraryQuery(event.target.value)} placeholder={libraryFolder?`在 ${libraryFolder} 中搜索歌曲或歌手`:"搜索全部歌曲、歌手或目录"}/></label><span>{filteredLibrarySongs.length}/{folderLibrarySongs.length} 首</span></div>
          <div className="playlist-table-head"><span>#</span><span>歌曲</span><span>歌手</span><span>BPM</span><span>时长</span><span>关联</span><span>加入当前分类</span></div>
          <div className="playlist-track-list">{filteredLibrarySongs.length?filteredLibrarySongs.map((song,index)=>{const binding=playlistManagement.trackBindings[song.path]??{};const alreadyAdded=Boolean(selectedPlaylist?.trackPaths.includes(song.path));return <article key={song.path} className={selectedManagedSong?.path===song.path?"selected":""} onClick={()=>setSelectedManagedSongPath(song.path)}><span className="playlist-drag">{String(index+1).padStart(2,"0")}</span><span className="playlist-song-copy"><b>{song.title}</b><small>{song.tag||song.path?.split(/[\\/]/).pop()}</small></span><span>{song.artist||"--"}</span><span>{song.bpm||"--"}</span><span>{song.duration||"--"}</span><span className="playlist-bindings"><i className={binding.videoId?"bound":""}><VideoCamera/>视频</i><i className={binding.lightPresetId!==undefined&&binding.lightPresetId!==""?"bound":""}><LightbulbFilament/>灯光</i></span><span className="all-playlist-actions"><button type="button" disabled={!selectedPlaylist||alreadyAdded} onClick={event=>{event.stopPropagation();addSongToSelectedCategory(song.path)}}>{alreadyAdded?<><CheckCircle weight="fill"/>已在{selectedPlaylist.name}</>:<><Plus weight="bold"/>加入{selectedPlaylist?.name??"当前分类"}</>}</button><button type="button" onClick={event=>{event.stopPropagation();onLoadTrackToDeck(1,song.index)}} title="装载到 Deck 1，不自动播放">1</button><button type="button" onClick={event=>{event.stopPropagation();onLoadTrackToDeck(2,song.index)}} title="装载到 Deck 2，不自动播放">2</button></span></article>}):<div className="playlist-empty"><MusicNotes/><b>没有找到歌曲</b><small>请更换歌曲名、歌手或目录关键词。</small></div>}</div>
        </section>}
        {activeSection==="categories"&&<section className="category-management-workspace">
          <header><div className="category-management-heading"><span><b>分类管理 · {activeLibrary}号曲库</b><small>两套曲库独立保存类型、顺序和歌曲归属</small></span><div className="category-library-switch" role="group" aria-label="选择要管理的曲库"><button type="button" className={activeLibrary===1?"active":""} onClick={()=>onActiveLibraryChange(1)}>1号曲库</button><button type="button" className={activeLibrary===2?"active":""} onClick={()=>onActiveLibraryChange(2)}>2号曲库</button></div></div><form onSubmit={event=>{event.preventDefault();submitCategory()}}><select aria-label="分类类型" value={categoryKind} disabled={Boolean(editingCategoryId)} onChange={event=>setCategoryKind(event.target.value)}><option value="event">节日活动</option><option value="custom">自定义分类</option></select><input aria-label={editingCategoryId?"修改分类名称":"新分类名称"} value={categoryName} onChange={event=>setCategoryName(event.target.value)} placeholder={editingCategoryId?"输入新名称":"输入分类名称"}/><button type="submit" disabled={!categoryName.trim()}>{editingCategoryId?<><FloppyDisk weight="bold"/>保存改名</>:<><Plus weight="bold"/>新建分类</>}</button>{editingCategoryId&&<button type="button" onClick={cancelCategoryEdit}><X weight="bold"/>取消</button>}</form></header>
          <div className="category-management-groups">{playlistGroups.map(group=><section key={group.id}><header><span><b>{group.label}</b><small>{group.items.length} 个分类{group.id==="weekday"?" · 系统固定":" · 可增删改排序"}</small></span></header><div>{group.items.length?group.items.map((item,index)=><article key={item.id} className={selectedPlaylist?.id===item.id?"active":""} onClick={()=>choosePlaylist(item)}><span><Folders weight={selectedPlaylist?.id===item.id?"fill":"regular"}/><b>{item.name}</b><small>{item.trackPaths.length} 首 · {selectedPlaylist?.id===item.id?"左侧当前分类":"点击设为当前分类"}</small></span><div><button type="button" disabled={index===0} onClick={event=>{event.stopPropagation();moveCategory(item,-1)}} title="上移"><ArrowUp/></button><button type="button" disabled={index===group.items.length-1} onClick={event=>{event.stopPropagation();moveCategory(item,1)}} title="下移"><ArrowDown/></button>{item.kind!=="weekday"&&<><button type="button" onClick={event=>{event.stopPropagation();beginRenameCategory(item)}} title="修改名称"><PencilSimple/></button><button type="button" className="danger" onClick={event=>{event.stopPropagation();deleteCategory(item)}} title="删除分类"><Trash/></button></>}</div></article>):<div className="category-group-empty">还没有{group.label}，可从上方新增</div>}</div></section>)}</div>
        </section>}
        {activeSection==="schedule"&&<section className="daily-schedule-workspace">
          <header><span><b>{activeLibrary}号曲库 · 每日播放计划</b><small>这套计划只属于当前曲库；保存计划不会自动启动播放</small></span></header>
          <div>{playlistWeekdays.map(day=><label key={day} className={day===todayName?"today":""}><span><CalendarBlank weight="fill"/><b>{day}</b><small>{day===todayName?"今天":"默认歌单"}</small></span><select value={playlistManagement.dailySchedule[day]??""} onChange={event=>updateDailySchedule(day,event.target.value)}>{playlistManagement.playlists.map(item=><option key={item.id} value={item.id}>{item.name} · {item.trackPaths.length} 首</option>)}</select></label>)}</div>
        </section>}
        {activeSection==="editor"&&<section className="song-link-editor">
          <header><span><b>歌曲演出项目</b><small>音乐管理只负责选择歌曲；视频、图片、文字与灯光统一进入演出编排</small></span></header>
          <label className="song-editor-selector"><span>编辑歌曲</span><select value={selectedManagedSong?.path??""} onChange={event=>setSelectedManagedSongPath(event.target.value)}>{songs.map(song=><option key={song.path} value={song.path}>{song.title} · {song.artist||"--"}</option>)}</select></label>
          {selectedManagedSong&&<><div className="song-editor-summary"><MusicNotes weight="fill"/><span><b>{selectedManagedSong.title}</b><small>{selectedManagedSong.artist||"未知歌手"} · {selectedManagedSong.bpm||"--"} BPM · {selectedManagedSong.duration||"--"}</small></span><div><button type="button" onClick={()=>onLoadTrackToDeck(1,selectedManagedSong.index)}>装载 Deck 1</button><button type="button" onClick={()=>onLoadTrackToDeck(2,selectedManagedSong.index)}>装载 Deck 2</button><button type="button" className="open-show-editor" onClick={()=>onOpenShowEditor(selectedManagedSong.index)}><FilmSlate weight="fill"/>打开演出编排</button></div></div><div className="song-binding-grid"><label><span><VideoCamera weight="fill"/><b>旧版视频关联</b><small>保留旧项目兼容；新项目请在演出编排时间线配置</small></span><select value={selectedBinding.videoId??""} onChange={event=>updateBinding({videoId:event.target.value})}><option value="">不关联视频</option>{videos.map(video=><option key={video.id} value={video.id}>{video.name}</option>)}</select></label><label><span><LightbulbFilament weight="fill"/><b>旧版灯光关联</b><small>只保存效果映射，不会在这里触发现场灯光</small></span><select value={selectedBinding.lightPresetId??""} onChange={event=>updateBinding({lightPresetId:event.target.value})}><option value="">不关联灯光</option>{lightingEffects.map(effect=><option key={effect.id} value={effect.id}>{effect.name}</option>)}</select></label></div><label className="song-editor-note"><span>编排备注</span><textarea value={selectedBinding.note??""} onChange={event=>updateBinding({note:event.target.value})} placeholder="例如：前奏 8 秒后切舞台视频，副歌进入暖场灯光"/></label></>}
        </section>}
        {activeSection==="packages"&&<section className="music-package-workspace">
          <header><span><b>歌曲包导入与导出</b><small>图二中的文件操作已集中到这里，首页仅保留播放功能</small></span><strong className={runtimeMode==="full"?"full":"player"}>{runtimeMode==="full"?"制作 + 播放":"仅播放"}</strong></header>
          <label><span>选择歌曲包</span><select value={selectedManagedSong?.path??""} onChange={event=>setSelectedManagedSongPath(event.target.value)}>{songs.map(song=><option key={song.path} value={song.path}>{song.title} · {song.artist||"--"}</option>)}</select></label>
          <div className="music-package-actions"><button type="button" disabled={!selectedManagedSong||!packageReadyPaths.includes(selectedManagedSong.path)} onClick={()=>onExportPackage(selectedManagedSong?.path)}><DownloadSimple weight="bold"/>导出所选歌曲包</button><button type="button" onClick={()=>onOpenPackageDirectory("outbox")}><FolderOpen/>打开导出目录</button><button type="button" onClick={()=>onOpenPackageDirectory("inbox")}><FolderOpen/>打开收件箱</button><button type="button" onClick={onImportPackage}><UploadSimple weight="bold"/>导入收件箱</button></div>
          <footer>{packageMessage||(packageDirectories?.inboxDirectory?`收件箱：${packageDirectories.inboxDirectory}`:"选择已完成 AI 制作的歌曲后可导出 .kingsong；导入不会自动播放。")}</footer>
        </section>}
        {activeSection==="vocal"&&<section className="vocal-profile-panel" aria-label="歌手音色包">
      <header>
        <div><Microphone weight="fill"/><span><b>歌手包 · 一次采集长期复用</b><small>每首歌仍需按歌词和旋律离线生成一次；歌手无需为每首歌重新录音</small></span></div>
        <strong className={selectedProfile?.state==="samples_ready"?"ready":"collecting"}>{selectedProfile ? (selectedProfile.state==="samples_ready"?"采样已合格":"采集中") : "尚未选择"}</strong>
      </header>
      <div className="vocal-profile-create">
        <label><span>歌手姓名 / 艺名</span><input value={profileName} placeholder="例如：女声 1" onChange={event=>setProfileName(event.target.value)}/></label>
        <label className="vocal-profile-consent"><input type="checkbox" checked={profileConsent} onChange={event=>setProfileConsent(event.target.checked)}/><span>本人已明确同意采集、生成和本地保存，并可随时删除</span></label>
        <button type="button" disabled={vocalProfileBusy||!profileName.trim()||!profileConsent} onClick={()=>onCreateVocalProfile(profileName,profileConsent).then(profile=>{if(profile?.id){onSelectedProfileIdChange(profile.id);setProfileName("");setProfileConsent(false)}})}>新建歌手包</button>
      </div>
      {vocalProfiles.length>0&&<div className="vocal-profile-selector">
        <label><span>当前歌手包</span><select value={selectedProfileId} onChange={event=>onSelectedProfileIdChange(event.target.value)}>{vocalProfiles.map(profile=><option value={profile.id} key={profile.id}>{profile.displayName} · {profile.acceptedSampleCount}/{profile.requiredSampleCount}</option>)}</select></label>
        <label><span>录音设备 · 已保存</span><select value={profileDevice} onChange={event=>setProfileDevice(event.target.value)}>{vocalProfileDevices.map(device=><option value={device.name} key={device.name}>{device.name} · {device.channels}ch / {device.sampleRate}Hz</option>)}</select></label>
        <label><span>输入声道</span><select value={profileChannel} onChange={event=>setProfileChannel(Number(event.target.value))}>{Array.from({length:Math.max(1,vocalProfileDevices.find(device=>device.name===profileDevice)?.channels??1)},(_,index)=><option value={index} key={index}>通道 {index+1}</option>)}</select></label>
      </div>}
      {selectedProfile&&<>
        <div className="vocal-profile-notice"><b>耳麦录音</b><span>已优先选择 Realtek 耳麦麦克风并记住选择；录音后会自动比较左右输入声道，静音声道不会造成误判。关闭音乐、原唱、伴奏、FX 和混响；每段固定录制 15 秒，总计约 90 秒。</span></div>
        <div className="vocal-profile-prompts">{vocalProfilePrompts.map(prompt=>{
          const sample=selectedProfile.samples?.[prompt.id];
          return <article className={sample?.report?.accepted?"accepted":sample?"rejected":""} key={prompt.id}>
            <span><b>{prompt.label}</b><small>{prompt.instruction}</small></span>
            <em>{sample?.report?.accepted?`合格 · 通道 ${Number(sample.report.channel??0)+1} · ${sample.report.rmsDbfs.toFixed(1)} dBFS`:sample?sample.report.message:"未录制"}</em>
            <button type="button" disabled={vocalProfileBusy||!profileDevice} onClick={()=>onRecordVocalProfileSample(selectedProfile.id,prompt.id,profileDevice,profileChannel)}>{sample?"重录 15 秒":"录制 15 秒"}</button>
          </article>;
        })}</div>
        <div className="vocal-profile-song-picker">
          <label><span>搜索目标歌曲</span><input type="search" value={songQuery} placeholder="输入歌曲名或歌手，例如：怎么说我不爱你" onChange={event=>setSongQuery(event.target.value)}/></label>
          <label><span>明确选择歌曲 · 不跟随 Deck</span><select value={selectedSongPath} onChange={event=>setSelectedSongPath(event.target.value)}><option value="" disabled>请选择歌曲</option>{filteredSongs.map(song=><option value={song.path} key={song.path}>{song.title} · {song.artist||"--"}</option>)}</select></label>
          <small>{filteredSongs.length}{songs.length>100?" / "+songs.length:""} 首匹配；歌手原始母样永久复用，换歌无需重新录音</small>
        </div>
        <div className="vocal-profile-generate">
          <span><b>{selectedSong?.title||"尚未选择歌曲"}</b><small>{selectedSong?`目标歌曲已锁定 · ${selectedSong.artist||"--"} · 不会随当前播放歌曲改变`:"请先搜索并选择要制作补音的歌曲"}</small></span>
          <button type="button" disabled={vocalProfileBusy||selectedProfile.state!=="samples_ready"||!selectedSong?.path} onClick={()=>onPrepareVocalProfileSong(selectedProfile.id,selectedSong.path)}>为所选歌曲生成女声补音</button>
          <button type="button" className="danger" disabled={vocalProfileBusy} onClick={()=>{if(window.confirm(`删除歌手包“${selectedProfile.displayName}”及全部录音？`))onDeleteVocalProfile(selectedProfile.id)}}>删除歌手包</button>
        </div>
        {selectedProfile.generatorState!=="ready"&&<p className="vocal-generator-warning">歌手采样可以先完成；本机歌声生成模型尚未安装时，只保存生成请求，不会用男原唱冒充女声。</p>}
      </>}
      <footer className={vocalProfileMessage?.state??"idle"}>{vocalProfileBusy?"正在录制或处理，请保持安静…":vocalProfileMessage?.message||"尚未建立歌手包"}</footer>
    </section>}
      </section>
    </div>
  </section>;
}

function SettingsView({ screenTargets, monitorTargets, onScreenChange, onMonitorChange, onSave, dirty, runtimeCapability, audioAiWorker, aiRuntimeBusy, onAiRuntimeEnabledChange, mixerModelId, mixerDriverStatus, mixerControlHost, mixerMeterStatus, onMixerModelChange, onMixerControlHostChange, onOpenMixerDriver, titanHost, titanStatus, titanPlaybacks, titanMappings, titanActionStatus, lightingPackageStatus, onTitanHostChange, onRefreshTitan, onTitanMappingChange, onExportLightingPackage, onImportLightingPackage, onOpenLightingPackageDirectory, vocalStatus, vocalBusy, onRefreshVocal, onVocalPresetChange, onVocalDisarm, vocalRouting, routingBusy, onDiscoverRouting, onSaveRouting, calibrationStatus, onRunCalibration }) {
  const failoverView=describeVocalFailover(vocalStatus.failover);
  const aiRuntimeAvailable=Boolean(runtimeCapability.aiProcessingAvailable);
  const aiRuntimeEnabled=audioAiWorker.enabled!==false;
  return <section className="settings-view" aria-label="屏幕与监控设置">
    <header className="settings-header">
      <div><GearSix weight="fill"/><span><b>屏幕与监控按钮设置</b><small>左侧 4 个输出屏，右侧预览开关与 3 个监控机位</small></span></div>
      <button className="settings-save" onClick={onSave} disabled={!dirty}><FloppyDisk weight="fill"/>{dirty ? "保存配置" : "配置已保存"}</button>
    </header>
    <section className={`settings-ai-runtime ${aiRuntimeEnabled?"enabled":"disabled"}`} aria-label="AI 歌曲制作运行开关">
      <div className="settings-ai-runtime-identity"><Lightning weight="fill"/><span><b>AI 歌曲制作</b><small>控制 MOSS 8B、分轨和歌词制作后台；不影响 Deck、mpv、Qu-16 或已制作歌曲</small></span></div>
      <div className="settings-ai-runtime-state" role="status"><i/><span><b>{!aiRuntimeAvailable?"本机为播放版":aiRuntimeEnabled?(audioAiWorker.running?"制作后台运行中":audioAiWorker.playbackProtected?"播放保护 · 制作已暂停":"制作后台启动中"):"开业模式 · AI 已关闭"}</b><small>{!aiRuntimeAvailable?"本机不会启动 MOSS 与制作 Worker":audioAiWorker.message||(aiRuntimeEnabled?"正在读取后台状态":"MOSS 与 Worker 均未运行")}</small></span></div>
      <button type="button" className="settings-ai-runtime-toggle" role="switch" aria-checked={aiRuntimeEnabled} disabled={!aiRuntimeAvailable||aiRuntimeBusy} onClick={()=>onAiRuntimeEnabledChange(!aiRuntimeEnabled)}><span/><b>{aiRuntimeBusy?"处理中":aiRuntimeEnabled?"关闭 AI 制作":"开启 AI 制作"}</b></button>
    </section>
    <section className="settings-mixer-model" aria-label="调音台型号设置">
      <div className="settings-mixer-identity"><SlidersHorizontal weight="fill"/><span><b>调音台型号包</b><small>USB-B 传输音频 · 以太网 TCP-MIDI 控制 · 选择型号后切换数字孪生 UI 与驱动</small></span></div>
      <label><span>当前型号</span><select value={mixerModelId} onChange={event=>onMixerModelChange(event.target.value)}>{mixerModels.map(model=><option value={model.id} key={model.id}>{model.displayName}</option>)}</select></label>
      <label className="settings-mixer-host"><span>以太网控制台 IP / 主机名</span><input value={mixerControlHost} placeholder="例如 192.168.1.60" spellCheck="false" onChange={event=>onMixerControlHostChange(event.target.value)}/></label>
      <div className="settings-mixer-states"><div className={`settings-driver-state ${mixerDriverStatus.state}`}><b>{mixerDriverStatus.title}</b><small>{mixerDriverStatus.message}</small></div><div className={`settings-meter-state ${mixerMeterStatus.state}`}><b>{mixerMeterStatus.title}</b><small>{mixerMeterStatus.message}</small></div></div>
      <button type="button" className="settings-driver-action" onClick={onOpenMixerDriver}>安装驱动 / EULA</button>
    </section>
    <section className="settings-lighting-console" aria-label="Avolites Titan 灯光控制台设置">
      <div className="settings-lighting-identity"><LightbulbFilament weight="fill"/><span><b>Avolites Titan 控制台</b><small>以太网 WebAPI · 真机保留 DMX 权威 · KING 仅读取并映射已编程 Playback</small></span></div>
      <label><span>控制台 IP / 主机名</span><input value={titanHost} placeholder="例如 192.168.1.154" spellCheck="false" onChange={event=>onTitanHostChange(event.target.value)}/></label>
      <div className={`settings-titan-state ${titanStatus.connected?"live":"offline"}`}><i/><span><b>{titanStatus.connected?`${titanStatus.deviceName} · LIVE`:titanStatus.environmentMode==="identity-mismatch"?"非绑定 Titan 控制台":"离线模拟模式"}</b><small>{titanStatus.connected?`Titan ${titanStatus.softwareVersion} · Show ${titanStatus.showName} · ${titanPlaybacks.length} 个 Playback/Cue`:titanStatus.message}</small></span></div>
      <button type="button" className="settings-titan-refresh" onClick={onRefreshTitan}><ArrowsClockwise/>刷新连接</button>
      <div className="settings-titan-mapping">
        <header><b>0–9 效果映射</b><small>只绑定 Titan 当前 Show 已编程的 Cue / Chase / Cue List；选择不会立即触发灯光</small></header>
        <div className="settings-titan-mapping-grid">{lights.map((preset)=><label key={preset.id}><span><b>{preset.id}</b><small>{preset.label||"待命名效果"}</small></span><select value={titanMappings[preset.id]??""} disabled={!titanStatus.connected} onChange={(event)=>onTitanMappingChange(preset.id,event.target.value)}><option value="">未绑定</option>{titanPlaybacks.map((playback)=><option value={playback.titanId} key={playback.titanId}>{titanPlaybackLabel(playback)}</option>)}</select></label>)}</div>
        <footer className={titanActionStatus.state}>{titanActionStatus.message}</footer>
      </div>
      <div className="settings-titan-package">
        <header><b>.kinglight 配置包</b><small>保存 Show 身份、Playback 映射、语义元数据和自动规则；导入永不触发灯光</small></header>
        <div><button type="button" onClick={onExportLightingPackage}>导出配置包</button><button type="button" onClick={()=>onOpenLightingPackageDirectory("inbox")}>打开收件箱</button><button type="button" onClick={onImportLightingPackage}>导入收件箱</button><button type="button" onClick={()=>onOpenLightingPackageDirectory("outbox")}>打开导出目录</button></div>
        <footer className={lightingPackageStatus.state}>{lightingPackageStatus.message}</footer>
      </div>
    </section>
    <section className="settings-vocal-engine" aria-label="AI 人声补音设置">
      <div className="settings-vocal-heading">
        <div className="settings-vocal-identity"><Microphone weight="fill"/><span><b>AI 人声补音</b><small>独立 Rust Vocal Engine · 三路隔离 · 当前不启动物理音频</small></span></div>
        <div className={`vocal-runtime-state ${vocalStatus.hardwareBound?"bound":"offline"}`}>
          <i aria-hidden="true"/><span><b>{vocalStatus.hardwareBound?"硬件已绑定":"离线控制 / 未武装"}</b><small>{vocalStatus.message}</small></span>
        </div>
        <div className={`vocal-failover-state ${failoverView.tone}`} role="status" aria-live="polite">
          <i aria-hidden="true"/><span><b>{failoverView.title}</b><small>{failoverView.message}</small></span>
        </div>
        <div className="settings-vocal-actions">
          <button type="button" onClick={onRefreshVocal} disabled={vocalBusy}><ArrowsClockwise/>{vocalBusy?"读取中":"刷新状态"}</button>
          <button type="button" onClick={onVocalDisarm} disabled={vocalBusy}><SpeakerSlash/>保持解除武装</button>
        </div>
      </div>
      <div className="vocal-lane-grid">
        {vocalStatus.lanes.map((lane,index)=><article className="vocal-lane-card" key={lane.lane}>
          <header><span className="vocal-lane-index">{index+1}</span><span><b>{lane.lane.toUpperCase()}</b><small>{vocalLaneLabels[lane.lane]}</small></span><i className={lane.fresh?"fresh":""} title={lane.fresh?"实时数据":"无实时输入"}/></header>
          <label><span>修音方案</span><select value={lane.preset} disabled={vocalBusy} onChange={event=>onVocalPresetChange(lane.lane,event.target.value)}>{vocalPresetOptions.map(option=><option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
          <dl>
            <div><dt>输入峰值</dt><dd>{formatVocalMetric(lane.inputPeakDbfs,{suffix:" dBFS",digits:1})}</dd></div>
            <div><dt>质量评分</dt><dd>{formatVocalMetric(lane.qualityScore,{digits:0})}</dd></div>
            <div><dt>修音混合</dt><dd>{formatVocalMetric(lane.correctedMix,{scale:100,suffix:"%",digits:0})}</dd></div>
          </dl>
        </article>)}
      </div>
      <section className={`vocal-routing-panel ${vocalRouting.hardwareReady?"verified":vocalRouting.stage}`} aria-label="Vocal Engine USB 通道映射">
        <header>
          <div><SlidersHorizontal weight="fill"/><span><b>Qu-16 USB / ASIO 通道映射</b><small>{vocalRouting.driverName?`${vocalRouting.driverName} · ${vocalRouting.sampleRate??"--"} Hz`:`逐路确认输入与处理返回，禁止按通道序号猜测`}</small></span></div>
          <span className="vocal-routing-stage"><i/>{routingStageLabel(vocalRouting.stage)}</span>
          <div className="vocal-routing-actions">
            <button type="button" onClick={onDiscoverRouting} disabled={routingBusy}><ArrowsClockwise/>发现通道</button>
            <button type="button" onClick={onRunCalibration} disabled={routingBusy}><SlidersHorizontal/>{routingBusy?"执行中":"向导演练"}</button>
            <button type="button" onClick={onSaveRouting} disabled={routingBusy||!vocalRouting.report||vocalRouting.saved}><FloppyDisk/>{vocalRouting.saved?"已保存":"保存映射"}</button>
            <button type="button" disabled title="连接 Qu-16 USB-B 并完成现场逐路追踪后开放"><CheckCircle/>现场确认待连接</button>
          </div>
        </header>
        <div className="vocal-calibration-progress" aria-label="三路校准进度">
          {calibrationStatus.lanes.map((lane,index)=><div className={lane.state} key={lane.lane}><span>{index+1}</span><b>{lane.lane.toUpperCase()}</b><small>{lane.state==="complete"?"输入与返回已绑定":lane.state==="pending"?"等待校准":"正在校准"}</small></div>)}
          <p><b>{calibrationStatus.finalState==="complete"?"向导演练完成":"现场逐路校准"}</b><small>{calibrationStatus.message}</small><em>{calibrationStatus.jointEvidence?`同步 ${calibrationStatus.maximumSkewFrames??"--"}/${calibrationStatus.allowedSkewFrames??"--"} 帧`:`拒绝串音 ${calibrationStatus.rejectedObservations} 次`}</em></p>
        </div>
        <div className="vocal-routing-lanes">
          {(vocalRouting.lanes.length?vocalRouting.lanes:vocalStatus.lanes.map((lane,index)=>({lane:lane.lane,quInputChannel:index+1,inputDriverIndex:null,inputChannelName:"未发现",returnDriverIndex:null,returnChannelName:"未发现",evidence:"virtual_signal_trace"}))).map(route=><article key={route.lane}>
            <strong>{route.lane.toUpperCase()}<small>QU CH{route.quInputChannel}</small></strong>
            <span><small>USB 输入</small><b>{route.inputDriverIndex===null?"--":`#${route.inputDriverIndex}`} · {route.inputChannelName}</b></span>
            <span><small>处理返回</small><b>{route.returnDriverIndex===null?"--":`#${route.returnDriverIndex}`} · {route.returnChannelName}</b></span>
            <em className={route.evidence==="onsite_signal_trace"?"onsite":"virtual"}>{route.evidence==="onsite_signal_trace"?"现场证据":"虚拟证据"}</em>
          </article>)}
        </div>
        <footer><span>{vocalRouting.message}</span><small>歧义 {vocalRouting.ambiguityCount??0} · 未启动声音 · 未写入 Qu-16</small></footer>
      </section>
    </section>
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
  const [playlistSelections,setPlaylistSelections]=useState(()=>{
    const today=currentWeekdayPlaylistName();
    return {"1":today,"2":today};
  });
  const playlist=playlistSelections[String(library)]??currentWeekdayPlaylistName();
  const setPlaylist=useCallback((value)=>{
    setPlaylistSelections(current=>{
      const key=String(library);
      const previous=current[key]??currentWeekdayPlaylistName();
      const next=typeof value==="function"?value(previous):value;
      return next===previous?current:{...current,[key]:next};
    });
  },[library]);
  const [playlistLibraries,setPlaylistLibraries]=useState(()=>{
    try{return normalizePlaylistLibraries(JSON.parse(localStorage.getItem(PLAYLIST_MANAGEMENT_STORAGE_KEY)))}catch{return createDefaultPlaylistLibraries()}
  });
  const playlistManagement=playlistLibraries.libraries[String(library)];
  const setPlaylistManagement=useCallback((value)=>{
    setPlaylistLibraries(current=>updatePlaylistLibrary(current,library,value));
  },[library]);
  const [playlistContextMenu,setPlaylistContextMenu]=useState(null);
  const [trackContextMenu,setTrackContextMenu]=useState(null);
  const [songSearch, setSongSearch] = useState("");
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [deck1, setDeck1] = useState(()=>desktopRuntime?null:0);
  const [deck2, setDeck2] = useState(()=>desktopRuntime?null:1);
  const [deckPlaybackQueueSources,setDeckPlaybackQueueSources]=useState({1:null,2:null});
  // 首屏默认由 Deck 1 播放；Deck 2 是待播位，只有操作员手动点击播放才会出声。
  const [playingDecks, setPlayingDecks] = useState(() => desktopRuntime ? { 1: false, 2: false } : { 1: true, 2: false });
  const [deckProgress, setDeckProgress] = useState(() => desktopRuntime ? { 1: 0, 2: 0 } : { 1: 136, 2: 0 });
  // KINGCLUB onsite cold-start baseline. Persisted operator values still win,
  // while a cleared WebView profile now falls back to the accepted safe mix.
  // Crossfade remains a live Auto-DJ state and must not be restored mid-queue.
  const [crossfade, setCrossfade] = useState(28);
  const [masterVolume, setMasterVolume] = useState(()=>loadMixerNumber("king.mixer.master",66));
  const [headphoneVolume, setHeadphoneVolume] = useState(()=>loadMixerNumber("king.mixer.headphones",33));
  const [microphoneVolumes, setMicrophoneVolumes] = useState([null,null]);
  const [faderInteractionActive, setFaderInteractionActive] = useState(false);
  const [vocalStatus,setVocalStatus]=useState(()=>createOfflineVocalStatus(desktopRuntime?"等待读取独立 Vocal Engine":"浏览器预览；未连接独立 Vocal Engine"));
  const [deckPlaybackModes, setDeckPlaybackModes] = useState({ 1: "sequence", 2: "sequence" });
  const [deckAutomationOwners,setDeckAutomationOwners]=useState({1:"automatic",2:"automatic"});
  const deckAutomationOwnersRef=useRef(deckAutomationOwners);
  const setDeckAutomationOwner=useCallback((deckNumber,owner)=>{
    deckAutomationOwnersRef.current={...deckAutomationOwnersRef.current,[deckNumber]:owner};
    setDeckAutomationOwners(deckAutomationOwnersRef.current);
  },[]);
  const [deckLyricsEnabled, setDeckLyricsEnabled] = useState({ 1: true, 2: true });
  const [deckVocalModes, setDeckVocalModes] = useState({ 1: "original", 2: "original" });
  const [deckAiRescueEnabled, setDeckAiRescueEnabled] = useState({ 1: false, 2: false });
  const [selectedVocalProfileId,setSelectedVocalProfileId]=useState(loadSelectedVocalProfileId);
  const [deckReferenceStatus,setDeckReferenceStatus]=useState({
    1:createDeckReferenceStatus(),
    2:createDeckReferenceStatus(),
  });
  const [vocalReferenceRevision,setVocalReferenceRevision]=useState(0);
  const vocalReferenceResolutionRef=useRef(0);
  const vocalReferenceBindKeyRef=useRef("");
  const vocalReferenceBindingGenerationRef=useRef(0);
  const initialDeckCueRecoveryRef=useRef(undefined);
  if(initialDeckCueRecoveryRef.current===undefined)initialDeckCueRecoveryRef.current=loadDeckCueRecovery();
  const [deckCue, setDeckCue] = useState(()=>initialDeckCueRecoveryRef.current
    ? {deck:initialDeckCueRecoveryRef.current.deck,busy:false,message:`检测到上次异常退出时 Deck ${initialDeckCueRecoveryRef.current.deck} 的 CUE；关闭后恢复 LR 路由`}
    : {deck:null,busy:false,message:"连接 Qu-16 后可用耳机 CUE"});
  const deckCueMainAssignedRef=useRef(initialDeckCueRecoveryRef.current?.mainAssigned??null);
  const [qu16OutputRestore,setQu16OutputRestore]=useState({busy:false,state:"idle",message:"恢复 8/26 已确认的 ST3 → LR 主输出基准"});
  const [video, setVideo] = useState(0);
  const [videoAssets, setVideoAssets] = useState([]);
  const [audioAssets, setAudioAssets] = useState([]);
  const audioAssetsRef = useRef([]);
  const audioScanStabilityRef = useRef(new Map());
  const deckSelectionRef = useRef({ 1:null, 2:null });
  const deckStartupSelectionAppliedRef = useRef({1:false,2:false});
  const [audioAnalyses, setAudioAnalyses] = useState({});
  const audioAnalysesRef = useRef({});
  const audioAnalysisPendingRef = useRef(new Set());
  const audioAnalysisQueueRef = useRef([]);
  const audioAnalysisWorkerRef = useRef(false);
  const audioAiQueuedRef = useRef(new Set());
  const audioAiQueueChainRef = useRef(Promise.resolve());
  const [runtimeCapability, setRuntimeCapability] = useState({ mode:desktopRuntime?"detecting":"player", hasNvidia:false, aiProcessingAvailable:false, message:desktopRuntime?"正在识别硬件":"浏览器播放版" });
  const [audioAiJobs, setAudioAiJobs] = useState([]);
  const [audioAiWorker, setAudioAiWorker] = useState({ enabled:null, running:false, message:"正在读取 AI 制作状态" });
  const audioAiQueueAllowed = shouldQueueAudioAiAnalysis(
    runtimeCapability.aiProcessingAvailable,
    audioAiWorker.enabled,
  );
  const audioAiQueueAllowedRef = useRef(audioAiQueueAllowed);
  audioAiQueueAllowedRef.current = audioAiQueueAllowed;
  const [aiRuntimeBusy,setAiRuntimeBusy]=useState(false);
  const [manualAiPendingPaths, setManualAiPendingPaths] = useState([]);
  const [songPackageDirectories, setSongPackageDirectories] = useState({ inboxDirectory:"", outboxDirectory:"" });
  const [songPackageMessage, setSongPackageMessage] = useState("");
  const [mpvRuntime, setMpvRuntime] = useState({ available:false, checked:!desktopRuntime, version:null, message:desktopRuntime?"正在检测 mpv":"浏览器原型模式" });
  const deckOneAudioRef = useRef(null);
  const deckTwoAudioRef = useRef(null);
  const realAudioInitializedRef = useRef(false);
  const mpvLoadedPathsRef = useRef({ 1:null, 2:null });
  const mpvAutoplayAfterLoadRef = useRef({ 1:false, 2:false });
  const mpvEndingRef = useRef({ 1:false, 2:false });
  const mpvEofHandledRef = useRef({ 1:false, 2:false });
  const mpvAutoTransitionRef = useRef({phase:"idle"});
  const mpvAutoTransitionTimerRef = useRef(null);
  const operatorDeckControlRef=useRef(async()=>{});
  const rhythmCursorRef = useRef({ 1:{ trackKey:null, seconds:0 }, 2:{ trackKey:null, seconds:0 } });
  const mpvVolumeWriterRef = useRef(null);
  if (!mpvVolumeWriterRef.current) mpvVolumeWriterRef.current = createMpvVolumeWriter();
  const cancelMpvAutoTransition=useCallback(()=>{
    if(mpvAutoTransitionTimerRef.current!==null){
      window.clearInterval(mpvAutoTransitionTimerRef.current);
      mpvAutoTransitionTimerRef.current=null;
    }
    mpvAutoTransitionRef.current={phase:"idle"};
  },[]);
  useEffect(()=>()=>cancelMpvAutoTransition(),[cancelMpvAutoTransition]);
  const mpvEnabled = desktopRuntime && mpvRuntime.available;
  const writeDeckOutputVolumes = useCallback((nextCrossfade,nextMasterVolume) => {
    const { deck1Gain:deckOneGain,deck2Gain:deckTwoGain,outputVolume } = deckCueMix(nextCrossfade,nextMasterVolume,headphoneVolume,deckCue.deck);
    if (mpvEnabled) {
      const batch = [];
      if (mpvLoadedPathsRef.current[1]) batch.push({deck:1,volume:deckOutputVolumePercent(deckOneGain,outputVolume,deckVocalModes[1])});
      if (mpvLoadedPathsRef.current[2]) batch.push({deck:2,volume:deckOutputVolumePercent(deckTwoGain,outputVolume,deckVocalModes[2])});
      if (batch.length) mpvVolumeWriterRef.current.enqueue(batch);
      return;
    }
    if (deckOneAudioRef.current) deckOneAudioRef.current.volume = deckOutputVolumeScalar(deckOneGain,outputVolume,deckVocalModes[1]);
    if (deckTwoAudioRef.current) deckTwoAudioRef.current.volume = deckOutputVolumeScalar(deckTwoGain,outputVolume,deckVocalModes[2]);
  },[deckCue.deck,deckVocalModes,headphoneVolume,mpvEnabled]);
  const takeDeckOperatorControl=async(deckNumber,{rollbackAutoTarget=true}={})=>{
    setDeckAutomationOwner(deckNumber,"operator");
    const transition=mpvAutoTransitionRef.current;
    if(transition.phase==="idle")return;
    const wasAutoTarget=transition.targetDeck===deckNumber;
    const pendingAutoLoad=wasAutoTarget&&transition.phase==="preloading"?transition.loadPromise:null;
    const shouldRollback=rollbackAutoTarget
      && transition.phase==="crossfading"
      && wasAutoTarget;
    cancelMpvAutoTransition();
    if(!shouldRollback){
      if(pendingAutoLoad)await pendingAutoLoad.catch(()=>null);
      if(wasAutoTarget&&["preloading","ready"].includes(transition.phase))writeDeckOutputVolumes(crossfade,masterVolume);
      return;
    }
    const sourceDeck=transition.sourceDeck;
    const targetDeck=transition.targetDeck;
    const startPosition=Number.isFinite(transition.visualPosition)?transition.visualPosition:crossfade;
    const endpoint=sourceDeck===1?0:100;
    const rollback={phase:"operator-rollback",sourceDeck,targetDeck};
    mpvAutoTransitionRef.current=rollback;
    await new Promise((resolve)=>{
      const startedAt=performance.now();
      mpvAutoTransitionTimerRef.current=window.setInterval(()=>{
        if(mpvAutoTransitionRef.current!==rollback){resolve();return}
        const progress=Math.min(1,(performance.now()-startedAt)/400);
        const position=startPosition+(endpoint-startPosition)*progress;
        setCrossfade(Math.round(position));
        writeDeckOutputVolumes(position,masterVolume);
        if(progress<1)return;
        window.clearInterval(mpvAutoTransitionTimerRef.current);
        mpvAutoTransitionTimerRef.current=null;
        setCrossfade(endpoint);
        writeDeckOutputVolumes(endpoint,masterVolume);
        void (async()=>{
          if(mpvEnabled){
            try{
              const state=await invoke("mpv_deck_set_paused",{deck:targetDeck,paused:true});
              applyMpvDeckState(state);
            }catch(error){
              console.error("人工接管时停止自动目标 Deck 失败",error);
            }
          }
          setPlayingDecks((current)=>({...current,[targetDeck]:false,[sourceDeck]:true}));
          mpvAutoTransitionRef.current={phase:"idle"};
          resolve();
        })();
      },40);
    });
  };
  operatorDeckControlRef.current=takeDeckOperatorControl;
  const beginFaderInteraction = useCallback(() => {
    setFaderInteractionActive(true);
  },[]);
  const endFaderInteraction = useCallback(() => setFaderInteractionActive(false),[]);
  const tracks = useMemo(() => audioAssets.length ? audioAssets.map((item)=>({
    id:item.id,
    title:item.title || item.name,
    artist:item.artist?.trim() || "--",
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
    coverSrc:item.coverSrc ?? "",
  })) : demoTracks.map((item)=>({...item,demo:true,tag:`演示 · ${item.tag}`})), [audioAssets]);
  const activePlaylistRecord=useMemo(
    ()=>playlistManagement.playlists.find((item)=>item.name===playlist)??null,
    [playlistManagement.playlists,playlist],
  );
  const activePlaylistPlaybackSource=useMemo(
    ()=>createPlaylistPlaybackSource(library,activePlaylistRecord),
    [library,activePlaylistRecord],
  );
  const trackIndexByPath=useMemo(
    ()=>new Map(tracks.map((track,index)=>[managedTrackIdentity(track,index),index])),
    [tracks],
  );
  const activePlaylistTrackIndexes=useMemo(()=>{
    if(!playlistManagement.seeded||!activePlaylistRecord)return tracks.map((_,index)=>index);
    return activePlaylistRecord.trackPaths.map((path)=>trackIndexByPath.get(path)).filter(Number.isInteger);
  },[tracks,trackIndexByPath,activePlaylistRecord,playlistManagement.seeded]);
  const deckPlaybackTrackIndexes=useMemo(()=>Object.fromEntries([1,2].map((deckNumber)=>[
    deckNumber,
    resolvePlaybackQueuePaths(playlistLibraries,deckPlaybackQueueSources[deckNumber])
      .map((path)=>trackIndexByPath.get(path))
      .filter(Number.isInteger),
  ])),[playlistLibraries,deckPlaybackQueueSources,trackIndexByPath]);
  useEffect(()=>{
    if(!desktopRuntime||!tracks.length)return;
    const selections=resolveWeekdayDeckStartupSelections(
      playlistLibraries,
      trackIndexByPath,
      currentWeekdayPlaylistName(),
    );
    const pendingDecks=[1,2].filter((deckNumber)=>!deckStartupSelectionAppliedRef.current[deckNumber]);
    if(!pendingDecks.length)return;
    setDeckPlaybackQueueSources((current)=>{
      let changed=false;
      const next={...current};
      for(const deckNumber of pendingDecks){
        const source=selections[deckNumber].source;
        if(!source)continue;
        const existing=current[deckNumber];
        if(existing?.kind===source.kind&&existing?.libraryKey===source.libraryKey&&existing?.playlistId===source.playlistId)continue;
        next[deckNumber]=source;
        changed=true;
      }
      return changed?next:current;
    });
    const resolvedDecks=pendingDecks.filter((deckNumber)=>Number.isInteger(selections[deckNumber].trackIndex));
    if(!resolvedDecks.length)return;
    for(const deckNumber of resolvedDecks)deckStartupSelectionAppliedRef.current[deckNumber]=true;
    if(resolvedDecks.includes(1))setDeck1(selections[1].trackIndex);
    if(resolvedDecks.includes(2))setDeck2(selections[2].trackIndex);
    setDeckProgress((current)=>Object.fromEntries([1,2].map((deckNumber)=>[
      deckNumber,
      resolvedDecks.includes(deckNumber)?0:current[deckNumber],
    ])));
    setPlayingDecks((current)=>Object.fromEntries([1,2].map((deckNumber)=>[
      deckNumber,
      resolvedDecks.includes(deckNumber)?false:current[deckNumber],
    ])));
  },[desktopRuntime,tracks.length,playlistLibraries,trackIndexByPath]);
  useEffect(()=>{
    const trackPaths=tracks.map(managedTrackIdentity).filter(Boolean);
    setPlaylistManagement(current=>seedPlaylistManagement(current,trackPaths,playlist));
  },[tracks,playlist,setPlaylistManagement]);
  useEffect(()=>{
    try{localStorage.setItem(PLAYLIST_MANAGEMENT_STORAGE_KEY,JSON.stringify(playlistLibraries))}catch{}
  },[playlistLibraries]);
  useEffect(()=>{
    if(!playlistContextMenu&&!trackContextMenu)return undefined;
    const closeMenu=(event)=>{
      if(event?.type==="pointerdown"&&event.button===2)return;
      setPlaylistContextMenu(null);
      setTrackContextMenu(null);
    };
    const closeOnKey=(event)=>{if(event.key==="Escape")closeMenu()};
    window.addEventListener("pointerdown",closeMenu);
    window.addEventListener("resize",closeMenu);
    window.addEventListener("blur",closeMenu);
    window.addEventListener("keydown",closeOnKey);
    return ()=>{
      window.removeEventListener("pointerdown",closeMenu);
      window.removeEventListener("resize",closeMenu);
      window.removeEventListener("blur",closeMenu);
      window.removeEventListener("keydown",closeOnKey);
    };
  },[playlistContextMenu,trackContextMenu]);
  useEffect(() => {
    if (!desktopRuntime) return;
    const deck = selectDominantDeck(playingDecks,crossfade) ?? (crossfade < 50 ? 1 : 2);
    invoke("vocal_sync_playback",{
      deck,
      seconds:Math.max(0,Number(deckProgress[deck])||0),
      playing:Boolean(playingDecks[deck]),
    }).catch((error)=>console.debug("Vocal Engine 播放时钟等待中",error));
  },[desktopRuntime,crossfade,deckProgress,playingDecks]);
  useEffect(() => {
    if (!desktopRuntime) return;
    const deck = selectDominantDeck(playingDecks,crossfade) ?? (crossfade < 50 ? 1 : 2);
    const enabled = AI_RESCUE_FEATURE_ENABLED
      && deckVocalModes[deck] === "accompaniment"
      && Boolean(deckAiRescueEnabled[deck])
      && Boolean(deckReferenceStatus[deck]?.bound);
    invoke("vocal_set_rescue_enabled",{enabled})
      .catch((error)=>console.debug("Vocal Engine 补音开关等待中",error));
  },[desktopRuntime,crossfade,deckAiRescueEnabled,deckReferenceStatus,deckVocalModes,playingDecks]);
  useEffect(() => {
    if (!desktopRuntime || !mpvEnabled) return;
    const plans=deckRescuePreviewPlans({
      crossfade,
      masterVolume,
      headphoneVolume,
      cueDeck:deckCue.deck,
      playingDecks,
      vocalModes:deckVocalModes,
      rescueEnabled:deckAiRescueEnabled,
      referenceStatus:deckReferenceStatus,
      physicalAudioStarted:vocalStatus.physicalAudioStarted,
    });
    for(const plan of plans){
      invoke("mpv_rescue_preview_sync",{
        ...plan,
        seconds:Math.max(0,Number(deckProgress[plan.deck])||0),
      }).catch((error)=>console.error(`Deck ${plan.deck} 本地补音试听同步失败`,error));
    }
  },[
    crossfade,
    deckAiRescueEnabled,
    deckCue.deck,
    deckProgress,
    deckReferenceStatus,
    deckVocalModes,
    desktopRuntime,
    headphoneVolume,
    masterVolume,
    mpvEnabled,
    playingDecks,
    vocalStatus.physicalAudioStarted,
  ]);
  useEffect(()=>()=>{
    if(!desktopRuntime||!mpvEnabled)return;
    for(const deck of [1,2]){
      invoke("mpv_rescue_preview_sync",{
        deck,
        path:".",
        seconds:0,
        playing:false,
        enabled:false,
        volume:0,
      }).catch(()=>{});
    }
  },[desktopRuntime,mpvEnabled]);
  const normalizeMediaPath = (value) => {
    const path = String(value ?? "");
    return (path.startsWith("\\\\?\\") ? path.slice(4) : path).toLowerCase();
  };
  const audioAiJobByPath = useMemo(() => {
    const newestJobByPath = new Map();
    for (const job of audioAiJobs) {
      const path = normalizeMediaPath(job.mediaPath);
      if (path && !newestJobByPath.has(path)) newestJobByPath.set(path,job);
    }
    return newestJobByPath;
  },[audioAiJobs]);
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
  const activeLyric = lyricsDeck
    ? lyricAtTime(deckLyricsLines[lyricsDeck],deckProgress[lyricsDeck])
    : null;
  const activeLyricIndex = activeLyric?.index ?? -1;
  const activeLyrics = useMemo(() => {
    if (!lyricsDeck||activeLyricIndex<0) return null;
    const lines=deckLyricsLines[lyricsDeck];
    return {
      deck:lyricsDeck,
      trackId:tracks[lyricsDeck===1?deck1:deck2]?.id ?? null,
      index:activeLyricIndex,
      visible:activeLyric?.visible!==false,
      previousText:lines[activeLyricIndex-1]?.text ?? "",
      text:lines[activeLyricIndex].text,
      nextText:lines[activeLyricIndex+1]?.text ?? "",
      followingText:lines[activeLyricIndex+2]?.text ?? "",
    };
  },[lyricsDeck,activeLyricIndex,activeLyric?.visible,deckLyricsLines,tracks,deck1,deck2]);
  const audioAnalysisFingerprint = useMemo(
    () => audioAssets.map((item)=>audioAnalysisKey(item)).filter(Boolean).join("\n"),
    [audioAssets],
  );
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let disposed = false;
    Promise.all([invoke("runtime_capabilities"),invoke("song_package_directories")])
      .then(([capability,directories])=>{
        if (disposed) return;
        setRuntimeCapability(capability);
        setSongPackageDirectories(directories);
      })
      .catch((error)=>console.error("读取运行能力失败",error));
    return ()=>{disposed=true};
  },[]);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__||!runtimeCapability.aiProcessingAvailable||audioAiWorker.enabled===false) return;
    const loadedDeckPaths=[tracks[deck1]?.path,tracks[deck2]?.path].filter(Boolean);
    const playingPaths=[playingDecks[1]?tracks[deck1]?.path:null,playingDecks[2]?tracks[deck2]?.path:null].filter(Boolean);
    invoke("set_audio_ai_scheduler",{playingPaths,deckPaths:[...new Set(loadedDeckPaths)]})
      .then((worker)=>setAudioAiWorker((current)=>JSON.stringify(current)===JSON.stringify(worker)?current:worker))
      .catch((error)=>console.error("更新 AI 三级调度失败",error));
  },[runtimeCapability.aiProcessingAvailable,audioAiWorker.enabled,playingDecks[1],playingDecks[2],tracks,deck1,deck2]);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let disposed = false;
    const refresh = () => Promise.all([invoke("list_audio_ai_jobs"),invoke("audio_ai_worker_status")])
      .then(([jobs,worker])=>{
        if (disposed) return;
        const nextJobs=Array.isArray(jobs)?jobs:[];
        setAudioAiJobs((current)=>JSON.stringify(current)===JSON.stringify(nextJobs)?current:nextJobs);
        setAudioAiWorker((current)=>JSON.stringify(current)===JSON.stringify(worker)?current:worker);
      })
      .catch((error)=>console.error("读取 AI 制作队列失败",error));
    refresh();
    const timer=window.setInterval(refresh,3000);
    return ()=>{disposed=true;window.clearInterval(timer)};
  },[]);
  const changeAiRuntimeEnabled=useCallback(async(enabled)=>{
    if(!window.__TAURI_INTERNALS__||aiRuntimeBusy)return;
    setAiRuntimeBusy(true);
    try{
      const worker=await invoke("set_audio_ai_runtime_enabled",{enabled});
      setAudioAiWorker(worker);
    }catch(error){
      console.error("切换 AI 制作运行状态失败",error);
      setSongPackageMessage(`AI 制作开关失败：${String(error)}`);
    }finally{
      setAiRuntimeBusy(false);
    }
  },[aiRuntimeBusy]);
  useEffect(() => {
    audioAssetsRef.current = audioAssets;
    deckSelectionRef.current = {
      1:tracks[deck1] ? { id:tracks[deck1].id, path:tracks[deck1].path } : null,
      2:tracks[deck2] ? { id:tracks[deck2].id, path:tracks[deck2].path } : null,
    };
  }, [audioAssets, deck1, deck2, tracks]);
  const [mediaLibraryDirectories, setMediaLibraryDirectories] = useState({ rootDirectory:"", videoDirectory:"", audioDirectory:"" });
  const [audioImportStatus,setAudioImportStatus]=useState({state:"idle",detected:0,ready:0,failed:0,message:""});
  const [imageAssets, setImageAssets] = useState([]);
  const [systemFonts, setSystemFonts] = useState(fallbackFontFamilies);
  const [fontLibraryDirectory,setFontLibraryDirectory] = useState("");
  const [customFontCount,setCustomFontCount] = useState(0);
  const refreshFontLibrary = () => invoke("font_library")
    .then(async (library)=>{
      await registerCustomFonts(library?.customFonts);
      applyPreferredLyricsFont(library);
      const nextFonts=mergeFontFamilies(library,fallbackFontFamilies);
      setSystemFonts(current=>current.length===nextFonts.length&&current.every((font,index)=>font===nextFonts[index])?current:nextFonts);
      const nextDirectory=library?.directory??"";
      setFontLibraryDirectory(current=>current===nextDirectory?current:nextDirectory);
      setCustomFontCount(library?.customFonts?.length??0);
      return library;
    });
  const [imageLibraryDirectory, setImageLibraryDirectory] = useState("");
  const [selectedImage, setSelectedImage] = useState(blackScreenImage.id);
  const [outputMedia, setOutputMedia] = useState({ ...blackScreenImage, type:"image" });
  const [videoPlayback,setVideoPlayback]=useState({mode:"sequence",queueIds:[],mediaId:null,token:0});
  const videoPlaybackRef=useRef(videoPlayback);
  const updateVideoPlayback=useCallback((next)=>{
    videoPlaybackRef.current=next;
    setVideoPlayback(next);
  },[]);
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
  const [videoRenderLimit, setVideoRenderLimit] = useState(VIDEO_GRID_INITIAL_LIMIT);
  // Venue startup is deterministic: always return to automatic lighting so a
  // stale manual preset cannot disable PGM colour and music-beat following.
  // Operators can still select a manual preset for the current session.
  const [light, setLight] = useState(null);
  const [autoLightPreset, setAutoLightPreset] = useState(0);
  // Per-bar automation depends on reliable downbeat metadata. Real club tracks
  // with low-confidence analysis still expose useful beat events, so default to
  // every beat and let the operator explicitly choose a sparser rule.
  const [lightRhythmRule, setLightRhythmRule] = useState("beat");
  const [videoRhythmRule, setVideoRhythmRule] = useState(()=>loadRhythmRule("king.rhythm.video","off"));
  const automationVideoIndexRef = useRef(-1);
  const [lightingEnabled, setLightingEnabled] = useState(true);
  // Beam movement is separately armed and intentionally never persisted. A
  // restart may restore the safe Gatling environment, but must not launch a
  // focused beam show before the floor and furniture are confirmed clear.
  const [beamShowArmed,setBeamShowArmed]=useState(false);
  const [titanHost,setTitanHost]=useState(()=>window.localStorage.getItem("king.lighting.titanHost")||"192.168.1.154");
  const [titanStatus,setTitanStatus]=useState({connected:false,environmentMode:"detecting",host:"",port:4430,deviceName:"Avolites Titan",softwareVersion:"--",showName:"--",message:"正在识别酒吧灯光控制台"});
  const [titanInventory,setTitanInventory]=useState({state:"idle",authoritative:false,fixtureCount:0,groupCount:0,playbackCount:0,fixtures:[],groups:[],liveShowName:"",cachedShowName:"",blockedReason:"尚未读取真机 Patch"});
  const [titanPlaybacks,setTitanPlaybacks]=useState([]);
  const [titanStaticPlaybacks,setTitanStaticPlaybacks]=useState([]);
  const [titanMappings,setTitanMappings]=useState(loadTitanMappings);
  const [titanEffectRegistry,setTitanEffectRegistry]=useState(loadTitanEffectRegistry);
  const [titanMappingShowName,setTitanMappingShowName]=useState(()=>window.localStorage.getItem("king.lighting.mappingShowName")||"");
  const [titanActionStatus,setTitanActionStatus]=useState({state:"idle",message:"尚未由 KING 触发 Titan Playback"});
  const [lightingPackageStatus,setLightingPackageStatus]=useState({state:"idle",message:"可导出当前灯光配置，或从收件箱导入"});
  const [lightingPackageDirectories,setLightingPackageDirectories]=useState({inboxDirectory:"",outboxDirectory:""});
  const [titanSimulation,setTitanSimulation]=useState(createTitanSimulatorState);
  const titanPollGenerationRef=useRef(0);
  const titanStatusProbeRef=useRef(null);
  const titanActiveHandleRef=useRef({scene:null,accent:null});
  const titanSimulationRef=useRef(titanSimulation);
  const titanCommandQueueRef=useRef(Promise.resolve());
  const gatlingUpdateQueueRef=useRef(createLatestOnlyAsyncQueue());
  const gatlingBaselineKeyRef=useRef("");
  const beamShowControllerRef=useRef(createBeamShowController());
  const beamShowBusyRef=useRef(false);
  const beamPreparedKeyRef=useRef("");
  const titanAutomationRef=useRef(createLightingAutomationState());
  const titanDiscoveryRef=useRef({busy:false,lastAttempt:0});
  const qu16DiscoveryRef=useRef({busy:false,lastAttempt:0});
  const outputVideoElementRef=useRef(null);
  const videoColorCanvasRef=useRef(null);
  const videoColorSamplingErrorRef=useRef(null);
  const videoColorAutomationRef=useRef({family:null,stableSamples:0,lastAppliedFamily:null});
  const [lightPlaybackModes, setLightPlaybackModes] = useState(loadLightPlaybackModes);
  const [fixtureColorEditor, setFixtureColorEditor] = useState(null);
  const [fixtureColors, setFixtureColors] = useState(() => Object.fromEntries(fixtureControls.map((fixture) => [fixture.id, fixture.color])));
  const [screenTargets, setScreenTargets] = useState(() => loadTargetSettings("king.screenTargets", defaultScreenTargets));
  const [monitorTargets, setMonitorTargets] = useState(() => loadTargetSettings("king.monitorTargets", defaultMonitorTargets));
  const [screenTarget, setScreenTarget] = useState(0);
  const [monitorTarget, setMonitorTarget] = useState(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [ledOutputStatus, setLedOutputStatus] = useState({ connected: false, previewMode: false, message: "正在检测 LED 第二屏" });
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [mixerModelId, setMixerModelId] = useState(()=>window.localStorage.getItem("king.mixer.model")||defaultMixerModelId);
  const [mixerDriverStatus, setMixerDriverStatus] = useState({state:"checking",title:"正在检测驱动",message:"Windows 桌面端会核对当前型号的驱动状态"});
  const [mixerControlHost,setMixerControlHost]=useState(()=>window.localStorage.getItem("king.mixer.controlHost")||"192.168.1.60");
  const [mixerMeterStatus,setMixerMeterStatus]=useState({state:"disconnected",title:"真机表计未连接",message:"在设置中填写 Qu-16 的以太网 IP"});
  const [mixerParameterSnapshot,setMixerParameterSnapshot]=useState(null);
  const mixerParameterSnapshotRef=useRef(null);
  const [mixerControlStatus,setMixerControlStatus]=useState({mode:"local-ui-only",state:"offline",title:"本地控制",message:"离线数字孪生模式"});
  const [vocalBusy,setVocalBusy]=useState(false);
  const [vocalProfiles,setVocalProfiles]=useState([]);
  const [vocalProfileDevices,setVocalProfileDevices]=useState([]);
  const [vocalProfileBusy,setVocalProfileBusy]=useState(false);
  const [vocalProfileMessage,setVocalProfileMessage]=useState({state:"idle",message:"请选择或新建歌手包"});
  const [vocalRouting,setVocalRouting]=useState(()=>createOfflineRoutingStatus(desktopRuntime?"等待读取已保存映射":"浏览器预览；可执行离线演练"));
  const [routingBusy,setRoutingBusy]=useState(false);
  const [calibrationStatus,setCalibrationStatus]=useState(()=>createCalibrationStatus());
  const qu16MeterEffectGenerationRef=useRef(0);
  const qu16ControlSessionRef=useRef({generation:0,host:"",sessionId:null,revision:-1,live:false});
  const qu16ParameterFrameApplyRef=useRef(null);
  const qu16BrowserParameterFrameRef=useRef({host:null,sessionId:null,revision:-1});
  const homeMicrophoneWritesRef=useRef(new Map());
  const homeMicrophoneFlushTimerRef=useRef(null);
  const homeMicrophoneWriterRef=useRef(null);
  const homeMicrophoneControlModeRef=useRef("local-ui-only");
  const [activeNav, setActiveNav] = useState("首页");
  const effectiveLight = light === null ? autoLightPreset : light;
  const activeMixerModel = mixerModelById(mixerModelId);
  const microphoneBindings = useMemo(()=>homeMicrophoneBindings(activeMixerModel),[activeMixerModel]);
  const refreshVocalStatus=useCallback(async()=>{
    if(!desktopRuntime){
      setVocalStatus(current=>normalizeVocalResponse(createOfflineVocalStatus(),current));
      return;
    }
    setVocalBusy(true);
    try{
      const response=await invoke("vocal_runtime_status");
      setVocalStatus(current=>normalizeVocalResponse(response,current));
    }catch(error){
      setVocalStatus(current=>({...current,physicalAudioStarted:false,hardwareBound:false,message:`Vocal Engine 控制桥不可用：${String(error)}`}));
    }finally{
      setVocalBusy(false);
    }
  },[desktopRuntime]);
  const refreshVocalRouting=useCallback(async()=>{
    if(!desktopRuntime)return;
    try{
      const response=await invoke("vocal_routing_status");
      setVocalRouting(current=>normalizeRoutingResponse(response,current));
    }catch(error){
      setVocalRouting(current=>({...current,hardwareReady:false,message:`通道映射读取失败：${String(error)}`}));
    }
  },[desktopRuntime]);
  const refreshVocalProfiles=useCallback(async()=>{
    if(!desktopRuntime){
      setVocalProfileMessage({state:"error",message:"歌手包录制仅在桌面版中可用"});
      return;
    }
    try{
      const [profiles,devices]=await Promise.all([
        invoke("list_vocal_profiles"),
        invoke("vocal_profile_input_devices"),
      ]);
      setVocalProfiles(Array.isArray(profiles)?profiles:[]);
      setVocalProfileDevices(Array.isArray(devices)?devices:[]);
      setVocalProfileMessage(current=>current.state==="error"?{state:"idle",message:"请选择或新建歌手包"}:current);
    }catch(error){
      setVocalProfileMessage({state:"error",message:`读取歌手包失败：${String(error)}`});
    }
  },[desktopRuntime]);
  const selectVocalProfile=useCallback((profileId)=>{
    const next=String(profileId||"");
    setSelectedVocalProfileId(next);
    try{
      if(next)localStorage.setItem(VOCAL_PROFILE_SELECTED_STORAGE_KEY,next);
      else localStorage.removeItem(VOCAL_PROFILE_SELECTED_STORAGE_KEY);
    }catch{}
  },[]);
  useEffect(()=>{
    if(!desktopRuntime)return;
    refreshVocalProfiles();
  },[desktopRuntime,refreshVocalProfiles]);
  useEffect(()=>{
    if(vocalProfiles.length===0)return;
    if(!selectedVocalProfileId||!vocalProfiles.some(profile=>profile.id===selectedVocalProfileId)){
      selectVocalProfile(vocalProfiles[0].id);
    }
  },[selectedVocalProfileId,selectVocalProfile,vocalProfiles]);
  useEffect(()=>{
    const generation=++vocalReferenceResolutionRef.current;
    const deckTracks={1:tracks[deck1],2:tracks[deck2]};
    if(!desktopRuntime||!selectedVocalProfileId){
      const message=desktopRuntime?"请先在音乐管理选择歌手包":"歌手补音绑定仅在桌面版中可用";
      setDeckReferenceStatus({1:createDeckReferenceStatus("idle",message),2:createDeckReferenceStatus("idle",message)});
      return;
    }
    for(const deck of [1,2]){
      const track=deckTracks[deck];
      if(!track?.path){
        setDeckReferenceStatus(current=>({...current,[deck]:createDeckReferenceStatus("idle","Deck 尚未装入本地歌曲")}));
        continue;
      }
      setDeckReferenceStatus(current=>({...current,[deck]:createDeckReferenceStatus("checking",`正在检查 ${track.title} 的歌手补音参考`)}));
      invoke("resolve_vocal_profile_song_reference",{profileId:selectedVocalProfileId,mediaPath:track.path})
        .then(report=>{
          if(vocalReferenceResolutionRef.current!==generation)return;
          setDeckReferenceStatus(current=>({...current,[deck]:{...report,bound:false}}));
        })
        .catch(error=>{
          if(vocalReferenceResolutionRef.current!==generation)return;
          setDeckReferenceStatus(current=>({...current,[deck]:createDeckReferenceStatus("missing",`补音参考检查失败：${String(error)}`)}));
        });
    }
  },[deck1,deck2,desktopRuntime,selectedVocalProfileId,tracks,vocalReferenceRevision]);
  useEffect(()=>{
    const pendingStates=new Set(["queued","preparing_reference","converting_voice","encoding"]);
    if(!pendingStates.has(deckReferenceStatus[1]?.state)&&!pendingStates.has(deckReferenceStatus[2]?.state))return;
    const timer=window.setTimeout(()=>setVocalReferenceRevision(current=>current+1),3000);
    return ()=>window.clearTimeout(timer);
  },[deckReferenceStatus]);
  useEffect(()=>{
    const deck=selectDominantDeck(playingDecks,crossfade)??(crossfade<50?1:2);
    const status=deckReferenceStatus[deck];
    const shouldBind=AI_RESCUE_FEATURE_ENABLED
      && desktopRuntime
      && deckVocalModes[deck]==="accompaniment"
      && Boolean(deckAiRescueEnabled[deck])
      && Boolean(status?.ready);
    if(!shouldBind){
      if(vocalReferenceBindKeyRef.current){
        vocalReferenceBindKeyRef.current="";
        const generation=++vocalReferenceBindingGenerationRef.current;
        invoke("vocal_unbind_reference")
          .then(()=>{
            if(vocalReferenceBindingGenerationRef.current!==generation)return;
            setDeckReferenceStatus(current=>({
              1:{...current[1],bound:false},
              2:{...current[2],bound:false},
            }));
          })
          .catch((error)=>console.debug("解除 Vocal Engine 补音参考等待中",error));
      }
      return;
    }
    const bindingKey=[deck,status.profileId,status.mediaPath,status.referencePath,status.referenceVocalPath].join("|");
    if(status.bound||vocalReferenceBindKeyRef.current===bindingKey)return;
    vocalReferenceBindKeyRef.current=bindingKey;
    const generation=++vocalReferenceBindingGenerationRef.current;
    setDeckReferenceStatus(current=>({...current,[deck]:{...current[deck],state:"binding",bound:false,message:`正在把 ${status.displayName} 的女声参考绑定到 Deck ${deck}`}}));
    invoke("vocal_bind_reference",{request:{
      profileId:status.profileId,
      displayName:status.displayName,
      mediaPath:status.mediaPath,
      referencePath:status.referencePath,
      referenceVocalPath:status.referenceVocalPath,
    }}).then(response=>{
      if(vocalReferenceBindingGenerationRef.current!==generation)return;
      setDeckReferenceStatus(current=>({
        1:deck===1?{...current[1],state:"ready",ready:true,bound:true,message:response.message||"Deck 1 补音参考已绑定；现场路由未启动"}:{...current[1],bound:false},
        2:deck===2?{...current[2],state:"ready",ready:true,bound:true,message:response.message||"Deck 2 补音参考已绑定；现场路由未启动"}:{...current[2],bound:false},
      }));
    }).catch(error=>{
      if(vocalReferenceBindingGenerationRef.current!==generation)return;
      setDeckReferenceStatus(current=>({...current,[deck]:{...current[deck],state:"binding-error",ready:true,bound:false,message:`Deck ${deck} 补音绑定失败：${String(error)}`}}));
    });
  },[crossfade,deckAiRescueEnabled,deckReferenceStatus,deckVocalModes,desktopRuntime,playingDecks]);
  useEffect(()=>{
    if(activeNav==="设置"){
      refreshVocalStatus();
      refreshVocalRouting();
    }
  },[activeNav,refreshVocalStatus,refreshVocalRouting]);
  const refreshTitanStatus=useCallback(()=>{
    if(titanStatusProbeRef.current)return titanStatusProbeRef.current;
    const probe=(async()=>{
    const host=titanHost.trim();
    if(!desktopRuntime||!host){
      const message=host?"桌面端启动后连接 Titan":"请填写 Titan 控制台 IP";
      setTitanStatus(current=>current.connected===false&&current.host===host&&current.message===message?current:{...current,connected:false,environmentMode:"offline",host,message});
      setTitanPlaybacks(current=>current.length?[]:current);
      setTitanStaticPlaybacks(current=>current.length?[]:current);
      return false;
    }
    try{
      const status=await invoke("titan_status",{host});
      const identity=titanIdentityFromStatus(status);
      const storedIdentity=loadTitanIdentity();
      const expected=storedIdentity||SITE_TITAN_IDENTITY;
      if(!titanIdentityMatches(expected,identity)){
        const expectedName=expected?.deviceName||expected?.hardwareIdentifier||`序列号 ${expected?.serial}`;
        const actualName=identity.deviceName||identity.hardwareIdentifier||`序列号 ${identity.serial}`;
        const message=`检测到 ${actualName}，但不是已绑定的酒吧控制台 ${expectedName}；已保持离线模拟`;
        setTitanStatus(current=>({...current,...status,connected:false,environmentMode:"identity-mismatch",host,message}));
        setTitanPlaybacks(current=>current.length?[]:current);
        setTitanStaticPlaybacks(current=>current.length?[]:current);
        return false;
      }
      if(!storedIdentity)window.localStorage.setItem("king.lighting.titanIdentity",JSON.stringify(identity));
      const liveStatus={...status,connected:true,environmentMode:"live",message:`已识别酒吧控制台 · ${status.message}`};
      setTitanStatus(current=>JSON.stringify(current)===JSON.stringify(liveStatus)?current:liveStatus);
      window.localStorage.setItem("king.lighting.titanHost",host);
      return true;
    }catch(error){
      console.info("当前网络未识别到酒吧 Titan 控制台",error);
      const message=`灯控连接暂时失败：${String(error)}；20 秒后自动重试`;
      setTitanStatus(current=>current.connected===false&&current.host===host&&current.message===message?current:{...current,connected:false,environmentMode:"offline",host,message});
      setTitanPlaybacks(current=>current.length?[]:current);
      setTitanStaticPlaybacks(current=>current.length?[]:current);
      return false;
    }
    })();
    titanStatusProbeRef.current=probe;
    return probe.finally(()=>{if(titanStatusProbeRef.current===probe)titanStatusProbeRef.current=null;});
  },[desktopRuntime,titanHost]);
  const discoverTitanConsole=useCallback(async()=>{
    const hostHint=titanHost.trim();
    const now=Date.now();
    if(!desktopRuntime||!hostHint||titanDiscoveryRef.current.busy||now-titanDiscoveryRef.current.lastAttempt<60_000)return false;
    titanDiscoveryRef.current={busy:true,lastAttempt:now};
    try{
      const candidates=await invoke("titan_discover",{hostHint});
      const expected=loadTitanIdentity()||SITE_TITAN_IDENTITY;
      const matches=(Array.isArray(candidates)?candidates:[]).filter(status=>titanIdentityMatches(expected,titanIdentityFromStatus(status)));
      if(matches.length!==1){
        if(matches.length>1)setTitanActionStatus({state:"blocked",message:"自动扫描发现多个已绑定 Titan 候选；为避免误控，未自动改绑"});
        return false;
      }
      const status=matches[0];
      const discoveredHost=String(status.host||"").trim();
      if(!discoveredHost)return false;
      const identity=titanIdentityFromStatus(status);
      if(!loadTitanIdentity())window.localStorage.setItem("king.lighting.titanIdentity",JSON.stringify(identity));
      window.localStorage.setItem("king.lighting.titanHost",discoveredHost);
      setTitanHost(discoveredHost);
      setTitanStatus({...status,connected:true,environmentMode:"live",message:`自动发现并连接酒吧控制台 · ${status.message}`});
      setTitanActionStatus({state:"idle",message:`已自动发现 Titan：${discoveredHost}；未触发任何 Playback`});
      return true;
    }catch(error){
      console.info("Titan 局域网自动扫描未找到已绑定控制台",error);
      return false;
    }finally{
      titanDiscoveryRef.current.busy=false;
    }
  },[desktopRuntime,titanHost]);
  const refreshTitanInventory=useCallback(async()=>{
    const host=titanHost.trim();
    if(!desktopRuntime||!host){
      setTitanInventory({state:"offline",authoritative:false,fixtureCount:0,groupCount:0,playbackCount:0,fixtures:[],groups:[],liveShowName:"",cachedShowName:"",blockedReason:host?"桌面端启动后读取真机 Patch":"请先配置 Titan 控制台 IP"});
      return null;
    }
    setTitanInventory(current=>({...current,state:"scanning",blockedReason:"正在只读扫描 Titan Show / Patch…"}));
    try{
      const inventory=await invoke("titan_inventory",{host});
      const next={...inventory,state:inventory?.authoritative?"ready":"blocked"};
      setTitanInventory(next);
      return next;
    }catch(error){
      const next={state:"error",authoritative:false,fixtureCount:0,groupCount:0,playbackCount:0,fixtures:[],groups:[],liveShowName:"",cachedShowName:"",blockedReason:`真机 Patch 扫描失败：${String(error)}`};
      setTitanInventory(next);
      return next;
    }
  },[desktopRuntime,titanHost]);
  useEffect(()=>{
    const generation=++titanPollGenerationRef.current;
    let disposed=false;
    let timer;
    const schedule=async(immediate=false)=>{
      if(disposed||titanPollGenerationRef.current!==generation)return;
      if(!immediate)window.clearTimeout(timer);
      const connected=await refreshTitanStatus();
      if(disposed||titanPollGenerationRef.current!==generation)return;
      const discovered=connected?false:await discoverTitanConsole();
      if(disposed||titanPollGenerationRef.current!==generation)return;
      timer=window.setTimeout(()=>schedule(),connected?3000:discovered?1000:20000);
    };
    const retryNow=()=>{
      if(disposed||document.visibilityState==="hidden")return;
      window.clearTimeout(timer);
      schedule(true);
    };
    schedule(true);
    window.addEventListener("online",retryNow);
    document.addEventListener("visibilitychange",retryNow);
    return ()=>{
      disposed=true;
      window.clearTimeout(timer);
      window.removeEventListener("online",retryNow);
      document.removeEventListener("visibilitychange",retryNow);
    };
  },[discoverTitanConsole,refreshTitanStatus]);
  useEffect(()=>{
    if(!desktopRuntime)return;
    invoke("lighting_package_directories")
      .then(setLightingPackageDirectories)
      .catch((error)=>setLightingPackageStatus({state:"error",message:`灯光配置目录建立失败：${String(error)}`}));
  },[desktopRuntime]);
  const refreshTitanPlaybacks=useCallback(async()=>{
    if(!desktopRuntime||!titanStatus.connected||!titanStatus.host)return [];
    try{
      const handles=await invoke("titan_playbacks",{host:titanStatus.host});
      const next=Array.isArray(handles)?handles:[];
      setTitanPlaybacks(current=>JSON.stringify(current)===JSON.stringify(next)?current:next);
      return next;
    }catch(error){
      console.error("Titan Playback 状态读取失败",error);
      return [];
    }
  },[desktopRuntime,titanStatus.connected,titanStatus.host]);
  const refreshTitanStaticPlaybacks=useCallback(async()=>{
    if(!desktopRuntime||!titanStatus.connected||!titanStatus.host)return [];
    try{
      const handles=await invoke("titan_static_playbacks",{host:titanStatus.host});
      const next=Array.isArray(handles)?handles:[];
      setTitanStaticPlaybacks(current=>JSON.stringify(current)===JSON.stringify(next)?current:next);
      return next;
    }catch(error){
      console.error("Titan StaticPlayback 状态读取失败",error);
      return [];
    }
  },[desktopRuntime,titanStatus.connected,titanStatus.host]);
  useEffect(()=>{
    if(!desktopRuntime||!titanStatus.connected||!titanStatus.host)return undefined;
    let disposed=false;
    let refreshing=false;
    const refresh=async()=>{
      if(refreshing)return;
      refreshing=true;
      try{await refreshTitanPlaybacks();}finally{refreshing=false;}
    };
    refresh();
    const timer=window.setInterval(()=>{if(!disposed)refresh();},5000);
    return ()=>{disposed=true;window.clearInterval(timer);};
  },[desktopRuntime,titanStatus.connected,titanStatus.host,titanStatus.showName,refreshTitanPlaybacks]);
  useEffect(()=>{
    if(!desktopRuntime||!titanStatus.connected||!titanStatus.host)return;
    refreshTitanStaticPlaybacks();
  },[desktopRuntime,titanStatus.connected,titanStatus.host,titanStatus.showName,refreshTitanStaticPlaybacks]);
  useEffect(()=>{
    if(activeNav!=="Avolites Tiger Touch Pro")return;
    refreshTitanInventory();
  },[activeNav,refreshTitanInventory]);
  const triggerTitanPlayback=useCallback((presetId,source="manual")=>{
    if(!lightingEnabled){
      setTitanActionStatus({state:"paused",message:"KING 灯光联动已暂停；未向 Titan 发送命令"});
      return Promise.resolve(false);
    }
    const liveConnection=Boolean(desktopRuntime&&titanStatus.connected&&titanStatus.host);
    const titanId=Number(titanMappings[presetId]);
    if(!lightingCueIsAuthorized({source,presetId,titanId,effectRegistry:titanEffectRegistry})){
      setTitanActionStatus({state:"blocked",message:`中控 ${presetId} 号效果未明确标记“可自动”，已拒绝${source==="rhythm"?"节拍":"视频"}触发`});
      return Promise.resolve(false);
    }
    if(liveConnection&&(!titanMappingShowName||!titanStatus.showName)){
      setTitanActionStatus({state:"error",message:"当前映射或 Titan 未提供可验证的 Show 名称；已拒绝触发"});
      return Promise.resolve(false);
    }
    if(liveConnection&&titanMappingShowName!==titanStatus.showName){
      setTitanActionStatus({state:"error",message:`映射属于 Show ${titanMappingShowName}，当前为 ${titanStatus.showName}；已拒绝触发`});
      return Promise.resolve(false);
    }
    if(liveConnection&&(!Number.isSafeInteger(titanId)||titanId<=0)){
      setTitanActionStatus({state:"unmapped",message:`中控 ${presetId} 号效果尚未绑定 Titan Playback`});
      return Promise.resolve(false);
    }
    const automationPlan=planLightingCue(titanAutomationRef.current,{presetId,source});
    if(!automationPlan.accepted){
      if(automationPlan.reason==="cooldown")setTitanActionStatus({state:"waiting",message:"自动灯光切换冷却中；已忽略过密节拍"});
      if(automationPlan.reason==="category-hold")setTitanActionStatus({state:"waiting",message:"保持视频分类灯光；取色结果稍后接管"});
      return Promise.resolve(false);
    }
    titanAutomationRef.current=automationPlan.state;
    const sourceLabel=source==="rhythm"?"音乐动态层":source==="video-color"?"视频取色层":source==="video"?"视频基础层":"手动";
    if(!liveConnection){
      const simulation=simulateTitanCue(titanSimulationRef.current,{
        presetId,
        lane:automationPlan.lane,
        source,
      });
      if(!simulation.accepted)return Promise.resolve(false);
      titanSimulationRef.current=simulation.state;
      setTitanSimulation(simulation.state);
      setTitanActionStatus({state:"simulation",message:`离线模拟：中控 ${presetId} 号效果 · ${sourceLabel}；未向灯光控制台发送命令`});
      return Promise.resolve(true);
    }
    setTitanActionStatus({state:"busy",message:`正在触发中控 ${presetId} 号效果…`});
    const command=titanCommandQueueRef.current.catch(()=>undefined).then(async()=>{
      const lane=automationPlan.lane;
      const owners={...titanActiveHandleRef.current};
      const previous=owners[lane];
      const handlesToRelease=source==="manual"
        ? [...new Set(Object.values(owners).filter((handle)=>handle&&handle!==titanId))]
        : previous&&previous!==titanId&&!Object.entries(owners).some(([ownerLane,handle])=>ownerLane!==lane&&handle===previous)
          ? [previous]
          : [];
      for(const handle of handlesToRelease){
        await invoke("titan_release_playback",{host:titanStatus.host,titanId:handle,expectedShowName:titanMappingShowName});
      }
      if(source==="manual"){owners.scene=null;owners.accent=null;}
      const result=await invoke("titan_fire_playback",{host:titanStatus.host,titanId,level:1,alwaysRefire:true,expectedShowName:titanMappingShowName});
      owners[lane]=titanId;
      titanActiveHandleRef.current=owners;
      setTitanActionStatus({state:"live",message:`${result?.message||`已启动 TitanId ${titanId}`} · ${sourceLabel}`});
      window.setTimeout(refreshTitanPlaybacks,120);
      return true;
    }).catch((error)=>{
      setTitanActionStatus({state:"error",message:`Titan 控制失败：${String(error)}`});
      return false;
    });
    titanCommandQueueRef.current=command;
    return command;
  },[desktopRuntime,lightingEnabled,refreshTitanPlaybacks,titanEffectRegistry,titanMappingShowName,titanMappings,titanStatus.connected,titanStatus.host,titanStatus.showName]);
  const updateGatling=useCallback(({paletteTitanId=null,dimmerPercent=null,speedValue=null,source="manual"}={})=>{
    if(beamShowBusyRef.current&&["rhythm","rhythm-release","video-color"].includes(source)){
      return Promise.resolve(false);
    }
    if(!lightingEnabled){
      setTitanActionStatus({state:"paused",message:"KING 灯光联动已暂停；加特林保持当前状态"});
      return Promise.resolve(false);
    }
    const liveConnection=Boolean(desktopRuntime&&titanStatus.connected&&titanStatus.host);
    if(!liveConnection){
      setTitanActionStatus({state:"simulation",message:"离线预演：暗红加特林未向 Titan 发送命令"});
      return Promise.resolve(false);
    }
    if(titanStatus.deviceName!==SITE_TITAN_IDENTITY.deviceName||titanStatus.showName!==kingclubGatlingProfile.showName){
      setTitanActionStatus({state:"blocked",message:`加特林联动仅绑定 ${SITE_TITAN_IDENTITY.deviceName} / Show ${kingclubGatlingProfile.showName}`});
      return Promise.resolve(false);
    }
    const sourceLabel=source==="video-color"?"主视频取色":source==="rhythm"?"音乐节拍":source==="rhythm-release"?"节拍回落":"暗红常规";
    return gatlingUpdateQueueRef.current.push(()=>{
      setTitanActionStatus({state:"busy",message:`正在更新加特林 · ${sourceLabel}`});
      const command=titanCommandQueueRef.current.catch(()=>undefined).then(async()=>{
        const result=source==="rhythm"
          ? await invoke("titan_pulse_gatling",{
              host:titanStatus.host,
              expectedShowName:kingclubGatlingProfile.showName,
              peakDimmerPercent:dimmerPercent,
              baseDimmerPercent:kingclubGatlingProfile.baseDimmerPercent,
              pulseMillis:70,
            })
          : await invoke("titan_update_gatling",{
              host:titanStatus.host,
              expectedShowName:kingclubGatlingProfile.showName,
              paletteTitanId,
              dimmerPercent,
              speedValue,
            });
        setTitanActionStatus({state:"live",message:`${result?.message||"暗场加特林已更新"} · ${sourceLabel}`});
        return true;
      }).catch((error)=>{
        setTitanActionStatus({state:"error",message:`加特林控制失败：${String(error)}`});
        return false;
      });
      titanCommandQueueRef.current=command;
      return command;
    });
  },[desktopRuntime,lightingEnabled,titanStatus.connected,titanStatus.deviceName,titanStatus.host,titanStatus.showName]);
  const runBeamShow=useCallback(({bpm=128,source="rhythm"}={})=>{
    if(!lightingEnabled||!beamShowArmed)return Promise.resolve(false);
    const liveConnection=Boolean(desktopRuntime&&titanStatus.connected&&titanStatus.host);
    if(!liveConnection){
      setTitanActionStatus({state:"simulation",message:"离线预演：南区到北区光束点缀未向 Titan 发送命令"});
      return Promise.resolve(false);
    }
    if(titanStatus.deviceName!==SITE_TITAN_IDENTITY.deviceName||titanStatus.showName!==kingclubBeamProfile.showName){
      setTitanActionStatus({state:"blocked",message:`光束联动仅绑定 ${SITE_TITAN_IDENTITY.deviceName} / Show ${kingclubBeamProfile.showName}`});
      return Promise.resolve(false);
    }
    if(beamShowBusyRef.current)return Promise.resolve(false);
    gatlingUpdateQueueRef.current.cancelPending();
    beamShowBusyRef.current=true;
    setTitanActionStatus({state:"busy",message:"强段点缀：光束正从南区逐排走向北区…"});
    const command=titanCommandQueueRef.current.catch(()=>undefined).then(async()=>{
      const result=await invoke("titan_run_beam_show",{
        host:titanStatus.host,
        expectedShowName:kingclubBeamProfile.showName,
        bpm,
        panValue:kingclubBeamProfile.fixedPanValue,
        tiltValue:kingclubBeamProfile.fixedTiltValue,
      });
      setTitanActionStatus({state:"live",message:`${result?.message||"光束六拍点缀已完成"} · ${source==="rhythm"?"音乐强段":"手动"}`});
      return true;
    }).catch((error)=>{
      setTitanActionStatus({state:"error",message:`光束点缀失败并已执行收光：${String(error)}`});
      return false;
    }).finally(()=>{
      beamShowBusyRef.current=false;
    });
    titanCommandQueueRef.current=command;
    return command;
  },[beamShowArmed,desktopRuntime,lightingEnabled,titanStatus.connected,titanStatus.deviceName,titanStatus.host,titanStatus.showName]);
  const updateBeam=useCallback(({dimmerPercent=null,shutterOpen=null,panValue=null,tiltValue=null,source="manual"}={})=>{
    if(!lightingEnabled&&source!=="safety-off"){
      setTitanActionStatus({state:"paused",message:"KING 灯光联动已暂停；光束保持当前状态"});
      return Promise.resolve(false);
    }
    const liveConnection=Boolean(desktopRuntime&&titanStatus.connected&&titanStatus.host);
    if(!liveConnection){
      setTitanActionStatus({state:"simulation",message:"离线预演：光束未向 Titan 发送命令"});
      return Promise.resolve(false);
    }
    if(titanStatus.deviceName!==SITE_TITAN_IDENTITY.deviceName||titanStatus.showName!==kingclubBeamProfile.showName){
      setTitanActionStatus({state:"blocked",message:`光束联动仅绑定 ${SITE_TITAN_IDENTITY.deviceName} / Show ${kingclubBeamProfile.showName}`});
      return Promise.resolve(false);
    }
    const sourceLabel=source==="rhythm"?"音乐节拍":source==="arm-ready"?"光束点缀待命":source==="safety-off"?"光束安全收光":"光束常规";
    const command=titanCommandQueueRef.current.catch(()=>undefined).then(async()=>{
      const result=await invoke("titan_update_beam",{
        host:titanStatus.host,
        expectedShowName:kingclubBeamProfile.showName,
        dimmerPercent,
        shutterOpen,
        panValue,
        tiltValue,
      });
      setTitanActionStatus({state:"live",message:`${result?.message||"光束已更新"} · ${sourceLabel}`});
      return true;
    }).catch((error)=>{
      setTitanActionStatus({state:"error",message:`光束控制失败：${String(error)}`});
      return false;
    });
    titanCommandQueueRef.current=command;
    return command;
  },[desktopRuntime,lightingEnabled,titanStatus.connected,titanStatus.deviceName,titanStatus.host,titanStatus.showName]);
  useEffect(()=>{
    if(!lightingEnabled||light!==null||!desktopRuntime||!titanStatus.connected||!titanStatus.host){
      gatlingBaselineKeyRef.current="";
      return;
    }
    const key=`${titanStatus.host}|${titanStatus.showName}`;
    if(gatlingBaselineKeyRef.current===key)return;
    gatlingBaselineKeyRef.current=key;
    updateGatling({
      paletteTitanId:kingclubGatlingProfile.palettes.red,
      dimmerPercent:kingclubGatlingProfile.baseDimmerPercent,
      speedValue:kingclubGatlingProfile.baseSpeedValue,
      source:"baseline",
    });
  },[desktopRuntime,light,lightingEnabled,titanStatus.connected,titanStatus.host,titanStatus.showName,updateGatling]);
  useEffect(()=>{
    const anyDeckPlaying=Boolean(playingDecks[1]||playingDecks[2]);
    const canPrepare=lightingEnabled&&light===null&&beamShowArmed&&anyDeckPlaying&&desktopRuntime&&titanStatus.connected&&titanStatus.host;
    if(canPrepare){
      const key=`${titanStatus.host}|${titanStatus.showName}`;
      if(beamPreparedKeyRef.current!==key){
        beamPreparedKeyRef.current=key;
        updateBeam({
          dimmerPercent:0,
          shutterOpen:true,
          panValue:kingclubBeamProfile.fixedPanValue,
          tiltValue:kingclubBeamProfile.fixedTiltValue,
          source:"arm-ready",
        });
      }
      return;
    }
    beamPreparedKeyRef.current="";
    beamShowControllerRef.current.reset();
    if(!desktopRuntime||!titanStatus.connected||!titanStatus.host)return;
    updateBeam({
      dimmerPercent:0,
      shutterOpen:false,
      source:"safety-off",
    });
  },[beamShowArmed,desktopRuntime,light,lightingEnabled,playingDecks,titanStatus.connected,titanStatus.host,updateBeam]);
  useEffect(()=>{
    if(lightingEnabled)return;
    const clearedSimulation=clearTitanSimulator(titanSimulationRef.current);
    titanSimulationRef.current=clearedSimulation;
    setTitanSimulation(clearedSimulation);
    const titanIds=[...new Set(Object.values(titanActiveHandleRef.current).filter(Boolean))];
    titanActiveHandleRef.current={scene:null,accent:null};
    titanAutomationRef.current=createLightingAutomationState();
    if(!titanIds.length||!desktopRuntime||!titanStatus.connected||!titanStatus.host){
      setTitanActionStatus({state:"paused",message:"KING 灯光联动已暂停；离线模拟状态已清空"});
      return;
    }
    titanCommandQueueRef.current=titanCommandQueueRef.current.catch(()=>undefined)
      .then(async()=>{for(const titanId of titanIds)await invoke("titan_release_playback",{host:titanStatus.host,titanId,expectedShowName:titanMappingShowName});})
      .then(()=>{setTitanActionStatus({state:"paused",message:"KING 灯光联动已暂停；已释放自动灯光两层"});refreshTitanPlaybacks();})
      .catch((error)=>setTitanActionStatus({state:"error",message:`暂停灯光联动失败：${String(error)}`}));
  },[desktopRuntime,lightingEnabled,refreshTitanPlaybacks,titanMappingShowName,titanStatus.connected,titanStatus.host]);
  useEffect(()=>{
    if (!desktopRuntime) {
      setMixerDriverStatus({state:"preview",title:"浏览器预览",message:`${activeMixerModel.driver.name} ${activeMixerModel.driver.version}`});
      return;
    }
    invoke("mixer_driver_status",{modelId:mixerModelId})
      .then(setMixerDriverStatus)
      .catch(error=>setMixerDriverStatus({state:"error",title:"驱动检测失败",message:String(error)}));
  },[desktopRuntime,mixerModelId,activeMixerModel.driver.name,activeMixerModel.driver.version]);
  useEffect(()=>{
    const acceptFrame=(frame)=>{
      if(!frame||typeof frame!=="object")return;
      publishQu16MeterSnapshot(frame);
      const nextStatus=frame.connected
        ? {state:"live",title:"真机表计 LIVE",message:`${frame.source||"Qu-16 TCP Meter"} · ${mixerControlHost||"测试帧"}`}
        : {state:"disconnected",title:"真机表计已断开",message:frame.message||"等待 Qu-16 重新连接"};
      setMixerMeterStatus(current=>current.state===nextStatus.state&&current.title===nextStatus.title&&current.message===nextStatus.message?current:nextStatus);
    };
    const handleBrowserFrame=(event)=>acceptFrame(event.detail);
    window.addEventListener("king:qu16-meter-frame",handleBrowserFrame);
    return ()=>window.removeEventListener("king:qu16-meter-frame",handleBrowserFrame);
  },[mixerControlHost]);
  useEffect(()=>{
    if(desktopRuntime)return undefined;
    const handleBrowserParameterFrame=(event)=>{
      const frame=event.detail;
      if(!frame||typeof frame!=="object"||!frame.parameters||typeof frame.parameters!=="object")return;
      const revision=Number(frame.revision);
      const sessionId=Number(frame.sessionId);
      const host=String(frame.host||"browser-qa");
      if(!Number.isSafeInteger(revision)||revision<0||!Number.isFinite(sessionId))return;
      const previous=qu16BrowserParameterFrameRef.current;
      if(previous.host===host&&previous.sessionId===sessionId&&revision<previous.revision)return;
      qu16BrowserParameterFrameRef.current={host,sessionId,revision};
      setMixerParameterSnapshot({...frame,host,sessionId,revision,receivedAtMs:Date.now()});
      setMixerControlStatus({mode:"local-ui-only",state:"preview",title:"参数快照预览",message:"浏览器合成事件 · 不会写入真机"});
    };
    window.addEventListener("king:qu16-parameter-frame",handleBrowserParameterFrame);
    return ()=>window.removeEventListener("king:qu16-parameter-frame",handleBrowserParameterFrame);
  },[desktopRuntime]);
  useEffect(()=>{
    const host=mixerControlHost.trim();
    const effectGeneration=++qu16MeterEffectGenerationRef.current;
    if(!desktopRuntime||mixerModelId!=="allen-heath-qu16"||!host){
      clearQu16MeterSnapshot();
      setMixerMeterStatus({state:"disconnected",title:"真机表计未连接",message:host?"桌面端启动后连接 Qu-16":"在设置中填写 Qu-16 的以太网 IP"});
      setMixerParameterSnapshot(null);
      setMixerControlStatus({mode:"local-ui-only",state:"offline",title:"本地控制",message:host?"桌面端未连接 Qu-16":"未配置 Qu-16 控制地址"});
      qu16ControlSessionRef.current={generation:effectGeneration,host,sessionId:null,revision:-1,live:false};
      qu16ParameterFrameApplyRef.current=null;
      return undefined;
    }
    let disposed=false;
    let unlistenFrame;
    let unlistenStatus;
    let unlistenParameters;
    let startedSessionId=null;
    let pendingFrame=null;
    let pendingStatus=null;
    let pendingParameterFrame=null;
    qu16ControlSessionRef.current={generation:effectGeneration,host,sessionId:null,revision:-1,live:false};
    setMixerControlStatus({mode:"hardware-syncing",state:"syncing",title:"正在同步控制状态",message:`Qu-16 TCP-MIDI · ${host}`});
    const isCurrent=()=>!disposed&&qu16MeterEffectGenerationRef.current===effectGeneration;
    const detachListeners=()=>{
      const detachFrame=unlistenFrame;
      const detachStatus=unlistenStatus;
      const detachParameters=unlistenParameters;
      unlistenFrame=undefined;
      unlistenStatus=undefined;
      unlistenParameters=undefined;
      detachFrame?.();
      detachStatus?.();
      detachParameters?.();
    };
    const applyFrame=(frame)=>{
      if(!isCurrent()||!frame||frame.host!==host||Number(frame.sessionId)!==startedSessionId)return;
      publishQu16MeterSnapshot(frame);
      if(frame.connected){
        const nextStatus={sessionId:startedSessionId,host,state:"live",title:"真机表计 LIVE",message:`Qu-16 TCP Meter · ${host}`};
        setMixerMeterStatus(current=>current.sessionId===nextStatus.sessionId&&current.host===nextStatus.host&&current.state===nextStatus.state&&current.title===nextStatus.title&&current.message===nextStatus.message?current:nextStatus);
      }
    };
    const applyStatus=(status)=>{
      if(!isCurrent()||!status||status.host!==host||Number(status.sessionId)!==startedSessionId)return;
      setMixerMeterStatus(current=>current.sessionId===status.sessionId
        &&current.host===status.host
        &&current.state===status.state
        &&current.title===status.title
        &&current.message===status.message
        ? current
        : status);
      const session=qu16ControlSessionRef.current;
      if(session.generation!==effectGeneration||session.sessionId!==startedSessionId)return;
      if(status.state==="disconnected"||status.state==="error"){
        session.live=false;
        const nextControl={mode:"local-ui-only",state:status.state,title:"本地控制",message:status.message||"Qu-16 控制连接已断开"};
        setMixerControlStatus(current=>current.mode===nextControl.mode&&current.state===nextControl.state&&current.title===nextControl.title&&current.message===nextControl.message?current:nextControl);
      }else if(!session.live){
        const nextControl={mode:"hardware-syncing",state:"syncing",title:"正在同步控制状态",message:`Qu-16 TCP-MIDI · ${host}`};
        setMixerControlStatus(current=>current.mode===nextControl.mode&&current.state===nextControl.state&&current.title===nextControl.title&&current.message===nextControl.message?current:nextControl);
      }
    };
    const applyParameterFrame=(frame)=>{
      if(!isCurrent()||!frame||frame.host!==host||Number(frame.sessionId)!==startedSessionId)return false;
      const revision=Number(frame.revision);
      if(!Number.isSafeInteger(revision)||revision<0)return false;
      const session=qu16ControlSessionRef.current;
      if(session.generation!==effectGeneration||session.host!==host||session.sessionId!==startedSessionId||revision<session.revision)return false;
      session.revision=revision;
      session.live=Boolean(frame.connected&&frame.synced);
      const acceptedFrame={...frame,revision,receivedAtMs:Date.now()};
      const pendingCount=Number.isFinite(Number(frame.pending))?Math.max(0,Number(frame.pending)):0;
      setMixerParameterSnapshot(acceptedFrame);
      const nextControlStatus=session.live
        ? {mode:"hardware-live",state:"live",title:"真机控制 LIVE",message:`Qu-16 参数已同步 · ${host}${pendingCount?` · ${pendingCount} 项待确认`:""}`}
        : frame.connected
          ? {mode:"hardware-syncing",state:"syncing",title:"正在同步控制状态",message:`Qu-16 TCP-MIDI · ${host}`}
          : {mode:"local-ui-only",state:"disconnected",title:"本地控制",message:"Qu-16 控制连接已断开"};
      setMixerControlStatus(current=>current.mode===nextControlStatus.mode&&current.state===nextControlStatus.state&&current.title===nextControlStatus.title&&current.message===nextControlStatus.message?current:nextControlStatus);
      return true;
    };
    qu16ParameterFrameApplyRef.current=applyParameterFrame;
    const timer=window.setTimeout(async()=>{
      try{
        [unlistenFrame,unlistenStatus,unlistenParameters]=await Promise.all([
          listen("qu16-meter-frame",event=>{
            if(startedSessionId===null)pendingFrame=event.payload;
            else applyFrame(event.payload);
          }),
          listen("qu16-meter-status",event=>{
            if(startedSessionId===null)pendingStatus=event.payload;
            else applyStatus(event.payload);
          }),
          listen("qu16-parameter-frame",event=>{
            if(startedSessionId===null){
              const pendingRevision=Number(pendingParameterFrame?.revision);
              const nextRevision=Number(event.payload?.revision);
              if(!pendingParameterFrame||!Number.isSafeInteger(pendingRevision)||nextRevision>=pendingRevision)pendingParameterFrame=event.payload;
            }else applyParameterFrame(event.payload);
          }),
        ]);
        if(!isCurrent()){
          detachListeners();
          return;
        }
        const status=await invoke("qu16_start_metering",{host});
        startedSessionId=Number(status?.sessionId);
        qu16ControlSessionRef.current={generation:effectGeneration,host,sessionId:startedSessionId,revision:-1,live:false};
        if(!isCurrent()){
          detachListeners();
          if(Number.isFinite(startedSessionId))invoke("qu16_stop_metering_session",{sessionId:startedSessionId}).catch(()=>{});
          return;
        }
        applyStatus(status);
        if(pendingStatus)applyStatus(pendingStatus);
        if(pendingFrame)applyFrame(pendingFrame);
        if(pendingParameterFrame)applyParameterFrame(pendingParameterFrame);
        pendingStatus=null;
        pendingFrame=null;
        pendingParameterFrame=null;
      }catch(error){
        if(isCurrent()){
          clearQu16MeterSnapshot();
          setMixerMeterStatus({state:"error",title:"Qu-16 连接失败",message:String(error)});
          qu16ControlSessionRef.current.live=false;
          setMixerControlStatus({mode:"local-ui-only",state:"error",title:"本地控制",message:String(error)});
        }
      }
    },650);
    return ()=>{
      disposed=true;
      clearQu16MeterSnapshot();
      window.clearTimeout(timer);
      detachListeners();
      if(qu16ParameterFrameApplyRef.current===applyParameterFrame)qu16ParameterFrameApplyRef.current=null;
      if(qu16ControlSessionRef.current.generation===effectGeneration)qu16ControlSessionRef.current.live=false;
      if(Number.isFinite(startedSessionId))invoke("qu16_stop_metering_session",{sessionId:startedSessionId}).catch(()=>{});
    };
  },[desktopRuntime,mixerControlHost,mixerModelId]);
  useEffect(()=>{
    const hostHint=mixerControlHost.trim();
    const discoveryAllowed=["reconnecting","error","disconnected"].includes(mixerMeterStatus.state);
    if(!desktopRuntime||mixerModelId!=="allen-heath-qu16"||!hostHint||!discoveryAllowed)return undefined;
    let disposed=false;
    const timer=window.setTimeout(async()=>{
      const now=Date.now();
      if(disposed||qu16DiscoveryRef.current.busy||now-qu16DiscoveryRef.current.lastAttempt<60_000)return;
      qu16DiscoveryRef.current={busy:true,lastAttempt:now};
      try{
        const candidates=await invoke("qu16_discover",{hostHint});
        if(disposed||!Array.isArray(candidates)||candidates.length!==1)return;
        const discoveredHost=String(candidates[0]||"").trim();
        if(!discoveredHost||discoveredHost===hostHint)return;
        window.localStorage.setItem("king.mixer.controlHost",discoveredHost);
        setMixerControlHost(discoveredHost);
        setMixerMeterStatus({state:"connecting",title:"已自动发现 Qu-16",message:`正在连接 ${discoveredHost}:${51325}`});
      }catch(error){
        console.info("Qu-16 局域网自动扫描未找到唯一候选",error);
      }finally{
        qu16DiscoveryRef.current.busy=false;
      }
    },8_000);
    return ()=>{disposed=true;window.clearTimeout(timer);};
  },[desktopRuntime,mixerControlHost,mixerMeterStatus.state,mixerModelId]);
  const writeQu16Parameters=useCallback(async(writes)=>{
    const session=qu16ControlSessionRef.current;
    if(!desktopRuntime||mixerModelId!=="allen-heath-qu16"||!session.live||!Number.isFinite(session.sessionId)||!Array.isArray(writes)||writes.length===0){
      return {accepted:false,mode:"local-ui-only"};
    }
    const requestGeneration=session.generation;
    const requestSessionId=session.sessionId;
    try{
      const snapshot=await invoke("qu16_write_parameters",{sessionId:requestSessionId,writes});
      const current=qu16ControlSessionRef.current;
      if(current.generation!==requestGeneration||current.sessionId!==requestSessionId)return {accepted:false,mode:"stale-session"};
      qu16ParameterFrameApplyRef.current?.({...snapshot,writeResponseValues:Object.fromEntries(writes.map(write=>[write.key,write.value]))});
      return {accepted:true,snapshot};
    }catch(error){
      const message=String(error);
      const transportLost=/stale Qu-16 session|connection is not live|has not reached End Sync|worker is not running/i.test(message);
      const current=qu16ControlSessionRef.current;
      if(current.generation===requestGeneration&&current.sessionId===requestSessionId){
        if(transportLost)current.live=false;
        setMixerControlStatus(transportLost
          ? {mode:/End Sync/i.test(message)?"hardware-syncing":"local-ui-only",state:"error",title:/End Sync/i.test(message)?"控制状态未同步":"本地控制",message:`Qu-16 写入失败：${message}`}
          : {mode:"hardware-live",state:"warning",title:"控制写入未完成",message:`Qu-16 写入失败：${message}`});
      }
      return {accepted:false,mode:transportLost?"local-ui-only":"hardware-live",error:message};
    }
  },[desktopRuntime,mixerModelId]);
  homeMicrophoneWriterRef.current=writeQu16Parameters;
  homeMicrophoneControlModeRef.current=mixerControlStatus.mode;
  const flushHomeMicrophoneWrites=useCallback(()=>{
    homeMicrophoneFlushTimerRef.current=null;
    if(homeMicrophoneControlModeRef.current!=="hardware-live"){
      homeMicrophoneWritesRef.current.clear();
      return;
    }
    const writes=[...homeMicrophoneWritesRef.current.values()];
    homeMicrophoneWritesRef.current.clear();
    if(writes.length)homeMicrophoneWriterRef.current?.(writes);
  },[]);
  const queueHomeMicrophoneWrites=useCallback((writes)=>{
    if(homeMicrophoneControlModeRef.current!=="hardware-live")return;
    for(const write of writes)homeMicrophoneWritesRef.current.set(write.key,write);
    if(homeMicrophoneFlushTimerRef.current===null){
      homeMicrophoneFlushTimerRef.current=window.setTimeout(flushHomeMicrophoneWrites,38);
    }
  },[flushHomeMicrophoneWrites]);
  useEffect(()=>()=>{
    if(homeMicrophoneFlushTimerRef.current!==null)window.clearTimeout(homeMicrophoneFlushTimerRef.current);
    homeMicrophoneFlushTimerRef.current=null;
    homeMicrophoneWritesRef.current.clear();
  },[]);
  useEffect(()=>{
    if(mixerControlStatus.mode==="hardware-live")return;
    if(homeMicrophoneFlushTimerRef.current!==null)window.clearTimeout(homeMicrophoneFlushTimerRef.current);
    homeMicrophoneFlushTimerRef.current=null;
    homeMicrophoneWritesRef.current.clear();
  },[mixerControlStatus.mode]);
  useEffect(()=>{
    mixerParameterSnapshotRef.current=mixerParameterSnapshot;
  },[mixerParameterSnapshot]);
  const waitForQu16Readback=useCallback(async(writes,timeoutMs=2500)=>{
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      if(qu16WritesConfirmed(mixerParameterSnapshotRef.current,writes))return true;
      await new Promise((resolve)=>window.setTimeout(resolve,40));
    }
    return false;
  },[]);
  useEffect(()=>{
    if(faderInteractionActive)return;
    setMicrophoneVolumes(current=>[0,1].map((index)=>{
      const readback=microphoneFaderReadback(mixerParameterSnapshot,microphoneBindings[index]);
      return readback.available?readback.value:(current[index]??null);
    }));
  },[faderInteractionActive,microphoneBindings,mixerParameterSnapshot]);
  const toggleDeckCue=useCallback(async(deckNumber)=>{
    if(deckCue.busy)return;
    await operatorDeckControlRef.current(deckNumber,{rollbackAutoTarget:true});
    const turningOff=deckCue.deck===deckNumber;
    const switchingDeck=deckCue.deck!==null&&!turningOff;
    if(switchingDeck){
      const saved=persistDeckCueRecovery({deck:deckNumber,mainAssigned:deckCueMainAssignedRef.current});
      if(!saved){
        setDeckCue(current=>({...current,busy:false,message:"无法保存 CUE 恢复状态，已拒绝切换 Deck"}));
        return;
      }
      setDeckCue({deck:deckNumber,busy:false,message:`Deck ${deckNumber} 的完整声音正在送往 Qu-16 Phones`});
      return;
    }
    const liveMainAssigned=Number(mixerParameterSnapshot?.parameters?.["assign:st-3:LR"]);
    if(!turningOff&&![0,1].includes(liveMainAssigned)){
      setDeckCue(current=>({...current,busy:false,message:"尚未取得 ST3 → LR Assign 真值，CUE 未改变"}));
      return;
    }
    const restoreMainAssigned=turningOff?deckCueMainAssignedRef.current:liveMainAssigned;
    if(turningOff&&![0,1].includes(restoreMainAssigned)){
      setDeckCue(current=>({...current,busy:false,message:"缺少 CUE 前的 ST3 → LR Assign 真值，已拒绝不安全切换"}));
      return;
    }
    if(!turningOff&&!persistDeckCueRecovery({deck:deckNumber,mainAssigned:liveMainAssigned})){
      setDeckCue(current=>({...current,busy:false,message:"无法保存 ST3 原 LR Assign，CUE 未改变"}));
      return;
    }
    if(!turningOff)deckCueMainAssignedRef.current=liveMainAssigned;
    setDeckCue(current=>({...current,busy:true,message:turningOff?"正在关闭耳机 CUE 并恢复 LR 路由":"正在把完整 Deck 声音从主扩切到耳机"}));
    const cueWrites=qu16DeckCueWrites(!turningOff,restoreMainAssigned);
    const response=await writeQu16Parameters(cueWrites);
    if(!response.accepted){
      setDeckCue(current=>({...current,busy:false,message:"Qu-16 CUE 写入未接受；恢复状态已保留，请以真机 LR Assign/PAFL 为准"}));
      return;
    }
    if(!await waitForQu16Readback(cueWrites)){
      setDeckCue(current=>({...current,busy:false,message:"Qu-16 CUE 权威回读超时；恢复状态已保留，请以真机 LR Assign/PAFL 为准"}));
      return;
    }
    if(turningOff){
      clearDeckCueRecovery();
      deckCueMainAssignedRef.current=null;
    }
    setDeckCue({
      deck:turningOff?null:deckNumber,
      busy:false,
      message:turningOff
        ? "CUE 已关闭；完整 Deck 声音已恢复到原 LR 路由，推子未被改变"
        : `Deck ${deckNumber} 的完整声音正在送往 Qu-16 Phones；主扩已隔离`,
    });
  },[deckCue.busy,deckCue.deck,mixerParameterSnapshot,waitForQu16Readback,writeQu16Parameters]);
  const restoreQu16OutputBaseline=useCallback(async()=>{
    if(qu16OutputRestore.busy)return;
    if(mixerControlStatus.mode!=="hardware-live"){
      setQu16OutputRestore({busy:false,state:"error",message:"Qu-16 尚未完成真机同步，未执行恢复"});
      return;
    }
    const confirmed=window.confirm("将恢复 8/26 已确认的 ST3 → LR 主输出：ST3/LR 推子回到 0 dB、解除两路 Mute、ST3 Assign 到 LR、关闭 ST3 PAFL。请先确认功放/DP448 音量已降低。不会改 CH11/CH12、麦克风、48V、处理、DCA 或 Mute Group。\n\n确认现在恢复？");
    if(!confirmed)return;
    const writes=kingClubQu16OutputBaselineWrites();
    setQu16OutputRestore({busy:true,state:"working",message:"正在写入并等待 Qu-16 真机回读…"});
    const response=await writeQu16Parameters(writes);
    if(!response.accepted){
      setQu16OutputRestore({busy:false,state:"error",message:`恢复写入未接受${response.error?`：${response.error}`:""}`});
      return;
    }
    if(!await waitForQu16Readback(writes,3500)){
      setQu16OutputRestore({busy:false,state:"error",message:"恢复写入已发送，但真机回读未全部确认；请查看实体 ST3/LR"});
      return;
    }
    clearDeckCueRecovery();
    deckCueMainAssignedRef.current=null;
    setDeckCue({deck:null,busy:false,message:"CUE 已关闭；ST3 主推子未再被 CUE 修改"});
    setQu16OutputRestore({busy:false,state:"success",message:"8/26 ST3 → LR 主输出基准已由真机回读确认"});
  },[mixerControlStatus.mode,qu16OutputRestore.busy,waitForQu16Readback,writeQu16Parameters]);
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
    setDeck1((current)=>Number.isInteger(current)&&current>=0&&current<audioAssets.length?current:null);
    setDeck2((current)=>Number.isInteger(current)&&current>=0&&current<audioAssets.length?current:null);
    if (!realAudioInitializedRef.current) {
      realAudioInitializedRef.current = true;
      setDeckProgress({ 1:0, 2:0 });
      setPlayingDecks({ 1:false, 2:false });
    }
  },[audioAssets.length]);
  useEffect(() => {
    if (!desktopRuntime || !audioAssets.length) return undefined;
    const loadedPaths = new Set(Object.values(deckSelectionRef.current).map((item)=>item?.path).filter(Boolean));
    // Waveform/rhythm work is latency-sensitive and can be expensive for long
    // mixes. Analyse only the tracks actually loaded into a Deck; analysing the
    // whole 762-song library at startup can starve live audio for hours.
    audioAnalysisQueueRef.current = audioAnalysisQueueRef.current.filter(({item})=>loadedPaths.has(item.path));
    const requestedAssets = audioAssets.filter((item)=>loadedPaths.has(item.path));
    for (const item of requestedAssets) {
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
  }, [desktopRuntime, audioAnalysisFingerprint, deck1, deck2]);
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
  const dispatchDeckRhythmEvents=useCallback((deckNumber,track,currentSeconds,playing)=>{
      const trackKey = audioAnalysisKey(track);
      const analysis = audioAnalysesRef.current[trackKey];
      const cursor = rhythmCursorRef.current[deckNumber];
      if (!trackKey || cursor.trackKey !== trackKey || !playing) {
        rhythmCursorRef.current[deckNumber] = { trackKey, seconds:currentSeconds };
        return;
      }
      const events = collectRhythmEvents(analysis, cursor.seconds, currentSeconds, {lookAheadSeconds:0.16});
      rhythmCursorRef.current[deckNumber] = { trackKey, seconds:currentSeconds };
      for (const rhythmEvent of events) {
        window.dispatchEvent(new CustomEvent("king:rhythm", { detail:{
          ...rhythmEvent,
          deck:deckNumber,
          trackId:track.id,
          trackPath:track.path,
          observedAtSeconds:currentSeconds,
          lateByMs:Math.max(0, Math.round((currentSeconds - rhythmEvent.atSeconds) * 1000)),
          leadByMs:Math.max(0, Math.round((rhythmEvent.atSeconds - currentSeconds) * 1000)),
          bpm:effectiveRhythmBpm(analysis),
          confidence:Number(analysis?.bpmConfidence) || 0,
          energy:rhythmEnergyAt(analysis,rhythmEvent.atSeconds),
        } }));
      }
  },[]);
  useEffect(() => {
    if(mpvEnabled)return;
    for (const [deckNumber, trackIndex] of [[1, deck1], [2, deck2]]) {
      dispatchDeckRhythmEvents(
        deckNumber,
        tracks[trackIndex],
        Number(deckProgress[deckNumber])||0,
        Boolean(playingDecks[deckNumber]),
      );
    }
  }, [deckProgress, deck1, deck2, playingDecks, tracks, mpvEnabled, dispatchDeckRhythmEvents]);
  useEffect(() => {
    writeDeckOutputVolumes(crossfade,masterVolume);
  },[crossfade,masterVolume,tracks,writeDeckOutputVolumes]);
  useEffect(() => {
    window.localStorage.setItem("king.mixer.master",String(masterVolume));
    window.localStorage.setItem("king.mixer.headphones",String(headphoneVolume));
  },[masterVolume,headphoneVolume]);
  useEffect(() => {
    window.localStorage.setItem("king.textDrafts", JSON.stringify(textDrafts));
  }, [textDrafts]);
  useEffect(() => {
    window.localStorage.setItem("king.rhythm.lighting", lightRhythmRule);
    window.localStorage.setItem("king.rhythm.video", videoRhythmRule);
  }, [lightRhythmRule, videoRhythmRule]);
  useEffect(() => {
    window.localStorage.setItem("king.lighting.homeMode",light===null?"auto":String(light));
  },[light]);
  useEffect(() => {
    window.localStorage.setItem("king.lighting.playbackModes", JSON.stringify(lightPlaybackModes));
  }, [lightPlaybackModes]);
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
    let scanning = false;
    const scan = () => {
      if (disposed || scanning) return Promise.resolve();
      scanning = true;
      return invoke("scan_media_library")
      .then((library) => {
        if (disposed) return;
        setMediaLibraryDirectories({
          rootDirectory: library.rootDirectory ?? "",
          videoDirectory: library.videoDirectory ?? "",
          audioDirectory: library.audioDirectory ?? "",
        });
        setAudioImportStatus(library.audioImport??{state:"idle",detected:0,ready:0,failed:0,message:""});
        const nextVideos = (library.videos ?? []).map((item) => ({
          ...item,
          id: `local-video:${item.path}`,
          type: "video",
          src: convertFileSrc(item.path),
          thumbnailSrc: item.thumbnailPath ? convertFileSrc(item.thumbnailPath) : "",
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
          coverSrc: item.thumbnailPath ? convertFileSrc(item.thumbnailPath) : "",
          durationSeconds: Number(item.durationMs ?? 0) / 1000,
        }));
        for (const item of audioAiQueueAllowed ? nextAudio : []) {
          const sourceVersion = `${item.path}|${item.sizeBytes ?? 0}|${item.modifiedUnixMs ?? 0}`;
          if (audioAiQueuedRef.current.has(sourceVersion)) continue;
          audioAiQueuedRef.current.add(sourceVersion);
          // Keep fingerprinting and persistent AI-job creation strictly serial. This
          // only registers work; model inference runs in the separate Python worker.
          audioAiQueueChainRef.current = audioAiQueueChainRef.current
            .then(() => {
              if (!audioAiQueueAllowedRef.current) {
                audioAiQueuedRef.current.delete(sourceVersion);
                return null;
              }
              return invoke("queue_audio_ai_analysis", { path:item.path, artist:item.artist??null });
            })
            .catch((error) => {
              audioAiQueuedRef.current.delete(sourceVersion);
              console.error(`AI 分析任务登记失败：${item.name ?? item.path}`, error);
            });
        }
        setVideoAssets((current)=>mediaAssetFingerprint(current)===mediaAssetFingerprint(nextVideos)?current:nextVideos);
        if (mediaAssetFingerprint(audioAssetsRef.current) !== mediaAssetFingerprint(nextAudio)) {
          const previousDecks = deckSelectionRef.current;
          const findTrackIndex = (selection) => {
            const matched = nextAudio.findIndex((item)=>item.path===selection?.path || item.id===selection?.id);
            if (matched >= 0) return matched;
            return null;
          };
          const nextDeck1 = findTrackIndex(previousDecks[1]);
          const nextDeck2 = findTrackIndex(previousDecks[2]);
          audioAssetsRef.current = nextAudio;
          setDeck1(nextDeck1);
          setDeck2(nextDeck2);
          setAudioAssets(nextAudio);
        }
      })
      .catch((error) => console.error("扫描本地音视频目录失败", error))
      .finally(() => { scanning = false; });
    };
    scan();
    const timer = window.setInterval(scan, MEDIA_SCAN_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [audioAiQueueAllowed]);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const refresh=()=>refreshFontLibrary()
      .catch((error)=>console.error("读取 Windows 系统字体失败",error));
    refresh();
    const timer=window.setInterval(refresh,30000);
    return ()=>window.clearInterval(timer);
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
        const nextTrack = getNextPlayableTrackInQueue(deckPlaybackTrackIndexes[deckNumber], trackIndex, excludedIndex, mode === "shuffle");
        if (nextTrack !== null) {
          resetDeckForTrackChange(deckNumber);
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
  }, [deckProgress, deck1, deck2, playingDecks, deckPlaybackModes, tracks, deckPlaybackTrackIndexes]);
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
      // Keep the measured home C1 width while switching to management pages so
      // the shared L/C/R grid — especially the L region — does not jump.
    };
  }, [activeNav]);
  const isTrackLoaded = (index) => index===deck1||index===deck2;
  const resetDeckForTrackChange = (deckNumber) => {
    setDeckVocalModes((current)=>resetDeckVocalModeForTrackChange(current,deckNumber));
  };
  const prepareTrack = async(deck, index) => {
    if (index===null||isTrackLoaded(index)) return;
    deckStartupSelectionAppliedRef.current[deck]=true;
    await takeDeckOperatorControl(deck,{rollbackAutoTarget:true});
    setDeckPlaybackQueueSources((current)=>({...current,[deck]:activePlaylistPlaybackSource}));
    resetDeckForTrackChange(deck);
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
  const packageTrackIndex = selectedTrack ?? deck1;
  const packageTrack = tracks[packageTrackIndex];
  const exportSelectedPackage = async (requestedPath) => {
    const requestedTrack=requestedPath?tracks.find(track=>track.path===requestedPath):packageTrack;
    const requestedJob=requestedTrack?.path?audioAiJobByPath.get(normalizeMediaPath(requestedTrack.path)):null;
    if (!requestedTrack?.path || requestedJob?.status !== "ready") return;
    setSongPackageMessage("正在生成歌曲包…");
    try {
      const result = await invoke("export_kingsong", {
        path:requestedTrack.path,
        title:requestedTrack.title,
        artist:requestedTrack.artist,
      });
      setSongPackageMessage(`已导出：${result.path}`);
    } catch (error) {
      setSongPackageMessage(`导出失败：${error}`);
    }
  };
  const importPackageInbox = async () => {
    setSongPackageMessage("正在校验并导入歌曲包…");
    try {
      const report = await invoke("import_kingsong_inbox");
      const imported = report.imported?.length ?? 0;
      const failed = report.errors?.length ?? 0;
      setSongPackageMessage(imported||failed?`导入完成：成功 ${imported}，失败 ${failed}`:`收件箱中没有 .kingsong`);
    } catch (error) {
      setSongPackageMessage(`导入失败：${error}`);
    }
  };
  const openPackageDirectory = async (kind) => {
    try {
      const directory = await invoke("open_song_package_directory",{kind});
      setSongPackageMessage(`${kind==="inbox"?"导入收件箱":"导出目录"}：${directory}`);
    } catch (error) {
      setSongPackageMessage(`打开目录失败：${error}`);
    }
  };
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
  const configureMixerModel = async (modelId) => {
    setMixerModelId(modelId);
    window.localStorage.setItem("king.mixer.model",modelId);
    setMixerDriverStatus({state:"checking",title:"正在应用型号包",message:"正在切换数字孪生 UI 并检测驱动"});
    if (!desktopRuntime) return;
    try {
      setMixerDriverStatus(await invoke("configure_mixer_model",{modelId}));
    } catch (error) {
      setMixerDriverStatus({state:"error",title:"型号包配置失败",message:String(error)});
    }
  };
  const updateMixerControlHost=(value)=>{
    setMixerControlHost(value);
    window.localStorage.setItem("king.mixer.controlHost",value.trim());
  };
  const updateTitanHost=(value)=>{
    setTitanHost(value);
    window.localStorage.setItem("king.lighting.titanHost",value.trim());
  };
  const updateTitanEffect=(playback,patch)=>{
    const titanId=Number(playback?.titanId);
    if(!Number.isSafeInteger(titanId)||titanId<=0)return;
    setTitanEffectRegistry((current)=>{
      const existingIndex=current.findIndex((effect)=>Number(effect.titanHandle)===titanId);
      const existing=existingIndex>=0?current[existingIndex]:{};
      const nextEffect={
        effectId:existing.effectId||`titan:${titanId}`,
        presetId:existing.presetId??null,
        titanHandle:titanId,
        titanLegend:playback.legend||existing.titanLegend||"",
        kingName:"",
        layer:null,
        category:"",
        colorFamily:"",
        energy:null,
        motion:null,
        fixtureProfile:null,
        pattern:null,
        speed:null,
        direction:null,
        strobe:false,
        beatSync:false,
        continuous:false,
        safeAuto:false,
        priority:0,
        ...existing,
        ...patch,
      };
      if(nextEffect.layer==="event")nextEffect.safeAuto=false;
      const next=existingIndex>=0?current.map((effect,index)=>index===existingIndex?nextEffect:effect):[...current,nextEffect];
      window.localStorage.setItem("king.lighting.effectRegistry",JSON.stringify(next));
      return next;
    });
  };
  const updateTitanMapping=(presetId,value)=>{
    const slot=Number(presetId);
    const titanId=Number(value);
    if(!Number.isInteger(slot)||slot<0||slot>9)return;
    setTitanMappings((current)=>{
      const next={...current};
      if(Number.isSafeInteger(titanId)&&titanId>0){
        Object.entries(next).forEach(([otherSlot,handle])=>{
          if(Number(handle)===titanId&&Number(otherSlot)!==slot)delete next[otherSlot];
        });
        next[slot]=titanId;
      }else delete next[slot];
      window.localStorage.setItem("king.lighting.titanMappings",JSON.stringify(next));
      return next;
    });
    setTitanEffectRegistry((current)=>{
      let found=false;
      const next=current.map((effect)=>{
        if(effect.presetId===slot||Number(effect.titanHandle)===titanId){
          if(Number(effect.titanHandle)===titanId&&Number.isSafeInteger(titanId)&&titanId>0){
            found=true;
            return {...effect,presetId:slot};
          }
          return {...effect,presetId:null};
        }
        return effect;
      });
      if(!found&&Number.isSafeInteger(titanId)&&titanId>0){
        const playback=titanPlaybacks.find((item)=>Number(item.titanId)===titanId);
        next.push({effectId:`titan:${titanId}`,presetId:slot,titanHandle:titanId,titanLegend:playback?.legend||"",kingName:"",layer:null,category:"",colorFamily:"",energy:null,motion:null,strobe:false,beatSync:false,continuous:false,safeAuto:false,priority:0});
      }
      window.localStorage.setItem("king.lighting.effectRegistry",JSON.stringify(next));
      return next;
    });
    if(titanStatus.connected&&titanStatus.showName){
      setTitanMappingShowName(titanStatus.showName);
      window.localStorage.setItem("king.lighting.mappingShowName",titanStatus.showName);
    }
    setTitanActionStatus({state:"idle",message:value?`中控 ${presetId} 号映射已保存；尚未触发灯光`:`中控 ${presetId} 号映射已清除`});
  };
  const updateTitanPlaybackQuickSlot=(playback,value)=>{
    if(value===""){
      const currentSlot=Object.entries(titanMappings).find(([,handle])=>Number(handle)===Number(playback.titanId))?.[0];
      if(currentSlot!==undefined)updateTitanMapping(Number(currentSlot),"");
      return;
    }
    updateTitanMapping(Number(value),playback.titanId);
  };
  const exportLightingPackage=async()=>{
    const lightingPackage=createLightingPackage({
      titanHost,
      titanStatus:{...titanStatus,showName:titanStatus.showName||titanMappingShowName},
      titanMappings,
      titanPlaybacks,
      presets:lights,
      rhythmRule:lightRhythmRule,
      videoRule:videoRhythmRule,
      playbackModes:lightPlaybackModes,
      fixtureColors,
      effectRegistry:titanEffectRegistry,
    });
    if(!desktopRuntime){
      const url=URL.createObjectURL(new Blob([JSON.stringify(lightingPackage,null,2)],{type:"application/json"}));
      const anchor=document.createElement("a");
      anchor.href=url;
      anchor.download=`KING-${lightingPackage.console.showName||"lighting"}.kinglight`;
      anchor.click();
      URL.revokeObjectURL(url);
      setLightingPackageStatus({state:"ready",message:"浏览器预览已生成 .kinglight 下载"});
      return;
    }
    setLightingPackageStatus({state:"busy",message:"正在导出灯光配置包…"});
    try{
      const result=await invoke("export_kinglight",{payload:JSON.stringify(lightingPackage)});
      setLightingPackageStatus({state:"ready",message:`已导出：${result.path}`});
    }catch(error){
      setLightingPackageStatus({state:"error",message:`导出失败：${String(error)}`});
    }
  };
  const importLightingPackage=async()=>{
    if(!desktopRuntime){
      setLightingPackageStatus({state:"error",message:"浏览器预览不能读取本机收件箱，请在桌面端操作"});
      return;
    }
    setLightingPackageStatus({state:"busy",message:"正在校验 .kinglight；导入过程不会触发灯光…"});
    try{
      const result=await invoke("import_kinglight_inbox");
      const lightingPackage=normalizeLightingPackage(result.package);
      setTitanMappings(lightingPackage.mappings);
      setTitanEffectRegistry(lightingPackage.effects);
      setLightRhythmRule(lightingPackage.automation.rhythmRule);
      setVideoRhythmRule(lightingPackage.automation.videoRule);
      setLightPlaybackModes((current)=>({...current,...lightingPackage.presentation.playbackModes}));
      setFixtureColors((current)=>({...current,...lightingPackage.presentation.fixtureColors}));
      if(lightingPackage.console.host){
        setTitanHost(lightingPackage.console.host);
        window.localStorage.setItem("king.lighting.titanHost",lightingPackage.console.host);
      }
      setTitanMappingShowName(lightingPackage.console.showName);
      window.localStorage.setItem("king.lighting.titanMappings",JSON.stringify(lightingPackage.mappings));
      window.localStorage.setItem("king.lighting.effectRegistry",JSON.stringify(lightingPackage.effects));
      window.localStorage.setItem("king.lighting.mappingShowName",lightingPackage.console.showName);
      window.localStorage.setItem("king.rhythm.lighting",lightingPackage.automation.rhythmRule);
      window.localStorage.setItem("king.rhythm.video",lightingPackage.automation.videoRule);
      const cleared=clearTitanSimulator(titanSimulationRef.current);
      titanSimulationRef.current=cleared;
      setTitanSimulation(cleared);
      titanAutomationRef.current=createLightingAutomationState();
      setLight(0);
      setLightingPackageStatus({state:"ready",message:`已导入：${result.path}；未触发任何 Playback`});
    }catch(error){
      setLightingPackageStatus({state:"error",message:`导入失败：${String(error)}`});
    }
  };
  const openLightingPackageDirectory=async(kind)=>{
    if(!desktopRuntime)return;
    try{
      const directory=await invoke("open_lighting_package_directory",{kind});
      setLightingPackageStatus({state:"idle",message:`${kind==="inbox"?"收件箱":"导出目录"}：${directory}`});
    }catch(error){
      setLightingPackageStatus({state:"error",message:`打开目录失败：${String(error)}`});
    }
  };
  const stableUpdateTitanEffect=useStableCallback(updateTitanEffect);
  const stableUpdateTitanMapping=useStableCallback(updateTitanMapping);
  const stableUpdateTitanPlaybackQuickSlot=useStableCallback(updateTitanPlaybackQuickSlot);
  const stableExportLightingPackage=useStableCallback(exportLightingPackage);
  const stableImportLightingPackage=useStableCallback(importLightingPackage);
  const stableOpenLightingPackageDirectory=useStableCallback(openLightingPackageDirectory);
  const openMixerDriver = async () => {
    if (!desktopRuntime) return window.open(activeMixerModel.driver.officialResourceUrl,"_blank","noopener,noreferrer");
    setMixerDriverStatus({state:"installing",title:"准备驱动安装",message:"仅执行 Allen & Heath 有效数字签名的官方安装程序"});
    try {
      const status=await invoke("install_mixer_driver_from_downloads",{modelId:mixerModelId});
      setMixerDriverStatus(status);
      if (status.state==="waiting-download") await invoke("open_mixer_driver_support",{modelId:mixerModelId});
    }
    catch (error) { setMixerDriverStatus({state:"error",title:"驱动安装未完成",message:String(error)}); }
  };
  const changeVocalPreset=async(lane,preset)=>{
    if(!desktopRuntime){
      setVocalStatus(current=>updatePreviewVocalPreset(current,lane,preset));
      return;
    }
    setVocalBusy(true);
    try{
      const response=await invoke("vocal_set_preset",{lane,preset});
      setVocalStatus(current=>normalizeVocalResponse(response,current));
    }catch(error){
      setVocalStatus(current=>({...current,message:`修音方案未应用：${String(error)}`}));
    }finally{
      setVocalBusy(false);
    }
  };
  const disarmVocalEngine=async()=>{
    if(!desktopRuntime){
      setVocalStatus(current=>({...current,calibrationMode:"disarmed",physicalAudioStarted:false,hardwareBound:false,message:"浏览器预览；保持解除武装"}));
      return;
    }
    setVocalBusy(true);
    try{
      const response=await invoke("vocal_disarm");
      setVocalStatus(current=>normalizeVocalResponse(response,current));
    }catch(error){
      setVocalStatus(current=>({...current,physicalAudioStarted:false,message:`解除武装命令失败：${String(error)}`}));
    }finally{
      setVocalBusy(false);
    }
  };
  const discoverVocalRouting=async()=>{
    setRoutingBusy(true);
    try{
      if(!desktopRuntime){
        setVocalRouting(normalizeRoutingResponse({schemaVersion:1,hardwareReady:false,ambiguityCount:0,inventory:{driverName:"KING Virtual Qu-16 ASIO",sampleRate:48000},routingMap:{physicalHardware:false,qu16MappingVerified:false,lanes:[{lane:"mic1",quInputChannel:1,inputDriverIndex:2,inputChannelName:"Virtual Mic Send A",returnDriverIndex:1,returnChannelName:"Virtual Vocal Return A",evidence:"virtual_signal_trace"},{lane:"mic2",quInputChannel:2,inputDriverIndex:5,inputChannelName:"Virtual Mic Send B",returnDriverIndex:4,returnChannelName:"Virtual Vocal Return B",evidence:"virtual_signal_trace"},{lane:"mic3",quInputChannel:3,inputDriverIndex:9,inputChannelName:"Virtual Mic Send C",returnDriverIndex:8,returnChannelName:"Virtual Vocal Return C",evidence:"virtual_signal_trace"}]}}));
        return;
      }
      const report=await invoke("vocal_discover_routing_virtual");
      setVocalRouting(normalizeRoutingResponse(report));
    }catch(error){
      setVocalRouting(current=>({...current,hardwareReady:false,message:`离线通道发现失败：${String(error)}`}));
    }finally{
      setRoutingBusy(false);
    }
  };
  const runVocalCalibration=async()=>{
    setRoutingBusy(true);
    try{
      if(!desktopRuntime){
        const report={mode:"virtual_calibration_wizard",finalState:"complete",completedLanes:3,rejectedObservations:1,hardwareReady:false,routingMap:{physicalHardware:false,qu16MappingVerified:false,driverName:"KING Virtual Qu-16 ASIO",sampleRate:48000,lanes:[{lane:"mic1",quInputChannel:1,inputDriverIndex:2,inputChannelName:"Virtual Mic Send A",returnDriverIndex:1,returnChannelName:"Virtual Vocal Return A",evidence:"virtual_signal_trace"},{lane:"mic2",quInputChannel:2,inputDriverIndex:5,inputChannelName:"Virtual Mic Send B",returnDriverIndex:4,returnChannelName:"Virtual Vocal Return B",evidence:"virtual_signal_trace"},{lane:"mic3",quInputChannel:3,inputDriverIndex:9,inputChannelName:"Virtual Mic Send C",returnDriverIndex:8,returnChannelName:"Virtual Vocal Return C",evidence:"virtual_signal_trace"}]},events:[{sequence:1,state:"complete",lane:"mic3",accepted:true,rejection:null,message:"三路离线校准完成"}]};
        setCalibrationStatus(normalizeCalibrationReport(report));
        setVocalRouting(normalizeRoutingResponse(report));
        return;
      }
      const replay=await invoke("vocal_replay_joint_evidence");
      const report=replay?.calibration??replay;
      setCalibrationStatus(normalizeCalibrationReport(replay));
      setVocalRouting(normalizeRoutingResponse(report));
    }catch(error){
      setCalibrationStatus(current=>({...current,message:`向导演练失败：${String(error)}`}));
    }finally{
      setRoutingBusy(false);
    }
  };
  const saveVocalRouting=async()=>{
    if(!vocalRouting.report||!desktopRuntime)return;
    setRoutingBusy(true);
    try{
      const response=await invoke("vocal_save_routing",{report:vocalRouting.report});
      setVocalRouting(current=>normalizeRoutingResponse(response,current));
    }catch(error){
      setVocalRouting(current=>({...current,saved:false,hardwareReady:false,message:`通道映射保存失败：${String(error)}`}));
    }finally{
      setRoutingBusy(false);
    }
  };
  const createVocalProfile=async(displayName,consentConfirmed)=>{
    if(!desktopRuntime){
      setVocalProfileMessage({state:"error",message:"请在 KINGCLUB 桌面版中录制歌手包"});
      return null;
    }
    setVocalProfileBusy(true);
    setVocalProfileMessage({state:"working",message:"正在建立歌手包…"});
    try{
      const profile=await invoke("create_vocal_profile",{displayName,consentConfirmed});
      await refreshVocalProfiles();
      setVocalProfileMessage({state:"success",message:`已建立“${profile.displayName}”，请依次录制六段干声`});
      return profile;
    }catch(error){
      setVocalProfileMessage({state:"error",message:`建立失败：${String(error)}`});
      return null;
    }finally{
      setVocalProfileBusy(false);
    }
  };
  const recordVocalProfileSample=async(profileId,promptId,deviceName,channel)=>{
    const prompt=vocalProfilePrompts.find(item=>item.id===promptId);
    setVocalProfileBusy(true);
    setVocalProfileMessage({state:"working",message:`正在录制${prompt?.label??"采样"}，请连续演唱 15 秒…`});
    try{
      const profile=await invoke("record_vocal_profile_sample",{profileId,promptId,deviceName,channel});
      await refreshVocalProfiles();
      const sample=profile.samples?.[promptId];
      setVocalProfileMessage({
        state:sample?.report?.accepted?"success":"error",
        message:sample?.report?.accepted?`${prompt?.label??"采样"}合格：${sample.report.message}`:`${prompt?.label??"采样"}需重录：${sample?.report?.message??"录音质量未通过"}`,
      });
      return profile;
    }catch(error){
      setVocalProfileMessage({state:"error",message:`录音失败：${String(error)}`});
      return null;
    }finally{
      setVocalProfileBusy(false);
    }
  };
  const deleteVocalProfile=async(profileId)=>{
    setVocalProfileBusy(true);
    setVocalProfileMessage({state:"working",message:"正在删除歌手包及其本地录音…"});
    try{
      await invoke("delete_vocal_profile",{profileId});
      await refreshVocalProfiles();
      setVocalProfileMessage({state:"success",message:"歌手包及其本地录音已删除"});
    }catch(error){
      setVocalProfileMessage({state:"error",message:`删除失败：${String(error)}`});
    }finally{
      setVocalProfileBusy(false);
    }
  };
  const prepareVocalProfileSong=async(profileId,mediaPath)=>{
    setVocalProfileBusy(true);
    setVocalProfileMessage({state:"working",message:"正在核对当前歌曲的歌词、旋律和伴奏产物…"});
    try{
      const report=await invoke("prepare_vocal_profile_song",{profileId,mediaPath});
      setVocalProfileMessage({state:report.generatorAvailable?"success":"warning",message:report.message});
      setVocalReferenceRevision(current=>current+1);
      return report;
    }catch(error){
      setVocalProfileMessage({state:"error",message:`补音准备失败：${String(error)}`});
      return null;
    }finally{
      setVocalProfileBusy(false);
    }
  };
  const insertTrack = (deck, index) => prepareTrack(deck, index);
  const insertTrackWithoutPlaylistQueue = async(deck, index) => {
    if (index===null||isTrackLoaded(index)) return;
    deckStartupSelectionAppliedRef.current[deck]=true;
    await takeDeckOperatorControl(deck,{rollbackAutoTarget:true});
    setDeckPlaybackQueueSources((current)=>({...current,[deck]:{kind:"single"}}));
    resetDeckForTrackChange(deck);
    if (deck===1) setDeck1(index); else setDeck2(index);
    setDeckProgress((current)=>({...current,[deck]:0}));
    setPlayingDecks((current)=>({...current,[deck]:false}));
    setSelectedTrack(null);
  };
  const getDeckAudio = (deckNumber) => deckNumber === 1 ? deckOneAudioRef.current : deckTwoAudioRef.current;
  const playbackPathForDeck = (deckNumber, track) => (
    deckVocalModes[deckNumber] === "accompaniment" && track?.accompanimentPath
      ? track.accompanimentPath
      : track?.path
  );
  const applyMpvDeckState = (state) => {
    if (!state?.deck) return;
    const nextProgress=Math.max(0,Number(state.timePos)||0);
    const nextPlaying=!state.paused;
    setDeckProgress((current)=>Math.abs((current[state.deck]??0)-nextProgress)<.4
      ? current
      : {...current,[state.deck]:nextProgress});
    setPlayingDecks((current)=>current[state.deck]===nextPlaying
      ? current
      : {...current,[state.deck]:nextPlaying});
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
    const volume = deckOutputVolumePercent(
      deckNumber===1?deckOneGain:deckTwoGain,
      masterVolume,
      deckVocalModes[deckNumber],
    );
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
        const { deck1: deckOneGain, deck2: deckTwoGain } = equalPowerGains(crossfade);
        await invoke("mpv_deck_set_volume",{
          deck:deckNumber,
          volume:deckOutputVolumePercent(
            deckNumber===1?deckOneGain:deckTwoGain,
            masterVolume,
            nextMode,
          ),
        });
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
      const { deck1: deckOneGain, deck2: deckTwoGain } = equalPowerGains(crossfade);
      audio.volume = deckOutputVolumeScalar(
        deckNumber===1?deckOneGain:deckTwoGain,
        masterVolume,
        nextMode,
      );
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
  const seekDeck = async(deckNumber, seconds) => {
    const safeSeconds = Math.max(0,Number(seconds)||0);
    await takeDeckOperatorControl(deckNumber,{rollbackAutoTarget:true});
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
  const loadAdjacentDeckTrack = async(deckNumber, direction) => {
    const currentIndex = deckNumber===1?deck1:deck2;
    const excludedIndex = deckNumber===1?deck2:deck1;
    if(currentIndex===null||currentIndex===undefined)return;
    const lockedQueue=deckPlaybackQueueSources[deckNumber]
      ? deckPlaybackTrackIndexes[deckNumber]
      : activePlaylistTrackIndexes;
    if(!deckPlaybackQueueSources[deckNumber]) {
      setDeckPlaybackQueueSources((current)=>({...current,[deckNumber]:activePlaylistPlaybackSource}));
    }
    const nextIndex = getAdjacentPlayableTrackInQueue(lockedQueue,currentIndex,excludedIndex,direction);
    if (nextIndex===null) return;
    await takeDeckOperatorControl(deckNumber,{rollbackAutoTarget:true});
    const audio = getDeckAudio(deckNumber);
    audio?.pause();
    if (mpvEnabled&&mpvLoadedPathsRef.current[deckNumber]) invoke("mpv_deck_set_paused",{deck:deckNumber,paused:true}).catch((error)=>console.error(`Deck ${deckNumber} mpv 暂停失败`,error));
    mpvLoadedPathsRef.current[deckNumber]=null;
    mpvEofHandledRef.current[deckNumber]=false;
    resetDeckForTrackChange(deckNumber);
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
      const nextTrack = getNextPlayableTrackInQueue(deckPlaybackTrackIndexes[deckNumber],trackIndex,-1,mode === "shuffle");
      if (nextTrack !== null) {
        resetDeckForTrackChange(deckNumber);
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
    await takeDeckOperatorControl(deckNumber,{rollbackAutoTarget:true});
    const startingPlayback=!playingDecks[deckNumber];
    if(startingPlayback&&desktopRuntime&&runtimeCapability.aiProcessingAvailable){
      const otherDeck=deckNumber===1?2:1;
      const otherTrackIndex=otherDeck===1?deck1:deck2;
      const playingPaths=[
        track.path,
        playingDecks[otherDeck]?tracks[otherTrackIndex]?.path:null,
      ].filter(Boolean);
      const deckPaths=[tracks[deck1]?.path,tracks[deck2]?.path,track.path].filter(Boolean);
      try{
        // Stop GPU-heavy stem/transcription work before mpv is allowed to
        // unpause. Waiting here closes the short underrun window that existed
        // when the scheduler only reacted after playback had already started.
        const worker=await invoke("set_audio_ai_scheduler",{
          playingPaths:[...new Set(playingPaths)],
          deckPaths:[...new Set(deckPaths)],
        });
        setAudioAiWorker(worker);
        if(worker.enabled&&(!worker.playbackProtected||worker.running)){
          throw new Error("AI 制作后台未进入播放保护状态");
        }
      }catch(error){
        console.error(`Deck ${deckNumber} 播放保护失败`,error);
        setSongPackageMessage(`播放已阻止：无法安全暂停 AI 制作（${String(error)}）`);
        return;
      }
    }
    if(!playingDecks[deckNumber]&&!deckPlaybackQueueSources[deckNumber]) {
      setDeckPlaybackQueueSources((current)=>({...current,[deckNumber]:activePlaylistPlaybackSource}));
    }
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
  const prepareMpvAutoTransition=async(
    sourceDeck,
    sourceTrackIndex,
    targetTrackIndex,
    crossfadeSeconds=AUTO_DJ_CROSSFADE_SECONDS,
    targetQueueSource=null,
  )=>{
    if(!mpvEnabled||mpvAutoTransitionRef.current.phase!=="idle")return false;
    const targetDeck=sourceDeck===1?2:1;
    const targetTrack=tracks[targetTrackIndex];
    if(!targetTrack?.path)return false;
    const queueSource=targetQueueSource??deckPlaybackQueueSources[sourceDeck]??null;
    if(!queueSource)return false;
    setDeckAutomationOwner(targetDeck,"automatic");
    const transition={phase:"preloading",sourceDeck,targetDeck,sourceTrackIndex,targetTrackIndex,crossfadeSeconds,targetStartsSilent:true,queueSource};
    mpvAutoTransitionRef.current=transition;
    try{
      await invoke("mpv_deck_set_paused",{deck:targetDeck,paused:true});
      if(mpvAutoTransitionRef.current!==transition)return;
      mpvAutoplayAfterLoadRef.current[targetDeck]=false;
      mpvLoadedPathsRef.current[targetDeck]=null;
      mpvEofHandledRef.current[targetDeck]=false;
      deckStartupSelectionAppliedRef.current[targetDeck]=true;
      resetDeckForTrackChange(targetDeck);
      setDeckPlaybackQueueSources((current)=>({
        ...current,
        [targetDeck]:queueSource,
      }));
      transition.loadPromise=invoke("mpv_deck_load",{deck:targetDeck,path:targetTrack.path});
      const state=await transition.loadPromise;
      if(mpvAutoTransitionRef.current!==transition)return;
      mpvLoadedPathsRef.current[targetDeck]=targetTrack.path;
      await invoke("mpv_deck_set_volume",{deck:targetDeck,volume:0});
      if(mpvAutoTransitionRef.current!==transition)return;
      if(targetDeck===1)setDeck1(targetTrackIndex);else setDeck2(targetTrackIndex);
      setDeckProgress((current)=>({...current,[targetDeck]:0}));
      setPlayingDecks((current)=>({...current,[targetDeck]:false}));
      applyMpvDeckState(state);
      transition.phase="ready";
      return true;
    }catch(error){
      if(mpvAutoTransitionRef.current===transition)mpvAutoTransitionRef.current={phase:"idle"};
      console.error("自动 DJ 预载下一首失败",error);
      return false;
    }
  };
  const beginMpvAutoTransition=async(sourceDeck)=>{
    const transition=mpvAutoTransitionRef.current;
    if(transition.phase!=="ready"||transition.sourceDeck!==sourceDeck)return;
    transition.phase="crossfading";
    const targetDeck=transition.targetDeck;
    try{
      const startedState=await invoke("mpv_deck_set_paused",{deck:targetDeck,paused:false});
      if(mpvAutoTransitionRef.current!==transition)return;
      applyMpvDeckState(startedState);
      const startedAt=performance.now();
      const visualStart=crossfade;
      const initialGains=equalPowerGains(visualStart);
      const sourceBaseGain=sourceDeck===1?initialGains.deck1:initialGains.deck2;
      const targetBaseGain=transition.targetStartsSilent?0:(targetDeck===1?initialGains.deck1:initialGains.deck2);
      const transitionSeconds=Math.max(.4,Number(transition.crossfadeSeconds)||AUTO_DJ_CROSSFADE_SECONDS);
      mpvAutoTransitionTimerRef.current=window.setInterval(()=>{
        if(mpvAutoTransitionRef.current!==transition){cancelMpvAutoTransition();return}
        const progress=Math.min(1,(performance.now()-startedAt)/(transitionSeconds*1000));
        const angle=progress*Math.PI/2;
        const sourceGain=sourceBaseGain*Math.cos(angle);
        const targetGain=Math.sqrt(targetBaseGain*targetBaseGain*(1-progress)+Math.sin(angle)**2);
        mpvVolumeWriterRef.current.enqueue([
          {deck:sourceDeck,volume:deckOutputVolumePercent(sourceGain,masterVolume,deckVocalModes[sourceDeck])},
          {deck:targetDeck,volume:deckOutputVolumePercent(targetGain,masterVolume,"original")},
        ]);
        const visualPosition=sourceDeck===1
          ? visualStart+(100-visualStart)*progress
          : visualStart*(1-progress);
        transition.visualPosition=visualPosition;
        setCrossfade(Math.round(visualPosition));
        if(progress<1)return;
        window.clearInterval(mpvAutoTransitionTimerRef.current);
        mpvAutoTransitionTimerRef.current=null;
        mpvEofHandledRef.current[sourceDeck]=true;
        invoke("mpv_deck_set_paused",{deck:sourceDeck,paused:true})
          .then(applyMpvDeckState)
          .catch((error)=>console.error("自动 DJ 停止上一 Deck 失败",error));
        setPlayingDecks((current)=>({...current,[sourceDeck]:false,[targetDeck]:true}));
        setDeckAutomationOwner(sourceDeck,"automatic");
        const endpoint=targetDeck===1?0:100;
        setCrossfade(endpoint);
        writeDeckOutputVolumes(endpoint,masterVolume);
        mpvAutoTransitionRef.current={phase:"idle"};
      },100);
    }catch(error){
      if(mpvAutoTransitionRef.current===transition)mpvAutoTransitionRef.current={phase:"idle"};
      console.error("自动 DJ 启动下一首失败",error);
    }
  };
  const fadeOutDeletedMpvDeck=async(deckNumber,durationSeconds=2.5)=>{
    cancelMpvAutoTransition();
    const transition={phase:"fading-deleted",sourceDeck:deckNumber};
    mpvAutoTransitionRef.current=transition;
    const initialGains=equalPowerGains(crossfade);
    const initialGain=deckNumber===1?initialGains.deck1:initialGains.deck2;
    const startedAt=performance.now();
    mpvAutoTransitionTimerRef.current=window.setInterval(()=>{
      if(mpvAutoTransitionRef.current!==transition){cancelMpvAutoTransition();return}
      const progress=Math.min(1,(performance.now()-startedAt)/(Math.max(.4,durationSeconds)*1000));
      mpvVolumeWriterRef.current.enqueue([{
        deck:deckNumber,
        volume:deckOutputVolumePercent(initialGain*(1-progress),masterVolume,deckVocalModes[deckNumber]),
      }]);
      if(progress<1)return;
      window.clearInterval(mpvAutoTransitionTimerRef.current);
      mpvAutoTransitionTimerRef.current=null;
      invoke("mpv_deck_set_paused",{deck:deckNumber,paused:true})
        .then(applyMpvDeckState)
        .catch((error)=>console.error("删除播放歌曲后的淡出停止失败",error));
      setPlayingDecks((current)=>({...current,[deckNumber]:false}));
      mpvAutoTransitionRef.current={phase:"idle"};
    },100);
  };
  const transitionDeletedPlayingTrack=async(deckNumber,trackIndex,nextTrackIndex,targetQueueSource)=>{
    if(!mpvEnabled)return;
    const targetDeck=deckNumber===1?2:1;
    cancelMpvAutoTransition();
    if(playingDecks[targetDeck]){
      mpvAutoTransitionRef.current={
        phase:"ready",
        sourceDeck:deckNumber,
        targetDeck,
        sourceTrackIndex:trackIndex,
        targetTrackIndex:targetDeck===1?deck1:deck2,
        crossfadeSeconds:2.5,
        targetStartsSilent:false,
      };
      await beginMpvAutoTransition(deckNumber);
      return;
    }
    if(nextTrackIndex===null){
      await fadeOutDeletedMpvDeck(deckNumber);
      return;
    }
    const prepared=await prepareMpvAutoTransition(deckNumber,trackIndex,nextTrackIndex,2.5,targetQueueSource);
    if(!prepared){
      await fadeOutDeletedMpvDeck(deckNumber);
      return;
    }
    await beginMpvAutoTransition(deckNumber);
  };
  const advanceMpvAutoTransition=async(deckNumber,trackIndex,state)=>{
    if(state?.paused||!state?.duration)return;
    const targetDeck=deckNumber===1?2:1;
    const arbitration=planDeckOperatorArbitration({
      mode:deckPlaybackModes[deckNumber],
      targetDeck,
      targetPlaying:Boolean(playingDecks[targetDeck]),
      cueDeck:deckCue.deck,
    });
    if(!arbitration.automationAllowed)return;
    const transition=mpvAutoTransitionRef.current;
    const preparedTargetIndex=transition.sourceDeck===deckNumber&&transition.phase==="ready"
      ? transition.targetTrackIndex
      : null;
    const playbackChain=resolvePlaybackChainForDeck({
      deckNumber,
      currentIndex:trackIndex,
      queueSources:deckPlaybackQueueSources,
      queueIndexes:deckPlaybackTrackIndexes,
    });
    const plan=planDeckAutoTransition({
      queue:playbackChain.queue,
      currentIndex:trackIndex,
      mode:deckPlaybackModes[deckNumber],
      remainingSeconds:Math.max(0,state.duration-state.timePos),
      preparedTargetIndex,
      otherDeckPlaying:Boolean(playingDecks[targetDeck]),
    });
    if(plan.action==="preload")await prepareMpvAutoTransition(
      deckNumber,
      trackIndex,
      plan.nextIndex,
      AUTO_DJ_CROSSFADE_SECONDS,
      playbackChain.source,
    );
    else if(plan.action==="crossfade")await beginMpvAutoTransition(deckNumber);
  };
  const finishMpvDeck = async (deckNumber, trackIndex) => {
    if (mpvEndingRef.current[deckNumber]) return;
    const automaticTransition=mpvAutoTransitionRef.current;
    if(automaticTransition.phase==="crossfading"&&automaticTransition.sourceDeck===deckNumber)return;
    if(automaticTransition.sourceDeck===deckNumber)cancelMpvAutoTransition();
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
        const playbackChain=resolvePlaybackChainForDeck({
          deckNumber,
          currentIndex:trackIndex,
          queueSources:deckPlaybackQueueSources,
          queueIndexes:deckPlaybackTrackIndexes,
        });
        const nextTrack=getNextPlayableTrackInQueue(playbackChain.queue,trackIndex,-1,mode==="shuffle");
        if(nextTrack!==null) {
          if(playbackChain.source) {
            setDeckPlaybackQueueSources((current)=>({...current,[deckNumber]:playbackChain.source}));
          }
          mpvEofHandledRef.current[deckNumber]=false;
          mpvAutoplayAfterLoadRef.current[deckNumber]=true;
          mpvLoadedPathsRef.current[deckNumber]=null;
          resetDeckForTrackChange(deckNumber);
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
          dispatchDeckRhythmEvents(
            deckNumber,
            tracks[trackIndex],
            Math.max(0,Number(state.timePos)||0),
            !state.paused,
          );
          applyMpvDeckState(state);
          await advanceMpvAutoTransition(deckNumber,trackIndex,state);
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
    const timer=window.setInterval(poll,160);
    return()=>{disposed=true;window.clearInterval(timer)};
  },[mpvEnabled,deck1,deck2,deckOnePath,deckTwoPath,deckPlaybackModes,tracks.length,deckPlaybackTrackIndexes,playingDecks,deckCue.deck,dispatchDeckRhythmEvents]);
  const activeMediaType = mediaTypes.find(type => type.id === mediaType) ?? mediaTypes[0];
  const activeMediaCategories = mediaCategories[mediaType] ?? [];
  const availableVideos = useMemo(() => videoAssets.length
    ? videoAssets
    : desktopRuntime
      ? []
      : videos.map((item,index)=>({ ...item, id:`demo-video-${index}`, type:"video", index })), [videoAssets, desktopRuntime]);
  const visibleVideos = mediaCategory === "全部" ? availableVideos : availableVideos.filter((item) => item.category === mediaCategory);
  const handleProgramVideoEnded=useCallback((ended)=>{
    const playback=videoPlaybackRef.current;
    const next=nextProgramVideo(playback,ended,availableVideos);
    if(!next)return;
    // Advance the token synchronously: duplicate/late output events cannot skip a clip.
    updateVideoPlayback({...playback,mediaId:next.id,token:playback.token+1});
    setOutputMedia(current=>placeOverlayOnMedia(next,current?.type==="text"?current:null));
    setVideo(next.index);
    // PVW is deliberately left alone while the operator is preparing a take.
  },[availableVideos,updateVideoPlayback]);
  const programVideoEndedRef=useRef(handleProgramVideoEnded);
  programVideoEndedRef.current=handleProgramVideoEnded;
  useEffect(()=>{
    if(!desktopRuntime)return;
    let disposed=false;
    let stop=()=>{};
    listen("program-video-ended",event=>programVideoEndedRef.current(event.payload))
      .then(unlisten=>{if(disposed)unlisten();else stop=unlisten;})
      .catch(error=>console.error("视频顺播监听失败",error));
    return()=>{disposed=true;stop();};
  },[desktopRuntime]);
  const renderedVideos = useMemo(
    () => visibleVideos.slice(0, videoRenderLimit),
    [visibleVideos, videoRenderLimit],
  );
  useEffect(() => {
    setVideoRenderLimit(VIDEO_GRID_INITIAL_LIMIT);
  }, [mediaType, mediaCategory, availableVideos.length]);
  const extendVideoGrid = useCallback(() => {
    setVideoRenderLimit((current) => nextVideoRenderLimit(current, visibleVideos.length));
  }, [visibleVideos.length]);
  const handleVideoGridScroll = useCallback((event) => {
    if (shouldExtendVideoGrid(event.currentTarget)) extendVideoGrid();
  }, [extendVideoGrid]);
  const visibleImages = [
    blackScreenImage,
    resolutionTestImage,
    ...imageAssets.filter((item) => mediaCategory === "全部" || item.category === mediaCategory),
  ];
  const outputBaseMedia = resolveBaseMedia(outputMedia);
  const stagedBaseMedia = resolveBaseMedia(stagedMedia);
  const activeOverlayMedia = stagedMedia?.type === "text"
    ? stagedMedia
    : outputMedia?.type === "text"
      ? outputMedia
      : null;
  const hoverDisplayMedia = hoverMedia ? placeOverlayOnMedia(hoverMedia,activeOverlayMedia) : null;
  const displayMedia = hoverDisplayMedia ?? stagedMedia ?? outputMedia;
  const displayBaseMedia = resolveBaseMedia(displayMedia);
  const outputTransform = mediaTransforms[outputBaseMedia?.id ?? outputMedia.id] ?? defaultMediaTransform;
  const displayTransform = displayMedia === stagedMedia && stagedTransform
    ? stagedTransform
    : mediaTransforms[displayBaseMedia?.id ?? displayMedia.id] ?? defaultMediaTransform;
  // Media and transforms are updated immutably. Sharing the committed snapshot
  // reference makes the dirty check constant-time, even when a text composition
  // contains large PNG data URLs.
  const previewPending = Boolean(stagedMedia) && (
    stagedMedia !== outputMedia || (stagedTransform ?? defaultMediaTransform) !== outputTransform
  );
  useEffect(() => {
    const handleRhythmAutomation = (event) => {
      const rhythmEvent = event.detail;
      const dominantDeck = selectDominantDeck(playingDecks, crossfade);
      if (!dominantDeck || rhythmEvent?.deck !== dominantDeck) return;

      if (lightingEnabled && light === null && rhythmEventMatchesRule(lightRhythmRule, rhythmEvent)) {
        const pulse=gatlingPulseForRhythm(rhythmEvent);
        if(!pulse.skip){
          updateGatling({
            dimmerPercent:pulse.peakDimmerPercent,
            speedValue:pulse.speedValue,
            source:"rhythm",
          }).then((triggered)=>{
            if(!triggered)return;
            setAutoLightPreset(0);
            window.dispatchEvent(new CustomEvent("king:lighting-cue", { detail:{
              presetId:0,
              source:"rhythm",
              rule:lightRhythmRule,
              rhythm:rhythmEvent,
              look:pulse.look,
              speedValue:pulse.speedValue,
              peakDimmerPercent:pulse.peakDimmerPercent,
            } }));
          });
        }
        const beamPulse=beamShowArmed?beamShowControllerRef.current.next(rhythmEvent):null;
        if(beamPulse&&!beamPulse.skip){
          runBeamShow({bpm:beamPulse.bpm,source:"rhythm"}).then((triggered)=>{
            if(!triggered)return;
            window.dispatchEvent(new CustomEvent("king:beam-cue", { detail:{
              source:"rhythm",
              rule:lightRhythmRule,
              rhythm:rhythmEvent,
              look:beamPulse.look,
              bpm:beamPulse.bpm,
              beats:beamPulse.beats,
              rows:beamPulse.rows,
            } }));
          });
        }
      }

      if (rhythmEventMatchesRule(videoRhythmRule, rhythmEvent) && availableVideos.length) {
        automationVideoIndexRef.current = (automationVideoIndexRef.current + 1) % availableVideos.length;
        const source = availableVideos[automationVideoIndexRef.current];
        const candidate = { ...source, id:source.id, type:"video", name:source.name, src:source.src };
        const overlaySource = stagedMedia?.type === "text" ? stagedMedia : outputMedia?.type === "text" ? outputMedia : null;
        const stagedCandidate = placeOverlayOnMedia(candidate,overlaySource);
        setHoverMedia(null);
        setStagedMedia(stagedCandidate);
        setStagedTransform({ ...(mediaTransforms[candidate.id] ?? defaultMediaTransform) });
        if (!overlaySource) {
          setSelectedTextElement(null);
          setSelectedTextElements([]);
        }
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
  }, [availableVideos, beamShowArmed, crossfade, light, lightingEnabled, lightRhythmRule, mediaTransforms, outputMedia, playingDecks, runBeamShow, stagedMedia, updateGatling, videoRhythmRule]);
  useEffect(()=>{
    if(!lightingEnabled||light!==null||outputBaseMedia?.type!=="video")return undefined;
    videoColorSamplingErrorRef.current=null;
    videoColorAutomationRef.current={family:null,stableSamples:0,lastAppliedFamily:null};
    if(!videoColorCanvasRef.current)videoColorCanvasRef.current=document.createElement("canvas");
    const sample=()=>{
      try{
        const color=sampleVideoColor(outputVideoElementRef.current,videoColorCanvasRef.current);
        if(!color)return;
        window.dispatchEvent(new CustomEvent("king:video-color",{detail:{mediaId:outputBaseMedia.id,...color}}));
      }catch(error){
        if(videoColorSamplingErrorRef.current===outputBaseMedia.id)return;
        videoColorSamplingErrorRef.current=outputBaseMedia.id;
        console.warn("视频主色取样不可用",error);
      }
    };
    const timer=window.setInterval(sample,400);
    sample();
    return()=>window.clearInterval(timer);
  },[light,lightingEnabled,outputBaseMedia]);
  useEffect(()=>{
    const handleVideoColor=(event)=>{
      if(!lightingEnabled||light!==null||outputBaseMedia?.type!=="video"||event.detail?.mediaId!==outputBaseMedia.id)return;
      let tracker=videoColorAutomationRef.current;
      if(tracker.family===event.detail.family)tracker={...tracker,stableSamples:tracker.stableSamples+1};
      else tracker={family:event.detail.family,stableSamples:1,lastAppliedFamily:tracker.lastAppliedFamily};
      videoColorAutomationRef.current=tracker;
      const stableSamplesRequired=tracker.lastAppliedFamily===null?1:2;
      if(tracker.stableSamples<stableSamplesRequired||tracker.lastAppliedFamily===event.detail.family)return;
      videoColorAutomationRef.current={...tracker,lastAppliedFamily:event.detail.family};
      const paletteTitanId=gatlingPaletteForVideoFamily(event.detail.family);
      updateGatling({
        paletteTitanId,
        dimmerPercent:kingclubGatlingProfile.baseDimmerPercent,
        source:"video-color",
      }).then((triggered)=>{
        if(!triggered)return;
        setAutoLightPreset(0);
        window.dispatchEvent(new CustomEvent("king:lighting-cue",{detail:{presetId:0,source:"video-color",mediaId:outputBaseMedia.id,color:event.detail,paletteTitanId}}));
      });
    };
    window.addEventListener("king:video-color",handleVideoColor);
    return()=>window.removeEventListener("king:video-color",handleVideoColor);
  },[light,lightingEnabled,outputBaseMedia,updateGatling]);
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
    const programMedia = outputMedia.type === "text" && outputBaseMedia?.type === "video"
      ? { ...outputMedia, baseMedia:{ ...outputBaseMedia, muted:!videoAudioEnabled } }
      : outputBaseMedia?.type === "video"
        ? { ...outputMedia, muted:!videoAudioEnabled }
        : outputMedia;
    invoke("set_program_state", { program:{ media:programMedia, transform:outputTransform, lyrics:activeLyrics, playback:videoPlayback } })
      .catch((error)=>console.error("同步 LED 节目画面失败",error));
  },[outputMedia,outputBaseMedia,outputTransform,videoAudioEnabled,activeLyrics,videoPlayback]);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    connectLedOutput();
    const timer=window.setInterval(async()=>{
      try {
        const status=await invoke("output_window_status");
        setLedOutputStatus(current=>JSON.stringify(current)===JSON.stringify(status)?current:status);
        if(!status.connected) await connectLedOutput();
      } catch(error) {
        const next={connected:false,previewMode:false,message:String(error)};
        setLedOutputStatus(current=>JSON.stringify(current)===JSON.stringify(next)?current:next);
        await connectLedOutput();
      }
    },5000);
    return ()=>window.clearInterval(timer);
  },[]);
  const chosenTextElements = stagedMedia?.type === "text" ? stagedMedia.elements.filter((element)=>selectedTextElements.includes(element.id)) : [];
  const outputLabel = `${outputBaseMedia?.name ?? outputMedia.name}${outputMedia.type === "text" ? " · 文字/Logo 覆盖" : ""}`;
  const stageMedia = (candidate) => {
    if(candidate.type==="video")candidate={...candidate,playbackCategory:mediaCategory};
    setTextDraftClearSlot(null);
    const replacesOverlay = candidate.type === "text";
    const currentBaseMedia = resolveBaseMedia(stagedMedia ?? outputMedia);
    const overlaySource = stagedMedia?.type === "text" ? stagedMedia : outputMedia?.type === "text" ? outputMedia : null;
    const stagedCandidate = replacesOverlay
      ? { ...candidate, baseMedia:currentBaseMedia, elements:cloneOverlayElements(candidate) }
      : placeOverlayOnMedia(candidate,overlaySource);
    setStagedMedia(stagedCandidate);
    setStagedTransform({ ...(mediaTransforms[candidate.id] ?? defaultMediaTransform) });
    if (replacesOverlay) {
      textUndoRef.current = [];
      const firstTextElement = stagedCandidate.elements?.[0]?.id ?? null;
      setSelectedTextElement(firstTextElement);
      setSelectedTextElements(firstTextElement?[firstTextElement]:[]);
    } else if (!overlaySource) {
      setSelectedTextElement(null);
      setSelectedTextElements([]);
    }
    setPreviewMode(true);
    setMonitorTarget(null);
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
    const committedBaseMedia = resolveBaseMedia(committedMedia);
    const currentPlayback=videoPlaybackRef.current;
    if(committedBaseMedia?.id!==currentPlayback.mediaId){
      updateVideoPlayback({...currentPlayback,
        queueIds:committedBaseMedia?.type==="video"?captureVideoQueue(availableVideos,committedBaseMedia.playbackCategory??mediaCategory,committedBaseMedia.id):[],
        mediaId:committedBaseMedia?.id??null,
        token:currentPlayback.token+1,
      });
    }
    const committedTransform = { ...(stagedTransform ?? defaultMediaTransform) };
    setMediaTransforms((current)=>({...current,[committedBaseMedia?.id ?? committedMedia.id]:committedTransform}));
    // 上屏后保留一份独立的 PVW 副本，让操作员可立即继续编辑下一版。
    setOutputMedia(committedMedia);
    setStagedMedia(committedMedia);
    setStagedTransform(committedTransform);
    if (committedBaseMedia?.type === "video") setVideo(committedBaseMedia.index);
    if (committedBaseMedia?.type === "image") setSelectedImage(committedBaseMedia.id);
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

  const deckMeterCeilings = deckCue.deck
    ? { deck1:deckCue.deck===1?headphoneVolume:0, deck2:deckCue.deck===2?headphoneVolume:0 }
    : { deck1:100-crossfade, deck2:crossfade };
  const handleCrossfadeChange = (event) => {
    const automaticTarget=mpvAutoTransitionRef.current.targetDeck;
    if(automaticTarget)void takeDeckOperatorControl(automaticTarget,{rollbackAutoTarget:false});
    else cancelMpvAutoTransition();
    const nextCrossfade = Number(event.target.value);
    writeDeckOutputVolumes(nextCrossfade,masterVolume);
    setCrossfade(nextCrossfade);
  };
  const handleMasterVolumeChange = (event) => {
    const nextMasterVolume = Number(event.target.value);
    writeDeckOutputVolumes(crossfade,nextMasterVolume);
    setMasterVolume(nextMasterVolume);
  };
  const handleMicrophoneVolumeChange = (index,event) => {
    const binding=microphoneBindings[index];
    if(!binding||mixerControlStatus.mode!=="hardware-live")return;
    const value=Number(event.target.value);
    setMicrophoneVolumes(current=>[0,1].map(itemIndex=>itemIndex===index?value:(current[itemIndex]??null)));
    queueHomeMicrophoneWrites(microphoneFaderWrites(binding,value));
  };
  const faderPointerHandlers = {
    onPointerDown:beginFaderInteraction,
    onPointerUp:endFaderInteraction,
    onPointerCancel:endFaderInteraction,
    onMouseDown:beginFaderInteraction,
    onMouseUp:endFaderInteraction,
    onBlur:endFaderInteraction,
  };
  const filteredTrackEntries = useMemo(() => {
    const query = songSearch.trim().toLocaleLowerCase("zh-CN");
    const trackIndexByPath=new Map(tracks.map((track,index)=>[managedTrackIdentity(track,index),index]));
    const playlistEntries=playlistManagement.seeded&&activePlaylistRecord
      ? activePlaylistRecord.trackPaths.map(path=>trackIndexByPath.get(path)).filter(Number.isInteger).map(index=>({track:tracks[index],index}))
      : tracks.map((track,index)=>({track,index}));
    if (!query) return playlistEntries;
    return playlistEntries
      .filter(({track}) => [track.title,track.artist,track.tag,track.path]
        .some((value)=>String(value ?? "").toLocaleLowerCase("zh-CN").includes(query)));
  },[tracks,songSearch,activePlaylistRecord,playlistManagement.seeded]);
  const moveTrackInActivePlaylist = useCallback((track,index,direction) => {
    const trackPath=managedTrackIdentity(track,index);
    if(!trackPath||![-1,1].includes(direction))return;
    setPlaylistManagement(current=>{
      const selected=current.playlists.find(item=>item.name===playlist);
      if(!selected)return current;
      const fromIndex=selected.trackPaths.indexOf(trackPath);
      return updatePlaylistTracks(current,selected.id,paths=>movePlaylistTrack(paths,fromIndex,fromIndex+direction));
    });
  },[playlist,setPlaylistManagement]);
  const removeTrackFromActivePlaylist = useCallback((track,index) => {
    const trackPath=managedTrackIdentity(track,index);
    if(!trackPath)return;
    setPlaylistManagement(current=>{
      const selected=current.playlists.find(item=>item.name===playlist);
      return selected
        ? updatePlaylistTracks(current,selected.id,paths=>removePlaylistTrack(paths,trackPath))
        : current;
    });
    setSelectedTrack(current=>current===index?null:current);
  },[playlist,setPlaylistManagement]);
  const openTrackContextMenu = useCallback((event,track,index) => {
    event.preventDefault();
    event.stopPropagation();
    if(activeNav!=="音乐管理"||!activePlaylistRecord)return;
    const trackPath=managedTrackIdentity(track,index);
    if(activePlaylistRecord.trackPaths.indexOf(trackPath)<0)return;
    const width=174;
    const height=132;
    setPlaylistContextMenu(null);
    setTrackContextMenu({
      track,
      index,
      trackPath,
      x:Math.max(8,Math.min(event.clientX,window.innerWidth-width-8)),
      y:Math.max(8,Math.min(event.clientY,window.innerHeight-height-8)),
    });
  },[activeNav,activePlaylistRecord]);
  const requestManualAiProduction = useCallback(async (track) => {
    if (!track?.path || !runtimeCapability.aiProcessingAvailable||audioAiWorker.enabled===false) return;
    const normalizedPath = normalizeMediaPath(track.path);
    setManualAiPendingPaths((current)=>current.includes(normalizedPath)?current:[...current,normalizedPath]);
    try {
      await invoke("prioritize_audio_ai_analysis", {
        path:track.path,
        artist:track.artist&&track.artist!=="--"?track.artist:null,
      });
      const jobs = await invoke("list_audio_ai_jobs");
      setAudioAiJobs(Array.isArray(jobs)?jobs:[]);
      setSongPackageMessage(`已优先制作：${track.title}`);
    } catch (error) {
      const message=String(error);
      setSongPackageMessage(`AI 制作未提交：${message}`);
      console.error(`手动 AI 制作失败：${track.title}`,error);
    } finally {
      setManualAiPendingPaths((current)=>current.filter((path)=>path!==normalizedPath));
    }
  },[runtimeCapability.aiProcessingAvailable,audioAiWorker.enabled]);
  const trackRows = useMemo(() => filteredTrackEntries.map(({track:t,index:i},listPosition)=>{
    const trackAnalysis = audioAnalyses[audioAnalysisKey(t)];
    const aiJob = t.path ? audioAiJobByPath.get(normalizeMediaPath(t.path)) : null;
    const aiError = String(aiJob?.errorMessage ?? aiJob?.error_message ?? "");
    const aiFailureLabel = /JSON transcript|transcript/i.test(aiError)
      ? "歌词识别失败"
      : /allocate|allocation|memory/i.test(aiError)
        ? "资源不足/未制作"
        : /convert string to float/i.test(aiError)
          ? "时间解析失败"
          : "制作失败";
    const stemProgress = describeReadyStemProgress(Boolean(t.accompanimentPath),aiJob);
    const aiLabel = stemProgress?.label ?? (aiJob?.status==="ready"?"全部制作完成":aiJob?.status==="skipped"?(aiJob.stage==="missing-artist"?"无歌手/仅播放":"DJ长音频/仅播放"):aiJob?.status==="running"?`制作中/${aiJob.stage}`:aiJob?.status==="paused"?"播放中/制作暂停":aiJob?.status==="queued"?"待制作":aiJob?.status==="failed"?aiFailureLabel:runtimeCapability.mode==="player"?"可播放":"待登记");
    const aiTitle = aiJob?.status==="failed" && aiError ? `${aiLabel}：${aiError}` : aiLabel;
    const trackBpm = Number(trackAnalysis?.bpm) > 0 ? Number(trackAnalysis.bpm).toFixed(1).replace(/\.0$/, "") : t.bpm;
    const inDeck1 = i===deck1;
    const inDeck2 = i===deck2;
    const onAirDeck1 = playingDecks[1]&&inDeck1;
    const onAirDeck2 = playingDecks[2]&&inDeck2;
    const onAir = onAirDeck1||onAirDeck2;
    const bothOnAir = onAirDeck1&&onAirDeck2;
    const locked = inDeck1||inDeck2;
    const rowSelected = !locked&&selectedTrack===i;
    const manualAiPending = Boolean(t.path&&manualAiPendingPaths.includes(normalizeMediaPath(t.path)));
    const missingArtist = !t.artist||t.artist==="--";
    const manualAiDisabled = manualAiPending||!runtimeCapability.aiProcessingAvailable||audioAiWorker.enabled===false||missingArtist||["ready","running","paused"].includes(aiJob?.status)||aiJob?.status==="skipped";
    const manuallyPrioritized = aiJob?.status==="queued"&&["manual-priority","manual-retry"].includes(aiJob?.stage);
    const manualAiLabel = audioAiWorker.enabled===false?"AI已关":manualAiPending?"提交中":stemProgress?.actionLabel??(aiJob?.status==="ready"?"已完成":aiJob?.status==="running"||aiJob?.status==="paused"?"制作中":manuallyPrioritized?"已置顶":aiJob?.status==="queued"?"优先":aiJob?.status==="failed"?"重做":missingArtist?"补歌手":aiJob?.status==="skipped"?"仅播放":"AI制作");
    const manualAiTitle = audioAiWorker.enabled===false?"AI 歌曲制作已在设置中关闭":missingArtist?"请先在歌曲文件名或标签中补充歌手名":manuallyPrioritized?"已置顶，当前任务结束后立即制作":aiJob?.status==="queued"?"将这首歌提到 AI 制作队列最前面":aiJob?.status==="failed"?"重新制作歌词和原唱/伴唱":"制作歌词和原唱/伴唱";
    return <div key={t.id??`${t.title}-${i}`} role="button" aria-disabled={locked} tabIndex={locked?-1:0} className={`track-row ${rowSelected?"selected":""} ${locked?"deck-locked":""} ${inDeck1?"deck-one":""} ${inDeck2?"deck-two":""} ${onAir?"on-air":""} ${bothOnAir?"on-air-both":""}`} onClick={()=>{if(!locked)setSelectedTrack(i)}} onDoubleClick={()=>{if(!locked)loadTrack(i)}} onPointerDown={event=>{if(event.button===2)openTrackContextMenu(event,t,i)}} onContextMenuCapture={event=>openTrackContextMenu(event,t,i)} onKeyDown={event=>{if(event.key==="Enter"&&!locked)setSelectedTrack(i)}}>
      <span className={`track-index ${inDeck1||inDeck2?"deck-indicators":""}`}>{inDeck1||inDeck2?[inDeck1&&<SpeakerHigh key="deck-1" className="deck-one-indicator" weight={onAirDeck1?"fill":"regular"}/>,inDeck2&&<SpeakerHigh key="deck-2" className="deck-two-indicator" weight={onAirDeck2?"fill":"regular"}/>]:String(listPosition+1)}</span><span className="track-info"><b title={t.title}>{t.title}</b><small title={`${t.tag} · ${aiTitle}`}>{t.tag} · {aiLabel}</small></span><span className="track-artist" title={t.artist}>{t.artist}</span><span title={`BPM ${trackBpm}`}>{trackBpm}</span><span title={`时长 ${t.duration}`}>{t.duration}</span>
      {onAir&&<span className="track-playing-decks" aria-label={`正在由${bothOnAir?" Deck 1 和 Deck 2":` Deck ${onAirDeck1?1:2}`}播放`}>{onAirDeck1&&<span className="track-playing-badge deck-one-label">1</span>}{onAirDeck2&&<span className="track-playing-badge deck-two-label">2</span>}</span>}
      <button className="track-insert track-ai-action" disabled={manualAiDisabled} aria-label={`${manualAiLabel}：${t.title}`} title={manualAiTitle} onClick={event=>{event.stopPropagation();requestManualAiProduction(t)}} onDoubleClick={event=>event.stopPropagation()}>{manualAiLabel}</button>
      <button className="track-insert track-deck-one-action" aria-label="装载到 1 号 Deck，不自动播放" title="装载到 1 号 Deck（不自动播放）" onClick={event=>{event.stopPropagation();insertTrack(1,i)}} onDoubleClick={event=>event.stopPropagation()}>1</button>
      <button className="track-insert track-deck-two-action" aria-label="装载到 2 号 Deck，不自动播放" title="装载到 2 号 Deck（不自动播放）" onClick={event=>{event.stopPropagation();insertTrack(2,i)}} onDoubleClick={event=>event.stopPropagation()}>2</button>
    </div>;
  }), [filteredTrackEntries,audioAnalyses,audioAiJobByPath,runtimeCapability.mode,runtimeCapability.aiProcessingAvailable,audioAiWorker.enabled,manualAiPendingPaths,deck1,deck2,playingDecks,selectedTrack,library,openTrackContextMenu,requestManualAiProduction]);
  const exitApplication = () => {
    invoke("exit_application").catch((error) => {
      console.error("退出桌面程序失败", error);
      window.close();
    });
  };

  const weekdayPlaylistItems=playlistManagement.playlists.filter(item=>item.kind==="weekday");
  const secondaryPlaylistItems=playlistManagement.playlists.filter(item=>item.kind==="event"||item.kind==="custom");
  const openPlaylistSortMenu=(event,item)=>{
    event.preventDefault();
    event.stopPropagation();
    const width=154;
    const height=92;
    const anchor=event.currentTarget?.getBoundingClientRect?.();
    const requestedX=event.clientX||anchor?.left||8;
    const requestedY=event.clientY||anchor?.bottom||8;
    setPlaylistContextMenu({
      playlistId:item.id,
      x:Math.max(8,Math.min(requestedX,window.innerWidth-width-8)),
      y:Math.max(8,Math.min(requestedY,window.innerHeight-height-8)),
    });
  };
  const movePlaylistFromL=(item,direction)=>{
    setPlaylistManagement(current=>movePlaylistWithinKind(current,item.id,direction));
    setPlaylistContextMenu(null);
  };
  const contextPlaylist=playlistContextMenu?playlistManagement.playlists.find(item=>item.id===playlistContextMenu.playlistId)??null:null;
  const contextPlaylistGroup=contextPlaylist?playlistManagement.playlists.filter(item=>item.kind===contextPlaylist.kind):[];
  const contextPlaylistIndex=contextPlaylist?contextPlaylistGroup.findIndex(item=>item.id===contextPlaylist.id):-1;
  const contextTrackIndex=trackContextMenu&&activePlaylistRecord
    ? activePlaylistRecord.trackPaths.indexOf(trackContextMenu.trackPath)
    : -1;
  const moveTrackFromL=(direction)=>{
    if(!trackContextMenu)return;
    moveTrackInActivePlaylist(trackContextMenu.track,trackContextMenu.index,direction);
    setTrackContextMenu(null);
  };
  const removeTrackFromL=()=>{
    if(!trackContextMenu)return;
    const removedIndex=trackContextMenu.index;
    const matchingPlayingDeck=playingDecks[1]&&deck1===removedIndex
      ? 1
      : playingDecks[2]&&deck2===removedIndex
        ? 2
        : null;
    const matchingPlaybackSource=matchingPlayingDeck===null
      ? null
      : deckPlaybackQueueSources[matchingPlayingDeck];
    const playingDeckNumber=matchingPlaybackSource
      && activePlaylistPlaybackSource
      && matchingPlaybackSource.kind===activePlaylistPlaybackSource.kind
      && matchingPlaybackSource.libraryKey===activePlaylistPlaybackSource.libraryKey
      && matchingPlaybackSource.playlistId===activePlaylistPlaybackSource.playlistId
      ? matchingPlayingDeck
      : null;
    const orderedIndexes=activePlaylistRecord
      ? activePlaylistRecord.trackPaths.map((path)=>trackIndexByPath.get(path)).filter(Number.isInteger)
      : [];
    const nextTrackIndex=playingDeckNumber===null
      ? null
      : getNextPlayableTrackInQueue(orderedIndexes,removedIndex,-1,false);
    if(playingDeckNumber!==null){
      void transitionDeletedPlayingTrack(
        playingDeckNumber,
        removedIndex,
        nextTrackIndex,
        activePlaylistPlaybackSource,
      );
    }
    removeTrackFromActivePlaylist(trackContextMenu.track,trackContextMenu.index);
    setTrackContextMenu(null);
  };

  const homeLibraryPanel = <aside className="panel library-panel" aria-label="首页 L 区播放曲库">
    <div className="panel-title"><MusicNotes weight="fill"/><div><b>播放曲库</b><small title={[mpvRuntime.message,audioImportStatus.message].filter(Boolean).join(" · ")}>{audioAssets.length?`${library}号曲库 · ${playlist}常规歌单 · ${tracks.length} 首 · ${mpvEnabled?"mpv 播放引擎":"兼容引擎"}${audioImportStatus.detected?` · KGMA ${audioImportStatus.ready}/${audioImportStatus.detected}`:""}`:`${library}号曲库 · ${playlist}常规歌单 · 当前为演示数据${audioImportStatus.detected?` · KGMA ${audioImportStatus.ready}/${audioImportStatus.detected}`:""}`}</small></div></div>
    <div className="library-switch"><button className={library===1?"active":""} onClick={()=>{setLibrary(1);setPlaylistContextMenu(null);setTrackContextMenu(null);setSelectedTrack(null)}}>1号曲库</button><button className={library===2?"active":""} onClick={()=>{setLibrary(2);setPlaylistContextMenu(null);setTrackContextMenu(null);setSelectedTrack(null)}}>2号曲库</button></div>
    <div className="playlist-tabs" aria-label="歌单选择">
      <div className="playlist-row weekday-row">{weekdayPlaylistItems.map(item=><button key={item.id} className={playlist===item.name?"active":""} onClick={()=>setPlaylist(item.name)} onContextMenu={event=>openPlaylistSortMenu(event,item)} onKeyDown={event=>{if(event.key==="ContextMenu"||(event.shiftKey&&event.key==="F10"))openPlaylistSortMenu(event,item)}} title={`${item.name} · 右键排序`}>{item.name}</button>)}</div>
      <div className="playlist-row special-row">{secondaryPlaylistItems.map(item=><button key={item.id} className={playlist===item.name?"active":""} onClick={()=>setPlaylist(item.name)} onContextMenu={event=>openPlaylistSortMenu(event,item)} onKeyDown={event=>{if(event.key==="ContextMenu"||(event.shiftKey&&event.key==="F10"))openPlaylistSortMenu(event,item)}} title={`${item.name} · 右键排序`}>{item.name}</button>)}</div>
    </div>
    <label className="song-search">
      <MagnifyingGlass weight="bold"/>
      <input value={songSearch} onChange={event=>setSongSearch(event.target.value)} placeholder="搜索歌曲、歌手或目录" aria-label="搜索歌曲、歌手或目录"/>
      <span>{filteredTrackEntries.length}/{tracks.length}</span>
      {songSearch&&<button type="button" onClick={()=>setSongSearch("")} title="清空搜索" aria-label="清空搜索"><X weight="bold"/></button>}
    </label>
    <div className="table-head"><span>{activeNav==="音乐管理"?"歌曲 · 右键管理":"歌曲"}</span><span>歌手</span><span>BPM</span><span>时长</span></div>
    <div className="track-list" onContextMenu={event=>{if(activeNav==="音乐管理")event.preventDefault()}}>{trackRows.length?trackRows:<div className="track-search-empty"><b>没有找到歌曲</b><small>请更换歌曲名、歌手或目录关键词</small></div>}</div>
    {contextPlaylist&&createPortal(<div className="playlist-context-menu" role="menu" aria-label={`${contextPlaylist.name} 分类排序`} style={{left:playlistContextMenu.x,top:playlistContextMenu.y}} onPointerDown={event=>event.stopPropagation()}>
      <strong>{contextPlaylist.name}<small>调整 L 区顺序</small></strong>
      <button type="button" role="menuitem" disabled={contextPlaylistIndex<=0} onClick={()=>movePlaylistFromL(contextPlaylist,-1)}><ArrowUp/>上移</button>
      <button type="button" role="menuitem" disabled={contextPlaylistIndex<0||contextPlaylistIndex>=contextPlaylistGroup.length-1} onClick={()=>movePlaylistFromL(contextPlaylist,1)}><ArrowDown/>下移</button>
    </div>,document.body)}
    {trackContextMenu&&contextTrackIndex>=0&&createPortal(<div className="playlist-context-menu track-context-menu" role="menu" aria-label={`${trackContextMenu.track.title} 歌单操作`} style={{left:trackContextMenu.x,top:trackContextMenu.y}} onPointerDown={event=>event.stopPropagation()}>
      <strong title={trackContextMenu.track.title}>{trackContextMenu.track.title}<small>{library}号曲库 / {playlist} · 只调整当前列表</small></strong>
      <button type="button" role="menuitem" disabled={contextTrackIndex===0} onClick={()=>moveTrackFromL(-1)}><ArrowUp/>上移</button>
      <button type="button" role="menuitem" disabled={contextTrackIndex===activePlaylistRecord.trackPaths.length-1} onClick={()=>moveTrackFromL(1)}><ArrowDown/>下移</button>
      <button type="button" role="menuitem" className="danger" onClick={removeTrackFromL}><Trash/>从当前列表移除</button>
    </div>,document.body)}
  </aside>;

  return <div className="app-shell">
    <div className="media-audio-engine" aria-hidden="true">
      <audio ref={deckOneAudioRef} src={mpvEnabled?undefined:(deckOnePath?convertFileSrc(deckOnePath):undefined)} preload="metadata" autoPlay={Boolean(!mpvEnabled&&deckOnePath&&playingDecks[1])} onLoadedMetadata={(event)=>updateAudioMetadata(1,deck1,event)} onTimeUpdate={(event)=>setDeckProgress((current)=>({...current,1:event.currentTarget.currentTime}))} onEnded={()=>finishRealAudio(1,deck1)} onError={()=>setPlayingDecks((current)=>({...current,1:false}))}/>
      <audio ref={deckTwoAudioRef} src={mpvEnabled?undefined:(deckTwoPath?convertFileSrc(deckTwoPath):undefined)} preload="metadata" autoPlay={Boolean(!mpvEnabled&&deckTwoPath&&playingDecks[2])} onLoadedMetadata={(event)=>updateAudioMetadata(2,deck2,event)} onTimeUpdate={(event)=>setDeckProgress((current)=>({...current,2:event.currentTarget.currentTime}))} onEnded={()=>finishRealAudio(2,deck2)} onError={()=>setPlayingDecks((current)=>({...current,2:false}))}/>
    </div>
    <header className="topbar">
      <div className="brand"><img src="/assets/king-club-logo-white.svg" alt="King Club"/><div><strong>AI Broadcast Control 2027</strong></div></div>
      <div className="system-status"><span className={`runtime-mode runtime-mode-${runtimeCapability.mode}`} title={`${runtimeCapability.message}${runtimeCapability.aiProcessingAvailable?` · AI worker ${audioAiWorker.enabled===false?"已关闭":audioAiWorker.running?"运行中":"等待中"}`:""}`}>{runtimeCapability.mode==="full"?<><span className="nvidia-runtime-logo" aria-label="NVIDIA"><img src="/assets/nvidia-logo-horiz-wht-16x9.png" alt="NVIDIA"/></span><span className="runtime-edition">全功能版</span></>:<><Lightning weight="fill"/> {runtimeCapability.mode==="detecting"?"识别硬件":"播放版"}</>}</span><span><WifiHigh /> 本机控制</span><span className={ledOutputStatus.connected?"led-connected":"led-disconnected"} title={ledOutputStatus.message}><MonitorPlay /> {ledOutputStatus.previewMode?"单屏 · C1 预览":ledOutputStatus.connected?"第二屏 + C1 预览":"LED 主屏未连接"}</span><RuntimeClock/><button type="button" className="app-exit-button" onClick={exitApplication} title="退出软件" aria-label="退出软件"><X weight="bold"/></button></div>
    </header>

    <main ref={workspaceRef} className={`workspace ${previewMode?"preview-layout":""} ${activeNav==="调音台"?"mixer-layout":""} ${activeNav==="Avolites Tiger Touch Pro"?"titan-layout":""} ${activeNav==="演出编排"?"show-editor-layout":""}`}>
      {activeNav === "设置" ? <SettingsView
        screenTargets={screenTargets}
        monitorTargets={monitorTargets}
        onScreenChange={updateScreenTarget}
        onMonitorChange={updateMonitorTarget}
        onSave={saveTargetSettings}
        dirty={settingsDirty}
        runtimeCapability={runtimeCapability}
        audioAiWorker={audioAiWorker}
        aiRuntimeBusy={aiRuntimeBusy}
        onAiRuntimeEnabledChange={changeAiRuntimeEnabled}
        mixerModelId={mixerModelId}
        mixerDriverStatus={mixerDriverStatus}
        mixerControlHost={mixerControlHost}
        mixerMeterStatus={mixerMeterStatus}
        onMixerModelChange={configureMixerModel}
        onMixerControlHostChange={updateMixerControlHost}
        onOpenMixerDriver={openMixerDriver}
        titanHost={titanHost}
        titanStatus={titanStatus}
        titanPlaybacks={titanPlaybacks}
        titanMappings={titanMappings}
        titanActionStatus={titanActionStatus}
        lightingPackageStatus={lightingPackageStatus}
        onTitanHostChange={updateTitanHost}
        onRefreshTitan={refreshTitanStatus}
        onTitanMappingChange={updateTitanMapping}
        onExportLightingPackage={exportLightingPackage}
        onImportLightingPackage={importLightingPackage}
        onOpenLightingPackageDirectory={openLightingPackageDirectory}
        vocalStatus={vocalStatus}
        vocalBusy={vocalBusy}
        onRefreshVocal={refreshVocalStatus}
        onVocalPresetChange={changeVocalPreset}
        onVocalDisarm={disarmVocalEngine}
        vocalRouting={vocalRouting}
        routingBusy={routingBusy}
        onDiscoverRouting={discoverVocalRouting}
        onSaveRouting={saveVocalRouting}
        calibrationStatus={calibrationStatus}
        onRunCalibration={runVocalCalibration}
      /> : activeNav === "音乐管理" ? <MusicManagementView
        leftPanel={homeLibraryPanel}
        activeLibrary={library}
        onActiveLibraryChange={setLibrary}
        vocalProfiles={vocalProfiles}
        vocalProfileDevices={vocalProfileDevices}
        vocalProfileBusy={vocalProfileBusy}
        vocalProfileMessage={vocalProfileMessage}
        songs={tracks.map((track,index)=>({...track,index,path:managedTrackIdentity(track,index)})).filter(track=>track.path)}
        videos={availableVideos}
        lightingEffects={[...lights.filter(item=>item.label).map(item=>({id:String(item.id),name:item.label})),...titanEffectRegistry.map(item=>({id:String(item.effectId??item.id),name:item.name??item.label??item.legend??`灯光效果 ${item.effectId??item.id}`}))].filter((item,index,items)=>item.id&&items.findIndex(candidate=>candidate.id===item.id)===index)}
        playlistManagement={playlistManagement}
        onPlaylistManagementChange={setPlaylistManagement}
        activePlaylistName={playlist}
        onActivePlaylistNameChange={setPlaylist}
        onLoadTrackToDeck={insertTrackWithoutPlaylistQueue}
        onOpenShowEditor={(trackIndex)=>{setSelectedTrack(trackIndex);setActiveNav("演出编排")}}
        runtimeMode={runtimeCapability.mode}
        packageMessage={songPackageMessage}
        packageDirectories={songPackageDirectories}
        packageReadyPaths={tracks.filter(track=>track.path&&audioAiJobByPath.get(normalizeMediaPath(track.path))?.status==="ready").map(track=>track.path)}
        onExportPackage={exportSelectedPackage}
        onImportPackage={importPackageInbox}
        onOpenPackageDirectory={openPackageDirectory}
        selectedProfileId={selectedVocalProfileId}
        onSelectedProfileIdChange={selectVocalProfile}
        onCreateVocalProfile={createVocalProfile}
        onRecordVocalProfileSample={recordVocalProfileSample}
        onDeleteVocalProfile={deleteVocalProfile}
        onPrepareVocalProfileSong={prepareVocalProfileSong}
      /> : activeNav === "演出编排" ? <ShowEditorWorkspace
        track={tracks[selectedTrack]??tracks[deck1]??tracks[activePlaylistTrackIndexes[0]]??tracks[0]??null}
        deck1={deck1}
        deck2={deck2}
        playingDecks={playingDecks}
        cueDeck={deckCue.deck}
        crossfade={crossfade}
        programMedia={outputBaseMedia}
        previewMedia={stagedBaseMedia}
        videos={availableVideos}
      /> : <>
      <LightingConsoleWorkspace
        titanHost={titanHost}
        titanStatus={titanStatus}
        titanInventory={titanInventory}
        titanPlaybacks={titanPlaybacks}
        titanStaticPlaybacks={titanStaticPlaybacks}
        titanMappings={titanMappings}
        effectRegistry={titanEffectRegistry}
        titanActionStatus={titanActionStatus}
        lightingPackageStatus={lightingPackageStatus}
        lightingEnabled={lightingEnabled}
        onLightingEnabledChange={setLightingEnabled}
        onRefreshTitan={()=>Promise.allSettled([refreshTitanStatus(),refreshTitanInventory()])}
        onQuickSlotChange={stableUpdateTitanMapping}
        onPlaybackQuickSlotChange={stableUpdateTitanPlaybackQuickSlot}
        onEffectChange={stableUpdateTitanEffect}
        onExportPackage={stableExportLightingPackage}
        onImportPackage={stableImportLightingPackage}
        onOpenPackageDirectory={stableOpenLightingPackageDirectory}
      />
      {homeLibraryPanel}

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
                ? <><div className="dual-screen-pane program-pane"><span className="screen-role-label">PGM · 当前上屏</span><MediaOutputScreen media={outputMedia} track={tracks[deck1]} lyrics={activeLyrics} transform={outputTransform} videoRef={outputVideoElementRef} playback={videoPlayback} onVideoEnded={desktopRuntime?undefined:handleProgramVideoEnded}/></div><div className="dual-screen-pane preview-pane"><span className="screen-role-label">{previewPending?"PVW · 编辑中":"PVW · 已同步"}</span><MediaOutputScreen media={displayMedia} track={tracks[deck1]} transform={displayTransform} editable={stagedMedia?.type==="text"&&stagedMedia===displayMedia} selectedElementId={selectedTextElement} selectedElementIds={selectedTextElements} onElementSelect={selectTextElement} onElementChange={updateTextElementById} onEditStart={rememberTextState}/>{stagedMedia===displayMedia&&resolveBaseMedia(stagedMedia)?.src&&<MediaTransformEditor value={displayTransform} onChange={setStagedTransform}/>}<svg className="preview-visible-outline" viewBox="0 0 2048 2304" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="M512 0h1024v1152h512v1152H0V1152h512z"/></svg></div></>
                : <MediaOutputScreen media={outputMedia} track={tracks[deck1]} lyrics={activeLyrics} transform={outputTransform} videoRef={outputVideoElementRef} playback={videoPlayback} onVideoEnded={desktopRuntime?undefined:handleProgramVideoEnded}/>
              : <div className="monitor-feed" style={{backgroundImage:`linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.28)),url(${monitorTargets[monitorTarget].src})`}}><div className="monitor-live"><span className="live-dot"/> LIVE</div><b>{monitorTargets[monitorTarget].name}</b><small>摄像机视频流接口预留</small></div>}
          </div>
          {previewMode&&monitorTarget===null&&stagedMedia?.type==="text"&&<TextFormatToolbar elements={chosenTextElements} fonts={systemFonts} fontDirectory={fontLibraryDirectory} customFontCount={customFontCount} onOpenFontDirectory={()=>invoke("open_font_directory").then(setFontLibraryDirectory).catch((error)=>console.error("打开字体目录失败",error))} onRefreshFonts={()=>refreshFontLibrary().catch((error)=>console.error("刷新字体目录失败",error))} onApply={applyTextSelection} onAlign={alignTextSelection} onUpload={uploadTextGraphic} saveSlot={activeTextDraftSlot} onSave={saveActiveTextDraft}/>}
          {textDraftClearSlot!==null&&<div className="text-draft-dialog" role="alertdialog" aria-modal="true" aria-label={`清空暂存 ${textDraftClearSlot+1} 确认`}><b>清空暂存 {textDraftClearSlot+1}</b><span>此操作会移除该暂存内容，是否继续？</span><div><button type="button" onClick={()=>setTextDraftClearSlot(null)}>取消</button><button type="button" className="draft-clear" onClick={clearSelectedTextDraft}>清空暂存</button></div></div>}
          {monitorTarget===null&&previewMode&&stagedMedia&&<div className={`media-preview-confirm ${previewPending?"is-pending":"is-synced"}`}><span>{previewPending?"PVW · 有修改":"PVW · 与 PGM 一致"}</span><button type="button" className="reset" onClick={resetMediaPreview}>重置</button><button type="button" className="take" onClick={confirmStagedMedia}>上屏</button></div>}
          <div className="preview-footer">
            <span><CheckCircle weight="fill"/> {monitorTarget===null?(ledOutputStatus.previewMode?"单屏模式 · C1 实时预览":ledOutputStatus.connected?"第二屏输出正常 · C1 实时预览":"第二屏等待连接"):"监控已选择"}</span>
            <span>{monitorTarget===null?`${outputBaseMedia?.type === "image" ? "图片" : outputBaseMedia?.type === "video" ? "视频" : "画面"}：${outputLabel}`:"等待摄像机接入"}</span>
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
              level={deckMeterCeilings.deck1}
              progress={deckProgress[1]}
              onSeek={seconds=>seekDeck(1,seconds)}
              onPrevious={()=>loadAdjacentDeckTrack(1,-1)}
              onReplay={()=>replayDeck(1)}
              onNext={()=>loadAdjacentDeckTrack(1,1)}
              playbackMode={deckPlaybackModes[1]}
              onPlaybackModeChange={mode=>{void takeDeckOperatorControl(1,{rollbackAutoTarget:false});setDeckPlaybackModes(current=>({...current,1:mode}))}}
              automationOwner={deckAutomationOwners[1]}
              lyricsEnabled={deckLyricsEnabled[1]}
              lyricsAvailable={deckLyricsLines[1].length>0}
              vocalMode={deckVocalModes[1]}
              accompanimentAvailable={Boolean(tracks[deck1]?.accompanimentPath)}
              aiRescueEnabled={deckAiRescueEnabled[1]}
              aiReferenceStatus={deckReferenceStatus[1]}
              onAiRescueToggle={()=>setDeckAiRescueEnabled(current=>({...current,1:!current[1]}))}
              onLyricsToggle={()=>setDeckLyricsEnabled(current=>({...current,1:!current[1]}))}
              onVocalToggle={()=>switchDeckVocalMode(1,deck1)}
              onPlay={()=>toggleDeckPlayback(1,deck1)}
              cueActive={deckCue.deck===1}
              cueAvailable={mpvEnabled&&mixerControlStatus.mode==="hardware-live"}
              cueBusy={deckCue.busy}
              cueMessage={deckCue.message}
              onCueToggle={()=>toggleDeckCue(1)}
              meterMotionPaused={faderInteractionActive}
            />
            <Deck
              number={2}
              track={tracks[deck2]??emptyDeckTrack}
              analysis={audioAnalyses[audioAnalysisKey(tracks[deck2])]}
              onRhythmCorrection={correction=>saveTrackRhythmCorrection(tracks[deck2],correction)}
              playing={playingDecks[2]}
              active={crossfade>=50}
              side="two"
              level={deckMeterCeilings.deck2}
              progress={deckProgress[2]}
              onSeek={seconds=>seekDeck(2,seconds)}
              onPrevious={()=>loadAdjacentDeckTrack(2,-1)}
              onReplay={()=>replayDeck(2)}
              onNext={()=>loadAdjacentDeckTrack(2,1)}
              playbackMode={deckPlaybackModes[2]}
              onPlaybackModeChange={mode=>{void takeDeckOperatorControl(2,{rollbackAutoTarget:false});setDeckPlaybackModes(current=>({...current,2:mode}))}}
              automationOwner={deckAutomationOwners[2]}
              lyricsEnabled={deckLyricsEnabled[2]}
              lyricsAvailable={deckLyricsLines[2].length>0}
              vocalMode={deckVocalModes[2]}
              accompanimentAvailable={Boolean(tracks[deck2]?.accompanimentPath)}
              aiRescueEnabled={deckAiRescueEnabled[2]}
              aiReferenceStatus={deckReferenceStatus[2]}
              onAiRescueToggle={()=>setDeckAiRescueEnabled(current=>({...current,2:!current[2]}))}
              onLyricsToggle={()=>setDeckLyricsEnabled(current=>({...current,2:!current[2]}))}
              onVocalToggle={()=>switchDeckVocalMode(2,deck2)}
              onPlay={()=>toggleDeckPlayback(2,deck2)}
              cueActive={deckCue.deck===2}
              cueAvailable={mpvEnabled&&mixerControlStatus.mode==="hardware-live"}
              cueBusy={deckCue.busy}
              cueMessage={deckCue.message}
              onCueToggle={()=>toggleDeckCue(2)}
              meterMotionPaused={faderInteractionActive}
            />
          </div>
          <div className="crossfader"><div className="crossfader-side crossfader-side-one"><span className="track-playing-badge deck-one-label" aria-hidden="true">1</span><span className="crossfader-percent">{100-crossfade}</span></div><div className="crossfader-control" style={{"--crossfade-position":`${crossfade}%`}}><div className="crossfader-scale" aria-hidden="true">{Array.from({length:17},(_,index)=><i key={index} className={index===8?"center":index%4===0?"major":""}/>)}</div><input aria-label="双曲交叉推子" type="range" min="0" max="100" value={crossfade} onChange={handleCrossfadeChange} {...faderPointerHandlers}/></div><div className="crossfader-side crossfader-side-two"><span className="crossfader-percent">{crossfade}</span><span className="track-playing-badge deck-two-label" aria-hidden="true">2</span></div></div>
          <div className="mixer-channel-strip" aria-label="总输出、耳机与麦克风音量控制">
            <label className="mixer-channel master-channel" title="总声音"><span><SpeakerHigh weight="fill"/><em>{masterVolume}</em></span><div className="mixer-fader-control"><div className="mixer-fader-scale" aria-hidden="true">{Array.from({length:17},(_,index)=><i key={index} className={index===8?"center":index%4===0?"major":""}/>)}</div><input style={{"--mixer-level":`${masterVolume}%`}} aria-label="总声音大小" type="range" min="0" max="100" value={masterVolume} onChange={handleMasterVolumeChange} {...faderPointerHandlers}/></div></label>
            <label className="mixer-channel headphone-channel" title={deckCue.deck?`Deck ${deckCue.deck} CUE 软件监听电平；最终响度再由 Qu-16 Phones 实体旋钮控制`:"先按 Deck 的圆形 CUE，再用这里调软件监听电平"}><span><Headphones weight="fill"/><em>{headphoneVolume}</em></span><div className="mixer-fader-control"><div className="mixer-fader-scale" aria-hidden="true">{Array.from({length:17},(_,index)=><i key={index} className={index===8?"center":index%4===0?"major":""}/>)}</div><input style={{"--mixer-level":`${headphoneVolume}%`}} aria-label="CUE 耳机监听音量" type="range" min="0" max="100" value={headphoneVolume} onChange={event=>setHeadphoneVolume(Number(event.target.value))} {...faderPointerHandlers}/></div></label>
            {[0,1].map(index=>{const binding=microphoneBindings[index];const readback=microphoneFaderReadback(mixerParameterSnapshot,binding);const volume=microphoneVolumes[index]??readback.value??0;const controlReady=mixerControlStatus.mode==="hardware-live"&&readback.available;const targets=binding?.targets?.map(target=>target.replace("ch-","CH")).join("+")||"未绑定";const title=!binding?`麦克风 ${index+1} 尚未绑定`:!controlReady?`${binding.label} · ${targets}；等待 Qu-16 真机同步后开放控制`:`${binding.label} · ${targets} 真机回读${readback.synchronized?"已同步":"不一致，等待实体台联动回读"}${readback.pending?" · 写入待确认":""}`;return <label className={`mixer-channel microphone-channel microphone-channel-${index+1}`} key={`microphone-${index}`} title={title}><span><Microphone weight="fill"/><em>{readback.available?volume:"--"}</em></span><div className="mixer-fader-control"><div className="mixer-fader-scale" aria-hidden="true">{Array.from({length:17},(_,tickIndex)=><i key={tickIndex} className={tickIndex===8?"center":tickIndex%4===0?"major":""}/>)}</div><input style={{"--mixer-level":`${volume}%`}} aria-label={`麦克风 ${index+1} 音量`} type="range" min="0" max="100" value={volume} disabled={!controlReady} onChange={event=>handleMicrophoneVolumeChange(index,event)} {...faderPointerHandlers}/></div></label>})}
          </div>
        </div>
      </section>

      <aside className="right-column">
        <section className={`panel video-panel ${activeMediaCategories.length?"has-categories":""}`}>
          <div className="panel-title compact"><VideoCamera weight="fill"/><div><b>视频快速选择</b><small>{activeMediaType.hint}</small></div>{mediaType==="video"&&<label className="rhythm-rule-control" title="按当前主导 Deck 的节拍自动预选到 PVW，不会直接上屏"><Lightning weight="fill"/><select aria-label="视频节拍预选规则" value={videoRhythmRule} onChange={(event)=>setVideoRhythmRule(event.target.value)}>{rhythmRuleOptions.map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label>}{mediaType==="video"&&<button type="button" className={`video-audio-toggle ${videoAudioEnabled?"enabled":"muted"}`} aria-pressed={videoAudioEnabled} onClick={()=>setVideoAudioEnabled((enabled)=>!enabled)} title={videoAudioEnabled?"关闭视频自身声音，仅保留画面":"开启视频自身声音"}>{videoAudioEnabled?<SpeakerHigh weight="fill"/>:<SpeakerSlash weight="fill"/>}<span>{videoAudioEnabled?"视频声音":"已静音"}</span></button>}</div>
          {mediaType==="video"&&<label className="video-sequence-control"><span>视频播放</span><select aria-label="视频播放模式" value={videoPlayback.mode} onChange={event=>updateVideoPlayback({...videoPlaybackRef.current,mode:event.target.value})}><option value="sequence">顺序自动播放 · 列表循环</option><option value="single">单段循环</option></select><small>{videoPlayback.queueIds.length?`${videoPlayback.queueIds.indexOf(videoPlayback.mediaId)+1} / ${videoPlayback.queueIds.length}`:"上屏后开始顺播"}</small></label>}
          <div className="media-type-switch" role="tablist" aria-label="大屏素材类型">{mediaTypes.map(type=><button key={type.id} type="button" role="tab" aria-selected={mediaType===type.id} className={mediaType===type.id?"active":""} onClick={()=>{setMediaType(type.id);setMediaCategory("全部");setHoverMedia(null)}}>{type.label}</button>)}</div>
          {activeMediaCategories.length>0&&<div className="media-category-switch" role="radiogroup" aria-label={`${activeMediaType.label}分类`}>{activeMediaCategories.map((category)=><button key={category} type="button" role="radio" aria-checked={mediaCategory===category} className={mediaCategory===category?"active":""} onClick={()=>setMediaCategory(category)}>{category}</button>)}</div>}
          <div className={mediaType==="image"?"video-grid image-grid":mediaType==="text"?"text-workspace":"video-grid"} onScroll={mediaType==="video"?handleVideoGridScroll:undefined}>
            {mediaType==="video"?(visibleVideos.length?<>
              {renderedVideos.map((item)=>{const candidate={...item,id:item.id,type:"video",name:item.name,src:item.src};const programActive=outputBaseMedia?.id===candidate.id;const previewSelected=stagedBaseMedia?.id===candidate.id;return <button key={item.id} type="button" className={`${programActive?"active program-active":""} ${previewSelected?"staged preview-selected":""}`} onClick={()=>stageMedia(candidate)} aria-current={programActive?"true":undefined} aria-pressed={previewSelected} aria-label={`预览视频 ${item.name}${programActive?"，当前上屏":""}${previewSelected?"，PVW 已选":""}`} title={`${item.name} · ${programActive?"PGM 当前上屏 · ":""}${previewSelected?"PVW 已选":"点击后进入 PVW"}`}><MediaThumbnail item={item}/>{programActive&&<i><Play weight="fill"/></i>}</button>})}
              {renderedVideos.length<visibleVideos.length&&<button type="button" className="video-grid-load-more" onClick={extendVideoGrid} aria-label={`继续加载视频，剩余 ${visibleVideos.length-renderedVideos.length} 个`}><b>加载更多</b><small>{renderedVideos.length} / {visibleVideos.length}</small></button>}
            </>:<div className="media-empty"><b>该分类暂无视频</b><small>将 MP4 放入本地视频目录后自动出现。</small></div>)
            :mediaType==="image"?visibleImages.map((item)=>{const candidate={id:item.id,type:"image",name:item.name,src:item.src};return <button key={item.id} type="button" className={`${outputBaseMedia?.id===candidate.id?"active":""} ${stagedBaseMedia?.id===candidate.id?"staged":""} ${item.locked?"black-screen-tile":""}`} onMouseEnter={()=>setHoverMedia(candidate)} onMouseLeave={()=>setHoverMedia(null)} onFocus={()=>setHoverMedia(candidate)} onBlur={()=>setHoverMedia(null)} onClick={()=>stageMedia(candidate)} aria-label={item.locked?"预览固定黑屏，不可删除":`预览图片 ${item.name}`} title={item.locked?"固定黑屏 · 不可移动 · 不可删除":item.name}>{item.src?<img src={item.src} alt=""/>:<strong>黑屏</strong>}{item.locked&&<em>固定</em>}</button>})
            :<><section className="text-template-section"><header><b>预设模板</b><small>选择后在 PVW 画面编辑</small></header><div className="text-template-row">{textPrograms.map((item)=>{const candidate={...item,type:"text"};return <button key={item.id} type="button" className={`${stagedMedia?.id===candidate.id?"staged":""}`} onClick={()=>stageMedia(candidate)} aria-label={`选择${item.name}模板`}><TextProgramThumbnail program={item}/></button>})}</div></section><section className="text-draft-section"><header><b>暂存</b><small>4 个可视暂存位</small></header><div className="text-draft-row">{textDrafts.map((draft,index)=><div className={`text-draft-slot ${draft?"filled":"empty"}`} key={index}><button type="button" className="text-draft-main" onClick={()=>openTextDraft(index)} onContextMenu={(event)=>{event.preventDefault();if(draft)setTextDraftClearSlot(index)}} aria-label={draft?`暂存 ${index+1}，点击调取；右键清空`:`暂存 ${index+1}，点击新建图文`}>{draft?<TextProgramThumbnail program={draft} slot={index+1}/>:<span className="empty-draft-preview"><b>{index+1}</b><small>新建</small></span>}</button></div>)}</div></section></>}
          </div>
          {mediaType==="video"&&videoAssets.length===0&&<small className="image-library-hint">{mediaLibraryDirectories.videoDirectory?`将 MP4 放入：${mediaLibraryDirectories.videoDirectory}`:"桌面版启动后自动建立视频目录"}</small>}
          {mediaType==="image"&&imageAssets.length===0&&<small className="image-library-hint">{imageLibraryDirectory?`将图片放入：${imageLibraryDirectory}`:"桌面版启动后自动扫描图片目录"}</small>}
        </section>
        <section ref={lightPanelRef} className={`panel light-panel ${lightingEnabled ? "lighting-on" : "lighting-off"}`}>
          <div className="panel-title compact"><LightbulbFilament weight="fill"/><div className="titan-panel-identity"><b>{titanStatus.connected?titanStatus.deviceName:"Avolites Titan"}</b><small className={titanStatus.connected?"titan-live":"titan-offline"}>{titanStatus.connected?`Titan ${titanStatus.softwareVersion} · ${titanStatus.showName} · ${titanPlaybacks.length} Cue/Playback`:titanStatus.message||"离线模拟 · 不发送现场灯光命令"}</small></div><label className="rhythm-rule-control lighting-rhythm-rule" title="自动模式只跟随当前实际占主导声音的 Deck"><Lightning weight="fill"/><select aria-label="灯光节拍联动规则" value={lightRhythmRule} onChange={(event)=>setLightRhythmRule(event.target.value)}>{rhythmRuleOptions.map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label><button type="button" className="lighting-power-toggle beam-show-arm" aria-pressed={beamShowArmed} title={beamShowArmed?"停止后续点缀；当前六拍短秀完成后自动收光，重启仍默认不布防":"确认现场安全后，允许强段约每分钟穿插一次南区到北区六拍点缀"} onClick={()=>setBeamShowArmed((armed)=>!armed)}><span className="live-dot"/>{beamShowArmed?"光束点缀已布防":"光束点缀未布防"}</button><button type="button" className="lighting-power-toggle" aria-pressed={lightingEnabled} title={lightingEnabled ? "暂停 KING 灯光联动；不会修改 Titan Show" : "恢复 KING 灯光联动"} onClick={()=>setLightingEnabled((enabled)=>!enabled)}><span className="live-dot"/>{lightingEnabled ? "灯光联动" : "联动暂停"}</button></div>
          <div className="light-grid">{lights.map((lightPreset)=>{const titanId=Number(titanMappings[lightPreset.id]);const mappedPlayback=titanPlaybacks.find((playback)=>playback.titanId===titanId);const registeredEffect=titanEffectRegistry.find((effect)=>Number(effect.presetId)===lightPreset.id);const configured=Boolean(lightPreset.label||mappedPlayback||registeredEffect);const displayName=lightPreset.id===0?lightPreset.label:registeredEffect?.kingName||lightPreset.label||mappedPlayback?.legend||`Titan 效果 ${lightPreset.id}`;const isActive=effectiveLight===lightPreset.id;const simulatedActive=!titanStatus.connected&&isTitanPresetSimulated(titanSimulation,lightPreset.id);const mode=lightPlaybackModes[lightPreset.id]??"once";return <div className={`light-preset ${configured?"configured":"empty"} ${isActive?"active":""} ${mappedPlayback?.active?"titan-active":""} ${simulatedActive?"titan-simulated":""} ${light===null&&isActive?"rhythm-active":""}`} key={lightPreset.id}><button type="button" className="light-preset-main" disabled={!configured} onClick={()=>{if(lightPreset.id===0){setAutoLightPreset(0);setLight(null);}else{setLight(lightPreset.id);triggerTitanPlayback(lightPreset.id,"manual");}}} aria-label={lightPreset.id===0?"启用暗红加特林视频色彩与音乐节拍联动":configured?`触发 ${displayName}`:`${lightPreset.id} 号灯光预设未配置`} title={lightPreset.id===0?"暗红 10% 常规底色；颜色跟随主视频，速度和亮度轻微跟随主导 Deck":mappedPlayback?`${displayName} · TitanId ${mappedPlayback.titanId}`:displayName}><span className="light-number">{lightPreset.id}</span>{configured&&<span className="light-name">{displayName}</span>}{configured&&<span className="light-duration">{lightPreset.id===0&&light===null?"AUTO LIVE":mappedPlayback?.active?"TITAN LIVE":simulatedActive?"SIMULATION":lightPreset.duration||"已绑定"}</span>}</button>{configured&&lightPreset.id!==0&&<button type="button" className="light-mode-toggle" onClick={()=>setLightPlaybackModes((current)=>({...current,[lightPreset.id]:mode==="loop"?"once":"loop"}))} aria-label={`${displayName}${mode==="loop"?"循环播放":"单次播放"}`} title={mode==="loop"?"循环播放：点击改为单次":"单次播放：点击改为循环"}>{mode==="loop"?<ArrowsClockwise weight="bold"/>:<span className="light-once">1</span>}</button>}</div>})}</div>
          <div className="quick-actions">
            <button type="button" className={light===null?"auto active":"auto"} aria-pressed={light===null} onClick={()=>{setAutoLightPreset(0);setLight(null);}} title="暗红加特林：主视频定颜色，主导 Deck 定速度和节拍起伏">自动</button>
            {fixtureControls.map((fixture)=>{const color=fixtureColors[fixture.id];const colorValue=`rgb(${color.r}, ${color.g}, ${color.b})`;return <button type="button" key={fixture.id} className="fixture-control" style={{"--fixture-color":colorValue,"--fixture-text":isLightColor(color)?"#07100e":"#ffffff"}} onDoubleClick={(event)=>openFixtureColorPicker(fixture.id,event)} title="双击打开 RGB 调色板"><span className="fixture-color-dot"/>{fixture.label}</button>})}
          </div>
          {fixtureColorEditor&&(()=>{const color=fixtureColors[fixtureColorEditor.id];const hsv=rgbToHsv(color);const hue=fixtureColorEditor.hue;return <div className="fixture-color-editor" style={{left:fixtureColorEditor.left}} role="dialog" aria-label="RGB 调色板"><div className="fixture-color-editor-head"><b>{fixtureControls.find((fixture)=>fixture.id===fixtureColorEditor.id)?.label} 调色板</b><button type="button" onClick={()=>setFixtureColorEditor(null)}>关闭</button></div><div className="fixture-picker-body" style={{display:"grid",gridTemplateColumns:"minmax(0, 1fr) 18px 64px",gap:"8px",alignItems:"stretch",justifyItems:"stretch"}}><div className="fixture-sv-field" style={{width:"100%",height:"155px",background:`linear-gradient(to bottom, transparent, #000), linear-gradient(to right, #fff, hsl(${hue}, 100%, 50%))`}} onPointerDown={updatePickerSV} onPointerMove={(event)=>event.buttons&&updatePickerSV(event)}><i className="fixture-sv-cursor" style={{left:`calc(${hsv.s*100}% - 6px)`,top:`calc(${(1-hsv.v)*100}% - 6px)`}}/></div><div className="fixture-hue-field" style={{width:"18px",height:"155px",background:"linear-gradient(to bottom, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)"}} onPointerDown={updatePickerHue} onPointerMove={(event)=>event.buttons&&updatePickerHue(event)}><i className="fixture-hue-cursor" style={{top:`calc(${hue/3.6}% - 4px)`}}/></div><div className="fixture-picker-preview" style={{width:"64px",height:"155px",backgroundColor:`rgb(${color.r}, ${color.g}, ${color.b})`,color:isLightColor(color)?"#07100e":"#ffffff",textShadow:isLightColor(color)?"none":"0 1px 1px #000"}}><span>R {color.r}</span><span>G {color.g}</span><span>B {color.b}</span></div></div></div>})()}
        </section>
      </aside>
      <MixerWorkspace model={activeMixerModel} meterStatus={mixerMeterStatus} parameterSnapshot={mixerParameterSnapshot} controlStatus={mixerControlStatus} onWriteParameters={writeQu16Parameters} outputRestoreStatus={qu16OutputRestore} onRestoreOutputBaseline={restoreQu16OutputBaseline}/>
      </>}
    </main>

    <nav className="bottom-nav" aria-label="主导航">{nav.map(([label,Icon])=><button key={label} className={activeNav===label?"active":""} onClick={()=>setActiveNav(label)}><Icon weight={activeNav===label?"fill":"regular"}/><span>{label}</span></button>)}</nav>
  </div>;
}
