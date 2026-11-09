import {DeviceManager} from './devices.js';
import {SessionEngine} from './engine.js';
import {OPOSSUM_PATTERNS, LUSH_PATTERNS, patternsFor} from './patterns.js';

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const round = n => Math.round(n * 100) / 100;
const fmt = n => Number.isFinite(n) ? n.toFixed(2) : '—';
const names = {lush:'Lush Mini', opossum:'Opossum', vacuglide:'Vacuglide'};
const active = s => ['running','resting','waiting'].includes(s);
const KEY = 'solo2.settings.v1';
const TOKEN = 'solo2.token.v1';
const defaults = {toy:'opossum',civetEnabled:true,test:false,hardwareCap:40,cutoff:20.5,cutoffManual:false,restMin:10,restMax:30,power:{opossum:55,lush:50,vacuglide:35},pattern:{opossum:'random',lush:'random'},includes:{opossum:OPOSSUM_PATTERNS.map(p=>p.id),lush:LUSH_PATTERNS.map(p=>p.id)},cal:{zero:null,baseline:null,half:null,full:null},rememberToken:false};
let settings = structuredClone(defaults);
let storageOkay = true;
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (saved && typeof saved === 'object') {
    settings = {...settings,...saved,power:{...defaults.power,...saved.power},pattern:{...defaults.pattern,...saved.pattern},includes:{...defaults.includes,...saved.includes},cal:{...defaults.cal,...saved.cal}};
    if (!names[settings.toy]) settings.toy = 'opossum';
    settings.hardwareCap = clamp(settings.hardwareCap,0,100);
    for(const toy of Object.keys(names)) settings.power[toy] = clamp(settings.power[toy],0,100);
    for(const toy of ['opossum','lush']) {
      const catalogue = patternsFor(toy).map(p=>p.id);
      if(!Array.isArray(settings.includes[toy])) settings.includes[toy] = catalogue;
      settings.includes[toy] = settings.includes[toy].filter(id=>catalogue.includes(id));
      if(settings.pattern[toy] !== 'random' && !catalogue.includes(settings.pattern[toy])) settings.pattern[toy] = 'random';
    }
    for(const key of Object.keys(defaults.cal)) if(!Number.isFinite(settings.cal[key])) settings.cal[key] = null;
    if(!Number.isFinite(settings.cutoff)) settings.cutoff = 20.5;
    settings.restMin = clamp(Math.round(settings.restMin),1,600);
    settings.restMax = clamp(Math.round(settings.restMax),settings.restMin,600);
    settings.test = Boolean(settings.test); settings.civetEnabled = Boolean(settings.civetEnabled);
  }
} catch { storageOkay = false; }
if(new URLSearchParams(location.search).get('test') === '1') settings.test = true;
let currentView = settings.test ? 'play' : 'setup';
let snapshot = {state:'idle',elapsedMs:0,edges:0,restRemainingMs:0,restTotalMs:0,patternId:null,output:{a:0,b:0},pressure:null,reason:''};
let pressure = null, pressureAt = 0, epoch = 0, wanted = false, held = false;
let worker = null, fallback = null, fallbackInterval = null, workerReady = false;
let lastClock = Date.now(), lastSequence = 0, lastHistory = 0, toastTimer;
let stopPromise = Promise.resolve(), switching = false, demo = null, strokeSteps = 0;
let starting = false, startRequest = 0;
let wakeLock = null;
const history = Array.from({length:120},()=>({a:0,b:0}));

function persist() { try{localStorage.setItem(KEY,JSON.stringify(settings));}catch{storageOkay=false;showNotice('Browser storage is unavailable. Settings will last for this visit only.');} }
function showNotice(message) { $('notice').textContent=message; $('notice').hidden=!message; }
function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,3200); }
function report(error) { showNotice(error?.message || String(error)); }
function config() { return {toy:settings.toy,civetEnabled:settings.civetEnabled,cutoff:settings.cutoff,restMin:settings.restMin,restMax:settings.restMax,maxPower:settings.toy==='vacuglide'?100:settings.power[settings.toy],pattern:settings.pattern[settings.toy] || 'steady',includes:settings.includes[settings.toy] || null}; }
function caps() { return {hardwareCap:settings.hardwareCap,speedCap:settings.power.vacuglide}; }
function setText(id,text) { const el=$(id); if(el.textContent!==String(text))el.textContent=text; }

