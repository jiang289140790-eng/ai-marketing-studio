import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
import {
  P22_CNY_PER_USD, P22_EXECUTION_FLAGS, P22_LIMITS, P22_SCHEMA_VERSION, P22Error, buildMultimodalQwenContent, buildQwenPrompt,
  buildSimilarPostPrompt,
  allocatePaidAttemptBudgetReservationId, assertUniqueRawCollectedPost, assertUniqueSearchResults, bindExactCollectedPost, issueCollectionProof, normalizeCollectedItems, normalizeRedditSearchItems, parseP22Request, parseQwenAnalyses, parseQwenMultimodalAnalyses, publicError,
  parseSimilarPostDraft, persistedEvidenceToAnalyzeItem, redditSearchBatchId, runApifyCollectionSequence, searchBatchId, verifyAnalyzeSources,
  refreshCollectionReplayReceipt,
} from './assist-core.mjs';

const ORIGINS = new Set(['https://jiang289140790-eng.github.io','http://localhost:3000','http://127.0.0.1:3000','http://127.0.0.1:5173','http://127.0.0.1:5174']);
const ACTOR = 'xquik/x-tweet-scraper';
const REDDIT_ACTOR = 'endspec/reddit-instant-search-scraper';

function headers(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {'Access-Control-Allow-Origin':ORIGINS.has(origin)?origin:'null','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Content-Type':'application/json'};
}
function respond(request: Request, body: unknown, status=200) { return new Response(JSON.stringify(body), {status, headers:headers(request)}); }
async function sha256(value: string) { const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map((b)=>b.toString(16).padStart(2,'0')).join(''); }
function configured(name: string) { return Boolean(Deno.env.get(name)); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string,unknown>).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
}
function paidRequestBinding(input) {
  return Object.fromEntries(Object.entries(input).filter(([key])=>key!=='idempotency_key'));
}

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

async function reservationId(userId: string, provider: string, operation: string, idempotencyKey: string | null, sequence = 0) {
  if (!idempotencyKey) return crypto.randomUUID();
  const digest=await sha256(`${userId}\n${provider}\n${operation}\n${idempotencyKey}\n${sequence}`);
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
}

async function readPaidReplay(db, userId: string, reservation: string, provider: string, operation: string, sequence: number, requestSha256: string) {
  const {data,error}=await db.schema('api').rpc('p22_get_paid_operation_replay',{
    p_user_id:userId,p_reservation_id:reservation,p_provider:provider,p_operation:operation,p_sequence:sequence,p_request_sha256:requestSha256,
  });
  if(error) throw new P22Error('PAID_REPLAY_LOOKUP_FAILED','Unable to verify the durable paid-operation receipt.',503);
  return data ?? null;
}

async function completePaidReplay(db, userId: string, reservation: string, provider: string, operation: string, sequence: number, requestSha256: string, result) {
  const {data,error}=await db.schema('api').rpc('p22_complete_paid_operation_replay',{
    p_user_id:userId,p_reservation_id:reservation,p_provider:provider,p_operation:operation,p_sequence:sequence,p_request_sha256:requestSha256,p_result_json:result,
  });
  if(error||!data) throw new P22Error('PAID_REPLAY_PERSIST_FAILED','Unable to persist the durable paid-operation receipt.',503);
  return data;
}

async function failPaidReplay(db, userId: string, costRecord, provider: string, operation: string, sequence: number, error) {
  if (!costRecord?.reservation_id || !costRecord?.request_sha256 || error?.code === 'PAID_REPLAY_PERSIST_FAILED') return;
  const failureCode=/^[A-Z][A-Z0-9_]{0,79}$/.test(String(error?.code || ''))?String(error.code):'PROVIDER_OPERATION_FAILED';
  await db.schema('api').rpc('p22_fail_paid_operation_replay',{
    p_user_id:userId,p_reservation_id:costRecord.reservation_id,p_provider:provider,p_operation:operation,
    p_sequence:sequence,p_request_sha256:costRecord.request_sha256,p_failure_code:failureCode,
  });
}

