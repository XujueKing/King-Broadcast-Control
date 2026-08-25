const laneIds=["mic1","mic2","mic3"];

export function createOfflineRoutingStatus(message="尚未执行通道发现"){
  return {
    saved:false,
    savedPath:null,
    report:null,
    stage:"not_discovered",
    hardwareReady:false,
    message,
    lanes:[],
  };
}

const safeIndex=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;

export function normalizeRoutingResponse(response,fallback=createOfflineRoutingStatus()){
  const envelope=response&&typeof response==="object"?response:{};
  const report=envelope.report&&typeof envelope.report==="object"?envelope.report:(envelope.routingMap?envelope:null);
  if(!report)return {...fallback,saved:envelope.saved===true,savedPath:typeof envelope.savedPath==="string"?envelope.savedPath:fallback.savedPath,message:String(envelope.message||fallback.message)};
  const map=report.routingMap&&typeof report.routingMap==="object"?report.routingMap:{};
  const received=new Map(Array.isArray(map.lanes)?map.lanes.filter(lane=>laneIds.includes(lane?.lane)).map(lane=>[lane.lane,lane]):[]);
  const lanes=laneIds.map((laneId,index)=>{
    const lane=received.get(laneId)??{};
    return {
      lane:laneId,
      quInputChannel:safeIndex(lane.quInputChannel)??index+1,
      inputDriverIndex:safeIndex(lane.inputDriverIndex),
      inputChannelName:String(lane.inputChannelName||"未发现"),
      returnDriverIndex:safeIndex(lane.returnDriverIndex),
      returnChannelName:String(lane.returnChannelName||"未发现"),
      evidence:lane.evidence==="onsite_signal_trace"?"onsite_signal_trace":"virtual_signal_trace",
    };
  });
  const hardwareReady=report.hardwareReady===true&&map.physicalHardware===true&&map.qu16MappingVerified===true&&lanes.every(lane=>lane.evidence==="onsite_signal_trace");
  const saved=envelope.saved===true;
  return {
    saved,
    savedPath:typeof envelope.savedPath==="string"?envelope.savedPath:null,
    report,
    stage:hardwareReady?"onsite_verified":saved?"virtual_saved":"virtual_discovered",
    hardwareReady,
    message:String(envelope.message||(hardwareReady?"Qu-16 三路现场映射已确认":saved?"离线映射已保存；等待现场逐路确认":"离线演练完成；尚未写入配置")),
    driverName:String(report.inventory?.driverName||map.driverName||"未知驱动"),
    sampleRate:safeIndex(report.inventory?.sampleRate||map.sampleRate),
    ambiguityCount:safeIndex(report.ambiguityCount)??0,
    lanes,
  };
}

export function routingStageLabel(stage){
  return ({
    not_discovered:"等待发现",
    virtual_discovered:"离线演练完成",
    virtual_saved:"离线映射已保存",
    onsite_verified:"现场映射已确认",
  })[stage]??"状态未知";
}