const devices = new DeviceManager({
  onStatus(key,status,detail) {
    if((key===settings.toy || key==='civet' && settings.civetEnabled) && status!=='connected' && wanted) fault(`${key==='civet'?'Civet':names[key]} connection lost. Reconnecting at zero; press Start when ready.`);
    renderConnections();
    if(status==='connected') { if(key==='vacuglide'){strokeSteps=0;setText('stroke-value','Adjust on device');} toast(`${key==='civet'?'Civet':names[key]} ${settings.test?'simulated':'connected at zero'}.`); }
    if(status==='error') showNotice(detail);
  },
  onPressure(kpa,at) {
    pressure=kpa; pressureAt=at;
    // Send zero in this notification turn; do not wait for the next Worker tick.
    if(wanted && snapshot.state==='running' && settings.civetEnabled && kpa>=settings.cutoff) {
      held=true; devices.stop(settings.toy).catch(report);
      snapshot={...snapshot,output:{a:0,b:0}};
      renderSession();
    }
    send({type:'pressure',kpa,at}); renderPressure();
  },
  onFault(message) { if(wanted)fault(message); else showNotice(message); }
});

function send(data) {
  const message={...data,epoch};
  if(worker) { worker.postMessage(message); return; }
  if(!fallback)return;
  const now=Date.now(); let next;
  if(data.type==='config')next=fallback.configure(data.config,now);
  if(data.type==='start')next=fallback.start(now);
  if(data.type==='stop')next=fallback.stop(data.reason,now);
  if(data.type==='fault')next=fallback.fault(data.reason,now);
  if(data.type==='pressure')next=fallback.pressure(data.kpa,now,data.at??now);
  if(next)receive({type:'tick',snapshot:next,at:now,epoch,sequence:++lastSequence,clock:false});
}
function useFallback(reason) {
  worker?.terminate();worker=null;workerReady=true;
  if(fallbackInterval)clearInterval(fallbackInterval);
  wanted=false;held=false;epoch++;
  devices.stopAll().catch(report);
  fallback=new SessionEngine();fallback.configure(config());
  snapshot=fallback.snapshot();
  if(Number.isFinite(pressure))fallback.pressure(pressure,Date.now(),pressureAt);
  fallbackInterval=setInterval(()=>{const now=Date.now();receive({type:'tick',snapshot:fallback.tick(now),at:now,epoch,sequence:++lastSequence,clock:true});},100);
  setText('clock-status','Fallback timer · 100 ms');
  showNotice(`${reason} A fallback timer is available; keep this tab visible while using it.`);
  renderSession();
}
function initClock() {
  try {
    worker=new Worker(new URL('./clock.worker.js',import.meta.url),{type:'module',name:'solo2-control'});
    worker.onmessage=({data})=>{workerReady=true;receive(data);};
    worker.onerror=event=>{event.preventDefault();useFallback('The Worker clock could not run.');};
    send({type:'config',config:config()});
  } catch {useFallback('The Worker clock is unavailable.');}
}
function receive(data) {
  if(data.type!=='tick' || data.epoch!==epoch)return;
  const now=Date.now();
  if(wanted && (now-data.at>500 || (data.clock && now-lastClock>500 && settings.toy==='opossum' && snapshot.state==='running'))) {fault('Control heartbeat delayed. Output stopped; press Start to retry.');return;}
  if(worker && data.sequence<=lastSequence)return;
  if(worker)lastSequence=data.sequence;
  if(data.clock)lastClock=now;
  const previous=snapshot;
  snapshot=data.snapshot;
  if(!wanted && active(snapshot.state))snapshot={...snapshot,state:'idle',output:{a:0,b:0}};
  if(snapshot.state==='fault') {
    if(wanted){wanted=false;stopPromise=devices.stopAll().catch(report);releaseWakeLock();}
    showNotice(snapshot.reason);
  }
  if(snapshot.state!=='running')held=false;
  if(wanted && snapshot.state==='running' && !held) {
    if(!devices.connected(settings.toy) || settings.civetEnabled && !devices.connected('civet')){fault('A required device is disconnected. Reconnect, then press Start.');return;}
    // Sensor notifications update state immediately; the clock owns normal writes.
    if(data.clock || previous.state!=='running')devices.setOutput(settings.toy,snapshot.output,caps()).catch(error=>{if(wanted)fault(error.message);else report(error);});
  } else if(previous.state==='running' || snapshot.state==='resting' && previous.state!=='resting') {
    devices.stop(settings.toy).catch(report);
  }
  if(data.clock && settings.test && settings.civetEnabled)devices.tickFakePressure();
  if(demo)advanceDemo(now);
  if(now-lastHistory>=85) {history.push({...snapshot.output});history.shift();lastHistory=now;drawCharts();}
  renderSession();
}
function syncConfig() { persist();send({type:'config',config:config()});renderSettings(); }
function halt(reason='Stopped. Your settings are kept.', {quiet=false}={}) {
  startRequest++;starting=false;
  wanted=false;held=false;epoch++;demo=null;
  // Mask locally before any asynchronous transport or Worker acknowledgement.
  snapshot={...snapshot,state:'idle',output:{a:0,b:0},restRemainingMs:0,reason};
  send({type:'stop',reason});
  stopPromise=devices.stopAll().catch(error=>{report(error);throw error;});
  // A handler is attached immediately even for event handlers that don't await.
  stopPromise.catch(()=>{});
  releaseWakeLock();renderSession();drawCharts();
  if(!quiet)toast('Stopped. Output set to zero.');
  return stopPromise;
}
function fault(reason) {
  startRequest++;starting=false;
  if(!wanted && snapshot.state==='fault'){showNotice(reason);return;}
  wanted=false;held=false;demo=null;epoch++;
  snapshot={...snapshot,state:'fault',output:{a:0,b:0},reason,restRemainingMs:0};
  send({type:'fault',reason});
  stopPromise=devices.stopAll().catch(report);releaseWakeLock();showNotice(reason);renderSession();drawCharts();
}
async function start() {
  if(switching || wanted || starting)return false;
  if(!workerReady){showNotice('The control clock is still starting. Try again in a moment.');return false;}
  if(!devices.connected(settings.toy) || settings.civetEnabled && !devices.connected('civet')) {showNotice('Connect your selected device'+(settings.civetEnabled?' and Civet':'')+' in Setup first.');return false;}
  if(settings.civetEnabled && (!Number.isFinite(pressure) || Date.now()-pressureAt>1500)){showNotice('Waiting for a fresh Civet reading. Reconnect the sensor, then try again.');return false;}
  if(settings.toy!=='vacuglide' && settings.pattern[settings.toy]==='random' && !settings.includes[settings.toy].length){showNotice('Select at least one pattern in Random includes.');return false;}
  const request=++startRequest, requestedEpoch=epoch;
  starting=true;renderSession();
  try {
    try { await stopPromise; }
    catch {
      // A successful reconnection can make an earlier failed Stop obsolete.
      // Confirm zero again, without allowing a canceled Start to issue work.
      if(request!==startRequest || epoch!==requestedEpoch || switching || wanted)return false;
      const recoveryStop=devices.stopAll();
      stopPromise=recoveryStop;
      await recoveryStop;
    }
    // Stop, faults and setup changes invalidate a Start even while a physical
    // zero command is still settling. A stale continuation must never restart.
    if(request!==startRequest || epoch!==requestedEpoch || switching || wanted)return false;
    if(!devices.connected(settings.toy) || settings.civetEnabled && !devices.connected('civet')) {
      showNotice('A required device disconnected while starting. Reconnect, then press Start.');return false;
    }
    if(settings.civetEnabled && (!Number.isFinite(pressure) || Date.now()-pressureAt>1500)) {
      showNotice('Waiting for a fresh Civet reading. Reconnect the sensor, then try again.');return false;
    }
    if(settings.toy!=='vacuglide' && settings.pattern[settings.toy]==='random' && !settings.includes[settings.toy].length) {
      showNotice('Select at least one pattern in Random includes.');return false;
    }
    showNotice('');epoch++;wanted=true;held=false;lastClock=Date.now();
    send({type:'start'});
    requestWakeLock();return true;
  } catch(error) {if(request===startRequest)report(error);return false;}
  finally {if(request===startRequest){starting=false;renderSession();}}
}
async function requestWakeLock() {try{if(navigator.wakeLock && document.visibilityState==='visible' && wanted)wakeLock=await navigator.wakeLock.request('screen');}catch{/* Optional enhancement; clock does not depend on it. */}}
function releaseWakeLock() {wakeLock?.release().catch(()=>{});wakeLock=null;}