async function recordProviderCost(db, userId: string, provider: string, operation: string, amount: number, idempotencyKey: string | null, sequence: number, requestBinding: unknown) {
  const id=await reservationId(userId,provider,operation,idempotencyKey,sequence);
  const requestSha256=await sha256(canonicalJson(requestBinding));
  const {data:claimOutcome,error:claimError}=await db.schema('api').rpc('p22_claim_paid_operation_replay',{
    p_user_id:userId,p_reservation_id:id,p_provider:provider,p_operation:operation,p_sequence:sequence,p_request_sha256:requestSha256,
  });
  if(claimError) {
    if(String(claimError?.message || '').includes('P22_PAID_REPLAY_IDENTITY_CONFLICT')) throw new P22Error('IDEMPOTENCY_CONFLICT','The idempotency key is already bound to a different paid request.',409);
    throw new P22Error('PAID_REPLAY_CLAIM_FAILED','Unable to claim the paid operation safely.',503);
  }
  if (idempotencyKey && ['already_completed','already_claimed'].includes(claimOutcome)) {
    const replay=await readPaidReplay(db,userId,id,provider,operation,sequence,requestSha256);
    if(!replay) throw new P22Error('IDEMPOTENT_RESULT_PENDING','The paid operation is reserved but no completed receipt is available.',409);
    return {reservation_id:id,request_sha256:requestSha256,claim_outcome:claimOutcome,replay};
  }
  // The durable paid-operation identity is stable forever, while cost reservations are
  // intentionally scoped to their UTC accounting date. Keeping the two identities
  // separate lets a failed operation be reclaimed after midnight without colliding
  // with the previous day's cost row.
  const budgetId=await allocatePaidAttemptBudgetReservationId(id,idempotencyKey,claimOutcome);
  const {data,error}=await db.schema('api').rpc('p22_reserve_daily_budget',{p_user_id:userId,p_provider:provider,p_amount_cny:amount,p_reservation_id:budgetId});
  if (error) {
    const {data:released,error:releaseError}=await db.schema('api').rpc('p22_fail_paid_operation_replay',{
      p_user_id:userId,p_reservation_id:id,p_provider:provider,p_operation:operation,
      p_sequence:sequence,p_request_sha256:requestSha256,p_failure_code:'COST_RECORDING_FAILED',
    });
    if(releaseError||released!=='failed') throw new P22Error('PAID_REPLAY_RELEASE_FAILED','Unable to release the paid-operation claim after cost recording failed.',503);
    throw new P22Error('COST_RECORDING_FAILED','无法安全记录本次调用费用。',503);
  }
  return {...data,reservation_id:id,budget_reservation_id:budgetId,request_sha256:requestSha256,claim_outcome:claimOutcome,replay:null};
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
  const costRecord=await recordProviderCost(db,userId,'apify',input.action,P22_LIMITS.apify_reservation_cny,input.idempotency_key,0,paidRequestBinding(input));
  if(costRecord.replay) return await refreshCollectionReplayReceipt(proofSecret,userId,costRecord.replay);
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),P22_LIMITS.apify_sequence_ms);
  try {
    // P32-B：搜索是服务端构造的批量契约——精确关键词、X 平台（actorId 固定）、
    // 数量（1–20）与排序意图（latest）都由服务端绑定，绝不接受客户端任意 Actor 输入。
    // P22_LIMITS 在 JS 模块中推断为字面量类型（search_max: 20 / collect: 5），
    // 此处显式声明 number 保持类型边界：collect 仍上限 5、search 仍上限 20。
    const isSearch=input.action==='search'||input.action==='search_reddit';
    const isRedditSearch=input.action==='search_reddit';
    const hardMax: number=isSearch?P22_LIMITS.search_max:P22_LIMITS.collect;
    const count: number=isSearch?input.count:(input.action==='collect'?input.count:1);
    const sequence=await runApifyCollectionSequence({
      token, actorId:isRedditSearch?REDDIT_ACTOR:ACTOR,
      topic:isSearch&&!isRedditSearch?input.keyword:(input.action==='collect'?input.topic:undefined),
      sourceUrl:input.action==='collect_url'?input.url:undefined,
      actorInput:isRedditSearch?{
        search:input.keyword,
        ...(input.subreddit?{subreddit:input.subreddit}:{}),
        sortType:input.sort,
        timeFilter:input.time_filter,
        limit:input.count,
      }:undefined,
      count,
      maxItems:hardMax,
      hardMax,
      maxTotalChargeUsd:P22_LIMITS.apify_reservation_cny/P22_CNY_PER_USD,
      signal:controller.signal,
    });
    if (input.action==='collect_url') assertUniqueRawCollectedPost(sequence.items,{canonical_url:input.url,external_id:input.external_id});
    const collectedAt=new Date().toISOString();
    const provenance={provider:`apify:${isRedditSearch?REDDIT_ACTOR:ACTOR}`,run_id:sequence.runId,collected_at:collectedAt,usage_total_usd:sequence.usageTotalUsd,budget_reservation_id:costRecord.budget_reservation_id};
    const normalizedAll=isRedditSearch
      ? await normalizeRedditSearchItems(sequence.items,provenance,sha256,{
        search:input.keyword,
        subreddit:input.subreddit,
        sortType:input.sort,
        timeFilter:input.time_filter,
        limit:input.count,
      })
      : await normalizeCollectedItems(sequence.items,provenance,sha256,{fetchImpl:globalThis.fetch,maxItems:hardMax});
    const normalized=input.action==='collect_url'
      ? bindExactCollectedPost(normalizedAll,{canonical_url:input.url,external_id:input.external_id})
      : normalizedAll;
    // 搜索结果唯一性：URL/外部 ID/正文哈希重复或错绑即整批失败关闭。
    if (isSearch) assertUniqueSearchResults(normalized);
    const items=await Promise.all(normalized.map(async (item)=>({...item,collection_proof:await issueCollectionProof(proofSecret,userId,item)})));
    const cost={recorded_cny:P22_LIMITS.apify_reservation_cny,actual_cny:Number((sequence.usageTotalUsd*P22_CNY_PER_USD).toFixed(4)),tracking:costRecord};
    let result;
    if (isSearch) {
      const batchId=isRedditSearch
        ? await redditSearchBatchId({keyword:input.keyword,subreddit:input.subreddit,count:input.count,sort:input.sort,timeFilter:input.time_filter,runId:sequence.runId,collectedAt,items:normalized},sha256)
        : await searchBatchId({keyword:input.keyword,count:input.count,sort:input.sort,runId:sequence.runId,collectedAt,items:normalized},sha256);
      result={items,cost,search_batch_id:batchId,platform:isRedditSearch?'reddit':'x',keyword:input.keyword,count:input.count,sort_intent:input.sort,time_filter:isRedditSearch?input.time_filter:null,subreddit:isRedditSearch?input.subreddit:null,collected_at:collectedAt};
    } else {
      result={items,cost};
    }
    return await completePaidReplay(db,userId,costRecord.reservation_id,'apify',input.action,0,costRecord.request_sha256,result);
  } catch (error) { await failPaidReplay(db,userId,costRecord,'apify',input.action,0,error); if (error?.name==='AbortError') throw new P22Error('APIFY_TIMEOUT','采集超时。',504); throw error; }
  finally { clearTimeout(timer); }
}

