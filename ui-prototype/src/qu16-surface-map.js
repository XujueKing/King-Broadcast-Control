import qu16Model from "./mixer-models/allen-heath-qu16/model.json" with { type:"json" };

const lowerSurfaceSources=Array.from({length:16},(_,index)=>({
  id:`ch-${index+1}`,
  label:`CH${index+1}`,
  detail:"Input",
  entityKind:"input",
}));

const upperSurfaceSources=[
  ["st-1","ST1","Stereo","input"],
  ["st-2","ST2","Stereo","input"],
  ["st-3","ST3","Stereo","input"],
  ["fx-1-ret","FX1 Ret","Return","input"],
  ["fx-2-ret","FX2 Ret","Return","input"],
  ["fx-3-ret","FX3 Ret","Return","input"],
  ["fx-4-ret","FX4 Ret","Return","input"],
  ["fx-1-send","FX1 Send","Master","master","FX 1"],
  ["fx-2-send","FX2 Send","Master","master","FX 2"],
  ["mix-1-master","Mix1","Master","master","Mix 1"],
  ["mix-2-master","Mix2","Master","master","Mix 2"],
  ["mix-3-master","Mix3","Master","master","Mix 3"],
  ["mix-4-master","Mix4","Master","master","Mix 4"],
  ["mix-5-6-master","Mix5-6","Master","master","Mix 5-6"],
  ["mix-7-8-master","Mix7-8","Master","master","Mix 7-8"],
  ["mix-9-10-master","Mix9-10","Master","master","Mix 9-10"],
].map(([id,label,detail,entityKind,masterTarget])=>({id,label,detail,entityKind,masterTarget}));

const sourceById=new Map([...lowerSurfaceSources,...upperSurfaceSources].map(source=>[source.id,source]));
const configuredCustomSlots=qu16Model.ui?.customLayerProfile?.slots;
if(!Array.isArray(configuredCustomSlots)||configuredCustomSlots.length!==16){
  throw new Error("Qu-16 custom layer profile must define exactly 16 slots");
}
const customSurfaceSources=configuredCustomSlots.map((sourceId,index)=>{
  const source=sourceById.get(sourceId);
  if(!source)throw new Error(`Unknown Qu-16 custom layer source at slot ${index+1}: ${sourceId}`);
  return Object.freeze({...source,detail:"Custom"});
});

export const qu16SurfaceLayerDefinitions=Object.freeze({
  lower:Object.freeze(lowerSurfaceSources),
  upper:Object.freeze(upperSurfaceSources),
  custom:Object.freeze(customSurfaceSources),
});

export const qu16SurfaceInputSources=Object.freeze(Array.from(new Map(
  Object.values(qu16SurfaceLayerDefinitions)
    .flat()
    .filter(source=>source.entityKind==="input")
    .map(source=>[source.id,source]),
).values()));

export function qu16SurfaceSourceAt(layer,physicalSlot){
  if(!Object.hasOwn(qu16SurfaceLayerDefinitions,layer))throw new RangeError(`Unknown Qu-16 layer: ${layer}`);
  if(!Number.isInteger(physicalSlot)||physicalSlot<1||physicalSlot>16)throw new RangeError("Qu-16 physical slot must be between 1 and 16");
  return qu16SurfaceLayerDefinitions[layer][physicalSlot-1];
}
