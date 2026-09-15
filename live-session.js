/* Host-only view of existing state. No Bluetooth reads, commands, or session messages. */
(()=>{
  const $=selector=>document.querySelector(selector);
  const view=$('#live-session'),setup=$('#host-setup'),enter=$('#enter-live');
  const meter=$('#live-output-meter'),number=$('#live-output-number'),pattern=$('#live-pattern');
  const connection=$('#live-connection'),sessionState=$('#live-session-state');
  const background=$('#live-backdrop'),input=$('#live-background-input'),clear=$('#clear-live-background'),note=$('#live-background-note');
  const reconnect=$('#live-reconnect'),invite=$('#live-invite'),inviteToggle=$('#live-invite-toggle'),inviteContent=$('#live-invite-content'),guestLabel=$('#live-guest');
  const remote=$('.remote');
  // Keep the actual original buttons/listeners, including their enabled state.
  const placements=[[stopBtn,$('#live-stop-slot')],[edgeBtn,$('#live-edge-slot')],[edgeStatusEl,$('#live-edge-status-slot')],[$('#tease-stages'),$('#live-arousal-slot')],[$('#rating-stages'),$('#live-rating-slot')],[remote,inviteContent]].map(([node,slot])=>{
    const marker=document.createComment('Original safety control position');
    node.before(marker);return {node,slot,marker};
  });
  let opened=false,drawerOpen=false,lastLevel=0,lastGeneration=-1,backgroundURL=null,pairedSession=null;
  function clearBackground(){
    background.style.backgroundImage=hostAuthorized?'url("assets/host-live-background.jpg")':'none';
    if(backgroundURL)URL.revokeObjectURL(backgroundURL);
    backgroundURL=null;input.value='';clear.hidden=true;
    note.textContent='Your selection stays in this tab. Remove it to restore the default image.';
  }
  function connected(){return hostAuthorized&&!!tx&&!!device?.gatt?.connected&&!stopBtn.disabled}
  function eligible(){return connected()&&pairedSession===remoteSessionId&&!!remoteSessionId&&remoteChannelSubscribed()&&performance.now()<leaseDeadline}
  function setDrawer(open){
    drawerOpen=!!open&&opened;invite.hidden=!drawerOpen;inviteToggle.setAttribute('aria-expanded',String(drawerOpen));
    if(drawerOpen){refreshApprovals();guestNameEl.focus()}
  }
  function leave(){
    setDrawer(false);opened=false;view.hidden=true;setup.hidden=false;document.body.classList.remove('host-live');
    for(const {node,marker} of placements)marker.after(node);
  }
  function open(){
    if(!hostAuthorized)return;
    for(const {node,slot} of placements)slot.append(node);
    opened=true;setup.hidden=true;view.hidden=false;
    document.body.classList.add('host-live');stopBtn.focus();
  }
  function render(){
    if(!hostAuthorized){if(opened)leave();if(backgroundURL)clearBackground()}
    if(!hostAuthorized){pairedSession=null;if(opened)leave()}
    if(pairedSession&&pairedSession!==remoteSessionId)pairedSession=null;
    if(!hostAuthorized)background.style.backgroundImage='none';
    else if(!backgroundURL)background.style.backgroundImage='url("assets/host-live-background.jpg")';
    const toyConnected=connected(),canEnter=eligible();
    enter.disabled=!hostAuthorized;
    $('#live-availability').textContent=canEnter?'Ready for Live Session.':'Live Session is available. Connect the toy and invite a guest when ready.';
    connection.textContent=toyConnected?'● Toy connected':'○ Toy disconnected';
    reconnect.hidden=!opened||!hostAuthorized||!device||toyConnected;
    reconnect.disabled=reconnectBtn.disabled||!!bluetoothRecoveryPromise;
    sessionState.textContent=!toyConnected?'Toy disconnected · No guest connected':!remoteSessionId?'Toy connected · No guest connected':!remoteChannelSubscribed()?'Toy connected · Session recovering…':performance.now()>=leaseDeadline?'Toy connected · Session verification recovering…':pairedSession===remoteSessionId?'Guest browser approved':'Guest invitation ready';
    const guestName=remoteSessionId&&currentProfile?.name;guestLabel.hidden=!guestName;guestLabel.textContent=guestName?'Guest: '+guestName:'';
    inviteToggle.textContent=guestName?'Manage '+guestName:'Invite Guest';
    // A suspended tab or stale generation must never resurrect an old reading.
    if(!toyConnected||document.visibilityState!=='visible'||lastGeneration!==engine.generation||hostState.state==='unavailable'||edgeLocked())lastLevel=0;
    const percent=lastLevel*5;
    meter.style.setProperty('--output-fraction',String(lastLevel/14));
    meter.setAttribute('aria-valuenow',String(percent));
    meter.setAttribute('aria-valuetext',percent+'% commanded output; maximum 70%');
    if(number.dataset.value!==String(percent)){number.innerHTML=percent+'<span>%</span>';number.dataset.value=String(percent)}
    const names={'20':'LOW','40':'MED','60':'HIGH','70':'MAX','random':'Random HOLD','max-hold':'Max HOLD','manual':'Manual Control'};
    pattern.textContent=!toyConnected?'Disconnected':edgeLocked()?'Remote control paused':names[engine.active?.command]||'Stopped';
    $('#live-edge-count').textContent='EDGE used: '+edgeUseCount+' '+(edgeUseCount===1?'time':'times');
  }
  window.hostLiveView=Object.freeze({
    // Presentation only; approval and control permission remain owned by the existing flow.
    paired(session){if(hostAuthorized&&session&&session===remoteSessionId){pairedSession=session;render()}},
    open(){open();render()},
    output(level){
    lastLevel=Number.isInteger(level)?Math.max(0,Math.min(14,level)):0;
    lastGeneration=engine.generation;render();
  }});
  enter.addEventListener('click',()=>{open();render()});
  inviteToggle.addEventListener('click',()=>setDrawer(!drawerOpen));
  $('#live-invite-close').addEventListener('click',()=>setDrawer(false));
  $('#leave-live').addEventListener('click',()=>{leave();render();enter.focus()});
  reconnect.addEventListener('click',()=>{if(hostAuthorized)reconnectBtn.click()});
  input.addEventListener('change',()=>{
    if(!hostAuthorized){clearBackground();return}
    const file=input.files?.[0];if(!file)return;
    if(!['image/jpeg','image/png','image/webp','image/avif'].includes(file.type)){
      input.value='';note.textContent='Choose a JPEG, PNG, WebP or AVIF image.';return;
    }
    // Object URLs reference local file bytes only; never persist the file or URL.
    clearBackground();backgroundURL=URL.createObjectURL(file);
    background.style.backgroundImage='url("'+backgroundURL+'")';clear.hidden=false;
    note.textContent='Local background selected for this tab only.';
  });
  clear.addEventListener('click',clearBackground);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')lastLevel=0;render()});
  addEventListener('pagehide',()=>{lastLevel=0;clearBackground();render()});
  addEventListener('pageshow',render);
  addEventListener('host-unlocked',()=>{open();render()});
  // Local DOM refresh only; existing recovery continues to own all connections.
  setInterval(render,100);if(hostAuthorized)open();render();
})();
