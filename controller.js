const SUPABASE_URL="https://hqciviafxtfescteyvnn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY="sb_publishable_bvCxSUvRCzVTnpZfiHYshg_DTuRilpp";
const statusEl=document.querySelector("#status"),edgeCountEl=document.querySelector("#edge-count"),guestWelcomeEl=document.querySelector("#guest-welcome"),commandButtons=[...document.querySelectorAll("[data-command]")],holdButtons=[...document.querySelectorAll(".control.hold")];
const celebrationEl=document.querySelector("#edge-celebration"),celebrationEmojiEl=document.querySelector("#celebration-emoji"),celebrationMessageEl=document.querySelector("#celebration-message"),previewToolsEl=document.querySelector("#preview-tools");
const teasePanelEl=document.querySelector("#tease-panel"),teaseMessageEl=document.querySelector("#tease-message"),teaseTimerEl=document.querySelector("#tease-timer"),hapticStateEl=document.querySelector("#haptic-state");
const previewRequested=new URLSearchParams(location.search).get("preview")==="1";
function cleanGuestName(value){return typeof value==="string"?value.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f]/g,"").replace(/\s+/g," ").trim().slice(0,40):""}
function showGuestName(value){const name=cleanGuestName(value);guestWelcomeEl.textContent="WELCOME, "+(name||"GUEST").toLocaleUpperCase()}
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
let session,edgeKeyText,edgeVerificationKey,edgeCount=0,edgeCountBaselinePending=true,client,channel,guestReady=false,guestRecoveryTimer,guestRecoveryPromise;
let resolving,lastStateAt=0,lastSequence=0,hostState,challenge,holding,holdTimer,progressUntil=0,pendingId;
let teaseStage=1,teaseStartedAt=null,teaseHostClockOffset=0,lastTeaseSequence=0,teaseBaselinePending=true,hapticFlashTimer;
const released=new Set(),hapticAcknowledgements=new Set();
function status(text,colour="#ffca65"){statusEl.textContent=text;statusEl.style.color=colour}
function fromBase64Url(text){const binary=atob(text.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(text.length/4)*4,"="));return Uint8Array.from(binary,c=>c.charCodeAt(0))}
const firstEdgeCelebrations=[
  {message:"Edged me! ❤️",emoji:"❤️",weight:1},
  {message:"EDGED! ❤️",emoji:"❤️",weight:1}
];
const laterEdgeCelebrations=[
  {message:"Edged — nice work 😈",emoji:"😈",weight:1},
  {message:"You found my limit — edged 🔥",emoji:"🔥",weight:1},
  {message:"Edged me again! 😏",emoji:"😏",weight:1.35},
  {message:"Good girl — edged me! 😉",emoji:"😉",weight:1},
  {message:"Perfect. 😈",emoji:"😈",weight:1.35},
  {message:"Edged me! ❤️",emoji:"❤️",weight:1},
  {message:"EDGED! ❤️",emoji:"❤️",weight:1}
];
let lastCelebrationMessage="",celebrationTimer=null,celebrationSerial=0;
function chooseEdgeCelebration(count){
  const source=count===1?firstEdgeCelebrations:laterEdgeCelebrations;
  const options=source.filter(option=>option.message!==lastCelebrationMessage);
  const pool=options.length?options:source,total=pool.reduce((sum,option)=>sum+option.weight,0);
  let choice=Math.random()*total;
  for(const option of pool){choice-=option.weight;if(choice<0)return option}
  return pool.at(-1);
}
function hideEdgeCelebration(){clearTimeout(celebrationTimer);celebrationTimer=null;celebrationEl.classList.remove("show");celebrationEl.hidden=true}
function showEdgeCelebration(count){
  const choice=chooseEdgeCelebration(count);lastCelebrationMessage=choice.message;celebrationSerial+=1;
  clearTimeout(celebrationTimer);celebrationEmojiEl.textContent=choice.emoji;celebrationMessageEl.textContent=choice.message;
  celebrationEl.hidden=false;celebrationEl.classList.remove("show");void celebrationEl.offsetWidth;celebrationEl.classList.add("show");
  celebrationTimer=setTimeout(hideEdgeCelebration,1800);
}
const guestTeaseMessages={1:"He can take more. 😈",2:"You’re really getting to him… 😏",3:"He’s ready — your move. ❤️"};
function renderTeaseState(){
  teasePanelEl.dataset.stage=String(teaseStage);teaseMessageEl.textContent=guestTeaseMessages[teaseStage];
  if(teaseStartedAt===null){teaseTimerEl.textContent="Waiting for the first control…";return}
  const hostNow=Date.now()-teaseHostClockOffset,total=Math.max(0,Math.floor((hostNow-teaseStartedAt)/1000)),hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60),seconds=total%60;
  teaseTimerEl.textContent="Teasing for "+(hours?hours+":"+String(minutes).padStart(2,"0"):
    minutes)+":"+String(seconds).padStart(2,"0");
}
function resetGuestTeaseState(){
  teaseStage=1;teaseStartedAt=null;teaseHostClockOffset=0;lastTeaseSequence=0;teaseBaselinePending=true;hapticAcknowledgements.clear();renderTeaseState();
}
function showHapticVisual(kind){
  if(!previewRequested)return;
  clearTimeout(hapticFlashTimer);hapticStateEl.textContent=kind.toUpperCase()+" TAP";hapticStateEl.classList.add("flash");
  hapticFlashTimer=setTimeout(()=>{hapticStateEl.textContent="HAPTIC PREVIEW";hapticStateEl.classList.remove("flash")},650);
}
function guestHaptic(kind){
  showHapticVisual(kind);
  if(document.visibilityState!=="visible"||typeof navigator.vibrate!=="function")return;
  const pattern={fixed:12,hold:[18,28,18],edge:[28,22,42],tease:[14,28,14]}[kind];
  if(pattern!==undefined)try{navigator.vibrate(pattern)}catch{}
}
async function receiveTeaseState(payload){
  const key=edgeVerificationKey,currentSession=session;
  if(!key||typeof payload?.message!=="string"||payload.message.length>512||typeof payload.signature!=="string")return;
  try{
    const valid=await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,fromBase64Url(payload.signature),new TextEncoder().encode("tease-state:"+currentSession+":"+payload.message));
    if(!valid||currentSession!==session)return;
    const next=JSON.parse(payload.message);
    const validStart=next.startedAt===null||(Number.isSafeInteger(next.startedAt)&&next.startedAt>0);
    if(!Number.isSafeInteger(next.seq)||next.seq<=lastTeaseSequence||![1,2,3].includes(next.stage)||!validStart||!Number.isSafeInteger(next.sentAt)||next.sentAt<=0)return;
    const previousStage=teaseStage,restoring=teaseBaselinePending;
    lastTeaseSequence=next.seq;teaseStage=next.stage;teaseStartedAt=next.startedAt;teaseHostClockOffset=Date.now()-next.sentAt;teaseBaselinePending=false;renderTeaseState();
    if(!restoring&&next.stage!==previousStage)guestHaptic("tease");
  }catch{}
}
async function receiveEdgeCount(payload){
  const count=payload?.count,currentSession=session,key=edgeVerificationKey;
  if(!key||!Number.isSafeInteger(count)||count<edgeCount||typeof payload?.signature!=="string")return;
  try{
    const valid=await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,fromBase64Url(payload.signature),new TextEncoder().encode("edge-count:"+currentSession+":"+count));
    if(!valid||currentSession!==session||count<edgeCount)return;
    if(edgeCountBaselinePending){edgeCount=Math.max(edgeCount,count);edgeCountBaselinePending=false;edgeCountEl.textContent="EDGE used: "+edgeCount+(edgeCount===1?" time":" times");return}
    if(count<=edgeCount)return;
    edgeCount=count;edgeCountEl.textContent="EDGE used: "+count+(count===1?" time":" times");
    if(document.visibilityState==="visible"){guestHaptic("edge");showEdgeCelebration(count)}
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
      const ownCommand=pendingId===next.id||holding?.id===next.id;
      if(ownCommand&&!hapticAcknowledgements.has(next.id)){
        hapticAcknowledgements.add(next.id);guestHaptic(["random","max-hold"].includes(next.command)?"hold":"fixed");
      }
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
  edgeCountBaselinePending=true;teaseBaselinePending=true;
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
    .on("broadcast",{event:"tease-state"},payload=>{if(channel===activeChannel)receiveTeaseState(payload?.payload)})
    .subscribe(async(state)=>{
      if(channel!==activeChannel)return;
      if(state==="SUBSCRIBED"){
        guestReady=true;
        await Promise.all([
          activeChannel.send({type:"broadcast",event:"edge-count-request",payload:{}}),
          activeChannel.send({type:"broadcast",event:"tease-state-request",payload:{}})
        ]);
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
    if(result.valid)showGuestName(result.name);
    if(result.valid===false&&shortInvitation){saveToken("");showPairing()}
    if(!result.available){
      if(guestToken)unavailable("Control is currently unavailable. Your invitation will work when your host starts a session.");
      session=null;guestReady=false;resetGuestTeaseState();const previous=channel;channel=null;if(previous)await client.removeChannel(previous);return;
    }
    if(!/^[a-f0-9]{48}$/.test(result.session)||typeof result.edgeKey!=="string")throw new Error("Invalid session");
    if(session!==result.session){
      releaseHold();session=result.session;edgeKeyText=result.edgeKey;edgeVerificationKey=null;edgeCount=0;edgeCountBaselinePending=true;lastSequence=0;
      resetGuestTeaseState();released.clear();edgeCountEl.textContent="EDGE used: 0 times";
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
let previewTimer=null,previewStartedAt=0,previewFixedButton=null,previewHolding=null;
function stopPreview(message="Preview ready — controls are visual only"){
  clearInterval(previewTimer);previewTimer=null;previewStartedAt=0;previewFixedButton=null;previewHolding=null;clearActive();status(message,"#f0c98c");
}
function updatePreviewFixed(){
  if(!previewFixedButton)return;
  const elapsed=Math.max(0,performance.now()-previewStartedAt);
  previewFixedButton.style.setProperty("--progress",Math.min(100,elapsed/5000*100)+"%");
  if(elapsed>=5000)stopPreview();
}
function startPreviewFixed(button){
  stopPreview();previewFixedButton=button;previewStartedAt=performance.now();button.classList.add("active");
  guestHaptic("fixed");
  status("Previewing — "+button.querySelector(".level").textContent,"#f0c98c");
  previewTimer=setInterval(updatePreviewFixed,50);updatePreviewFixed();
}
function releasePreviewHold(){if(previewHolding)stopPreview("Released — preview stopped")}
function beginPreviewHold(button){
  stopPreview();previewHolding=button;button.classList.add("active");
  guestHaptic("hold");
  status(button.querySelector(".level").textContent+" active — release to stop","#f0c98c");
}
function enablePreviewInteractions(){
  document.querySelector("#preview-badge").hidden=false;previewToolsEl.hidden=false;hapticStateEl.hidden=false;document.body.dataset.controlState="ready";edgeCountEl.textContent="EDGE used: 0 times · preview";setControls(true);stopPreview();renderTeaseState();
  document.querySelectorAll("[data-preview-stage]").forEach(button=>button.addEventListener("click",()=>{teaseStage=Number(button.dataset.previewStage);renderTeaseState();guestHaptic("tease")}));
  document.querySelector("#preview-timer").addEventListener("click",()=>{teaseHostClockOffset=0;teaseStartedAt=Date.now()-1122000;renderTeaseState()});
  document.querySelector("#preview-haptic").addEventListener("click",()=>guestHaptic("tease"));
  document.querySelector("#preview-edge-first").addEventListener("click",()=>{guestHaptic("edge");showEdgeCelebration(1)});
  document.querySelector("#preview-edge-later").addEventListener("click",()=>{guestHaptic("edge");showEdgeCelebration(2)});
  commandButtons.filter(button=>!holdButtons.includes(button)).forEach(button=>button.addEventListener("click",()=>startPreviewFixed(button)));
  for(const button of holdButtons){
    let pointerId=null;
    button.addEventListener("pointerdown",event=>{
      if(!event.isPrimary||event.button!==0||previewHolding)return;
      event.preventDefault();pointerId=event.pointerId;button.setPointerCapture(pointerId);beginPreviewHold(button);
    });
    for(const eventName of ["pointerup","pointercancel","lostpointercapture"]){button.addEventListener(eventName,event=>{if(event.pointerId===pointerId){pointerId=null;releasePreviewHold()}})}
    button.addEventListener("contextmenu",event=>event.preventDefault());
    button.addEventListener("keydown",event=>{if([" ","Enter"].includes(event.key)){event.preventDefault();if(!event.repeat)beginPreviewHold(button)}});
    button.addEventListener("keyup",event=>{if([" ","Enter"].includes(event.key)){event.preventDefault();releasePreviewHold()}});
    button.addEventListener("blur",releasePreviewHold);
  }
  addEventListener("blur",releasePreviewHold);addEventListener("pagehide",()=>{hideEdgeCelebration();stopPreview("Preview paused")});
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState!=="visible"){hideEdgeCelebration();stopPreview("Preview paused — return to continue")}});
}
async function startPreview(){
  pairingEl.hidden=true;setControls(false);document.body.dataset.controlState="unavailable";status("Authorising host preview…");
  try{
    if(!window.supabase)throw new Error("The connection library did not load.");
    const previewClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:"lushcon-host-auth"}});
    const {data:{session:hostSession}}=await previewClient.auth.getSession();
    if(!hostSession)throw new Error("Sign in on the host page first.");
    const response=await fetch(SUPABASE_URL+"/functions/v1/guest-access",{method:"POST",headers:{"Content-Type":"application/json",apikey:SUPABASE_PUBLISHABLE_KEY,Authorization:"Bearer "+hostSession.access_token},body:JSON.stringify({action:"preview"}),signal:AbortSignal.timeout(6000)});
    if(!response.ok)throw new Error("This account is not authorised for host preview.");
    const result=await response.json();if(!result.ok)throw new Error("Host preview unavailable.");
    showGuestName(new URLSearchParams(location.search).get("name"));
    enablePreviewInteractions();
  }catch(error){setControls(false);status("Preview unavailable — "+error.message)}
}
if(previewRequested)startPreview();
else if(!shortInvitation&&!/^[2-9A-HJ-NP-Z]{16}$/.test(guestToken))status("This private invitation is missing or invalid. Ask your host for a current link.");
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
  addEventListener("pagehide",()=>{hideEdgeCelebration();releaseHold()});
  addEventListener("offline",()=>unavailable("Connection lost — control stopped"));
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")recoverGuestSession();else{hideEdgeCelebration();unavailable("Controller paused — return to reconnect")}});
  addEventListener("pageshow",recoverGuestSession);addEventListener("online",recoverGuestSession);
  setInterval(()=>{
    if(lastStateAt&&performance.now()-lastStateAt>1800){unavailable("Host unavailable — waiting to reconnect…");return}
    if(progressUntil){const remaining=Math.max(0,progressUntil-performance.now());const active=document.querySelector("button.fixed.active");if(active)active.style.setProperty("--progress",((5000-remaining)/5000*100)+"%")}
  },100);
}
renderTeaseState();setInterval(renderTeaseState,1000);
