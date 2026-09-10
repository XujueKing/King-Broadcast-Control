// Visual interpolation only: never changes the player or its clock.
export function createWaveformClock(){
  let sample=null,correction=0;
  const read=now=>{
    if(!sample)return 0;
    const age=Math.max(0,now-sample.at);
    const advance=sample.playing?Math.min(age,1000)/1000:0;
    return Math.min(sample.duration,Math.max(0,sample.seconds+advance+correction*Math.max(0,1-age/200)));
  };
  return {read,update({seconds,playing,duration,seeking=false},now){
    const previous=read(now),old=sample;
    sample={seconds:Math.max(0,Number(seconds)||0),playing:Boolean(playing&&!seeking),duration:Math.max(0,Number(duration)||0),at:now};
    correction=old&&old.playing&&sample.playing&&!seeking&&Math.abs(previous-sample.seconds)<1?previous-sample.seconds:0;
  }};
}
