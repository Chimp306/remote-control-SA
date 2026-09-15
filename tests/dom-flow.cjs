// Integration without hardware/network. JSDOM 26.1.0, Node 24.
const {JSDOM,VirtualConsole}=require(process.env.JSDOM_PATH||'jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),windows=[],errors=[];
const profile={id:'guest-1',name:'Test guest',token:'ABCDEFGHJKLMNPQR',pair_code:'ABCD'};
const firstCelebrations=new Set(['Edged me! ❤️','EDGED! ❤️']);
const laterCelebrations=new Set(['Edged — nice work 😈','You found my limit — edged 🔥','Edged me again! 😏','Good girl — edged me! 😉','Perfect. 😈','Edged me! ❤️','EDGED! ❤️']);
let active,approved=false,authorised=true;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<100;i++){if(fn())return;await pause(30)}throw new Error('Timed out: '+label)}
function page(file,hash='',storage={}){
  let html=fs.readFileSync(path.join(root,file),'utf8');
  html=html.replace(/<script src="([^"]+)"><\/script>/g,(_,src)=>src.startsWith('https:')?'':`<script>${fs.readFileSync(path.join(root,src),'utf8')}</script>`);
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(html,{url:'https://ctmp.uk/'+(file==='index.html'?'':file)+hash,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole,beforeParse(window){
    window.TextEncoder=TextEncoder;window.TextDecoder=TextDecoder;window.AbortSignal=AbortSignal;
    Object.defineProperty(window.crypto,'subtle',{value:crypto.subtle});
    window.__writes=[];window.__channels=[];window.__broadcasts=[];window.__haptics=[];window.__fetchActions=[];window.__fetchBodies=[];window.__visibility='visible';window.__opened=[];window.__bluetoothRequests=0;
    window.open=url=>{window.__opened.push(url);return {opener:window}};
    Object.defineProperty(window.document,'visibilityState',{get:()=>window.__visibility});
    Object.defineProperty(window.navigator,'vibrate',{value:pattern=>{window.__haptics.push(pattern);return true}});
    window.HTMLElement.prototype.setPointerCapture=()=>{};
    for(const [key,value] of Object.entries(storage))window.localStorage.setItem(key,value);
    window.supabase={createClient:()=>({
      auth:{getSession:async()=>({data:{session:authorised?{access_token:'test'}:null}}),onAuthStateChange:()=>{},signOut:async()=>{},signInWithPassword:async()=>({error:null})},realtime:{isConnected:()=>true},
      channel:topic=>{
        const ch={topic,state:'joining',handlers:{},on(type,{event},handler){this.handlers[event]=handler;return this},subscribe(callback){this.callback=callback;setTimeout(()=>{this.state='joined';callback('SUBSCRIBED')},0);return this},async send(message){window.__broadcasts.push(message);
          for(const peer of windows)if(peer!==window)for(const channel of peer.__channels)if(channel.state==='joined'&&channel.topic===topic)channel.handlers[message.event]?.({payload:message.payload});return 'ok';
        }};window.__channels.push(ch);return ch;
      },removeChannel:async ch=>{ch.state='closed'}
    })};
    const characteristic={properties:{writeWithoutResponse:true},writeValueWithoutResponse:async bytes=>window.__writes.push(new TextDecoder().decode(bytes))};
    const service={uuid:'test-service',getCharacteristic:async()=>characteristic,getCharacteristics:async()=>[characteristic]};
    const device={name:'LVS-test',addEventListener(type,handler){this[type]=handler},gatt:{connected:false,async connect(){this.connected=true;return this},disconnect(){this.connected=false;device.gattserverdisconnected?.()},getPrimaryService:async()=>service,getPrimaryServices:async()=>[service]}};
    Object.defineProperty(window.navigator,'bluetooth',{value:{requestDevice:async()=>{window.__bluetoothRequests++;return device}}});
    window.fetch=async(url,options)=>{
      const body=JSON.parse(options.body);window.__fetchActions.push({action:body.action,authorization:options.headers.Authorization||null});window.__fetchBodies.push(body);let result={ok:true};
      if(body.action==='list')result={profiles:[profile]};
      if(['create','rotate'].includes(body.action)){profile.name=body.name;result={profile}}
      if(body.action==='activate')active={session:body.session,edgeKey:body.edgeKey};
      if(body.action==='end'&&active?.session===body.session)active=null;
      if(body.action==='resolve')result=active?{valid:true,available:true,name:profile.name,...active}:{valid:true,available:false,name:profile.name};
      if(body.action==='pair-list')result={requests:[{id:'request-1',profile_id:profile.id,check_number:'3814',control_guests:{name:profile.name}}]};
      if(['pair-poll','pair-request'].includes(body.action))result=approved?{state:'approved',token:profile.token}:{state:'pending',checkNumber:'7261'};
      return {ok:true,status:200,json:async()=>result};
    };
  }});
  windows.push(dom.window);return dom.window;
}
function click(window,selector){window.document.querySelector(selector).click()}
function pointer(window,type,selector='#random'){const event=new window.Event(type,{bubbles:true});Object.assign(event,{isPrimary:true,button:0,pointerId:1});window.document.querySelector(selector).dispatchEvent(event)}
(async()=>{
  try{
    const host=page('index.html');await until(()=>host.eval('hostAuthorized'),'host login');
    assert.ok(host.document.querySelector('#guest-name'));assert.equal(host.document.querySelector('#guest-select'),null);assert.equal(host.document.querySelector('#rotate-guest'),null);
    assert.equal(host.document.querySelector('.advanced').open,false);assert.ok(host.document.querySelector('.advanced #vibrate'));assert.ok(host.document.querySelector('.advanced #diagnostics'));
    assert.equal(host.document.querySelector('#controller-link').value,'');
    host.document.querySelector('#guest-name').value='Sophie';
    assert.equal(host.document.querySelector('#preview-controller').disabled,false);click(host,'#preview-controller');assert.equal(host.__opened[0],'/controller.html?preview=1&name=Sophie');assert.equal(host.__bluetoothRequests,0);
    const preview=page('controller.html','?preview=1&name=Sophie');await until(()=>!preview.document.querySelector('#preview-badge').hidden,'preview authorisation');assert.equal(preview.document.querySelector('#guest-welcome').textContent,'WELCOME, SOPHIE');
    assert.ok([...preview.document.querySelectorAll('[data-command]')].every(button=>!button.disabled));assert.deepEqual(preview.__fetchActions,[{action:'preview',authorization:'Bearer test'}]);assert.equal(preview.__channels.length,0);assert.equal(preview.__writes.length,0);assert.equal(active,undefined);
    assert.equal(preview.document.querySelector('#tease-panel').dataset.stage,'1');assert.equal(preview.document.querySelector('#tease-message').textContent,'😈 RELAXED');assert.equal(preview.document.querySelector('#tease-copy').textContent,'I can handle this.');
    click(preview,'[data-preview-stage="2"]');assert.equal(preview.document.querySelector('#tease-panel').dataset.stage,'2');assert.equal(preview.document.querySelector('#tease-message').textContent,'😏 BUILDING');assert.equal(preview.document.querySelector('#tease-copy').textContent,'The frustration is building… and this is good.');
    click(preview,'[data-preview-stage="3"]');assert.equal(preview.document.querySelector('#tease-panel').dataset.stage,'3');assert.equal(preview.document.querySelector('#tease-message').textContent,'🔥 DESPERATE');assert.equal(preview.document.querySelector('#tease-copy').textContent,'You’re an epic tease. You’ve really got me now.');
    click(preview,'[data-preview-stage="4"]');assert.equal(preview.document.querySelector('#tease-panel').dataset.stage,'4');assert.equal(preview.document.querySelector('#tease-message').textContent,'❤️ PLEASE');assert.equal(preview.document.querySelector('#tease-copy').textContent,'Okay… really. PLEASE.');
    click(preview,'#preview-timer');assert.match(preview.document.querySelector('#tease-timer').textContent,/^Teasing for 18:4[12]$/);click(preview,'#preview-haptic');assert.equal(preview.document.querySelector('#haptic-state').textContent,'TEASE TAP');assert.deepEqual(Array.from(preview.__haptics.at(-1)),[14,28,14]);assert.equal(preview.__channels.length,0);assert.equal(active,undefined);
    for(const command of ['20','40','60','70']){
      click(preview,'[data-command="'+command+'"]');assert.ok(preview.document.querySelector('[data-command="'+command+'"]').classList.contains('active'));
      preview.eval('previewStartedAt-=100;updatePreviewFixed()');assert.ok(parseFloat(preview.document.querySelector('[data-command="'+command+'"]').style.getPropertyValue('--progress'))>0);
      preview.eval('previewStartedAt-=5000;updatePreviewFixed()');assert.ok(!preview.document.querySelector('[data-command="'+command+'"]').classList.contains('active'));
    }
    pointer(preview,'pointerdown','#random');assert.ok(preview.document.querySelector('#random').classList.contains('active'));pointer(preview,'pointerup','#random');assert.ok(!preview.document.querySelector('#random').classList.contains('active'));
    pointer(preview,'pointerdown','#max-hold');assert.ok(preview.document.querySelector('#max-hold').classList.contains('active'));pointer(preview,'pointerup','#max-hold');assert.ok(!preview.document.querySelector('#max-hold').classList.contains('active'));assert.equal(preview.__channels.length,0);assert.equal(preview.__writes.length,0);
    assert.equal(preview.document.querySelector('#preview-tools').hidden,false);click(preview,'#preview-edge-first');assert.equal(preview.document.querySelector('#edge-celebration').hidden,false);const previewFirst=preview.document.querySelector('#celebration-message').textContent;assert.ok(firstCelebrations.has(previewFirst));
    const previewSerial=preview.eval('celebrationSerial'),celebrationStarted=Date.now();click(preview,'#preview-edge-later');const previewLater=preview.document.querySelector('#celebration-message').textContent;assert.ok(laterCelebrations.has(previewLater));assert.notEqual(previewLater,previewFirst);assert.equal(preview.eval('celebrationSerial'),previewSerial+1);assert.equal(preview.document.querySelector('#edge-count').textContent,'EDGE used: 0 times · preview');assert.deepEqual(preview.__fetchActions,[{action:'preview',authorization:'Bearer test'}]);assert.equal(preview.__channels.length,0);assert.equal(preview.__writes.length,0);await until(()=>preview.document.querySelector('#edge-celebration').hidden,'celebration auto-hide');assert.ok(Date.now()-celebrationStarted>=1500&&Date.now()-celebrationStarted<2300);
    click(host,'#connect');await until(()=>host.eval('!!tx'),'Bluetooth connect');assert.equal(host.document.querySelector('#device-state').textContent,'Connected');assert.equal(host.document.querySelector('#device-name').textContent,'LVS-test');click(host,'#create-controller');await until(()=>host.eval('remoteReady'),'host session');
    assert.equal(host.eval('teaseStage'),1);assert.equal(host.eval('teaseStartedAt'),null);assert.equal(host.document.querySelector('[data-tease-stage="1"]').getAttribute('aria-pressed'),'true');assert.deepEqual([...host.document.querySelectorAll('[data-tease-stage]')].map(button=>button.textContent),['Relaxed','Frustration building','OMG','PLEASE']);
    assert.equal(host.__fetchBodies.find(body=>body.action==='rotate').name,'Sophie');
    assert.equal(host.document.querySelector('#controller-link').value,'https://ctmp.uk/#ABCD');
    await host.eval('refreshApprovals()');assert.ok(host.document.querySelector('#pair-requests').textContent.includes('Sophie · Check number 3814'));assert.equal(host.document.querySelector('#pair-requests').textContent.includes('guest-1'),false);
    const guest=page('controller.html','#ABCD');assert.equal(guest.document.querySelector('#guest-welcome').textContent,'WELCOME, GUEST');assert.equal(guest.document.querySelectorAll('.control .release').length,2);assert.equal(guest.document.querySelector('.hold-note'),null);await until(()=>!guest.document.querySelector('#pairing').hidden,'guest pairing');click(guest,'#request-access');await until(()=>guest.document.querySelector('#pairing-message').textContent.includes('7261'),'check number');assert.equal(guest.document.querySelector('[data-command="70"]').disabled,true);
    approved=true;await guest.eval('pollPairing()');await until(()=>guest.eval('guestReady&&lastStateAt>0&&!edgeCountBaselinePending&&!teaseBaselinePending'),'signed ready and baselines');assert.equal(guest.document.querySelector('#guest-welcome').textContent,'WELCOME, SOPHIE');assert.equal(guest.eval('celebrationSerial'),0);assert.equal(guest.document.querySelector('#edge-celebration').hidden,true);assert.equal(guest.document.querySelector('#tease-panel').dataset.stage,'1');assert.equal(guest.eval('teaseStartedAt'),null);assert.equal(guest.__haptics.length,0);
    const stageWriteCount=host.__writes.length;click(host,'[data-tease-stage="2"]');await until(()=>guest.document.querySelector('#tease-panel').dataset.stage==='2','signed stage 2');assert.equal(host.__writes.length,stageWriteCount);assert.equal(host.eval('engine.active'),null);assert.deepEqual(Array.from(guest.__haptics.at(-1)),[14,28,14]);assert.equal(guest.eval('teaseStartedAt'),null);
    const hapticsAfterStage=guest.__haptics.length,lastSignedTease=host.__broadcasts.filter(message=>message.event==='tease-state').at(-1).payload;await guest.eval('receiveTeaseState('+JSON.stringify(lastSignedTease)+')');assert.equal(guest.__haptics.length,hapticsAfterStage);await guest.eval('receiveTeaseState({message:JSON.stringify({stage:4,startedAt:null,seq:9999}),signature:"AAAA"})');assert.equal(guest.document.querySelector('#tease-panel').dataset.stage,'2');assert.equal(guest.__haptics.length,hapticsAfterStage);
    await host.eval('setTeaseStage(5);receiveControl({id:"rejected-before-timer",command:"70",challenge:"invalid"})');assert.equal(host.eval('teaseStage'),2);assert.equal(host.eval('teaseStartedAt'),null);assert.equal(host.__writes.length,stageWriteCount);
    click(host,'[data-tease-stage="1"]');await until(()=>guest.document.querySelector('#tease-panel').dataset.stage==='1','signed stage 1');assert.equal(host.__writes.length,stageWriteCount);assert.equal(host.eval('engine.active'),null);
    click(guest,'[data-command="70"]');await until(()=>host.__writes.includes('Vibrate:14;'),'peak 14');assert.ok(guest.document.querySelector('[data-command="70"]').classList.contains('active'));await until(()=>host.eval('teaseStartedAt!==null')&&guest.eval('teaseStartedAt!==null'),'timer start');assert.equal(guest.eval('teaseStartedAt'),host.eval('teaseStartedAt'));assert.match(guest.document.querySelector('#tease-timer').textContent,/^Teasing for 0:0[01]$/);assert.equal(guest.__haptics.filter(value=>value===12).length,1);
    await until(()=>parseFloat(guest.document.querySelector('[data-command="70"]').style.getPropertyValue('--progress'))>0,'fixed progress fill');
    pointer(guest,'pointerdown','#max-hold');await until(()=>host.eval('engine.active?.command==="max-hold"'),'max hold before EDGE');await until(()=>host.__writes.at(-1)==='Vibrate:14;','max hold before EDGE level');assert.deepEqual(Array.from(guest.__haptics.at(-1)),[18,28,18]);
    click(host,'#edge');await until(()=>host.eval('engine.active===null'),'EDGE stops max hold');assert.equal(host.__writes.at(-1),'Vibrate:0;');await until(()=>guest.document.querySelector('#status').textContent.includes('paused'),'EDGE UI');await until(()=>guest.document.querySelector('#edge-count').textContent==='EDGE used: 1 time'&&guest.eval('celebrationSerial')===1,'signed count celebration');
    const firstMessage=guest.document.querySelector('#celebration-message').textContent;assert.ok(firstCelebrations.has(firstMessage));assert.deepEqual(Array.from(guest.__haptics.at(-1)),[28,22,42]);
    const count=host.__writes.length;await host.eval('receiveControl({command:"70",id:"fake-command-123456",challenge:[...challenges.keys()][0]})');assert.equal(host.__writes.length,count);
    await guest.eval('receiveEdgeCount({count:999,signature:"AAAA"})');assert.equal(guest.document.querySelector('#edge-count').textContent,'EDGE used: 1 time');assert.equal(guest.eval('celebrationSerial'),1);
    await host.eval('publishEdgeCount()');await pause(80);assert.equal(guest.eval('celebrationSerial'),1);
    click(host,'#edge');await until(()=>guest.document.querySelector('#edge-count').textContent==='EDGE used: 2 times'&&guest.eval('celebrationSerial')===2,'repeat EDGE celebration');const laterMessage=guest.document.querySelector('#celebration-message').textContent;assert.ok(laterCelebrations.has(laterMessage));assert.notEqual(laterMessage,firstMessage);assert.ok(host.eval('edgeLockUntil-Date.now()>29000'));
    await host.eval('edgeUseCount=1;publishEdgeCount()');await pause(80);assert.equal(guest.document.querySelector('#edge-count').textContent,'EDGE used: 2 times');assert.equal(guest.eval('celebrationSerial'),2);host.eval('edgeUseCount=2');
    host.eval('edgeLockUntil=Date.now()-1;updateEdgeCountdown()');await until(()=>!guest.document.querySelector('#random').disabled,'unlock');
    pointer(guest,'pointerdown','#max-hold');await until(()=>host.eval('engine.active?.command==="max-hold"'),'max hold start');await until(()=>host.__writes.at(-1)==='Vibrate:14;','max hold level');await until(()=>guest.document.querySelector('#max-hold').classList.contains('active'),'signed max hold active state');
    const activeHoldId=host.eval('engine.active.id'),holdWriteCount=host.__writes.length;click(host,'[data-tease-stage="4"]');await until(()=>guest.eval('teaseStage===4'),'stage 4 during hold');assert.equal(guest.document.querySelector('#tease-message').textContent,'❤️ PLEASE');assert.equal(host.eval('engine.active.id'),activeHoldId);assert.equal(host.eval('engine.active.command'),'max-hold');assert.equal(host.__writes.length,holdWriteCount);assert.equal(host.__writes.at(-1),'Vibrate:14;');
    pointer(guest,'pointerup','#max-hold');await until(()=>host.eval('engine.active===null'),'max hold release');assert.equal(host.__writes.at(-1),'Vibrate:0;');await until(()=>!guest.document.querySelector('#max-hold').classList.contains('active'),'max hold active state clears');
    await pause(550);
    pointer(guest,'pointerdown','#max-hold');await until(()=>host.eval('engine.active?.command==="max-hold"'),'max hold before host Stop');await until(()=>host.__writes.at(-1)==='Vibrate:14;','max hold before host Stop level');click(host,'#stop');await until(()=>host.eval('engine.active===null'),'host Stop ends max hold');assert.equal(host.__writes.at(-1),'Vibrate:0;');pointer(guest,'pointerup','#max-hold');
    await pause(550);
    pointer(guest,'pointerdown');await until(()=>host.eval('engine.active?.command==="random"'),'random start');pointer(guest,'pointerup');await until(()=>host.eval('engine.active===null'),'release stop');assert.equal(host.__writes.at(-1),'Vibrate:0;');
    await pause(550);pointer(guest,'pointerdown');await until(()=>host.eval('engine.active?.command==="random"'),'second hold');guest.eval('clearInterval(holdTimer);holding=null');await until(()=>host.eval('engine.active===null'),'dead-man');assert.equal(host.__writes.at(-1),'Vibrate:0;');
    const staleCount=host.__writes.length;await host.eval('receiveControl({id:"stale-start-123456",command:"hold-start",challenge:"expired"})');assert.equal(host.__writes.length,staleCount);
    const stored={};for(let i=0;i<guest.localStorage.length;i++){const key=guest.localStorage.key(i);stored[key]=guest.localStorage.getItem(key)}guest.close();
    const timerStart=host.eval('teaseStartedAt');const refreshed=page('controller.html','#ABCD',stored);await until(()=>refreshed.eval('guestReady&&lastStateAt>0&&!edgeCountBaselinePending&&!teaseBaselinePending'),'refresh');assert.equal(refreshed.document.querySelector('#pairing').hidden,true);await until(()=>refreshed.document.querySelector('#edge-count').textContent==='EDGE used: 2 times','refresh count');assert.equal(refreshed.eval('celebrationSerial'),0);assert.equal(refreshed.document.querySelector('#edge-celebration').hidden,true);assert.equal(refreshed.eval('teaseStartedAt'),timerStart);assert.match(refreshed.document.querySelector('#tease-timer').textContent,/^Teasing for /);assert.equal(refreshed.__haptics.length,0);
    await refreshed.eval('guestReady=false;channel.state="closed"');await host.eval('edgeUseCount=3');click(host,'[data-tease-stage="3"]');await refreshed.eval('recoverGuestSession()');await until(()=>refreshed.eval('guestReady&&!edgeCountBaselinePending&&!teaseBaselinePending&&edgeCount===3&&teaseStage===3'),'reconnect restored state');assert.equal(refreshed.eval('celebrationSerial'),0);assert.equal(refreshed.document.querySelector('#edge-celebration').hidden,true);assert.equal(refreshed.eval('teaseStartedAt'),timerStart);assert.equal(refreshed.__haptics.length,0);
    const before=host.__writes.length;await host.eval('device.gatt.connected=false;reconnectBluetooth(false)');assert.ok(host.__writes.slice(before).every(command=>command==='Vibrate:0;'));
    await host.eval('remoteReady=false;remoteChannel.state="closed";recoverRemoteSession()');await until(()=>host.eval('remoteReady'),'realtime recovery');assert.equal(host.__writes.at(-1),'Vibrate:0;');
    await pause(550);pointer(refreshed,'pointerdown');await until(()=>host.eval('engine.active?.command==="random"'),'background test hold');host.__visibility='hidden';host.document.dispatchEvent(new host.Event('visibilitychange'));await until(()=>host.eval('engine.active===null'),'host background stop');host.__visibility='visible';host.document.dispatchEvent(new host.Event('visibilitychange'));await pause(100);assert.equal(host.eval('engine.active'),null);
    assert.ok(host.__writes.every(command=>!command.startsWith('Vibrate:')||Number(command.match(/\d+/)[0])<=14));
    const previousSession=host.eval('remoteSessionId');click(host,'#create-controller');await until(()=>host.eval('remoteReady&&remoteSessionId!=='+JSON.stringify(previousSession)),'fresh session reset');assert.equal(host.eval('teaseStage'),1);assert.equal(host.eval('teaseStartedAt'),null);assert.equal(host.document.querySelector('[data-tease-stage="1"]').getAttribute('aria-pressed'),'true');
    authorised=false;const deniedPreview=page('controller.html','?preview=1');await until(()=>deniedPreview.document.querySelector('#status').textContent.includes('Sign in on the host page first'),'preview denied');assert.ok([...deniedPreview.document.querySelectorAll('[data-command]')].every(button=>button.disabled));assert.equal(deniedPreview.__channels.length,0);assert.equal(deniedPreview.__fetchActions.length,0);
    const visitor=page('index.html');await pause(100);assert.equal(visitor.document.querySelector('#host-controls').hidden,true);assert.equal(visitor.document.querySelector('#login').hidden,false);
    assert.deepEqual(errors,[]);console.log('PASS: four signed tease stages and spoof rejection; exact host/guest wording; progressive preview; zero-output stage changes; timer/haptics; EDGE celebration; fixed/HOLD controls; pairing; dead-man; recovery; max14; visitor gate.');
  }finally{for(const window of windows)window.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
