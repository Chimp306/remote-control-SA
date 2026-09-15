// Integration without hardware/network. JSDOM 26.1.0, Node 24.
const {JSDOM,VirtualConsole}=require(process.env.JSDOM_PATH||'jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),windows=[],errors=[];
const profile={id:'guest-1',name:'Test guest',token:'ABCDEFGHJKLMNPQR',pair_code:'ABCD'};
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
    window.__writes=[];window.__channels=[];window.__fetchActions=[];window.__visibility='visible';window.__opened=[];window.__bluetoothRequests=0;
    window.open=url=>{window.__opened.push(url);return {opener:window}};
    Object.defineProperty(window.document,'visibilityState',{get:()=>window.__visibility});
    window.HTMLElement.prototype.setPointerCapture=()=>{};
    for(const [key,value] of Object.entries(storage))window.localStorage.setItem(key,value);
    window.supabase={createClient:()=>({
      auth:{getSession:async()=>({data:{session:authorised?{access_token:'test'}:null}}),onAuthStateChange:()=>{},signOut:async()=>{},signInWithPassword:async()=>({error:null})},realtime:{isConnected:()=>true},
      channel:topic=>{
        const ch={topic,state:'joining',handlers:{},on(type,{event},handler){this.handlers[event]=handler;return this},subscribe(callback){this.callback=callback;setTimeout(()=>{this.state='joined';callback('SUBSCRIBED')},0);return this},async send(message){
          for(const peer of windows)if(peer!==window)for(const channel of peer.__channels)if(channel.state==='joined'&&channel.topic===topic)channel.handlers[message.event]?.({payload:message.payload});return 'ok';
        }};window.__channels.push(ch);return ch;
      },removeChannel:async ch=>{ch.state='closed'}
    })};
    const characteristic={properties:{writeWithoutResponse:true},writeValueWithoutResponse:async bytes=>window.__writes.push(new TextDecoder().decode(bytes))};
    const service={uuid:'test-service',getCharacteristic:async()=>characteristic,getCharacteristics:async()=>[characteristic]};
    const device={name:'LVS-test',addEventListener(type,handler){this[type]=handler},gatt:{connected:false,async connect(){this.connected=true;return this},disconnect(){this.connected=false;device.gattserverdisconnected?.()},getPrimaryService:async()=>service,getPrimaryServices:async()=>[service]}};
    Object.defineProperty(window.navigator,'bluetooth',{value:{requestDevice:async()=>{window.__bluetoothRequests++;return device}}});
    window.fetch=async(url,options)=>{
      const body=JSON.parse(options.body);window.__fetchActions.push({action:body.action,authorization:options.headers.Authorization||null});let result={ok:true};
      if(body.action==='list')result={profiles:[profile]};
      if(['create','rotate'].includes(body.action))result={profile};
      if(body.action==='activate')active={session:body.session,edgeKey:body.edgeKey};
      if(body.action==='end'&&active?.session===body.session)active=null;
      if(body.action==='resolve')result=active?{valid:true,available:true,...active}:{valid:true,available:false};
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
    assert.equal(host.document.querySelector('#guest-name'),null);assert.equal(host.document.querySelector('#guest-select'),null);assert.equal(host.document.querySelector('#rotate-guest'),null);
    assert.equal(host.document.querySelector('#controller-link').value,'');
    assert.equal(host.document.querySelector('#preview-controller').disabled,false);click(host,'#preview-controller');assert.equal(host.__opened[0],'/controller.html?preview=1');assert.equal(host.__bluetoothRequests,0);
    const preview=page('controller.html','?preview=1');await until(()=>!preview.document.querySelector('#preview-badge').hidden,'preview authorisation');
    assert.ok([...preview.document.querySelectorAll('[data-command]')].every(button=>!button.disabled));assert.deepEqual(preview.__fetchActions,[{action:'preview',authorization:'Bearer test'}]);assert.equal(preview.__channels.length,0);assert.equal(preview.__writes.length,0);assert.equal(active,undefined);
    for(const command of ['20','40','60','70']){
      click(preview,'[data-command="'+command+'"]');assert.ok(preview.document.querySelector('[data-command="'+command+'"]').classList.contains('active'));
      preview.eval('previewStartedAt-=100;updatePreviewFixed()');assert.ok(parseFloat(preview.document.querySelector('[data-command="'+command+'"]').style.getPropertyValue('--progress'))>0);
      preview.eval('previewStartedAt-=5000;updatePreviewFixed()');assert.ok(!preview.document.querySelector('[data-command="'+command+'"]').classList.contains('active'));
    }
    pointer(preview,'pointerdown','#random');assert.ok(preview.document.querySelector('#random').classList.contains('active'));pointer(preview,'pointerup','#random');assert.ok(!preview.document.querySelector('#random').classList.contains('active'));
    pointer(preview,'pointerdown','#max-hold');assert.ok(preview.document.querySelector('#max-hold').classList.contains('active'));pointer(preview,'pointerup','#max-hold');assert.ok(!preview.document.querySelector('#max-hold').classList.contains('active'));assert.equal(preview.__channels.length,0);assert.equal(preview.__writes.length,0);
    click(host,'#connect');await until(()=>host.eval('!!tx'),'Bluetooth connect');click(host,'#create-controller');await until(()=>host.eval('remoteReady'),'host session');
    assert.equal(host.document.querySelector('#controller-link').value,'https://ctmp.uk/#ABCD');
    await host.eval('refreshApprovals()');assert.ok(host.document.querySelector('#pair-requests').textContent.includes('Check number 3814'));assert.ok(!host.document.querySelector('#pair-requests').textContent.includes(profile.name));
    const guest=page('controller.html','#ABCD');await until(()=>!guest.document.querySelector('#pairing').hidden,'guest pairing');click(guest,'#request-access');await until(()=>guest.document.querySelector('#pairing-message').textContent.includes('7261'),'check number');assert.equal(guest.document.querySelector('[data-command="70"]').disabled,true);
    approved=true;await guest.eval('pollPairing()');await until(()=>guest.eval('guestReady&&lastStateAt>0'),'signed ready');
    click(guest,'[data-command="70"]');await until(()=>host.__writes.includes('Vibrate:14;'),'peak 14');assert.ok(guest.document.querySelector('[data-command="70"]').classList.contains('active'));
    await until(()=>parseFloat(guest.document.querySelector('[data-command="70"]').style.getPropertyValue('--progress'))>0,'fixed progress fill');
    pointer(guest,'pointerdown','#max-hold');await until(()=>host.eval('engine.active?.command==="max-hold"'),'max hold before EDGE');await until(()=>host.__writes.at(-1)==='Vibrate:14;','max hold before EDGE level');
    click(host,'#edge');await until(()=>host.eval('engine.active===null'),'EDGE stops max hold');assert.equal(host.__writes.at(-1),'Vibrate:0;');await until(()=>guest.document.querySelector('#status').textContent.includes('paused'),'EDGE UI');await until(()=>guest.document.querySelector('#edge-count').textContent==='EDGE used: 1 time','signed count');
    const count=host.__writes.length;await host.eval('receiveControl({command:"70",id:"fake-command-123456",challenge:[...challenges.keys()][0]})');assert.equal(host.__writes.length,count);
    await guest.eval('receiveEdgeCount({count:999,signature:"AAAA"})');assert.equal(guest.document.querySelector('#edge-count').textContent,'EDGE used: 1 time');
    click(host,'#edge');await until(()=>guest.document.querySelector('#edge-count').textContent==='EDGE used: 2 times','repeat EDGE');assert.ok(host.eval('edgeLockUntil-Date.now()>29000'));
    host.eval('edgeLockUntil=Date.now()-1;updateEdgeCountdown()');await until(()=>!guest.document.querySelector('#random').disabled,'unlock');
    pointer(guest,'pointerdown','#max-hold');await until(()=>host.eval('engine.active?.command==="max-hold"'),'max hold start');await until(()=>host.__writes.at(-1)==='Vibrate:14;','max hold level');await until(()=>guest.document.querySelector('#max-hold').classList.contains('active'),'signed max hold active state');
    pointer(guest,'pointerup','#max-hold');await until(()=>host.eval('engine.active===null'),'max hold release');assert.equal(host.__writes.at(-1),'Vibrate:0;');await until(()=>!guest.document.querySelector('#max-hold').classList.contains('active'),'max hold active state clears');
    await pause(550);
    pointer(guest,'pointerdown','#max-hold');await until(()=>host.eval('engine.active?.command==="max-hold"'),'max hold before host Stop');await until(()=>host.__writes.at(-1)==='Vibrate:14;','max hold before host Stop level');click(host,'#stop');await until(()=>host.eval('engine.active===null'),'host Stop ends max hold');assert.equal(host.__writes.at(-1),'Vibrate:0;');pointer(guest,'pointerup','#max-hold');
    await pause(550);
    pointer(guest,'pointerdown');await until(()=>host.eval('engine.active?.command==="random"'),'random start');pointer(guest,'pointerup');await until(()=>host.eval('engine.active===null'),'release stop');assert.equal(host.__writes.at(-1),'Vibrate:0;');
    await pause(550);pointer(guest,'pointerdown');await until(()=>host.eval('engine.active?.command==="random"'),'second hold');guest.eval('clearInterval(holdTimer);holding=null');await until(()=>host.eval('engine.active===null'),'dead-man');assert.equal(host.__writes.at(-1),'Vibrate:0;');
    const staleCount=host.__writes.length;await host.eval('receiveControl({id:"stale-start-123456",command:"hold-start",challenge:"expired"})');assert.equal(host.__writes.length,staleCount);
    const stored={};for(let i=0;i<guest.localStorage.length;i++){const key=guest.localStorage.key(i);stored[key]=guest.localStorage.getItem(key)}guest.close();
    const refreshed=page('controller.html','#ABCD',stored);await until(()=>refreshed.eval('guestReady&&lastStateAt>0'),'refresh');assert.equal(refreshed.document.querySelector('#pairing').hidden,true);await until(()=>refreshed.document.querySelector('#edge-count').textContent==='EDGE used: 2 times','refresh count');
    const before=host.__writes.length;await host.eval('device.gatt.connected=false;reconnectBluetooth(false)');assert.ok(host.__writes.slice(before).every(command=>command==='Vibrate:0;'));
    await host.eval('remoteReady=false;remoteChannel.state="closed";recoverRemoteSession()');await until(()=>host.eval('remoteReady'),'realtime recovery');assert.equal(host.__writes.at(-1),'Vibrate:0;');
    await pause(550);pointer(refreshed,'pointerdown');await until(()=>host.eval('engine.active?.command==="random"'),'background test hold');host.__visibility='hidden';host.document.dispatchEvent(new host.Event('visibilitychange'));await until(()=>host.eval('engine.active===null'),'host background stop');host.__visibility='visible';host.document.dispatchEvent(new host.Event('visibilitychange'));await pause(100);assert.equal(host.eval('engine.active'),null);
    assert.ok(host.__writes.every(command=>!command.startsWith('Vibrate:')||Number(command.match(/\d+/)[0])<=14));
    authorised=false;const deniedPreview=page('controller.html','?preview=1');await until(()=>deniedPreview.document.querySelector('#status').textContent.includes('Sign in on the host page first'),'preview denied');assert.ok([...deniedPreview.document.querySelectorAll('[data-command]')].every(button=>button.disabled));assert.equal(deniedPreview.__channels.length,0);assert.equal(deniedPreview.__fetchActions.length,0);
    const visitor=page('index.html');await pause(100);assert.equal(visitor.document.querySelector('#host-controls').hidden,true);assert.equal(visitor.document.querySelector('#login').hidden,false);
    assert.deepEqual(errors,[]);console.log('PASS: authenticated no-device preview with local-only fixed/HOLD interactions; compact host workflow; pairing and storage; signed state/count and forgery; EDGE/repeat; random/MAX hold release and dead-man; stale command; refresh; GATT/realtime recovery; host background stop; max14; visitor login gate.');
  }finally{for(const window of windows)window.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
