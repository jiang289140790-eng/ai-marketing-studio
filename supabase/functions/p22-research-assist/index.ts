import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
import {
  P22_CNY_PER_USD, P22_EXECUTION_FLAGS, P22_LIMITS, P22_SCHEMA_VERSION, P22Error, buildQwenPrompt,
  assertUniqueRawCollectedPost, bindExactCollectedPost, issueCollectionProof, normalizeCollectedItems, parseP22Request, parseQwenAnalyses, publicError,
  runApifyCollectionSequence, verifyAnalyzeSources,
} from './assist-core.mjs';

const ORIGINS = new Set(['https://jiang289140790-eng.github.io','http://localhost:3000','http://127.0.0.1:3000','http://127.0.0.1:5173','http://127.0.0.1:5174']);
const ACTOR = 'xquik/x-tweet-scraper';

function headers(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {'Access-Control-Allow-Origin':ORIGINS.has(origin)?origin:'null','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Content-Type':'application/json'};
}
function respond(request: Request, body: unknown, status=200) { return new Response(JSON.stringify(body), {status, headers:headers(request)}); }
async function sha256(value: string) { const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map((b)=>b.toString(16).padStart(2,'0')).join(''); }
function configured(name: string) { return Boolean(Deno.env.get(name)); }

async function verify(request: Request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new P22Error('AUTH_REQUIRED','请先登录。',401);
  const url=Deno.env.get('SUPABASE_URL'); const key=Deno.env.get('SUPABASE_ANON_KEY'); const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const proofSecret=Deno.env.get('P22_COLLECTION_PROOF_SECRET');
  if (!url || !key || !service) throw new P22Error('SERVICE_CONFIG_MISSING','服务端配置不完整。',500);
  const authClient=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:`Bearer ${token}`}}});
  const {data,error}=await authClient.auth.getUser(token);
  if (error || !data?.user?.id) throw new P22Error('AUTH_FAILED','登录状态无效。',401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:role,error:roleError}=await db.schema('api').rpc('p19_staging_role',{p_user_id:data.user.id});
  if (roleError || !role) throw new P22Error('STAGING_ROLE_DENIED','当前账号不在 staging 访问清单内。',403);
  if (!proofSecret) throw new P22Error('SERVICE_CONFIG_MISSING','P22 collection proof configuration is unavailable.',500);
  return {userId:data.user.id,role:String(role),db,proofSecret};
}

async function recordProviderCost(db, userId: string, provider: string, amount: number) {
  const id=crypto.randomUUID();
  const {data,error}=await db.schema('api').rpc('p22_reserve_daily_budget',{p_user_id:userId,p_provider:provider,p_amount_cny:amount,p_reservation_id:id});
  if (error) {
    throw new P22Error('COST_RECORDING_FAILED','无法安全记录本次调用费用。',503);
  }
  return data;
}

async function costStatus(db) {
  const today=new Date().toISOString().slice(0,10);
  const {data,error}=await db.from('cost_records').select('amount,metadata').eq('cost_date',today).contains('metadata',{schema_version:'p22_budget_reservation_v1'});
  if(error) throw new P22Error('COST_STATUS_UNAVAILABLE','无法安全读取今日费用记录。',503);
  const totals={apify:0,qwen:0};
  for(const row of data || []) { const provider=String(row?.metadata?.provider || ''); if(provider in totals) totals[provider]+=Number(row.amount || 0); }
  return {cost_date_utc:today,daily_cap_enabled:false,apify:{recorded_cny:Number(totals.apify.toFixed(4))},qwen:{recorded_cny:Number(totals.qwen.toFixed(4))}};
}