async function analyze(db,userId:string,items,proofSecret:string,{persisted=false,idempotencyKey=null,operation='analyze'}:{persisted?:boolean,idempotencyKey?:string|null,operation?:string}={}) {
  // 按媒体分组调用模型：带媒体来源 → qwen3.5-omni-flash 多模态契约（逐媒体绑定，
  // 绝不静默回退到纯文本分析）；纯文本来源 → 既有 qwen-plus 文本契约。
  // 每组独立记录有界费用；全部组的结果合并为一个 analyses 数组。
  if (!persisted) await verifyAnalyzeSources(proofSecret,userId,items);
  const key=Deno.env.get('DASHSCOPE_API_KEY');
  if (!key) throw new P22Error('QWEN_NOT_CONFIGURED','Qwen 尚未配置。',503);
  const groups=[];
  const mediaItems=items.filter((item)=>Array.isArray(item.media_assets)&&item.media_assets.length>0);
  const textItems=items.filter((item)=>!(Array.isArray(item.media_assets)&&item.media_assets.length>0));
  if (mediaItems.length>0) groups.push({items:mediaItems,multimodal:true});
  if (textItems.length>0) groups.push({items:textItems,multimodal:false});
  const analyses=[]; let usageTotal=0; const costRecords=[];
  for (const [groupIndex, group] of groups.entries()) {
    const costRecord=await recordProviderCost(db,userId,'qwen',operation,P22_LIMITS.qwen_reservation_cny,idempotencyKey,groupIndex,{operation,persisted,multimodal:group.multimodal,items:group.items});
    if(costRecord.replay) {
      analyses.push(...costRecord.replay.analyses);
      usageTotal+=costRecord.replay.total_tokens;
      costRecords.push({recorded_cny:P22_LIMITS.qwen_reservation_cny,tracking:costRecord.replay.tracking});
      continue;
    }
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),60000);
    try {
      const messages=group.multimodal
        ? [{role:'user',content:buildMultimodalQwenContent(group.items)}]
        : [{role:'user',content:buildQwenPrompt(group.items)}];
      const response=await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:group.multimodal?'qwen3.5-omni-flash':'qwen-plus',temperature:0.2,max_tokens:group.multimodal?2400:1200,response_format:{type:'json_object'},messages}),signal:controller.signal});
      if (!response.ok) throw new P22Error('QWEN_REQUEST_FAILED','辅助分析失败。',502);
      const payload=await response.json(); const totalTokens=Number(payload?.usage?.total_tokens);
      if (!Number.isFinite(totalTokens) || totalTokens <= 0) throw new P22Error('QWEN_COST_UNVERIFIABLE','无法验证分析用量。',502);
      const modelName=group.multimodal?'qwen3.5-omni-flash':'qwen-plus';
      const groupAnalyses=(group.multimodal
        ? parseQwenMultimodalAnalyses(payload,group.items).map((row)=>({...row,model:modelName}))
        : parseQwenAnalyses(payload,group.items).map((row)=>({...row,model:modelName})));
      const tracking={...costRecord}; delete tracking.replay;
      const receipt=await completePaidReplay(db,userId,costRecord.reservation_id,'qwen',operation,groupIndex,costRecord.request_sha256,{analyses:groupAnalyses,total_tokens:totalTokens,tracking});
      analyses.push(...receipt.analyses);
      usageTotal+=receipt.total_tokens;
      costRecords.push({recorded_cny:P22_LIMITS.qwen_reservation_cny,tracking:receipt.tracking});
    } catch(error) { await failPaidReplay(db,userId,costRecord,'qwen',operation,groupIndex,error); if(error?.name==='AbortError') throw new P22Error('QWEN_TIMEOUT','辅助分析超时。',504); throw error; }
    finally { clearTimeout(timer); }
  }
  return {analyses,usage:{total_tokens:usageTotal},cost:{recorded_cny:costRecords.reduce((sum,row)=>sum+row.recorded_cny,0),tracking:costRecords.map((row)=>row.tracking)}};
}

