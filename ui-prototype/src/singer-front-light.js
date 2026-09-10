// Binding is installed only after the physical executor has been identified.
// Never infer it from the neighboring StaticPlayback fader number.
export function frontLightState(binding, status, sample, now=Date.now()) {
  if(!binding?.verified || !Number.isSafeInteger(binding.titanId) || binding.titanId<=0 || !binding.showName || !binding.deviceName || !binding.group || !Number.isInteger(binding.index))
    return {available:false,enabled:null,reason:'面光程序待绑定'};
  if(!status.connected || status.deviceName!==binding.deviceName || status.showName!==binding.showName || sample.host!==status.host || now-sample.at>4000)
    return {available:false,enabled:null,reason:'灯控台未连接或状态待同步'};
  const handle=sample.handles.find(h=>h.titanId===binding.titanId&&h.group===binding.group&&h.index===binding.index&&['cueHandle','chaseHandle','cueListHandle'].includes(h.handleType));
  if(!handle || typeof handle.active!=='boolean')return {available:false,enabled:null,reason:'面光程序已变化，请重新核对'};
  return {available:true,enabled:handle.active,reason:null};
}

export async function setFrontLight(enabled,{binding,status,read,fire,release,now=Date.now}) {
  if(typeof enabled!=='boolean')throw Error('invalid_front_light');
  if(!binding?.verified||!status.connected)throw Error('front_light_unavailable');
  const before=frontLightState(binding,status,await read(),now());
  if(!before.available)throw Error('front_light_unavailable');
  if(before.enabled===enabled)return;
  const args={host:status.host,titanId:binding.titanId,expectedShowName:binding.showName};
  if(enabled)await fire({...args,level:1,alwaysRefire:false});else await release(args);
  const after=frontLightState(binding,status,await read(),now());
  if(!after.available||after.enabled!==enabled)throw Error('front_light_readback_failed');
}
