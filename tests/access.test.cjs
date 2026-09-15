const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(require.resolve('../supabase/functions/guest-access/index.ts'),'utf8')).replace(/^import.*\n/,'');
async function fixture(){
  const hash=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
  const profile={id:'guest-1',host_id:'host-1',name:'Private Name',pair_code:'ABCD',token:'ABCDEFGHJKLMNPQR',token_hash:await hash('ABCDEFGHJKLMNPQR')};
  const db={control_hosts:[{user_id:'host-1'}],control_guests:[profile],control_pairings:[],control_sessions:[]};
  class Query{
    constructor(table){this.table=table;this.filters=[];this.op='select'}
    select(){return this}order(){return this}eq(key,value){this.filters.push(row=>key.split('.').reduce((v,k)=>v?.[k],row)===value);return this}gt(key,value){this.filters.push(row=>row[key]>value);return this}
    maybeSingle(){this.singleResult=true;return this}single(){this.singleResult=true;return this}
    insert(value){this.op='insert';this.value=value;return this}upsert(value){this.op='upsert';this.value=value;return this}update(value){this.op='update';this.value=value;return this}delete(){this.op='delete';return this}
    then(resolve,reject){return Promise.resolve().then(()=>{
      if(this.op==='insert'){const row={id:crypto.randomUUID(),...this.value};db[this.table].push(row);return {data:this.singleResult?row:[row],error:null}}
      if(this.op==='upsert'){const old=db[this.table].find(r=>r.host_id===this.value.host_id);if(old)Object.assign(old,this.value);else db[this.table].push(this.value);return {data:this.value,error:null}}
      const selected=db[this.table].filter(row=>{const joined={...row,control_guests:db.control_guests.find(g=>g.id===row.profile_id)};return this.filters.every(f=>f(joined))});
      if(this.op==='update')selected.forEach(row=>Object.assign(row,this.value));
      if(this.op==='delete')db[this.table]=db[this.table].filter(row=>!selected.includes(row));
      const rows=selected.map(row=>({...row,control_guests:db.control_guests.find(g=>g.id===row.profile_id)}));
      return {data:this.singleResult?(rows[0]||null):rows,error:null};
    }).then(resolve,reject)}
  }
  const admin={from:table=>new Query(table),auth:{getUser:async jwt=>({data:{user:jwt==='host'?{id:'host-1',email_confirmed_at:'now'}:jwt==='outsider'?{id:'outsider',email_confirmed_at:'now'}:null},error:null})},rpc:async(name,{guest_id,request_hash})=>{
    const row={id:crypto.randomUUID(),profile_id:guest_id,request_hash,check_number:'7261',state:'pending',expires_at:new Date(Date.now()+600000).toISOString()};db.control_pairings.push(row);return {data:row,error:null};
  }};
  let handler;const context=vm.createContext({crypto,TextEncoder,Uint8Array,Response,JSON,Date,Math,Number,createClient:()=>admin,Deno:{env:{get:()=>''},serve:fn=>handler=fn}});vm.runInContext(source,context);
  async function request(body,jwt){const response=await handler(new Request('https://example.invalid',{method:'POST',headers:jwt?{Authorization:'Bearer '+jwt}:{},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()}}
  return {request,profile,db};
}
test('all host actions require a verified user and allowlist membership',async()=>{
  const f=await fixture();for(const action of ['preview','list','create','activate','renew','end','rotate','pair-list','pair-approve','pair-deny']){
    assert.equal((await f.request({action})).status,401);assert.equal((await f.request({action},'outsider')).status,403);
  }
});
test('authorised preview check creates no session, pairing or guest record',async()=>{
  const f=await fixture(),before=JSON.stringify(f.db);const result=await f.request({action:'preview'},'host');
  assert.equal(result.status,200);assert.equal(result.body.ok,true);assert.equal(JSON.stringify(f.db),before);
});
test('host guest names are normalised and remain presentation data',async()=>{
  const f=await fixture();const created=await f.request({action:'create',name:'  Sophie\u0000   Rae  '},'host');
  assert.equal(created.status,200);assert.equal(created.body.profile.name,'Sophie Rae');
});
test('four-character code alone cannot resolve a control session or reveal name',async()=>{
  const f=await fixture();const r=await f.request({action:'resolve',token:'ABCD'});assert.equal(r.body.available,false);assert.ok(!JSON.stringify(r.body).includes(f.profile.name));
});
test('pairing requires explicit host approval and possession of request secret',async()=>{
  const f=await fixture(),secret='A'.repeat(32),other='B'.repeat(32);
  const pending=await f.request({action:'pair-request',code:'abcd',secret});assert.equal(pending.body.state,'pending');assert.equal(pending.body.token,undefined);
  const stolen=await f.request({action:'pair-poll',code:'ABCD',secret:other});assert.equal(stolen.body.state,'expired');
  const id=f.db.control_pairings[0].id;assert.equal((await f.request({action:'pair-approve',request:id})).status,401);
  assert.equal((await f.request({action:'pair-approve',request:id},'host')).status,200);
  const granted=await f.request({action:'pair-poll',code:'ABCD',secret});assert.equal(granted.body.token,f.profile.token);
  assert.equal((await f.request({action:'pair-poll',code:'ABCD',secret:other})).body.token,undefined);
});
test('approved capability resolves the display name with session data',async()=>{
  const f=await fixture();f.db.control_sessions.push({host_id:'host-1',profile_id:'guest-1',session:'a'.repeat(48),edge_key:'test-public-key',contact_key:'test-contact-public-key',lease_until:new Date(Date.now()+10000).toISOString()});
  const result=await f.request({action:'resolve',token:f.profile.token});assert.equal(result.body.session,'a'.repeat(48));assert.equal(result.body.edgeKey,'test-public-key');assert.equal(result.body.contactKey,'test-contact-public-key');assert.equal(result.body.name,f.profile.name);assert.equal(result.body.token,undefined);
  f.db.control_sessions[0].lease_until=new Date(Date.now()-1).toISOString();const idle=await f.request({action:'resolve',token:f.profile.token});assert.equal(idle.body.available,false);assert.equal(idle.body.name,f.profile.name);
});
test('rotation invalidates remembered secret and old approved pairing cannot acquire replacement',async()=>{
  const f=await fixture(),secret='A'.repeat(32),oldToken=f.profile.token;
  await f.request({action:'pair-request',code:'ABCD',secret});await f.request({action:'pair-approve',request:f.db.control_pairings[0].id},'host');
  const rotated=await f.request({action:'rotate',profile:'guest-1',name:'Sophie'},'host');assert.equal(rotated.status,200);assert.notEqual(f.profile.token,oldToken);assert.equal(f.profile.name,'Sophie');
  assert.equal((await f.request({action:'resolve',token:oldToken})).body.valid,false);
  assert.notEqual((await f.request({action:'pair-poll',code:'ABCD',secret})).body.token,f.profile.token);
});
