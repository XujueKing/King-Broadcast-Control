export const vocalPresetOptions = [
  { value:"natural", label:"自然保留" },
  { value:"professional", label:"专业增强" },
  { value:"strong", label:"强力修音" },
  { value:"auto", label:"自动" },
];

export const vocalLaneLabels = Object.freeze({
  mic1:"Shure SLX4",
  mic2:"UHF Receiver A（待核对）",
  mic3:"UHF Receiver B（待核对）",
});

const laneIds = Object.keys(vocalLaneLabels);
const failoverStates = new Set(["inactive","processed","dry_fallback","recovering","input_unavailable"]);
const failoverReasons = new Set(["engine_timeout","invalid_processed_output","control_bridge_disconnect","input_unavailable"]);

const inactiveFailover = () => ({
  state:"inactive",
  reason:null,
  usingDryFallback:false,
  fresh:false,
  revision:0,
});

export function createOfflineVocalStatus(message="浏览器预览；未连接独立 Vocal Engine") {
  return {
    schemaVersion:1,
    engineState:"control_only_disarmed",
    calibrationMode:"disarmed",
    physicalAudioStarted:false,
    hardwareBound:false,
    failover:inactiveFailover(),
    lanes:laneIds.map(lane=>({
      lane,
      preset:"professional",
      inputPeakDbfs:null,
      qualityScore:null,
      correctedMix:null,
      fresh:false,
    })),
    message,
  };
}

const finiteOrNull = value => value!==null&&value!==undefined&&value!==""&&Number.isFinite(Number(value)) ? Number(value) : null;

export function normalizeVocalResponse(response, fallback=createOfflineVocalStatus()) {
  const status = response?.status ?? response;
  if (!status || typeof status !== "object") return fallback;
  const received = new Map(Array.isArray(status.lanes)
    ? status.lanes.filter(lane=>laneIds.includes(lane?.lane)).map(lane=>[lane.lane,lane])
    : []);
  const previous = new Map((fallback.lanes ?? []).map(lane=>[lane.lane,lane]));
  const failover=status.failover&&typeof status.failover==="object"?status.failover:{};
  const failoverState=failoverStates.has(failover.state)?failover.state:"inactive";
  const failoverReason=failoverReasons.has(failover.reason)?failover.reason:null;
  return {
    schemaVersion:Number(status.schemaVersion)||1,
    engineState:String(status.engineState||"control_only_disarmed"),
    calibrationMode:String(status.calibrationMode||"disarmed"),
    physicalAudioStarted:status.physicalAudioStarted===true,
    hardwareBound:status.hardwareBound===true,
    failover:{
      state:failoverState,
      reason:failoverReason,
      usingDryFallback:failover.usingDryFallback===true,
      fresh:failover.fresh===true,
      revision:Number.isSafeInteger(Number(failover.revision))?Number(failover.revision):0,
    },
    lanes:laneIds.map(laneId=>{
      const lane=received.get(laneId)??previous.get(laneId)??{};
      const preset=vocalPresetOptions.some(option=>option.value===lane.preset)?lane.preset:"professional";
      return {
        lane:laneId,
        preset,
        inputPeakDbfs:finiteOrNull(lane.inputPeakDbfs),
        qualityScore:finiteOrNull(lane.qualityScore),
        correctedMix:finiteOrNull(lane.correctedMix),
        fresh:lane.fresh===true,
      };
    }),
    message:String(status.message||fallback.message||"Vocal Engine 状态不可用"),
  };
}

export function describeVocalFailover(failover=inactiveFailover()) {
  const reasonLabels={
    engine_timeout:"处理引擎超时",
    invalid_processed_output:"处理结果异常",
    control_bridge_disconnect:"控制桥断开",
    input_unavailable:"麦克风输入断开",
  };
  if(failover.state==="processed") return {tone:"healthy",title:"处理声运行",message:"三路看门狗正常"};
  if(failover.state==="dry_fallback") return {tone:"warning",title:"正在使用干声回退",message:reasonLabels[failover.reason]??"处理链故障"};
  if(failover.state==="recovering") return {tone:"recovering",title:"正在恢复处理声",message:"20 ms 平滑淡回处理中"};
  if(failover.state==="input_unavailable") return {tone:"error",title:"麦克风输入不可用",message:reasonLabels[failover.reason]??"等待输入恢复"};
  return {tone:"inactive",title:"看门狗未启动",message:"未连接物理音频，当前没有实时状态"};
}

export function updatePreviewVocalPreset(status, laneId, preset) {
  if (!laneIds.includes(laneId) || !vocalPresetOptions.some(option=>option.value===preset)) return status;
  return {
    ...status,
    lanes:status.lanes.map(lane=>lane.lane===laneId?{...lane,preset}:lane),
  };
}

export function formatVocalMetric(value, { suffix="", scale=1, digits=0 }={}) {
  const number=finiteOrNull(value);
  return number===null?"--":`${(number*scale).toFixed(digits)}${suffix}`;
}