async function collect(db, userId: string, input, proofSecret: string) {
  const token=Deno.env.get('APIFY_TOKEN');
  if (!token) throw new P22Error('APIFY_NOT_CONFIGURED','Apify 尚未配置。',503);
  const costRecord=await recordProviderCost(db,userId,'apify',P22_LIMITS.apify_reservation_cny);
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),P22_LIMITS.apify_sequence_ms);
  try {
    const sequence=await runApifyCollectionSequence({
      token, actorId:ACTOR,
      topic:input.action==='collect'?input.topic:undefined,
      sourceUrl:input.action==='collect_url'?input.url:undefined,
      count:input.action==='collect'?input.count:1,
      maxItems:P22_LIMITS.collect,
      maxTotalChargeUsd:P22_LIMITS.apify_reservation_cny/P22_CNY_PER_USD,
      signal:controller.signal,
    });
    if (input.action==='collect_url') assertUniqueRawCollectedPost(sequence.items,{canonical_url:input.url,external_id:input.external_id});
    const normalizedAll=await normalizeCollectedItems(sequence.items,{provider:`apify:${ACTOR}`,run_id:sequence.runId,collected_at:new Date().toISOString(),usage_total_usd:sequence.usageTotalUsd,budget_reservation_id:costRecord.reservation_id},sha256);
    const normalized=input.action==='collect_url'
      ? bindExactCollectedPost(normalizedAll,{canonical_url:input.url,external_id:input.external_id})
      : normalizedAll;
    const items=await Promise.all(normalized.map(async (item)=>({...item,collection_proof:await issueCollectionProof(proofSecret,userId,item)})));
    return {items,cost:{recorded_cny:P22_LIMITS.apify_reservation_cny,actual_cny:Number((sequence.usageTotalUsd*P22_CNY_PER_USD).toFixed(4)),tracking:costRecord}};
  } catch (error) { if (error?.name==='AbortError') throw new P22Error('APIFY_TIMEOUT','采集超时。',504); throw error; }
  finally { clearTimeout(timer); }
}

async function analyze(db,userId:string,items,proofSecret:string) {
  await verifyAnalyzeSources(proofSecret,userId,items);
  const key=Deno.env.get('DASHSCOPE_API_KEY');
  if (!key) throw new P22Error('QWEN_NOT_CONFIGURED','Qwen 尚未配置。',503);
  const costRecord=await recordProviderCost(db,userId,'qwen',P22_LIMITS.qwen_reservation_cny);
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),60000);
  try {
    const response=await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'qwen-plus',temperature:0.2,max_tokens:1200,response_format:{type:'json_object'},messages:[{role:'user',content:buildQwenPrompt(items)}]}),signal:controller.signal});
    if (!response.ok) throw new P22Error('QWEN_REQUEST_FAILED','辅助分析失败。',502);
    const payload=await response.json(); const totalTokens=Number(payload?.usage?.total_tokens);
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) throw new P22Error('QWEN_COST_UNVERIFIABLE','无法验证分析用量。',502);
    return {analyses:parseQwenAnalyses(payload,items),usage:{total_tokens:totalTokens},cost:{recorded_cny:P22_LIMITS.qwen_reservation_cny,tracking:costRecord}};
  } catch(error) { if(error?.name==='AbortError') throw new P22Error('QWEN_TIMEOUT','辅助分析超时。',504); throw error; }
  finally { clearTimeout(timer); }
}

Deno.serve(async (request)=>{
  if(request.method==='OPTIONS') return new Response('ok',{headers:headers(request)});
  if(request.method!=='POST') return respond(request,{ok:false,code:'METHOD_NOT_ALLOWED',message:'只接受 POST。'},405);
  try {
    const input=parseP22Request(await request.json()); const {userId,role,db,proofSecret}=await verify(request);
    const capabilities={apify_configured:configured('APIFY_TOKEN'),qwen_configured:configured('DASHSCOPE_API_KEY')};
    if(input.action==='status') return respond(request,{ok:true,schema_version:P22_SCHEMA_VERSION,role,capabilities,limits:P22_LIMITS,cost_tracking:await costStatus(db),execution_flags:P22_EXECUTION_FLAGS});
    if(!['operator','admin'].includes(role)) throw new P22Error('OPERATOR_REQUIRED','智能研究仅向 operator 开放。',403);
    const result=(input.action==='collect'||input.action==='collect_url')
      ? await collect(db,userId,input,proofSecret)
      : await analyze(db,userId,input.items,proofSecret);
    return respond(request,{ok:true,schema_version:P22_SCHEMA_VERSION,action:input.action,...result,execution_flags:P22_EXECUTION_FLAGS});
  } catch(error) {
    const safe=publicError(error);
    console.error(JSON.stringify({event:'p22_research_assist_failure',code:safe.code,status:safe.status,details:safe.details}));
    return respond(request,{ok:false,code:safe.code,message:safe.message,details:safe.details,execution_flags:P22_EXECUTION_FLAGS},safe.status);
  }
});
