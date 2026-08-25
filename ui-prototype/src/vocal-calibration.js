const laneIds=["mic1","mic2","mic3"];
const acceptedStates=new Set(["idle","countdown","tracing_input","tracing_return","lane_complete","complete","cancelled"]);

export function createCalibrationStatus(message="向导尚未运行"){
  return {mode:"idle",finalState:"idle",completedLanes:0,rejectedObservations:0,events:[],lanes:laneIds.map(lane=>({lane,state:"pending"})),jointEvidence:false,allLanesSynchronized:false,maximumSkewFrames:null,allowedSkewFrames:null,message};
}

export function normalizeCalibrationReport(response,fallback=createCalibrationStatus()){
  if(!response||typeof response!=="object")return fallback;
  const joint=response.mode==="joint_recorded_evidence_replay"?response:null;
  const report=joint?.calibration??response;
  if(report.mode!=="virtual_calibration_wizard")return fallback;
  const events=Array.isArray(report.events)?report.events.map((event,index)=>({
    sequence:Number.isSafeInteger(Number(event.sequence))?Number(event.sequence):index+1,
    state:acceptedStates.has(event.state)?event.state:"idle",
    lane:laneIds.includes(event.lane)?event.lane:null,
    accepted:event.accepted===true,
    rejection:typeof event.rejection==="string"?event.rejection:null,
    message:String(event.message||""),
  })):[];
  const completed=Math.max(0,Math.min(3,Number(report.completedLanes)||0));
  return {
    mode:joint?"joint_recorded_evidence_replay":"virtual_calibration_wizard",
    finalState:acceptedStates.has(report.finalState)?report.finalState:"idle",
    completedLanes:completed,
    rejectedObservations:Math.max(0,Number(report.rejectedObservations)||0),
    events,
    lanes:laneIds.map((lane,index)=>({lane,state:index<completed?"complete":index===completed&&report.finalState!=="complete"?report.finalState:"pending"})),
    jointEvidence:Boolean(joint),
    allLanesSynchronized:joint?.allLanesSynchronized===true,
    maximumSkewFrames:Number.isSafeInteger(Number(joint?.maximumObservedSkewFrames))?Number(joint.maximumObservedSkewFrames):null,
    allowedSkewFrames:Number.isSafeInteger(Number(joint?.maximumAllowedSkewFrames))?Number(joint.maximumAllowedSkewFrames):null,
    message:report.finalState==="complete"?(joint?.allLanesSynchronized===true?"USB 输入与 Qu-16 返回双证据已同步；等待现场复验":"三路向导演练完成；等待 Qu-16 现场复验"):"向导未完成",
  };
}