async function loadPersistedProjectEntity(db,userId:string,projectId:string,evidenceId:string) {
  const [{data:project,error:projectError},{data:entities,error:entityError}]=await Promise.all([
    db.schema('api').rpc('p19_get_project',{p_user_id:userId,p_project_id:projectId}),
    db.schema('api').rpc('p19_list_project_entities',{p_user_id:userId,p_project_id:projectId}),
  ]);
  if(projectError||entityError) throw new P22Error('PERSISTED_EVIDENCE_LOOKUP_FAILED','无法安全读取已保存证据。',503);
  if(!project||project.id!==projectId||project.status!=='active') throw new P22Error('PROJECT_NOT_ACTIVE','项目不存在或不可编辑。',409,{field:'project_id'});
  const matches=(Array.isArray(entities?.evidence)?entities.evidence:[]).filter((row)=>row?.id===evidenceId&&row?.project_id===projectId);
  if(matches.length!==1) throw new P22Error(matches.length?'EVIDENCE_NOT_UNIQUE':'EVIDENCE_NOT_FOUND','找不到唯一且属于当前项目的已保存证据。',409,{field:'evidence_id'});
  return {project,entities,evidence:matches[0]};
}

async function analyzePersisted(db,userId:string,input,proofSecret:string) {
  const loaded=await loadPersistedProjectEntity(db,userId,input.project_id,input.evidence_id);
  const item=await persistedEvidenceToAnalyzeItem(loaded.evidence,{hasher:sha256});
  const result=await analyze(db,userId,[item],proofSecret,{persisted:true,idempotencyKey:input.idempotency_key,operation:input.action});
  return {...result,evidence_id:input.evidence_id,project_id:input.project_id};
}

