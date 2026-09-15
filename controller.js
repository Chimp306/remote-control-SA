const SUPABASE_URL="https://hqciviafxtfescteyvnn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY="sb_publishable_bvCxSUvRCzVTnpZfiHYshg_DTuRilpp";
const statusEl=document.querySelector("#status"),edgeCountEl=document.querySelector("#edge-count"),commandButtons=[...document.querySelectorAll("[data-command]")],holdButtons=[...document.querySelectorAll(".control.hold")];
const invitationCode=location.hash.slice(1).toUpperCase();
const shortInvitation=/^[2-9A-HJ-NP-Z]{4}$/.test(invitationCode);
const storageKey="lushcon-invitation:"+invitationCode;
let guestToken=shortInvitation?readStoredToken():invitationCode;
function readStoredToken(){try{return localStorage.getItem(storageKey)||""}catch{return ""}}
function saveToken(token){guestToken=token;try{if(token)localStorage.setItem(storageKey,token);else localStorage.removeItem(storageKey)}catch{}}
let pairingSecret=null,pairingBusy=false;
const pairingEl=document.querySelector("#pairing"),pairingMessage=document.querySelector("#pairing-message"),requestAccess=document.querySelector("#request-access");
async function pairingCall(action){
  const response=await fetch(SUPABASE_URL+"/functions/v1/guest-access",{method:"POST",headers:{"Content-Type":"application/json",apikey:SUPABASE_PUBLISHABLE_KEY},body:JSON.stringify({action,code:invitationCode,secret:pairingSecret}),signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw new Error("Pairing unavailable");return response.json();
}
function showPairing(){
  pairingEl.hidden=false;unavailable("One-time browser approval needed");
  pairingMessage.textContent="Request access, then share the check number with your host in your private conversation. No account needed.";
}
async function pollPairing(action="pair-poll"){
  if(pairingBusy||!pairingSecret)return;pairingBusy=true;
  try{
    const result=await pairingCall(action);
    if(result.state==="approved"){
      saveToken(result.token);pairingSecret=null;pairingEl.hidden=true;requestAccess.disabled=false;await recoverGuestSession();
    }else if(result.state==="pending"){
      status("Waiting for your host to approve this browser…");
      pairingMessage.textContent="Your check number: "+result.checkNumber+". Share it with your host so they can approve the right request.";
    }else{
      pairingSecret=null;requestAccess.disabled=false;
      pairingMessage.textContent=result.state==="busy"?"The approval queue is full. Ask your host, then try again later.":"Request "+result.state+". Check your code with the host and try again.";
    }
  }catch{pairingMessage.textContent="Connection unavailable. Waiting to reconnect…"}finally{pairingBusy=false}
}
requestAccess.addEventListener("click",()=>{
  pairingSecret=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll("+","-").replaceAll("/","_");
  requestAccess.disabled=true;pollPairing("pair-request");
});
setInterval(()=>{if(document.visibilityState==="visible")pollPairing()},2500);
let session,edgeKeyText,edgeVerificationKey,edgeCount=0,client,channel,guestReady=false,guestRecoveryTimer,guestRecoveryPromise;
let resolving,lastStateAt=0,lastSequence=0,hostState,challenge,holding,holdTimer,progressUntil=0,pendingId;
const released=new Set();
function status(text,colour="#ffca65"){statusEl.textContent=text;statusEl.style.color=colour}
function fromBase64Url(text){const binary=atob(text.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(text.length/4)*4,"="));return Uint8Array.from(binary,c=>c.charCodeAt(0))}
async function receiveEdgeCount(payload){
  const count=payload?.count,currentSession=session,key=edgeVerificationKey;
  if(!key||!Number.isSafeInteger(count)||count<edgeCount||typeof payload?.signature!=="string")return;
  try{
    const valid=await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,fromBase64Url(payload.signature),new TextEncoder().encode("edge-count:"+currentSession+":"+count));
    if(!valid||currentSession!==session||count<edgeCount)return;
    edgeCount=count;edgeCountEl.textContent="EDGE used: "+count+(count===1?" time":" times");
  }catch{}
}
function guestChannelSubscribed(){return guestReady&&channel?.state==="joined"&&(typeof client?.realtime?.isConnected!=="function"||client.realtime.isConnected())}
function guestChannelConnecting(){return channel?.state==="joining"}
function setControls(enabled){commandButtons.forEach(button=>button.disabled=!enabled)}
function clearActive(){commandButtons.forEach(b=>{b.classList.remove("active");b.style.setProperty("--progress","0%")});progressUntil=0}
function unavailable(message="Connection unavailable — recovering…"){
  releaseHold();hostState=null;lastStateAt=0;challenge=null;setControls(false);clearActive();document.body.dataset.controlState="unavailable";status(message);
}
async function receiveHostState(payload){
  const key=edgeVerificationKey,currentSession=session,receivedAt=performance.now();
  if(!key||typeof payload?.message!=="string"||payload.message.length>2048||typeof payload.signature!=="string")return;
  try{
    const valid=await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,fromBase64Url(payload.signature),new TextEncoder().encode("host-state:"+currentSession+":"+payload.message));
    if(!valid||currentSession!==session)return;
    const next=JSON.parse(payload.message);
    if(!Number.isSafeInteger(next.seq)||next.seq<=lastSequence||typeof next.challenge!=="string")return;
    lastSequence=next.seq;lastStateAt=receivedAt;challenge=next.challenge;hostState=next;
    const blocked=next.state==="locked"||next.state==="unavailable";
    if(blocked)releaseHold();
    setControls(!blocked&&guestChannelSubscribed()&&document.visibilityState==="visible");clearActive();
    document.body.dataset.controlState=next.state==="locked"?"locked":next.state==="unavailable"?"unavailable":"ready";
    if(next.state==="locked"){status("Remote control paused — "+Math.ceil(next.pauseMs/1000)+"s");return}
    if(next.state==="unavailable"){status("Host connection unavailable — recovering…");return}
    if(next.state==="running"&&!released.has(next.id)){
      if(["random","max-hold"].includes(next.command)&&holding?.id!==next.id){status("Host is running a hold from another controller.");return}
      const button=commandButtons.find(b=>b.dataset.command===next.command);
      if(button)button.classList.add("active");
      progressUntil=performance.now()+(next.remaining||0);
      const label=button?.querySelector(".level")?.textContent||"vibration";
      status(["random","max-hold"].includes(next.command)?label+" active — release to stop":"Running — "+label,"#f0c98c");
    }else{status(next.state==="stopped"?"Stopped — ready":"Ready — choose a control","#7ee787")}
  }catch{}
}
async function send(command,id){
  if(!channel)throw new Error("No session");
  const result=await channel.send({type:"broadcast",event:"control-command",payload:{command,id,challenge}});
  if(result!=="ok")throw new Error("Command unavailable");
}
function releaseHold(){
  const id=holding?.id;
  holding=null;clearInterval(holdTimer);holdTimer=null;
  if(!id)return;
  released.add(id);clearActive();status("Released — stopping");
  send("hold-stop",id).catch(()=>{});
}
function scheduleGuestRecovery(){clearTimeout(guestRecoveryTimer);if(document.visibilityState==="visible")guestRecoveryTimer=setTimeout(recoverGuestSession,1500)}
async function subscribeGuestChannel(recovering=false){
  clearTimeout(guestRecoveryTimer);releaseHold();
  const previousChannel=channel;guestReady=false;channel=null;unavailable(recovering?"Restoring controller session…":"Waiting for your host…");
  if(previousChannel)try{await client.removeChannel(previousChannel)}catch{}
  if(!session)return;
  const currentSession=session;
  edgeVerificationKey=await crypto.subtle.importKey("raw",fromBase64Url(edgeKeyText),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  if(session!==currentSession)return;
  const activeChannel=client.channel("lushcon:"+session);channel=activeChannel;
  activeChannel
    .on("broadcast",{event:"edge-count"},payload=>{if(channel===activeChannel)receiveEdgeCount(payload?.payload)})
    .on("broadcast",{event:"host-state"},payload=>{if(channel===activeChannel)receiveHostState(payload?.payload)})
    .subscribe(async(state)=>{
      if(channel!==activeChannel)return;
      if(state==="SUBSCRIBED"){
        guestReady=true;
        await activeChannel.send({type:"broadcast",event:"edge-count-request",payload:{}});
      }else if(["CHANNEL_ERROR","TIMED_OUT","CLOSED"].includes(state)){
        guestReady=false;unavailable();scheduleGuestRecovery();
      }
    });
}
async function resolveSession(){
  if(!guestToken){if(shortInvitation&&!pairingSecret)showPairing();return}
  if(resolving)return resolving;
  resolving=(async()=>{
    const response=await fetch(SUPABASE_URL+"/functions/v1/guest-access",{method:"POST",headers:{"Content-Type":"application/json",apikey:SUPABASE_PUBLISHABLE_KEY},body:JSON.stringify({action:"resolve",token:guestToken}),signal:AbortSignal.timeout(6000)});
    if(!response.ok)throw new Error("Resolution unavailable");
    const result=await response.json();
    if(result.valid===false&&shortInvitation){saveToken("");showPairing()}
    if(!result.available){
      if(guestToken)unavailable("Control is currently unavailable. Your invitation will work when your host starts a session.");
      session=null;guestReady=false;const previous=channel;channel=null;if(previous)await client.removeChannel(previous);return;
    }
    if(!/^[a-f0-9]{48}$/.test(result.session)||typeof result.edgeKey!=="string")throw new Error("Invalid session");
    if(session!==result.session){
      releaseHold();session=result.session;edgeKeyText=result.edgeKey;edgeVerificationKey=null;edgeCount=0;lastSequence=0;released.clear();edgeCountEl.textContent="EDGE used: 0 times";
      await subscribeGuestChannel();
    }else if(!guestChannelSubscribed()&&!guestChannelConnecting())await subscribeGuestChannel(true);
  })().catch(()=>{unavailable();scheduleGuestRecovery()}).finally(()=>{resolving=null});
  return resolving;
}
async function recoverGuestSession(){
  if(document.visibilityState!=="visible")return;
  if(guestRecoveryPromise)return guestRecoveryPromise;
  guestRecoveryPromise=resolveSession().finally(()=>{guestRecoveryPromise=null});return guestRecoveryPromise;
}
if(!shortInvitation&&!/^[2-9A-HJ-NP-Z]{16}$/.test(guestToken))status("This private invitation is missing or invalid. Ask your host for a current link.");
else if(!window.supabase)status("The connection library did not load. Please reload.");
else{
  client=window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  recoverGuestSession();setInterval(()=>{if(document.visibilityState==="visible")resolveSession()},5000);
  commandButtons.filter(button=>!holdButtons.includes(button)).forEach(button=>button.addEventListener("click",async()=>{
    if(!guestChannelSubscribed()||!challenge)return;
    releaseHold();const id=crypto.randomUUID();pendingId=id;status("Waiting for host acknowledgement…");
    try{await send(button.dataset.command,id)}catch{unavailable()}
    setTimeout(()=>{if(pendingId===id&&hostState?.id!==id&&hostState?.state!=="locked")status("No running acknowledgement received — try again when ready.")},1600);
  }));
  function beginHold(button){
    if(holding||button.disabled||!guestChannelSubscribed()||!challenge)return;
    const id=crypto.randomUUID(),command=button.dataset.command;
    holding={id,command};
    status("Waiting for host acknowledgement…");
    send(command==="max-hold"?"max-hold-start":"hold-start",id).catch(()=>{if(holding?.id===id)unavailable()});
    holdTimer=setInterval(()=>{
      if(holding?.id!==id)return;
      if(!guestChannelSubscribed()||document.visibilityState!=="visible"||performance.now()-lastStateAt>1000){releaseHold();return}
      send("hold-heartbeat",id).catch(()=>{if(holding?.id===id)unavailable()});
    },250);
  }
  for(const button of holdButtons){
    let pointerId=null;
    button.addEventListener("pointerdown",event=>{
      if(!event.isPrimary||event.button!==0||holding)return;
      event.preventDefault();pointerId=event.pointerId;button.setPointerCapture(pointerId);beginHold(button);
    });
    for(const eventName of ["pointerup","pointercancel","lostpointercapture"]){button.addEventListener(eventName,event=>{if(event.pointerId===pointerId){pointerId=null;releaseHold()}})}
    button.addEventListener("contextmenu",event=>event.preventDefault());
    button.addEventListener("keydown",event=>{if([" ","Enter"].includes(event.key)){event.preventDefault();if(!event.repeat)beginHold(button)}});
    button.addEventListener("keyup",event=>{if([" ","Enter"].includes(event.key)){event.preventDefault();releaseHold()}});
    button.addEventListener("blur",releaseHold);
  }
  addEventListener("blur",releaseHold);
  addEventListener("pagehide",releaseHold);
  addEventListener("offline",()=>unavailable("Connection lost — control stopped"));
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")recoverGuestSession();else unavailable("Controller paused — return to reconnect")});
  addEventListener("pageshow",recoverGuestSession);addEventListener("online",recoverGuestSession);
  setInterval(()=>{
    if(lastStateAt&&performance.now()-lastStateAt>1800){unavailable("Host unavailable — waiting to reconnect…");return}
    if(progressUntil){const remaining=Math.max(0,progressUntil-performance.now());const active=document.querySelector("button.fixed.active");if(active)active.style.setProperty("--progress",((5000-remaining)/5000*100)+"%")}
  },100);
}