function view(name) {
  currentView=name;const playing=name==='play';
  $('setup-view').hidden=playing;$('play-view').hidden=!playing;$('transport').hidden=!playing;
  $('setup-tab').setAttribute('aria-selected',String(!playing));$('play-tab').setAttribute('aria-selected',String(playing));
  $('setup-tab').tabIndex=playing?-1:0;$('play-tab').tabIndex=playing?0:-1;
  document.body.classList.toggle('session-view',playing);
  if(playing){drawCharts();renderSession();}
}
function renderConnections() {
  for(const [prefix,key] of [['toy',settings.toy],['civet','civet']]) {
    const status=devices.status(key);
    setText(`${prefix}-status`,settings.test&&status==='connected'?'Simulated':status.charAt(0).toUpperCase()+status.slice(1));
    $(`${prefix}-status-light`).className=`status-dot ${status}`;
    $(`${prefix}-connect`).disabled=['connected','connecting','reconnecting'].includes(status);
    $(`${prefix}-disconnect`).disabled=status==='disconnected';
    $(`${prefix}-reconnect`).disabled=status==='connecting';
  }
  const connected=devices.connected(settings.toy);
  $('session-connection').querySelector('.status-dot').className=`status-dot ${devices.status(settings.toy)}`;
  $('session-connection').querySelector('span').textContent=connected?(settings.test?'Simulated device':'Device connected'):'Not connected';
  $('calibration-dot').className=`status-dot ${devices.status('civet')}`;
  renderSession();
}
function renderSettings() {
  $('test-toggle').checked=settings.test;$('test-banner').hidden=!settings.test;$('test-controls').hidden=!settings.test;
  $('civet-enabled').checked=settings.civetEnabled;
  for(const el of all('[data-toy]'))el.setAttribute('aria-pressed',String(el.dataset.toy===settings.toy));
  setText('toy-connection-name',names[settings.toy]);
  setText('active-toy',names[settings.toy]+(settings.civetEnabled?' + Civet':''));
  $('token-panel').hidden=settings.toy!=='vacuglide';$('hardware-setting').hidden=settings.toy!=='opossum';
  $('civet-connection').hidden=!settings.civetEnabled;$('calibration-panel').hidden=!settings.civetEnabled;
  $('pressure-panel').hidden=!settings.civetEnabled;$('no-sensor-panel').hidden=settings.civetEnabled;
  $('fake-pressure').disabled=!settings.civetEnabled;$('test-cross').disabled=!settings.civetEnabled;$('test-release').disabled=!settings.civetEnabled;
  $('hardware-cap').value=settings.hardwareCap;setText('hardware-cap-value',`${settings.hardwareCap}% · ${Math.floor(settings.hardwareCap*2)} / 200`);
  $('remember-token').checked=settings.rememberToken;
  for(const [key,value] of Object.entries(settings.cal))if(document.activeElement!==$(`cal-${key}`))$(`cal-${key}`).value=Number.isFinite(value)?fmt(value):'';
  for(const id of ['setup-cutoff','live-cutoff'])if(document.activeElement!==$(id))$(id).value=fmt(settings.cutoff);
  if(document.activeElement!==$('rest-min'))$('rest-min').value=settings.restMin;
  if(document.activeElement!==$('rest-max'))$('rest-max').value=settings.restMax;
  const isVac=settings.toy==='vacuglide';
  $('pattern-controls').hidden=isVac;$('stroke-controls').hidden=!isVac;$('channel-b-wrap').hidden=settings.toy!=='opossum';
  $('max-power').value=settings.power[settings.toy];
  setText('power-label',isVac?'Max speed':'Max power');$('max-power').setAttribute('aria-label',isVac?'Maximum speed':'Maximum power');
  $('max-power-value').innerHTML=`${settings.power[settings.toy]}<small>%</small>`;
  setText('power-hint',isVac?'Cloud speed ceiling':settings.toy==='opossum'?`Within your ${settings.hardwareCap}% hardware ceiling`:'Of the 0–20 device range');
  if(!isVac) {
    const toy=settings.toy;
    if($('pattern-select').dataset.toy!==toy) {
      $('pattern-select').replaceChildren(new Option('Random','random'),...patternsFor(toy).map(p=>new Option(p.name,p.id)));
      $('pattern-select').dataset.toy=toy;
    }
    $('pattern-select').value=settings.pattern[toy];
    $('random-includes').textContent=`Random includes (${settings.includes[toy].length} of ${patternsFor(toy).length}) ↗`;
  }
  renderPressure();renderConnections();
}
function renderPressure() {
  const fresh=Date.now()-pressureAt<=1500 && devices.connected('civet');
  const shown=fresh?fmt(pressure):'—';setText('setup-pressure',shown);setText('live-pressure',shown);
  setText('pressure-status',fresh?(settings.test?'SIMULATED · LIVE':'CIVET · LIVE'):'WAITING FOR CIVET');
  const values=[settings.cal.baseline,settings.cal.half,settings.cal.full,settings.cutoff].filter(Number.isFinite);
  const lo=Math.min(settings.cal.baseline??19,settings.cutoff-.5,...values)-.25;
  const hi=Math.max(settings.cal.full??21.2,settings.cutoff+.5,...values)+.25;
  $('pressure-fill').style.width=`${fresh?clamp((pressure-lo)/(hi-lo)*100,0,100):0}%`;
  $('pressure-fill').classList.toggle('over',fresh&&pressure>=settings.cutoff);
  $('cutoff-marker').style.left=`${clamp((settings.cutoff-lo)/(hi-lo)*100,2,98)}%`;
  setText('gauge-low',fmt(lo));setText('gauge-high',`${fmt(hi)} kPa`);
  const captureDisabled=!fresh;
  for(const button of all('[data-capture]'))button.disabled=captureDisabled;
}
function clock(ms) {const t=Math.floor(Math.max(0,ms)/1000);return (t>=3600?`${Math.floor(t/3600)}:`:'')+`${String(Math.floor(t/60)%60).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;}
function renderSession() {
  const s=snapshot, running=active(s.state);
  const pattern=patternsFor(settings.toy).find(p=>p.id===s.patternId);
  setText('pattern-kicker',settings.toy==='vacuglide'?'CONTINUOUS CONTROL':settings.pattern[settings.toy]==='random'?'RANDOM ROTATION':'YOUR SELECTED PATTERN');
  const chosen=settings.toy==='vacuglide'?'Steady flow':pattern?.name||'Ready when you are.';
  setText('current-pattern',chosen);
  setText('pattern-description',settings.toy==='vacuglide'?'A steady speed, within your chosen ceiling.':pattern?.description||'Choose your pattern. Set a limit. Take your time.');
  setText('channel-a-label',settings.toy==='lush'?'LIVE LEVEL':settings.toy==='vacuglide'?'SPEED':'CHANNEL A');
  $('channel-a-value').innerHTML=settings.toy==='lush'?`${Math.floor(s.output.a/5+1e-9)}<small>/20</small>`:`${Math.round(s.output.a*(settings.toy==='vacuglide'?settings.power.vacuglide/100:1))}<small>%</small>`;
  $('channel-b-value').innerHTML=`${Math.round(s.output.b)}<small>%</small>`;
  setText('session-time',clock(s.elapsedMs));setText('edge-count',s.edges);
  const states={idle:['◌','All at your pace.','Press Start when you’re ready.','Ready','Output is at zero'],running:['∿','In your rhythm.',settings.civetEnabled?'Civet is watching the pressure.':'Your selected pattern is running.','Running','Output is active'],resting:['Ⅱ','Take a breath.','A little rest. Then we continue.','Resting','Output is at zero'],waiting:['◌','Ready when you release.','Drop below the cutoff to continue.','Waiting','Output is at zero'],fault:['!','Let’s check the connection.','Output stopped. Check the message above.','Stopped','Check the connection']};
  const state=states[s.state]||states.idle;
  setText('phase-icon',state[0]);setText('phase-title',state[1]);setText('phase-detail',state[2]);
  setText('transport-state',state[3]);setText('transport-detail',state[4]);
  $('phase-card').className=`phase-card ${s.state}`;
  $('transport-dot').className=`status-dot ${s.state==='running'?'connected':s.state==='fault'?'error':''}`;
  $('rest-countdown').hidden=s.state!=='resting';setText('rest-countdown',Math.ceil(s.restRemainingMs/1000)+'s');
  $('rest-progress').style.width=s.state==='resting'?`${100*(1-s.restRemainingMs/s.restTotalMs)}%`:'0';
  $('start').disabled=wanted||starting||switching||!devices.connected(settings.toy)||settings.civetEnabled&&!devices.connected('civet');
  $('start').innerHTML=`<span aria-hidden="true">${running?'∿':'▶'}</span> ${starting?'Starting…':running?'Session active':'Start session'}`;
  $('change-toy').disabled=switching;
  document.title=(s.state==='resting'?`Rest ${Math.ceil(s.restRemainingMs/1000)}s · `:s.state==='running'?'Running · ':'')+'SOLO 02';
  renderPressure();
}
function drawOne(canvas,channel,color) {
  if(canvas.offsetWidth===0)return;
  const ratio=Math.min(window.devicePixelRatio||1,2),w=canvas.clientWidth,h=canvas.clientHeight;
  if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
  const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='#36513a';ctx.lineWidth=.5;ctx.setLineDash([2,5]);
  for(let y=8;y<h;y+=(h-16)/3){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  ctx.setLineDash([]);const val=p=>p[channel]*(settings.toy==='vacuglide'?settings.power.vacuglide/100:1);
  const points=history.map((p,i)=>[i*w/(history.length-1),h-7-val(p)*(h-15)/100]);
  ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.strokeStyle=color;ctx.lineWidth=1.8;ctx.lineJoin='round';ctx.stroke();
  ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();const gradient=ctx.createLinearGradient(0,0,0,h);gradient.addColorStop(0,color+'24');gradient.addColorStop(1,color+'00');ctx.fillStyle=gradient;ctx.fill();
  const last=points.at(-1);ctx.beginPath();ctx.arc(last[0]-2,last[1],2.4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
}
function drawCharts(){drawOne($('chart-a'),'a','#d3f58b');drawOne($('chart-b'),'b','#e39d7d');}

async function changeToy(toy) {
  if(toy===settings.toy||switching)return;switching=true;
  try{await halt('',{quiet:true});await devices.disconnect(settings.toy);settings.toy=toy;snapshot.patternId=null;history.fill({a:0,b:0});syncConfig();if(settings.test)await devices.connect(toy);showNotice('');}
  catch(error){report(error);}finally{switching=false;renderSettings();}
}
async function toggleTest(enabled) {
  if(switching)return;switching=true;$('test-toggle').disabled=true;
  try {
    await halt('',{quiet:true});await devices.setTest(enabled);settings.test=enabled;pressure=null;pressureAt=0;
    persist();renderSettings();
    if(enabled){await devices.connect(settings.toy);if(settings.civetEnabled)await devices.connect('civet');devices.setFakePressure(Number($('fake-pressure').value));view('play');}
    else{view('setup');const url=new URL(location.href);url.searchParams.delete('test');window.history.replaceState(null,'',url);}
    showNotice('');
  }catch(error){report(error);}finally{switching=false;$('test-toggle').disabled=false;renderSettings();}
}
function fakePressure(value) {
  const n=round(clamp(value,-327.68,327.67));
  $('fake-pressure').min=Math.min(18,settings.cutoff-1,n);$('fake-pressure').max=Math.max(23,settings.cutoff+1,n);
  $('fake-pressure').value=n;setText('fake-pressure-value',`${fmt(n)} kPa`);devices.setFakePressure(n);
}
async function runDemo() {
  if(!settings.test||switching)return;
  await halt('',{quiet:true});
  settings.civetEnabled=true;syncConfig();await devices.connect(settings.toy);await devices.connect('civet');
  fakePressure(settings.cutoff-.4);view('play');
  if(await start()){demo={stage:'playing',at:Date.now()};toast('Demo running: cutoff in 2 seconds. Your rest window stays as set.');}
}
function advanceDemo(now) {
  if(demo.stage==='playing'&&now-demo.at>=2000){demo={stage:'release',at:now};fakePressure(settings.cutoff+.2);}
  else if(demo.stage==='release'&&now-demo.at>=700){demo={stage:'resting',at:now};fakePressure(settings.cutoff-.4);}
  else if(demo.stage==='resting'&&snapshot.state==='running'){demo=null;toast('Loop complete: cutoff → edge → rest → resume.');}
}
function saveToken() {
  settings.rememberToken=$('remember-token').checked;
  try{if(settings.rememberToken)localStorage.setItem(TOKEN,$('device-token').value.trim());else localStorage.removeItem(TOKEN);}catch{report(new Error('Token could not be saved in this browser.'));}
  persist();
}
function recalculate(force=false) {
  if(Number.isFinite(settings.cal.half)&&Number.isFinite(settings.cal.full)&&(force||!settings.cutoffManual)) {settings.cutoff=round((settings.cal.half+settings.cal.full)/2);settings.cutoffManual=false;}
  syncConfig();
}
function editCutoff(n) {if(!Number.isFinite(n))return;settings.cutoff=round(clamp(n,-327.68,327.67));settings.cutoffManual=true;syncConfig();}
function renderPatternDialog() {
  const toy=settings.toy, catalogue=patternsFor(toy);
  $('pattern-options').replaceChildren(...catalogue.map(pattern=>{
    const label=document.createElement('label');label.className='pattern-option';
    const check=document.createElement('input');check.type='checkbox';check.value=pattern.id;check.checked=settings.includes[toy].includes(pattern.id);
    const text=document.createElement('div'),title=document.createElement('strong'),desc=document.createElement('span');title.textContent=pattern.name;desc.textContent=pattern.description;text.append(title,desc);label.append(check,text);
    check.addEventListener('change',()=>{settings.includes[toy]=all('#pattern-options input:checked').map(el=>el.value);updateIncludes();});return label;
  }));
  updateIncludes(false);
}
function updateIncludes(save=true) {
  const total=settings.includes[settings.toy].length;setText('included-count',`${total} selected`);$('empty-pool').hidden=total>0;
  if(save)syncConfig();
}

$('setup-tab').onclick=()=>{halt('',{quiet:true}).catch(()=>{});view('setup');};
document.querySelector('.tabs').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const target=e.key==='Home'?'setup-tab':e.key==='End'?'play-tab':currentView==='setup'?'play-tab':'setup-tab';$(target).click();$(target).focus();}});
$('play-tab').onclick=()=>view('play');$('open-session').onclick=()=>{view('play');window.scrollTo({top:0,behavior:'smooth'});};
$('change-toy').onclick=()=>{halt('',{quiet:true}).catch(()=>{});view('setup');window.scrollTo({top:0,behavior:'smooth'});};
$('test-toggle').onchange=e=>toggleTest(e.target.checked);
for(const button of all('[data-toy]'))button.onclick=()=>changeToy(button.dataset.toy);
for(const prefix of ['toy','civet']){
  const key=()=>prefix==='toy'?settings.toy:'civet';
  $(prefix+'-connect').onclick=()=>{showNotice('');devices.connect(key(),{token:$('device-token').value.trim()}).catch(report);};
  $(prefix+'-reconnect').onclick=()=>{halt('',{quiet:true}).catch(()=>{});devices.reconnect(key(),{token:$('device-token').value.trim()}).catch(report);};
  $(prefix+'-disconnect').onclick=()=>{halt('',{quiet:true}).catch(()=>{});devices.disconnect(key()).catch(report);};
}
$('civet-enabled').onchange=async e=>{
  const enabled=e.target.checked;
  try{await halt('',{quiet:true});settings.civetEnabled=enabled;syncConfig();if(!enabled)await devices.disconnect('civet');else if(settings.test)await devices.connect('civet');}catch(error){report(error);}
};
$('hardware-cap').oninput=e=>{settings.hardwareCap=Number(e.target.value);syncConfig();};
$('max-power').oninput=e=>{settings.power[settings.toy]=Number(e.target.value);syncConfig();};
$('pattern-select').onchange=e=>{settings.pattern[settings.toy]=e.target.value;syncConfig();};
for(const key of Object.keys(defaults.cal)) {
  $(`cal-${key}`).oninput=e=>{settings.cal[key]=e.target.value===''?null:round(clamp(Number(e.target.value),-327.68,327.67));recalculate();};
  $(`cal-${key}`).onchange=()=>renderSettings();
}
for(const button of all('[data-capture]'))button.onclick=()=>{if(!Number.isFinite(pressure)||Date.now()-pressureAt>1500){showNotice('Wait for a fresh pressure sample before capturing.');return;}settings.cal[button.dataset.capture]=round(pressure);recalculate();toast(`Captured ${fmt(pressure)} kPa — one current sample.`);};
$('recalculate').onclick=()=>{if(!Number.isFinite(settings.cal.half)||!Number.isFinite(settings.cal.full)){toast('Capture or enter Half and Full first.');return;}recalculate(true);};
for(const id of ['setup-cutoff','live-cutoff']) {
  $(id).oninput=e=>{if(e.target.value!=='')editCutoff(Number(e.target.value));};
  $(id).onchange=()=>renderSettings();
}
$('cutoff-minus').onclick=()=>editCutoff(settings.cutoff-.1);$('cutoff-plus').onclick=()=>editCutoff(settings.cutoff+.1);
for(const [id,key] of [['rest-min','restMin'],['rest-max','restMax']]) {
  $(id).oninput=e=>{if(e.target.value==='')return;settings[key]=clamp(Math.round(Number(e.target.value)),1,600);persist();send({type:'config',config:config()});};
  $(id).onchange=()=>{if(settings.restMin>settings.restMax)[settings.restMin,settings.restMax]=[settings.restMax,settings.restMin];syncConfig();};
}
$('start').onclick=()=>start();$('stop').onclick=()=>halt().catch(()=>{});
$('fake-pressure').oninput=e=>{demo=null;fakePressure(Number(e.target.value));};
$('test-cross').onclick=()=>{demo=null;fakePressure(settings.cutoff+.2);};$('test-release').onclick=()=>{demo=null;fakePressure(settings.cutoff-.4);};
$('demo-loop').onclick=()=>runDemo().catch(report);
$('remember-token').onchange=saveToken;$('device-token').oninput=saveToken;
$('show-token').onclick=()=>{const hidden=$('device-token').type==='password';$('device-token').type=hidden?'text':'password';setText('show-token',hidden?'Hide':'Show');};
for(const [id,direction] of [['stroke-minus',-1],['stroke-plus',1]])$(id).onclick=async()=>{try{const result=await devices.stroke(direction);if(result.sent){strokeSteps+=direction;setText('stroke-value',`${Math.abs(strokeSteps)} step${Math.abs(strokeSteps)===1?'':'s'} ${strokeSteps<0?'shorter':'longer'} this connection`);}}catch(error){report(error);}};
$('random-includes').onclick=()=>{renderPatternDialog();$('pattern-dialog').showModal();};
for(const id of ['close-patterns','done-patterns'])$(id).onclick=()=>$('pattern-dialog').close();
for(const [id,selected] of [['select-all',true],['select-none',false]])$(id).onclick=()=>{settings.includes[settings.toy]=selected?patternsFor(settings.toy).map(p=>p.id):[];renderPatternDialog();syncConfig();};
$('pattern-dialog').addEventListener('click',e=>{if(e.target===$('pattern-dialog')){const r=$('pattern-dialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('pattern-dialog').close();}});
window.addEventListener('resize',drawCharts);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('pattern-dialog').open&&wanted)halt().catch(()=>{});});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){if(wanted&&Date.now()-lastClock>500)fault('Browser suspension detected. Press Start to begin again.');else if(wanted)requestWakeLock();drawCharts();}});
document.addEventListener('freeze',()=>{if(wanted)fault('Browser suspended this page. Output stopped; press Start to retry.');});
window.addEventListener('pagehide',()=>{halt('',{quiet:true}).catch(()=>{});});

initClock();renderSettings();view(currentView);
try{if(settings.rememberToken)$('device-token').value=localStorage.getItem(TOKEN)||'';else localStorage.removeItem(TOKEN);}catch{}
if(!storageOkay)showNotice('Browser storage is unavailable or invalid. Defaults are loaded for this visit.');
if(settings.test)toggleTest(true);
