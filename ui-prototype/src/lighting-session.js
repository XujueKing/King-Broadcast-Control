// A stopped/replaced session cannot publish queued commands or stale success messages.
export function createLightingSession(now=Date.now()) {
  let generation=now*1000;
  let key=null;
  let enabled=false;
  return {
    update(nextKey,nextEnabled) {
      if(key!==nextKey||enabled!==nextEnabled){key=nextKey;enabled=nextEnabled;generation+=1;}
      return generation;
    },
    capture:()=>generation,
    isCurrent:(value,allowDisabled=false)=>value===generation&&(allowDisabled||enabled),
  };
}

export function rhythmPulsePayload({host,expectedShowName,dimmerPercent,speedValue,baseDimmerPercent,generation}) {
  return {host,expectedShowName,peakDimmerPercent:dimmerPercent,baseDimmerPercent,speedValue,pulseMillis:70,generation};
}

export function createVideoColorTracker() {
  let family=null, stable=0, applied=null, pending=null, serial=0;
  return {
    reset(){family=null;stable=0;applied=null;pending=null;serial+=1;},
    sample(next){
      stable=family===next?stable+1:1;family=next;
      if(applied===next||pending?.family===next||stable<(applied===null?1:2))return null;
      pending={family:next,id:++serial};return pending;
    },
    complete(ticket,success){
      if(ticket!==pending)return false;
      pending=null;
      if(success&&family===ticket.family){applied=ticket.family;return true;}
      return false;
    },
  };
}
