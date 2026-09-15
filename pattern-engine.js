/* Host-owned levels, clock and cancellation. No guest-supplied intensity. */
(function(root){
  class PatternEngine {
    constructor({write,allowed=()=>true,onState=()=>{},now=()=>performance.now(),random=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296}){
      Object.assign(this,{write,allowed,onState,now,random});
      this.generation=0; this.timers=new Set(); this.active=null;
    }
    later(fn,ms){const timer=setTimeout(()=>{this.timers.delete(timer);fn()},ms);this.timers.add(timer);return timer}
    cancel(){this.generation++;for(const timer of this.timers) clearTimeout(timer);this.timers.clear();this.active=null;return this.generation}
    async stop(reason="stopped"){
      const generation=this.cancel();
      try{await this.write(0,()=>true)}catch(error){if(generation===this.generation)this.onState({state:"unavailable",reason:"Device stop failed"});throw error}
      if(generation===this.generation)this.onState({state:"stopped",reason});
    }
    async fixed(command,id){
      const peak={20:4,40:8,60:12,70:14}[command];
      if(!Number.isInteger(peak)||peak<1||peak>14||!this.allowed())return;
      const generation=this.cancel();
      const valid=()=>generation===this.generation&&this.allowed();
      await this.write(0,()=>generation===this.generation);
      if(!valid())return;
      const started=this.now();
      this.active={id,command};
      const advance=async()=>{
        if(!valid())return;
        const elapsed=this.now()-started;
        if(elapsed>=5000){await this.stop("finished");return}
        const level=elapsed<500?Math.round(peak*elapsed/500):elapsed<4500?peak:Math.round(peak*(5000-elapsed)/500);
        try{
          await this.write(Math.max(0,Math.min(peak,level)),valid);
          if(!valid())return;
          this.onState({state:"running",command,id,remaining:Math.max(0,5000-(this.now()-started))});
          this.later(advance,Math.min(100,Math.max(0,5000-(this.now()-started))));
        }catch(error){if(generation===this.generation)this.stop("Device write failed").catch(()=>{})}
      };
      this.later(()=>{if(generation===this.generation)this.stop("finished").catch(()=>{})},5000);
      await advance();
    }
    async hold(id,expires,command="random"){
      if(!this.allowed())return;
      if(!["random","max-hold"].includes(command))return;
      const generation=this.cancel();
      this.active={id,command,expires};
      const valid=()=>generation===this.generation&&this.allowed()&&this.active?.expires>this.now();
      const watchdog=()=>{
        if(generation!==this.generation)return;
        if(!valid()){this.stop("Hold released or connection lost").catch(()=>{});return}
        this.later(watchdog,100);
      };
      watchdog();
      await this.write(0,()=>generation===this.generation);
      if(command==="max-hold"){
        if(!valid())return;
        try{
          await this.write(14,valid);
          if(valid())this.onState({state:"running",command,id,remaining:0});
        }catch(error){if(generation===this.generation)this.stop("Device write failed").catch(()=>{})}
        return;
      }
      const advance=async()=>{
        if(!valid())return;
        try{
          // Uniform integer 0..14, dwell 200..900 ms, fresh host randomness.
          await this.write(Math.floor(this.random()*15),valid);
          if(!valid())return;
          this.onState({state:"running",command:"random",id,remaining:0});
          this.later(advance,200+Math.floor(this.random()*701));
        }catch(error){if(generation===this.generation)this.stop("Device write failed").catch(()=>{})}
      };
      await advance();
    }
    heartbeat(id,expires){if(["random","max-hold"].includes(this.active?.command)&&this.active.id===id&&this.active.expires>this.now())this.active.expires=Math.max(this.active.expires,expires)}
  }
  root.PatternEngine=PatternEngine;
  if(typeof module!=="undefined")module.exports=PatternEngine;
})(globalThis);
