let profiles=[],leaseRenewal,profileBusy=false;
const loginEl=document.querySelector("#login"),hostEl=document.querySelector("#host-controls"),loginStatus=document.querySelector("#login-status"),guestSelect=document.querySelector("#guest-select");
setupRemoteClient();
async function backend(action,values={}){
  const {data:{session}}=await remoteClient.auth.getSession();
  if(!session)throw new Error("Please sign in");
  const response=await fetch(SUPABASE_URL+"/functions/v1/guest-access",{
    method:"POST",headers:{"Content-Type":"application/json",apikey:SUPABASE_PUBLISHABLE_KEY,Authorization:"Bearer "+session.access_token},
    body:JSON.stringify({action,...values}),signal:AbortSignal.timeout(8000)
  });
  const data=await response.json();
  if(!response.ok){
    if([401,403].includes(response.status)&&hostAuthorized){hostAuthorized=false;setTimeout(()=>lockHost(),0)}
    throw new Error(data.error||"Host access unavailable");
  }
  return data;
}
function selectedProfile(){return profiles.find(profile=>profile.id===guestSelect.value)}
function renderProfiles(selected=guestSelect.value){
  guestSelect.replaceChildren();
  for(const profile of profiles){const option=document.createElement("option");option.value=profile.id;option.textContent=profile.name;guestSelect.append(option)}
  if(profiles.some(p=>p.id===selected))guestSelect.value=selected;
  document.querySelector("#rotate-guest").disabled=!selectedProfile();
  controllerLinkEl.value=selectedProfile()?"https://ctmp.uk/#"+selectedProfile().pair_code:"";
  copyControllerBtn.disabled=!selectedProfile();
}
async function unlockHost(){
  try{
    const data=await backend("list");
    profiles=data.profiles;renderProfiles();hostAuthorized=true;
    loginEl.hidden=true;hostEl.hidden=false;
  }catch(error){hostAuthorized=false;hostEl.hidden=true;loginEl.hidden=false;loginStatus.textContent=error.message}
}
document.querySelector("#login-form").addEventListener("submit",async event=>{
  event.preventDefault();const button=document.querySelector("#login-button");button.disabled=true;
  loginStatus.textContent="Signing in…";
  try{
    const {error}=await remoteClient.auth.signInWithPassword({email:document.querySelector("#email").value.trim(),password:document.querySelector("#password").value});
    document.querySelector("#password").value="";
    if(error)throw error;
    await unlockHost();
  }catch(error){loginStatus.textContent=error.message}finally{button.disabled=false}
});
async function lockHost(){
  hostAuthorized=false;hostEl.hidden=true;loginEl.hidden=false;
  await endRemoteSession();
  if(device?.gatt?.connected)device.gatt.disconnect();
  tx=null;ready(false);connectBtn.disabled=false;
}
document.querySelector("#logout").addEventListener("click",async()=>{
  await lockHost();await remoteClient.auth.signOut();loginStatus.textContent="Signed out.";
});
remoteClient.auth.onAuthStateChange((event)=>{
  // Avoid invoking Auth APIs inside Supabase's auth callback lock.
  if(event==="SIGNED_OUT")setTimeout(()=>lockHost(),0);
});
async function renewLease(){
  if(!remoteSessionId||!hostAuthorized)return;
  if(leaseRenewal)return leaseRenewal;
  const session=remoteSessionId,started=performance.now();
  leaseRenewal=(async()=>{
    try{
      const result=await backend("renew",{session});
      if(remoteSessionId!==session)return;
      if(!result.ok){await endRemoteSession("Session ended or guest link revoked.");return}
      leaseDeadline=started+30000;
    }catch(error){
      if(remoteSessionId===session&&performance.now()>=leaseDeadline){await stopNow("Session verification unavailable");remoteStatus("Session verification unavailable — recovering…")}
    }
  })().finally(()=>{leaseRenewal=null});
  return leaseRenewal;
}
setInterval(()=>{if(document.visibilityState==="visible")renewLease()},10000);
setInterval(()=>{if(remoteSessionId&&performance.now()>=leaseDeadline&&engine.active)stopNow("Session verification expired")},100);
document.querySelector("#add-guest").addEventListener("click",async()=>{
  if(profileBusy)return;profileBusy=true;
  try{
    const {profile}=await backend("create",{name:document.querySelector("#guest-name").value});
    profiles.push(profile);renderProfiles(profile.id);document.querySelector("#guest-name").value="";
    remoteStatus("Guest saved. Create a controller link when the device is connected.");
  }catch(error){remoteStatus(error.message)}finally{profileBusy=false}
});
guestSelect.addEventListener("change",()=>renderProfiles());
document.querySelector("#rotate-guest").addEventListener("click",async()=>{
  const selected=selectedProfile();if(!selected||profileBusy)return;
  profileBusy=true;
  try{
    await endRemoteSession();
    const {profile}=await backend("rotate",{profile:selected.id});
    profiles=profiles.map(p=>p.id===profile.id?profile:p);renderProfiles(profile.id);
    remoteStatus("Old link revoked. Create a controller link to start a fresh session.");
  }catch(error){remoteStatus(error.message)}finally{profileBusy=false}
});
document.querySelector("#end-session").addEventListener("click",()=>endRemoteSession());
remoteClient.auth.getSession().then(({data:{session}})=>{if(session)unlockHost()});

document.querySelector("#guest-code-form").addEventListener("submit",event=>{
  event.preventDefault();const code=document.querySelector("#guest-code").value.trim().toUpperCase();
  if(/^[2-9A-HJ-NP-Z]{4}$/.test(code))location.href="/controller.html#"+code;
  else loginStatus.textContent="Check the four-character invitation code.";
});
let approvalBusy=false;
async function refreshApprovals(){
  if(!hostAuthorized||approvalBusy||document.visibilityState!=="visible")return;
  approvalBusy=true;
  try{
    const {requests}=await backend("pair-list"),container=document.querySelector("#pair-requests");
    container.replaceChildren();
    if(!requests.length)container.textContent="No pending requests.";
    for(const request of requests){
      const row=document.createElement("div"),label=document.createElement("p"),approve=document.createElement("button"),deny=document.createElement("button");
      label.textContent=request.control_guests.name+" — check number "+request.check_number;
      approve.textContent="Approve "+request.check_number;deny.textContent="Deny";
      for(const [button,action] of [[approve,"pair-approve"],[deny,"pair-deny"]])button.addEventListener("click",async()=>{
        approve.disabled=true;deny.disabled=true;
        try{await backend(action,{request:request.id});row.remove()}catch(error){remoteStatus(error.message)}
      });
      row.append(label,approve,deny);container.append(row);
    }
  }catch(error){console.warn("Browser approvals unavailable")}finally{approvalBusy=false}
}
setInterval(refreshApprovals,5000);