async function generateSimilar(db,userId:string,input) {
  const loaded=await loadPersistedProjectEntity(db,userId,input.project_id,input.evidence_id);
  const item=await persistedEvidenceToAnalyzeItem(loaded.evidence,{hasher:sha256});
  const matches=(Array.isArray(loaded.entities?.analyses)?loaded.entities.analyses:[]).filter((row)=>row?.id===input.analysis_id&&row?.project_id===input.project_id&&row?.evidence_id===input.evidence_id);
  if(matches.length!==1) throw new P22Error(matches.length?'ANALYSIS_NOT_UNIQUE':'ANALYSIS_NOT_FOUND','找不到唯一且绑定该证据的已保存分析。',409,{field:'analysis_id'});
  const analysis=matches[0];
  if(analysis.evidence_fingerprint!==loaded.evidence.fingerprint||analysis.evidence_version!==loaded.evidence.version) throw new P22Error('ANALYSIS_EVIDENCE_MISMATCH','分析与当前证据版本不一致。',409,{field:'analysis_id'});
  const key=Deno.env.get('DASHSCOPE_API_KEY');
  if(!key) throw new P22Error('QWEN_NOT_CONFIGURED','Qwen 尚未配置。',503);
  const costRecord=await recordProviderCost(db,userId,'qwen',input.action,P22_LIMITS.qwen_reservation_cny,input.idempotency_key,0,{...paidRequestBinding(input),evidence_version:loaded.evidence.version,evidence_fingerprint:loaded.evidence.fingerprint,analysis_version:analysis.version,analysis_fingerprint:analysis.fingerprint});
  if(costRecord.replay) return costRecord.replay;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),60000);
  try {
    const response=await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'qwen-plus',temperature:0.5,max_tokens:1800,response_format:{type:'json_object'},messages:[{role:'user',content:buildSimilarPostPrompt(loaded.evidence,analysis)}]}),signal:controller.signal});
    if(!response.ok) throw new P22Error('QWEN_REQUEST_FAILED','相似帖子草稿生成失败。',502);
    const payload=await response.json(); const totalTokens=Number(payload?.usage?.total_tokens);
    if(!Number.isFinite(totalTokens)||totalTokens<=0) throw new P22Error('QWEN_COST_UNVERIFIABLE','无法验证草稿生成用量。',502);
    const draft=parseSimilarPostDraft(payload?.choices?.[0]?.message?.content);
    const result={draft:{...draft,evidence_id:input.evidence_id,evidence_version:loaded.evidence.version,evidence_fingerprint:loaded.evidence.fingerprint,analysis_id:input.analysis_id,analysis_version:analysis.version,analysis_fingerprint:analysis.fingerprint,model:'qwen-plus',generated_at:new Date().toISOString(),execution_flags:P22_EXECUTION_FLAGS},usage:{total_tokens:totalTokens},cost:{recorded_cny:P22_LIMITS.qwen_reservation_cny,tracking:costRecord},project_id:input.project_id};
    return await completePaidReplay(db,userId,costRecord.reservation_id,'qwen',input.action,0,costRecord.request_sha256,result);
  } catch(error) { await failPaidReplay(db,userId,costRecord,'qwen',input.action,0,error); if(error?.name==='AbortError') throw new P22Error('QWEN_TIMEOUT','相似帖子草稿生成超时。',504); throw error; }
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
    const result=(input.action==='collect'||input.action==='collect_url'||input.action==='search'||input.action==='search_reddit')
      ? await collect(db,userId,input,proofSecret)
      : input.action==='analyze_persisted' ? await analyzePersisted(db,userId,input,proofSecret)
        : input.action==='generate_similar' ? await generateSimilar(db,userId,input)
          : await analyze(db,userId,input.items,proofSecret,{idempotencyKey:input.idempotency_key,operation:input.action});
    return respond(request,{ok:true,schema_version:P22_SCHEMA_VERSION,action:input.action,...result,execution_flags:P22_EXECUTION_FLAGS});
  } catch(error) {
    const safe=publicError(error);
    console.error(JSON.stringify({event:'p22_research_assist_failure',code:safe.code,status:safe.status,details:safe.details}));
    return respond(request,{ok:false,code:safe.code,message:safe.message,details:safe.details,execution_flags:P22_EXECUTION_FLAGS},safe.status);
  }
});
