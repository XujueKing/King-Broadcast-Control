import {qu16IntentToWrite,midiToUiValue} from './qu16-control.js';

export const defaultSingerAudioPolicy=Object.freeze({microphone:'',reverbBus:'',musicMax:100,microphoneMax:77,reverbMax:60});
export const singerMicrophones={'ch-1':'专业麦克风 1 · CH1','ch-2':'专业麦克风 2 · CH2','ch-6':'GS 麦克风 · CH6'};
export function singerAudioKey(policy,control){
  if(!Object.hasOwn(singerMicrophones,policy?.microphone))return null;
  if(control==='microphone')return `fader:${policy.microphone}`;
  if(control==='reverb'&&['FX 1','FX 2'].includes(policy.reverbBus))return `send:${policy.microphone}:${policy.reverbBus}`;
  return null;
}
export function singerAudioSnapshot({policy,musicVolume,musicReady,acappella,mixerLive,mixer}){
  const result={acappella,music:{available:Boolean(musicReady),value:Math.round(musicVolume),reason:musicReady?null:'player_unavailable'}};
  for(const control of ['microphone','reverb']){
    const key=singerAudioKey(policy,control),raw=mixer?.parameters?.[key];
    const reason=!key?'audio_unbound':!mixerLive||!mixer?.connected||!mixer?.synced?'mixer_unavailable':!Number.isInteger(raw)||raw<0||raw>127||mixer.pendingDetails?.[key]?'audio_readback_pending':null;
    result[control]={available:!reason,value:reason?null:midiToUiValue(raw),reason};
  }
  return result;
}
export function singerAudioWrite(policy,control,value){
  const key=singerAudioKey(policy,control);
  if(!key)throw new Error('audio_unbound');
  const write=qu16IntentToWrite(control==='microphone'?{kind:'fader',target:policy.microphone,value}:{kind:'send',target:policy.microphone,mix:policy.reverbBus,value});
  if(!write||write.key!==key)throw new Error('audio_unbound');
  return write;
}
export async function transitionSingerAcappella({enabled,current,volume,restore,max,write}){
  if(enabled===current)return {enabled:current,restore};
  const saved=enabled?volume:restore;
  await write(enabled?0:Math.min(max,saved??volume));
  return {enabled,restore:enabled?saved:null};
}
// All operations are checked again at execution, including after queue admission.
export async function executeSingerAudio(operation,context){
  const policy=context.policy(),audio=context.snapshot();
  if(operation.type==='acappella'){
    if(typeof operation.enabled!=='boolean')throw new Error('invalid_audio_value');
    if(!audio.music.available)throw new Error(audio.music.reason||'audio_unavailable');
    return context.setAcappella(operation.enabled,policy.musicMax);
  }
  const {control,value}=operation;
  if(!['music','microphone','reverb'].includes(control)||!Number.isInteger(value)||value<0||value>policy[`${control}Max`])throw new Error('invalid_audio_value');
  if(!audio[control]?.available)throw new Error(audio[control]?.reason||'audio_unavailable');
  if(control==='music'){
    if(audio.acappella)throw new Error('acappella_active');
    return context.setMusic(value);
  }
  return context.writeMixer(singerAudioWrite(policy,control,value));
}
