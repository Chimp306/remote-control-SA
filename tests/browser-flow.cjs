// Local integration: real Chromium/WebCrypto + simulated Bluetooth and backend.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const root=path.resolve(__dirname,'..');
const firstCelebrations=['Edged me! ❤️','EDGED! ❤️'];
const laterCelebrations=['Edged — nice work 😈','You found my limit — edged 🔥','Edged me again! 😏','Good girl — edged me! 😉','Perfect. 😈','Edged me! ❤️','EDGED! ❤️'];
const server=http.createServer((req,res)=>{
  const file=path.join(root,req.url.split('?')[0]==='/'?'index.html':req.url.split('?')[0]);
  if(!file.startsWith(root)){res.writeHead(403).end();return}
  try{res.setHeader('Content-Type',file.endsWith('.html')?'text/html':'text/javascript');res.end(fs.readFileSync(file))}catch{res.writeHead(404).end()}
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  let active,approved=false;const profile={id:'11111111-1111-4111-8111-111111111111',name:'Test guest',token:'ABCDEFGHJKLMNPQR',pair_code:'ABCD'};
  const pages=[],errors=[];
  await context.exposeBinding('relay',async({page},topic,message)=>{
    for(const peer of pages)if(peer!==page&&!peer.isClosed())await peer.evaluate(({topic,message})=>{for(const ch of window.channels||[])if(ch.topic===topic&&ch.state==='joined')ch.handlers[message.event]?.({payload:message.payload})},{topic,message});
    return 'ok';
  });
  await context.addInitScript(()=>{
    window.channels=[];window.__writes=[];window.__haptics=[];
    Object.defineProperty(navigator,'vibrate',{value:pattern=>{window.__haptics.push(pattern);return true},configurable:true});
    window.supabase={createClient:()=>({
      auth:{getSession:async()=>({data:{session:{access_token:'test-only'}}}),onAuthStateChange:()=>{},signOut:async()=>{},signInWithPassword:async()=>({error:null})},
      realtime:{isConnected:()=>true},
      channel:topic=>{const ch={topic,state:'joining',handlers:{},on(type,{event},handler){this.handlers[event]=handler;return this},subscribe(callback){this.callback=callback;setTimeout(()=>{this.state='joined';callback('SUBSCRIBED')},0);return this},send(message){return window.relay(topic,message)}};window.channels.push(ch);return ch},
      removeChannel:async ch=>{ch.state='closed'}
    })};
    const characteristic={properties:{writeWithoutResponse:true},writeValueWithoutResponse:async bytes=>window.__writes.push({command:new TextDecoder().decode(bytes),time:performance.now()})};
    const service={uuid:'test',getCharacteristic:async()=>characteristic,getCharacteristics:async()=>[characteristic]};
    const device={name:'LVS-test',addEventListener(type,handler){this[type]=handler},gatt:{connected:false,async connect(){this.connected=true;return this},disconnect(){this.connected=false;device.gattserverdisconnected?.()},getPrimaryService:async()=>service,getPrimaryServices:async()=>[service]}};
    Object.defineProperty(navigator,'bluetooth',{value:{requestDevice:async()=>device},configurable:true});
  });
  await context.route('https://cdn.jsdelivr.net/**',route=>route.fulfill({body:'/* Supabase simulated by test harness */',contentType:'text/javascript'}));
  await context.route('https://hqciviafxtfescteyvnn.supabase.co/functions/v1/guest-access',async route=>{
    const body=route.request().postDataJSON();let result={ok:true};
    if(body.action==='list')result={profiles:[profile]};
    if(['create','rotate'].includes(body.action)){profile.name=body.name;result={profile}}
    if(body.action==='activate'){active={session:body.session,edgeKey:body.edgeKey};}
    if(body.action==='end'&&active?.session===body.session)active=null;
    if(body.action==='resolve')result=active?{valid:true,available:true,name:profile.name,...active}:{valid:true,available:false,name:profile.name};
    if(body.action==='pair-list')result={requests:[]};
    if(body.action==='pair-request'||body.action==='pair-poll')result=approved?{state:'approved',token:profile.token}:{state:'pending',checkNumber:'7261'};
    await route.fulfill({contentType:'application/json',body:JSON.stringify(result),headers:{'Access-Control-Allow-Origin':'*'}});
  });
  try{
    const host=await context.newPage();pages.push(host);host.on('pageerror',e=>errors.push(e.message));
    await host.goto(origin);await host.locator('#host-controls').waitFor({state:'visible'});
    assert.equal(await host.locator('#guest-name').count(),1);assert.equal(await host.locator('#guest-select').count(),0);assert.equal(await host.locator('#rotate-guest').count(),0);assert.equal(await host.locator('.advanced').evaluate(details=>details.open),false);
    assert.equal(await host.locator('#controller-link').inputValue(),'');
    await host.locator('#guest-name').fill('Sophie');
    assert.equal(await host.locator('#preview-controller').isEnabled(),true);
    const previewPromise=context.waitForEvent('page');await host.locator('#preview-controller').click();const preview=await previewPromise;pages.push(preview);preview.on('pageerror',e=>errors.push(e.message));
    await preview.locator('#preview-badge').waitFor({state:'visible'});assert.equal(await preview.locator('#guest-welcome').textContent(),'WELCOME, SOPHIE');assert.equal(await preview.locator('[data-command]:enabled').count(),6);assert.equal(await preview.evaluate(()=>window.channels.length),0);
    await preview.locator('[data-command="20"]').click();await preview.waitForFunction(()=>parseFloat(document.querySelector('[data-command="20"]').style.getPropertyValue('--progress'))>0);
    await preview.evaluate(()=>{previewStartedAt-=5000;updatePreviewFixed()});assert.equal(await preview.locator('[data-command="20"]').evaluate(button=>button.classList.contains('active')),false);
    const previewHold=await preview.locator('#max-hold').boundingBox();await preview.mouse.move(previewHold.x+20,previewHold.y+20);await preview.mouse.down();assert.equal(await preview.locator('#max-hold').evaluate(button=>button.classList.contains('active')),true);await preview.mouse.up();assert.equal(await preview.locator('#max-hold').evaluate(button=>button.classList.contains('active')),false);
    await preview.locator('#manual-toggle').click();const previewManual=await preview.locator('#manual-slider').boundingBox();await preview.mouse.move(previewManual.x+previewManual.width/2,previewManual.y+previewManual.height/2);await preview.mouse.down();assert.match(await preview.locator('#manual-readout').textContent(),/^3[45]%$/);await preview.mouse.move(previewManual.x+previewManual.width/2,previewManual.y);assert.equal(await preview.locator('#manual-slider').getAttribute('aria-valuenow'),'70');await preview.mouse.up();assert.equal(await preview.locator('#manual-slider').getAttribute('aria-valuenow'),'0');assert.equal(await preview.evaluate(()=>window.channels.length),0);
    assert.deepEqual(await host.locator('[data-tease-stage]').allTextContents(),['LOW','MEDIUM','DESPERATE!','MAXIMUM FRUSTRATION']);assert.equal(await preview.locator('#tease-message').textContent(),'LOW');assert.equal(await preview.locator('#tease-copy').textContent(),'Are you sure you’re teasing?');assert.equal(await preview.locator('#tease-timer').textContent(),'Teasing for 0:00');await preview.locator('[data-preview-stage="2"]').click();assert.equal(await preview.locator('#tease-message').textContent(),'MEDIUM');await preview.locator('[data-preview-stage="3"]').click();assert.equal(await preview.locator('#tease-message').textContent(),'DESPERATE!');await preview.locator('[data-preview-stage="4"]').click();assert.equal(await preview.locator('#tease-message').textContent(),'MAXIMUM FRUSTRATION');assert.equal(await preview.locator('#tease-copy').textContent(),'PLEASE!');await preview.locator('#preview-timer').click();assert.equal(await preview.locator('#tease-timer').textContent(),'Teasing for 0:00');await preview.locator('#preview-haptic').click();assert.equal(await preview.locator('#haptic-state').textContent(),'TEASE TAP');
    await preview.locator('#preview-edge-first').click();const previewFirst=await preview.locator('#celebration-message').textContent();assert.ok(firstCelebrations.includes(previewFirst));await preview.locator('#preview-edge-later').click();const previewLater=await preview.locator('#celebration-message').textContent();assert.ok(laterCelebrations.includes(previewLater));assert.notEqual(previewLater,previewFirst);assert.equal(await preview.locator('#edge-count').textContent(),'EDGE used: 0 times · preview');assert.equal(await preview.evaluate(()=>window.channels.length),0);await preview.close();
    await host.locator('#connect').click();await host.locator('#create-controller').waitFor({state:'visible'});await host.locator('#create-controller').click();
    await host.waitForFunction(()=>remoteReady);
    assert.equal(await host.locator('#controller-link').inputValue(),'https://ctmp.uk/#ABCD');assert.equal(await host.locator('#device-state').textContent(),'Connected');
    const guest=await context.newPage();pages.push(guest);guest.on('pageerror',e=>errors.push(e.message));
    await guest.goto(origin+'/controller.html#ABCD');await guest.locator('#request-access').click();await guest.waitForFunction(()=>document.querySelector('#pairing-message').textContent.includes('7261'));
    assert.equal(await guest.locator('[data-command="20"]').isDisabled(),true);
    approved=true;await guest.evaluate(()=>pollPairing());await guest.waitForFunction(()=>guestReady&&lastStateAt>0&&!edgeCountBaselinePending&&!teaseBaselinePending);assert.equal(await guest.locator('#guest-welcome').textContent(),'WELCOME, SOPHIE');assert.equal(await guest.locator('.control .release').count(),2);assert.equal(await guest.evaluate(()=>celebrationSerial),0);assert.ok(Number.isSafeInteger(await guest.evaluate(()=>teaseStartedAt)));
    const writesBeforeStage=await host.evaluate(()=>window.__writes.length);await host.locator('[data-tease-stage="2"]').click();await guest.waitForFunction(()=>teaseStage===2);assert.equal(await guest.locator('#tease-message').textContent(),'MEDIUM');assert.equal(await guest.locator('#tease-copy').textContent(),'I know I’m being teased now.');assert.equal(await host.evaluate(()=>window.__writes.length),writesBeforeStage);assert.equal(await host.evaluate(()=>engine.active),null);await guest.evaluate(()=>receiveTeaseState({message:JSON.stringify({stage:4,startedAt:null,seq:9999}),signature:'AAAA'}));assert.equal(await guest.evaluate(()=>teaseStage),2);
    await guest.screenshot({path:'/tmp/lushcon-guest-ready.png',fullPage:true});
    await guest.locator('#manual-toggle').click();const manual=await guest.locator('#manual-slider').boundingBox();await guest.mouse.move(manual.x+manual.width/2,manual.y+manual.height/2);await guest.mouse.down();await host.waitForFunction(()=>engine.active?.command==='manual');await guest.mouse.move(manual.x+manual.width/2,manual.y);await host.waitForFunction(()=>window.__writes.at(-1)?.command==='Vibrate:14;');await guest.mouse.up();await host.waitForFunction(()=>engine.active===null);assert.equal(await host.evaluate(()=>window.__writes.at(-1).command),'Vibrate:0;');assert.equal(await guest.locator('#manual-slider').getAttribute('aria-valuenow'),'0');
    await guest.locator('[data-command="70"]').click();await guest.waitForFunction(()=>document.querySelector('[data-command="70"]').classList.contains('active'));
    await host.waitForFunction(()=>window.__writes.some(w=>w.command==='Vibrate:14;'));
    await guest.waitForFunction(()=>teaseStartedAt!==null);assert.equal(await guest.evaluate(()=>teaseStartedAt),await host.evaluate(()=>teaseStartedAt));assert.match(await guest.locator('#tease-timer').textContent(),/^Teasing for /);assert.ok((await guest.evaluate(()=>window.__haptics)).includes(12));
    await host.locator('#edge').click();await guest.waitForFunction(()=>document.querySelector('#status').textContent.includes('paused')&&celebrationSerial===1);
    const edgeCount=await guest.locator('#edge-count').textContent();assert.equal(edgeCount,'EDGE used: 1 time');
    assert.ok(firstCelebrations.includes(await guest.locator('#celebration-message').textContent()));
    // Forged count and host acknowledgement must fail signature verification.
    await guest.evaluate(()=>{receiveEdgeCount({count:999,signature:'AAAA'});receiveHostState({message:JSON.stringify({seq:9999,state:'ready'}),signature:'AAAA'})});
    assert.equal(await guest.locator('#edge-count').textContent(),edgeCount);assert.equal(await guest.evaluate(()=>celebrationSerial),1);
    await host.evaluate(()=>{edgeLockUntil=Date.now()-1;updateEdgeCountdown()});await guest.waitForFunction(()=>!document.querySelector('#random').disabled);
    const maxHoldBox=await guest.locator('#max-hold').boundingBox();await guest.mouse.move(maxHoldBox.x+20,maxHoldBox.y+20);await guest.mouse.down();
    await host.waitForFunction(()=>engine.active?.command==='max-hold');await host.waitForFunction(()=>window.__writes.at(-1)?.command==='Vibrate:14;');await guest.mouse.up();await host.waitForFunction(()=>engine.active===null);
    // Real pointer capture requires an active pointer; mouse exercises Chromium's pointer pipeline.
    const box=await guest.locator('#random').boundingBox();await guest.mouse.move(box.x+20,box.y+20);await guest.mouse.down();
    await host.waitForFunction(()=>engine.active?.command==='random');await guest.mouse.up();await host.waitForFunction(()=>engine.active===null);
    assert.equal(await host.evaluate(()=>window.__writes.at(-1).command),'Vibrate:0;');
    await guest.mouse.down();await host.waitForFunction(()=>engine.active?.command==='random');
    // Simulate dropped release + all heartbeats: host must stop by its own clock.
    await guest.evaluate(()=>{clearInterval(holdTimer);holding=null});await host.waitForFunction(()=>engine.active===null,{},{timeout:2500});await guest.mouse.up();
    const before=await host.evaluate(()=>window.__writes.length);
    await host.evaluate(()=>receiveControl({id:'late-start-123456789',command:'hold-start',challenge:'expired-challenge'}));
    assert.equal(await host.evaluate(()=>window.__writes.length),before);
    const timerStart=await host.evaluate(()=>teaseStartedAt);await guest.reload();await guest.waitForFunction(()=>guestReady&&lastStateAt>0&&!edgeCountBaselinePending&&!teaseBaselinePending);assert.equal(await guest.locator('#pairing').isHidden(),true);assert.equal(await guest.locator('#edge-count').textContent(),'EDGE used: 1 time');assert.equal(await guest.evaluate(()=>celebrationSerial),0);assert.equal(await guest.locator('#edge-celebration').isHidden(),true);assert.equal(await guest.evaluate(()=>teaseStartedAt),timerStart);assert.equal(await guest.evaluate(()=>window.__haptics.length),0);
    await host.locator('#stop').click();assert.equal(await host.evaluate(()=>window.__writes.at(-1).command),'Vibrate:0;');
    // Existing GATT recovery path must only write a stop, never start a pattern.
    const start=await host.evaluate(()=>window.__writes.length);
    await host.evaluate(async()=>{device.gatt.connected=false;await reconnectBluetooth(false)});
    const recovered=await host.evaluate(start=>window.__writes.slice(start),start);assert.ok(recovered.every(w=>w.command==='Vibrate:0;'));
    assert.ok((await host.evaluate(()=>window.__writes)).every(w=>!w.command.startsWith('Vibrate:')||Number(w.command.match(/\d+/)[0])<=14));
    // A plain visitor sees login + code entry, never controls.
    await context.route('**/functions/v1/guest-access',route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'Sign in required'}),headers:{'Access-Control-Allow-Origin':'*'}}));
    const visitor=await context.newPage();await visitor.goto(origin);await visitor.locator('#login').waitFor({state:'visible'});assert.equal(await visitor.locator('#host-controls').isHidden(),true);await visitor.screenshot({path:'/tmp/lushcon-host-login.png',fullPage:true});
    assert.deepEqual(errors,[]);console.log('PASS: Manual Control interaction and isolated preview; signed state/timer recovery; acknowledgement haptics; pairing; EDGE; HOLD dead-man; GATT recovery and max level.');
  }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
