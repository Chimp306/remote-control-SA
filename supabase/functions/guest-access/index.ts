import { createClient } from "npm:@supabase/supabase-js@2.49.1";

// Custom auth: guest resolution requires an 80-bit bearer capability; every
// host action requires getUser(jwt) AND a server-managed host allowlist row.
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const headers={"Access-Control-Allow-Origin":"https://ctmp.uk","Access-Control-Allow-Headers":"authorization,apikey,content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"};
const answer=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
function token(){
  const alphabet="23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b=>alphabet[b&31]).join(""); // 16 x 5 = 80 random bits.
}
async function hash(value:string){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,"0")).join("")}
function check<T extends {error:unknown}>(result:T):T{if(result.error)throw new Error("Database operation failed");return result}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response(null,{headers});
  if(req.method!=="POST")return answer({error:"Method not allowed"},405);
  try{
    if(Number(req.headers.get("content-length"))>4096)return answer({error:"Request too large"},413);
    const text=await req.text();if(text.length>4096)return answer({error:"Request too large"},413);
    const body=JSON.parse(text);
    if(["pair-request","pair-poll"].includes(body.action)){
      const code=typeof body.code==="string"?body.code.toUpperCase():"";
      if(!/^[2-9A-HJ-NP-Z]{4}$/.test(code)||!/^[-A-Za-z0-9_]{32}$/.test(body.secret))return answer({error:"Invalid pairing request"},400);
      const {data:profile}=check(await admin.from("control_guests").select("id").eq("pair_code",code).maybeSingle());
      if(!profile)return answer({state:"unavailable"});
      const requestHash=await hash(body.secret);
      const {data:existing}=check(await admin.from("control_pairings").select("id,check_number,state,approved_token,expires_at").eq("profile_id",profile.id).eq("request_hash",requestHash).maybeSingle());
      if(existing){
        if(new Date(existing.expires_at).getTime()<Date.now())return answer({state:"expired"});
        return answer({state:existing.state,checkNumber:existing.check_number,token:existing.state==="approved"?existing.approved_token:undefined});
      }
      if(body.action==="pair-poll")return answer({state:"expired"});
      // Atomic per-profile queue limit and deduplication; no IP fingerprinting.
      const {data:request}=check(await admin.rpc("request_control_pairing",{guest_id:profile.id,request_hash:requestHash}));
      return answer(request?{state:"pending",checkNumber:request.check_number}:{state:"busy"});
    }
    if(body.action==="resolve"){
      const secret=typeof body.token==="string"?body.token.toUpperCase():"";
      if(!/^[2-9A-HJ-NP-Z]{16}$/.test(secret))return answer({available:false});
      const {data:profile}=check(await admin.from("control_guests").select("id,host_id").eq("token_hash",await hash(secret)).maybeSingle());
      if(!profile)return answer({available:false,valid:false});
      const {data:session}=check(await admin.from("control_sessions").select("session,edge_key").eq("profile_id",profile.id).eq("host_id",profile.host_id).gt("lease_until",new Date().toISOString()).maybeSingle());
      return answer(session?{valid:true,available:true,session:session.session,edgeKey:session.edge_key}:{valid:true,available:false});
    }
    const jwt=req.headers.get("authorization")?.replace(/^Bearer /i,"");
    if(!jwt)return answer({error:"Sign in required"},401);
    const {data:{user},error}=await admin.auth.getUser(jwt);
    if(error||!user||user.is_anonymous||!user.email_confirmed_at)return answer({error:"Sign in required"},401);
    const {data:host}=check(await admin.from("control_hosts").select("user_id").eq("user_id",user.id).maybeSingle());
    if(!host)return answer({error:"This account has not been authorised as a host"},403);
    if(body.action==="list"){
      const {data}=check(await admin.from("control_guests").select("id,name,token,pair_code").eq("host_id",user.id).order("created_at"));
      return answer({profiles:data});
    }
    if(body.action==="pair-list"){
      const {data}=check(await admin.from("control_pairings").select("id,profile_id,check_number,expires_at,control_guests!inner(name,host_id)").eq("control_guests.host_id",user.id).eq("state","pending").gt("expires_at",new Date().toISOString()).order("created_at"));
      return answer({requests:data});
    }
    if(["pair-approve","pair-deny"].includes(body.action)){
      const {data:request}=check(await admin.from("control_pairings").select("id,control_guests!inner(host_id,token)").eq("id",body.request).eq("control_guests.host_id",user.id).eq("state","pending").gt("expires_at",new Date().toISOString()).maybeSingle());
      if(!request)return answer({error:"Request unavailable"},404);
      const guest=request.control_guests as unknown as {token:string};
      check(await admin.from("control_pairings").update({state:body.action==="pair-approve"?"approved":"denied",approved_token:body.action==="pair-approve"?guest.token:null}).eq("id",request.id).eq("state","pending"));
      return answer({ok:true});
    }
    if(body.action==="create"){
      const name=typeof body.name==="string"?body.name.trim():"";
      if(!name||name.length>80)return answer({error:"Enter a guest name of 1–80 characters"},400);
      const secret=token();
      const {data}=check(await admin.from("control_guests").insert({host_id:user.id,name,token:secret,token_hash:await hash(secret),pair_code:token().slice(0,4)}).select("id,name,token,pair_code").single());
      return answer({profile:data});
    }
    if(body.action==="end"){
      check(await admin.from("control_sessions").delete().eq("host_id",user.id).eq("session",body.session));
      return answer({ok:true});
    }
    if(body.action==="renew"){
      const {data}=check(await admin.from("control_sessions").update({lease_until:new Date(Date.now()+45000).toISOString()}).eq("host_id",user.id).eq("session",body.session).select("session").maybeSingle());
      return answer({ok:!!data});
    }
    const {data:profile}=check(await admin.from("control_guests").select("id").eq("id",body.profile).eq("host_id",user.id).maybeSingle());
    if(!profile)return answer({error:"Guest unavailable"},404);
    if(body.action==="rotate"){
      const secret=token();
      // End the old session before replacing the private capability.
      check(await admin.from("control_sessions").delete().eq("host_id",user.id).eq("profile_id",profile.id));
      const {data}=check(await admin.from("control_guests").update({token:secret,token_hash:await hash(secret),pair_code:token().slice(0,4)}).eq("id",profile.id).eq("host_id",user.id).select("id,name,token,pair_code").single());
      check(await admin.from("control_pairings").delete().eq("profile_id",profile.id));
      return answer({profile:data});
    }
    if(body.action==="activate"){
      if(!/^[a-f0-9]{48}$/.test(body.session)||!/^B[A-Za-z0-9_-]{86}$/.test(body.edgeKey))return answer({error:"Invalid session"},400);
      check(await admin.from("control_sessions").upsert({host_id:user.id,profile_id:profile.id,session:body.session,edge_key:body.edgeKey,lease_until:new Date(Date.now()+45000).toISOString()},{onConflict:"host_id"}));
      return answer({ok:true});
    }
    return answer({error:"Unknown action"},400);
  }catch{return answer({error:"Request could not be completed"},400)}
});
