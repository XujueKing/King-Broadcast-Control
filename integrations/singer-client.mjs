// Dependency-free client for the later native tablet project. Browser fetch is
// intentionally not enabled across origins by the desktop gateway.
export class SingerClient {
  constructor({baseUrl,token,fetchImpl=globalThis.fetch}) {
    this.baseUrl=baseUrl.replace(/\/$/,"");this.token=token;this.fetch=fetchImpl;this.pending=false;
  }
  async request(path,{method="GET",body}={}) {
    const response=await this.fetch(`${this.baseUrl}/api/singer/v1${path}`,{
      method,headers:{Authorization:`Bearer ${this.token}`,...(body?{"Content-Type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(4000),cache:"no-store",
    });
    const value=await response.json();
    if(!response.ok)throw Object.assign(new Error(value.error??`http_${response.status}`),{status:response.status});
    return value;
  }
  state(){return this.request("/state")}
  songs(q="",offset=0,limit=50){return this.request(`/songs?${new URLSearchParams({q,offset,limit})}`)}
  lyrics(songId){return this.request(`/songs/${encodeURIComponent(songId)}/lyrics`)}
  receipt(id){return this.request(`/commands/${encodeURIComponent(id)}`)}
  async perform(operation){
    if(this.pending)throw new Error("client_busy");
    this.pending=true;
    const id=globalThis.crypto.randomUUID();
    try{
      const state=await this.state();
      if(!state.controllerOnline)throw new Error("controller_offline");
      if(state.busy)throw new Error("controller_busy");
      const command={id,sessionId:state.sessionId,expectedRevision:state.revision,issuedAtUnixMs:state.serverTimeUnixMs,operation};
      let receipt=await this.request("/commands",{method:"POST",body:command});
      const deadline=Date.now()+12000;
      while(["queued","executing"].includes(receipt.status)&&Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,150));receipt=await this.receipt(id);
      }
      if(receipt.status!=="succeeded")throw new Error(receipt.error??`command_${receipt.status}`);
      return receipt;
    }catch(error){
      // Keep this ID for receipt lookup after any transport uncertainty. Never
      // automatically issue a replacement command with a new ID.
      error.commandId=id;throw error;
    }finally{this.pending=false}
  }
  selectSong(songId){return this.perform({type:"select",songId})}
  nextSong(songId){return this.perform({type:"next",songId})}
  play(){return this.perform({type:"play"})}
  pause(){return this.perform({type:"pause"})}
  restart(){return this.perform({type:"restart"})}
  setVocalMode(mode){return this.perform({type:"vocal_mode",mode})}
}
