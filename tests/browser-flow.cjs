// Local integration: real Chromium/WebCrypto + simulated Bluetooth and backend.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const root=path.resolve(__dirname,'..');
const firstCelebrations=['Edged me! ❤️','EDGED! ❤️'];
const laterCelebrations=['Edged — nice work 😈','You found my limit — edged 🔥','Edged me again! 😏','Good girl — edged me! 😉','Perfect. 😈','Edged me! ❤️','EDGED! ❤️'];
const server=http.createServer((req,res)=>{
  const file=path.join(root,req.url.split('?')[0]==='/'?'index.html':req.url.split('?')[0]);
  if(!file.startsWith(root)){res.writeHead(403).end();return}
  try{res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.jpg')?'image/jpeg':'text/javascript');res.end(fs.readFileSync(file))}catch{res.writeHead(404).end()}
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE,args:["--no-sandbox"]}:{})});
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
    if(body.action==='activate'){active={session:body.session,edgeKey:body.edgeKey,contactKey:body.contactKey};}
    if(body.action==='end'&&active?.session===body.session)active=null;
    if(body.action==='resolve')result=active?{valid:true,available:true,name:profile.name,...active}:{valid:true,available:false,name:profile.name};
    if(body.action==='pair-list')result={requests:approved?[]:[{id:'request-1',profile_id:profile.id,check_number:'7261'}]};
    if(body.action==='pair-approve')approved=true;
    if(body.action==='pair-request'||body.action==='pair-poll')result=approved?{state:'approved',token:profile.token}:{state:'pending',checkNumber:'7261'};
    await route.fulfill({contentType:'application/json',body:JSON.stringify(result),headers:{'Access-Control-Allow-Origin':'*'}});
  });
  try{
    const host=await context.newPage();pages.push(host);host.on('pageerror',e=>errors.push(e.message));
    await host.goto(origin);await host.locator('#live-session').waitFor({state:'visible'});
    assert.equal(await host.locator('#host-setup').isHidden(),true);assert.match(await host.locator('#live-session-state').textContent(),/Toy disconnected · No guest connected/);
    assert.equal(await host.locator('#stop').isDisabled(),true);assert.equal(await host.locator('#edge').isDisabled(),true);assert.equal(await host.locator('#live-arousal-slot button').first().isDisabled(),true);
    await host.locator('#live-invite-toggle').click();await host.locator('#live-invite').waitFor({state:'visible'});
    assert.equal(await host.locator('#guest-name').count(),1);assert.equal(await host.locator('#guest-select').count(),0);assert.equal(await host.locator('#rotate-guest').count(),0);assert.equal(await host.locator('.advanced').evaluate(details=>details.open),false);
    assert.equal(await host.locator('#controller-link').inputValue(),'');assert.equal(await host.locator('#enter-live').isDisabled(),false);
    await host.locator('#guest-name').fill('Sophie');
    assert.equal(await host.locator('#preview-controller').isEnabled(),true);
    const previewPromise=context.waitForEvent('page');await host.locator('#preview-controller').click();const preview=await previewPromise;pages.push(preview);preview.on('pageerror',e=>errors.push(e.message));
    await preview.locator('#preview-badge').waitFor({state:'visible'});assert.equal(await preview.locator('#rating-panel #haptic-state').count(),1);assert.equal(await preview.locator('#tease-panel #haptic-state').count(),0);assert.equal(await preview.locator('#guest-welcome').textContent(),'WELCOME, SOPHIE');assert.equal(await preview.locator('[data-command]:enabled').count(),6);assert.equal(await preview.evaluate(()=>window.channels.length),0);
    await preview.locator('[data-command="20"]').click();await preview.waitForFunction(()=>parseFloat(document.querySelector('[data-command="20"]').style.getPropertyValue('--progress'))>0);
    await preview.evaluate(()=>{previewStartedAt-=5000;updatePreviewFixed()});assert.equal(await preview.locator('[data-command="20"]').evaluate(button=>button.classList.contains('active')),false);
    const previewHold=await preview.locator('#max-hold').boundingBox();await preview.mouse.move(previewHold.x+20,previewHold.y+20);await preview.mouse.down();assert.equal(await preview.locator('#max-hold').evaluate(button=>button.classList.contains('active')),true);await preview.mouse.up();assert.equal(await preview.locator('#max-hold').evaluate(button=>button.classList.contains('active')),false);
    await preview.locator('#manual-toggle').click();await preview.locator('#manual-slider').scrollIntoViewIfNeeded();const previewManual=await preview.locator('#manual-slider').boundingBox();await preview.mouse.move(previewManual.x+previewManual.width/2,previewManual.y+previewManual.height/2);await preview.mouse.down();assert.match(await preview.locator('#manual-readout').textContent(),/^4[89]%|5[01]%$/);await preview.mouse.move(previewManual.x+previewManual.width/2,previewManual.y);assert.equal(await preview.locator('#manual-slider').getAttribute('aria-valuenow'),'100');assert.equal(await preview.locator('#manual-readout').textContent(),'MAX');await preview.mouse.up();assert.equal(await preview.locator('#manual-slider').getAttribute('aria-valuenow'),'0');assert.equal(await preview.evaluate(()=>window.channels.length),0);
    assert.equal(await preview.locator('h1').textContent(),'Teasemeplease');assert.equal(await preview.locator('.subtitle').count(),0);await preview.locator('#wild-toggle').click();assert.equal(await preview.locator('#wild-panel').isVisible(),true);assert.equal(await preview.locator('.wild-list li').count(),7);assert.ok((await preview.locator('#wild-panel').textContent()).includes('Be curious.'));await preview.locator('#contact-toggle').click();assert.equal(await preview.locator('#contact-send').isEnabled(),false);assert.ok((await preview.locator('#contact-panel').textContent()).includes('steve.ctmp@gmail.com'));assert.ok((await preview.locator('#contact-panel').textContent()).includes('@Stevectmp'));assert.equal((await preview.locator('#contact-panel').textContent()).includes('WhatsApp'),false);assert.deepEqual(await host.locator('[data-tease-stage]').allTextContents(),['LOW','MEDIUM','DESPERATE!','MAXIMUM FRUSTRATION']);assert.deepEqual(await host.locator('[data-tease-rating]').allTextContents(),['FUN TEASE','A LITTLE MEAN 😏','DANGEROUSLY GOOD 😈','GIRL OF MY DREAMS ❤️']);assert.equal(await preview.locator('#tease-message').textContent(),'LOW');assert.equal(await preview.locator('#tease-copy').textContent(),'Are you sure you’re teasing?');assert.equal(await preview.locator('#tease-timer').textContent(),'Teasing for 0:00');await preview.locator('[data-preview-stage="2"]').click();assert.equal(await preview.locator('#tease-message').textContent(),'MEDIUM');await preview.locator('[data-preview-stage="3"]').click();assert.equal(await preview.locator('#tease-message').textContent(),'DESPERATE!');await preview.locator('[data-preview-stage="4"]').click();assert.equal(await preview.locator('#tease-message').textContent(),'MAXIMUM FRUSTRATION');assert.equal(await preview.locator('#tease-copy').textContent(),'PLEASE!');await preview.locator('[data-preview-rating="4"]').click();assert.equal(await preview.locator('#rating-message').textContent(),'GIRL OF MY DREAMS ❤️');assert.equal(await preview.locator('#rating-copy').textContent(),'Perfect!');await preview.locator('#preview-timer').click();assert.equal(await preview.locator('#tease-timer').textContent(),'Teasing for 0:00');await preview.locator('#preview-haptic').click();assert.equal(await preview.locator('#haptic-state').textContent(),'TEASE TAP');
    await preview.locator('#preview-edge-first').click();const previewFirst=await preview.locator('#celebration-message').textContent();assert.ok(firstCelebrations.includes(previewFirst));await preview.locator('#preview-edge-later').click();const previewLater=await preview.locator('#celebration-message').textContent();assert.ok(laterCelebrations.includes(previewLater));assert.notEqual(previewLater,previewFirst);assert.equal(await preview.locator('#edge-count').textContent(),'EDGE used: 0 times · preview');assert.equal(await preview.evaluate(()=>window.channels.length),0);await preview.close();
    await host.locator('#live-invite-close').click();await host.locator('#leave-live').click();
    await host.locator('#connect').click();await host.locator('#enter-live').click();await host.locator('#live-session').waitFor({state:'visible'});
    await host.locator('#live-invite-toggle').click();await host.locator('#create-controller').waitFor({state:'visible'});await host.locator('#create-controller').click();
    await host.waitForFunction(()=>remoteReady);
    assert.equal(await host.locator('#controller-link').inputValue(),'https://ctmp.uk/#ABCD');assert.equal(await host.locator('#copy-controller').isEnabled(),true);assert.equal(await host.locator('#end-session').isVisible(),true);assert.equal(await host.locator('#device-state').textContent(),'Connected');
    await host.screenshot({path:'/tmp/lushcon-live-invite.png',fullPage:true});
    const guest=await context.newPage();pages.push(guest);guest.on('pageerror',e=>errors.push(e.message));
    await guest.goto(origin+'/controller.html#ABCD');await guest.locator('#request-access').click();await guest.waitForFunction(()=>document.querySelector('#pairing-message').textContent.includes('7261'));
    assert.equal(await guest.locator('[data-command="20"]').isDisabled(),true);
    assert.equal(await host.locator('#live-session').isVisible(),true);
    assert.equal(await host.locator('#live-invite').isVisible(),true);assert.equal(await host.locator('#enter-live').isDisabled(),false);
    assert.match(await host.locator('#live-invite-toggle').textContent(),/Manage Sophie/);assert.equal(await host.locator('#live-guest').textContent(),'Guest: Sophie');
    const beforeApproval=await host.evaluate(()=>window.__writes.length);
    await host.evaluate(()=>refreshApprovals());
    await host.getByRole('button',{name:'Approve browser'}).click();
    await host.locator('#live-session').waitFor({state:'visible'});
    assert.equal(await host.locator('#live-arousal-slot [data-tease-stage]').count(),4);
    assert.equal(await host.locator('#live-rating-slot [data-tease-rating]').count(),4);
    assert.equal(await host.locator('.live-battery').count(),0);
    assert.equal(await host.evaluate(()=>window.__writes.length),beforeApproval);
    assert.match(await host.locator('#live-backdrop').evaluate(el=>el.style.backgroundImage),/host-live-background.jpg/);
    await guest.evaluate(()=>pollPairing());await guest.waitForFunction(()=>guestReady&&lastStateAt>0&&!edgeCountBaselinePending&&!teaseBaselinePending&&!ratingBaselinePending);assert.equal(await guest.locator('#guest-welcome').textContent(),'WELCOME, SOPHIE');assert.equal(await guest.locator('.control .release').count(),2);assert.equal(await guest.evaluate(()=>celebrationSerial),0);assert.ok(Number.isSafeInteger(await guest.evaluate(()=>teaseStartedAt)));await guest.locator('#contact-toggle').click();await guest.locator('#contact-value').fill('sophie@example.com');const contactWrites=await host.evaluate(()=>window.__writes.length);await guest.locator('#contact-send').click();await host.locator('#guest-contact-card').waitFor({state:'visible'});assert.equal(await host.locator('#guest-contact-value').textContent(),'sophie@example.com');assert.equal(await host.evaluate(()=>window.__writes.length),contactWrites);
    await host.locator('#live-invite-close').click();
    const writesBeforeStage=await host.evaluate(()=>window.__writes.length);await host.locator('[data-tease-stage="2"]').click();await guest.waitForFunction(()=>teaseStage===2);assert.equal(await guest.locator('#tease-message').textContent(),'MEDIUM');assert.equal(await guest.locator('#tease-copy').textContent(),'I know I’m being teased now.');assert.equal(await host.evaluate(()=>window.__writes.length),writesBeforeStage);assert.equal(await host.evaluate(()=>engine.active),null);await guest.evaluate(()=>receiveTeaseState({message:JSON.stringify({stage:4,startedAt:null,seq:9999}),signature:'AAAA'}));assert.equal(await guest.evaluate(()=>teaseStage),2);
    await host.locator('[data-tease-rating="3"]').click();await guest.waitForFunction(()=>teaseRating===3);assert.equal(await guest.locator('#rating-message').textContent(),'DANGEROUSLY GOOD 😈');assert.equal(await guest.locator('#rating-copy').textContent(),'You know exactly what you’re doing.');assert.equal(await host.evaluate(()=>window.__writes.length),writesBeforeStage);assert.equal(await host.evaluate(()=>engine.active),null);await guest.evaluate(()=>receiveTeaseRating({message:JSON.stringify({rating:4,seq:9999}),signature:'AAAA'}));assert.equal(await guest.evaluate(()=>teaseRating),3);
    await guest.screenshot({path:'/tmp/lushcon-guest-ready.png',fullPage:true});
    await guest.locator('#manual-toggle').click();await guest.locator('#manual-slider').scrollIntoViewIfNeeded();const manual=await guest.locator('#manual-slider').boundingBox();await guest.mouse.move(manual.x+manual.width/2,manual.y+manual.height/2);await guest.mouse.down();await host.waitForFunction(()=>engine.active?.command==='manual');await guest.mouse.move(manual.x+manual.width/2,manual.y);await host.waitForFunction(()=>window.__writes.at(-1)?.command==='Vibrate:14;');await guest.mouse.up();await host.waitForFunction(()=>engine.active===null);assert.equal(await host.evaluate(()=>window.__writes.at(-1).command),'Vibrate:0;');assert.equal(await guest.locator('#manual-slider').getAttribute('aria-valuenow'),'0');
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
    const timerStart=await host.evaluate(()=>teaseStartedAt);await guest.reload();await guest.waitForFunction(()=>guestReady&&lastStateAt>0&&!edgeCountBaselinePending&&!teaseBaselinePending&&!ratingBaselinePending);assert.equal(await guest.locator('#pairing').isHidden(),true);assert.equal(await guest.locator('#edge-count').textContent(),'EDGE used: 1 time');assert.equal(await guest.evaluate(()=>celebrationSerial),0);assert.equal(await guest.locator('#edge-celebration').isHidden(),true);assert.equal(await guest.evaluate(()=>teaseStartedAt),timerStart);assert.equal(await guest.evaluate(()=>teaseRating),3);assert.equal(await guest.evaluate(()=>window.__haptics.length),0);
    await host.locator('#stop').click();assert.equal(await host.evaluate(()=>window.__writes.at(-1).command),'Vibrate:0;');
    // Existing GATT recovery path must only write a stop, never start a pattern.
    const start=await host.evaluate(()=>window.__writes.length);
    await host.evaluate(async()=>{device.gatt.connected=false;await reconnectBluetooth(false)});
    const recovered=await host.evaluate(start=>window.__writes.slice(start),start);assert.ok(recovered.every(w=>w.command==='Vibrate:0;'));
    assert.ok((await host.evaluate(()=>window.__writes)).every(w=>!w.command.startsWith('Vibrate:')||Number(w.command.match(/\d+/)[0])<=14));
    // Returning to setup must stay there, including across a recovery refresh.
    await host.locator('#leave-live').click();
    await host.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
    assert.equal(await host.locator('#host-setup').isVisible(),true);
    assert.equal(await host.locator('#host-setup [data-tease-stage]').count(),4);
    assert.equal(await host.locator('#host-setup [data-tease-rating]').count(),4);
    // Live Session is a view: opening, closing and local images add no device writes.
    await host.waitForFunction(()=>!document.querySelector('#enter-live').disabled);
    const beforeLive=await host.evaluate(()=>window.__writes.length);
    await host.locator('#live-background-input').setInputFiles({name:'private-test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
    const localURL=await host.locator('#live-backdrop').evaluate(el=>el.style.backgroundImage);
    assert.match(localURL,/blob:/);assert.equal(await guest.locator('#live-backdrop').count(),0);
    await host.locator('#enter-live').click();await host.locator('#live-session').waitFor({state:'visible'});
    assert.equal(await host.locator('#live-stop-slot #stop').count(),1);assert.equal(await host.locator('#live-edge-slot #edge').count(),1);
    assert.equal(await host.locator('#stop').count(),1);assert.equal(await host.evaluate(()=>window.__writes.length),beforeLive);
    assert.match(await host.locator('#live-session-state').textContent(),/Guest browser approved/);
    for(const command of ['20','40','60','70']){
      await host.evaluate(command=>engine.fixed(command,'live-fixed-test'),command);
      await host.waitForFunction(command=>document.querySelector('#live-output-meter').getAttribute('aria-valuenow')===command,command);
      assert.equal(await host.evaluate(()=>Number(window.__writes.at(-1).command.match(/\d+/)[0])*5),Number(command));
      if(command==='20')await host.waitForFunction(()=>engine.active===null,{}, {timeout:6500});
      else await host.locator('#stop').click();
      assert.equal(await host.locator('#live-output-meter').getAttribute('aria-valuenow'),'0');
    }
    await host.evaluate(()=>engine.hold('live-hold',performance.now()+1200,'max-hold'));
    await host.waitForFunction(()=>document.querySelector('#live-output-meter').getAttribute('aria-valuenow')==='70');
    const edgeBefore=await host.evaluate(()=>edgeUseCount);
    await host.locator('#edge').click();assert.equal(await host.locator('#live-output-meter').getAttribute('aria-valuenow'),'0');
    await host.locator('#edge').click();assert.equal(await host.evaluate(()=>edgeUseCount),edgeBefore+2);
    await host.waitForFunction(count=>document.querySelector('#live-edge-count').textContent.includes(String(count)),edgeBefore+2);
    assert.ok(await host.evaluate(()=>edgeLockUntil-Date.now()>29000));
    await host.evaluate(()=>{edgeLockUntil=Date.now()-1;updateEdgeCountdown()});
    await host.evaluate(()=>engine.manual('live-manual',performance.now()+1200,8));
    await host.waitForFunction(()=>document.querySelector('#live-output-meter').getAttribute('aria-valuenow')==='40');
    await host.evaluate(()=>stopNow());assert.equal(await host.locator('#live-output-meter').getAttribute('aria-valuenow'),'0');
    await host.evaluate(()=>engine.hold('live-random',performance.now()+600,'random'));
    await host.waitForFunction(()=>engine.active===null);assert.equal(await host.locator('#live-output-meter').getAttribute('aria-valuenow'),'0');
    await host.evaluate(()=>engine.hold('live-drop',performance.now()+1200,'max-hold'));
    await host.waitForFunction(()=>document.querySelector('#live-output-meter').getAttribute('aria-valuenow')==='70');
    await host.evaluate(()=>{device.gatt.connected=false;ready(false,true)});
    await host.waitForFunction(()=>document.querySelector('#live-connection').textContent.includes('disconnected'));
    assert.equal(await host.locator('#live-output-meter').getAttribute('aria-valuenow'),'0');
    await host.evaluate(()=>reconnectBluetooth(true));await host.waitForFunction(()=>document.querySelector('#live-connection').textContent.includes('connected'));
    assert.equal(await host.locator('#live-output-meter').getAttribute('aria-valuenow'),'0');
    // Visibility and channel recovery leave the same session and a zero display.
    const liveSession=await host.evaluate(()=>remoteSessionId);
    await host.evaluate(()=>{Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'))});
    assert.equal(await host.locator('#live-output-meter').getAttribute('aria-valuenow'),'0');
    await host.evaluate(()=>{Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'))});
    await host.evaluate(async()=>{remoteReady=false;remoteChannel.state='closed';await recoverRemoteSession()});
    await host.waitForFunction(()=>remoteChannelSubscribed());assert.equal(await host.evaluate(()=>remoteSessionId),liveSession);
    // Restore the supplied background and inspect narrow, regular and landscape layouts.
    await host.locator('#leave-live').click();await host.locator('#clear-live-background').click();await host.locator('#enter-live').click();
    for(const viewport of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]){
      await host.setViewportSize(viewport);
      assert.equal(await host.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const left=await host.locator('#live-arousal-slot').boundingBox(),right=await host.locator('#live-rating-slot').boundingBox();
      assert.ok(left.x+left.width<right.x);
      for(const selector of ['#live-arousal-slot button','#live-rating-slot button']){
        for(const button of await host.locator(selector).all()){
          const box=await button.boundingBox();assert.ok(box.height>=44);
          assert.equal(await button.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
        }
      }
      const edgeBox=await host.locator('#edge').boundingBox();assert.ok(edgeBox.y+edgeBox.height<=viewport.height);
      await host.screenshot({path:'/tmp/lushcon-live-'+viewport.width+'x'+viewport.height+'.png',fullPage:true});
    }
    await host.setViewportSize({width:390,height:844});
    await host.screenshot({path:'/tmp/lushcon-live-session.png',fullPage:true});
    await host.locator('#leave-live').click();assert.equal(await host.locator('#host-setup #stop').count(),1);
    assert.match(await host.locator('#live-backdrop').evaluate(el=>el.style.backgroundImage),/host-live-background.jpg/);
    await host.locator('#enter-live').click();await host.locator('#live-invite-toggle').click();await host.locator('#end-session').click();
    await host.locator('#live-session').waitFor({state:'visible'});assert.match(await host.locator('#live-session-state').textContent(),/No guest connected/);assert.match(await host.locator('#live-invite-toggle').textContent(),/Invite Guest/);
    // A plain visitor sees login + code entry, never controls.
    await context.route('**/functions/v1/guest-access',route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'Sign in required'}),headers:{'Access-Control-Allow-Origin':'*'}}));
    const visitor=await context.newPage();await visitor.goto(origin);await visitor.locator('#login').waitFor({state:'visible'});assert.equal(await visitor.locator('#host-controls').isHidden(),true);await visitor.screenshot({path:'/tmp/lushcon-host-login.png',fullPage:true});
    assert.deepEqual(errors,[]);console.log('PASS: Live Session availability, original safety buttons, output mirror, local background, disconnect/background/realtime recovery;  Manual Control interaction and isolated preview; signed state/timer recovery; acknowledgement haptics; pairing; EDGE; HOLD dead-man; GATT recovery and max level.');
  }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
