import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
import {
  P22_CNY_PER_USD, P22_EXECUTION_FLAGS, P22_LIMITS, P22_SCHEMA_VERSION, P22Error, buildMultimodalQwenContent, buildQwenPrompt,
  buildSimilarPostPrompt,
  assertUniqueRawCollectedPost, assertUniqueSearchResults, bindExactCollectedPost, issueCollectionProof, normalizeCollectedItems, normalizeRedditSearchItems, parseP22Request, parseQwenAnalyses, parseQwenMultimodalAnalyses, publicError,
  parseSimilarPostDraft, persistedEvidenceToAnalyzeItem, redditSearchBatchId, runApifyCollectionSequence, searchBatchId, verifyAnalyzeSources,
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
async function sha256Bytes(value: Uint8Array) { const owned=new Uint8Array(value.byteLength); owned.set(value); const bytes=await crypto.subtle.digest('SHA-256',owned.buffer); return [...new Uint8Array(bytes)].map((b)=>b.toString(16).padStart(2,'0')).join(''); }
function canonicalJson(value: unknown, depth=0, state={nodes:0}): string {
  state.nodes+=1;
  if(state.nodes>4096||depth>16) throw new P22Error('REQUEST_CANONICALIZATION_FAILED','Request cannot be safely canonicalized.',400);
  if(value===null) return 'null';
  if(typeof value==='string'||typeof value==='boolean') return JSON.stringify(value);
  if(typeof value==='number') {
    if(!Number.isFinite(value)) throw new P22Error('REQUEST_CANONICALIZATION_FAILED','Request cannot be safely canonicalized.',400);
    return JSON.stringify(value);
  }
  if(Array.isArray(value)) return `[${value.map((item)=>canonicalJson(item,depth+1,state)).join(',')}]`;
  if(typeof value==='object') {
    const record=value as Record<string,unknown>;
    const keys=Object.keys(record).filter((key)=>key!=='idempotency_key'&&record[key]!==undefined).sort();
    return `{${keys.map((key)=>`${JSON.stringify(key)}:${canonicalJson(record[key],depth+1,state)}`).join(',')}}`;
  }
  throw new P22Error('REQUEST_CANONICALIZATION_FAILED','Request cannot be safely canonicalized.',400);
}
async function canonicalRequestSha256(value: unknown) { return sha256(canonicalJson(value)); }
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

async function paidReservationId(userId: string, provider: string, operation: string, idempotencyKey: string | null, sequence = 0) {
  if (!idempotencyKey) return crypto.randomUUID();
  const digest=await sha256(`${userId}\n${provider}\n${operation}\n${idempotencyKey}\n${sequence}`);
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
}

function hasDatabaseCode(error, code: string) {
  return [error?.message,error?.details,error?.hint,error?.code]
    .some((value)=>String(value||'').includes(code));
}

async function recordProviderCost(db, userId: string, provider: string, operation: string, amount: number, idempotencyKey: string | null, sequence = 0, requestBinding: unknown = {}) {
  const id=await paidReservationId(userId,provider,operation,idempotencyKey,sequence);
  const requestSha256=await canonicalRequestSha256(requestBinding);
  const bindingKey=idempotencyKey||`auto:${id}`;
  const {data,error}=await db.schema('api').rpc('p22_claim_paid_operation',{
    p_user_id:userId,p_provider:provider,p_operation:operation,p_sequence:sequence,
    p_idempotency_key:bindingKey,p_request_sha256:requestSha256,
    p_amount_cny:amount,p_reservation_id:id,
  });
  if(error) {
    if(idempotencyKey&&hasDatabaseCode(error,'P22_IDEMPOTENCY_CONFLICT')) {
      throw new P22Error('IDEMPOTENCY_CONFLICT','同一幂等键已绑定到不同请求；本次未调用、未计费。',409);
    }
    throw new P22Error('COST_RECORDING_FAILED','无法安全记录本次调用费用。',503);
  }
  if (idempotencyKey && data?.outcome !== 'claimed') {
    throw new P22Error('IDEMPOTENT_RESULT_UNAVAILABLE','该付费操作已经受理；为避免重复计费，本次不再执行。',409);
  }
  return {...(data?.cost||{}),reservation_id:data?.reservation_id||id,request_sha256:requestSha256,binding_outcome:data?.outcome};
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
  const costRecord=await recordProviderCost(db,userId,'apify',input.action,P22_LIMITS.apify_reservation_cny,input.idempotency_key,0,input);
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
    const provenance={provider:`apify:${isRedditSearch?REDDIT_ACTOR:ACTOR}`,run_id:sequence.runId,collected_at:collectedAt,usage_total_usd:sequence.usageTotalUsd,budget_reservation_id:costRecord.reservation_id};
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
    if (isSearch) {
      const batchId=isRedditSearch
        ? await redditSearchBatchId({keyword:input.keyword,subreddit:input.subreddit,count:input.count,sort:input.sort,timeFilter:input.time_filter,runId:sequence.runId,collectedAt,items:normalized},sha256)
        : await searchBatchId({keyword:input.keyword,count:input.count,sort:input.sort,runId:sequence.runId,collectedAt,items:normalized},sha256);
      return {items,cost,search_batch_id:batchId,platform:isRedditSearch?'reddit':'x',keyword:input.keyword,count:input.count,sort_intent:input.sort,time_filter:isRedditSearch?input.time_filter:null,subreddit:isRedditSearch?input.subreddit:null,collected_at:collectedAt};
    }
    return {items,cost};
  } catch (error) { if (error?.name==='AbortError') throw new P22Error('APIFY_TIMEOUT','采集超时。',504); throw error; }
  finally { clearTimeout(timer); }
}

function attachmentObjectPath(ref: string) {
  const prefix='harness-thread-attachments:';
  if(!ref.startsWith(prefix)) throw new P22Error('ATTACHMENT_BINDING_INVALID','附件来源绑定无效。',400,{field:'attachments.ref'});
  return {bucket:'harness-thread-attachments',path:ref.slice(prefix.length)};
}

async function extractPdfText(bytes: Uint8Array) {
  if(bytes.byteLength>8*1024*1024) throw new P22Error('ATTACHMENT_PDF_TOO_LARGE','PDF 超过可解析上限。',413,{field:'attachments.size'});
  try {
    const pdfjsSpecifier='npm:pdfjs-dist@4.10.38/legacy/build/pdf.mjs';
    const pdfjs=await import(pdfjsSpecifier);
    const document=await pdfjs.getDocument({data:bytes,disableWorker:true,useWorkerFetch:false,isEvalSupported:false}).promise;
    if(!Number.isInteger(document.numPages)||document.numPages<1||document.numPages>50) throw new P22Error('ATTACHMENT_PDF_PAGE_LIMIT','PDF 页数超过上限。',413,{field:'attachments.pages'});
    const pages=[];
    for(let pageNumber=1;pageNumber<=document.numPages;pageNumber+=1) {
      const page=await document.getPage(pageNumber);
      const content=await page.getTextContent();
      pages.push(content.items.map((item)=>typeof item?.str==='string'?item.str:'').filter(Boolean).join(' '));
      if(pages.join('\n').length>65536) throw new P22Error('ATTACHMENT_TEXT_TOO_LARGE','PDF 提取文本超过上限。',413,{field:'attachments.text'});
    }
    return pages.join('\n').trim();
  } catch(error) {
    if(error instanceof P22Error) throw error;
    throw new P22Error('ATTACHMENT_PDF_INVALID','PDF 无法安全解析。',422,{field:'attachments'});
  }
}

async function inspectAttachments(db,userId:string,input,proofSecret:string) {
  const [{data:taskThread,error:taskError},{data:thread,error:threadError}]=await Promise.all([
    db.schema('api').rpc('harness_get_thread_by_task_v1',{p_user_id:userId,p_task_id:input.harness_task_id}),
    db.schema('api').rpc('harness_get_thread_v1',{p_user_id:userId,p_thread_id:input.thread_id}),
  ]);
  if(taskError||threadError||taskThread?.threadId!==input.thread_id||taskThread?.currentTaskId!==input.harness_task_id
    ||thread?.thread?.id!==input.thread_id||thread?.thread?.projectId!==input.project_id) {
    throw new P22Error('ATTACHMENT_TASK_BINDING_INVALID','附件、会话、任务或项目绑定不一致。',409,{field:'thread_id'});
  }
  const verified=[]; const media=[]; const extracted=[];
  for(const [index,attachment] of input.attachments.entries()) {
    const expectedPrefix=`${userId}/${input.thread_id}/`;
    const object=attachmentObjectPath(attachment.ref);
    if(!object.path.startsWith(expectedPrefix)) throw new P22Error('ATTACHMENT_OWNER_MISMATCH','附件不属于当前用户和会话。',403,{field:`attachments.${index}.ref`});
    const {data:blob,error}=await db.storage.from(object.bucket).download(object.path);
    if(error||!blob) throw new P22Error('ATTACHMENT_OBJECT_UNAVAILABLE','附件对象无法读取。',404,{field:`attachments.${index}.ref`});
    const bytes=new Uint8Array(await blob.arrayBuffer());
    if(bytes.byteLength!==attachment.size) throw new P22Error('ATTACHMENT_SIZE_MISMATCH','附件实际大小与声明不一致。',409,{field:`attachments.${index}.size`});
    const observedType=String(blob.type||'').toLowerCase();
    if(observedType!==attachment.mime_type) throw new P22Error('ATTACHMENT_MIME_MISMATCH','附件实际类型与声明不一致。',409,{field:`attachments.${index}.mime_type`});
    const digest=await sha256Bytes(bytes);
    verified.push({...attachment,sha256:digest});
    if(/^(text\/|application\/json)/.test(attachment.mime_type)) {
      if(bytes.byteLength>65536) throw new P22Error('ATTACHMENT_TEXT_TOO_LARGE','文本附件超过提取上限。',413,{field:`attachments.${index}.size`});
      let value='';
      try { value=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw new P22Error('ATTACHMENT_TEXT_INVALID','文本附件不是有效 UTF-8。',422,{field:`attachments.${index}`}); }
      extracted.push({name:attachment.name,text:value.trim().slice(0,65536)});
    } else if(attachment.mime_type==='application/pdf') {
      extracted.push({name:attachment.name,text:await extractPdfText(bytes)});
    } else {
      const {data:signed,error:signedError}=await db.storage.from(object.bucket).createSignedUrl(object.path,300);
      if(signedError||!signed?.signedUrl) throw new P22Error('ATTACHMENT_SIGNING_FAILED','附件无法创建有界分析地址。',503,{field:`attachments.${index}.ref`});
      media.push({id:`m-${(await sha256(`${attachment.ref}\n${digest}`)).slice(0,24)}`,kind:attachment.mime_type.startsWith('image/')?'image':'video',url:signed.signedUrl,name:attachment.name});
    }
  }
  const stableObjects=verified.map(({ref,name,size,mime_type,sha256})=>({ref,name,size,mime_type,sha256}));
  const sourceDigest=await sha256(canonicalJson({project_id:input.project_id,thread_id:input.thread_id,objects:stableObjects}));
  const sourceId=`h5-att-${sourceDigest.slice(0,24)}`;
  const baseText=[`Verified private attachment bundle (${stableObjects.length} files).`,...extracted.map((entry)=>`[${entry.name}]\n${entry.text}`)].join('\n\n').slice(0,65536);
  const firstObject=attachmentObjectPath(stableObjects[0].ref);
  const sourceUrl=`${Deno.env.get('SUPABASE_URL')}/storage/v1/object/authenticated/${firstObject.bucket}/${firstObject.path.split('/').map(encodeURIComponent).join('/')}`;
  const modelItem={id:sourceId,source_url:sourceUrl,content_text:baseText||'Verified visual attachment bundle.',content_sha256:await sha256(baseText||'Verified visual attachment bundle.'),media_assets:media.map((entry)=>({id:entry.id,kind:entry.kind,media_url:entry.url}))};
  const key=Deno.env.get('DASHSCOPE_API_KEY');
  if(!key) throw new P22Error('QWEN_NOT_CONFIGURED','Qwen 尚未配置。',503);
  const requestBinding={action:input.action,project_id:input.project_id,thread_id:input.thread_id,harness_task_id:input.harness_task_id,attachments:stableObjects};
  const costRecord=await recordProviderCost(db,userId,'qwen',input.action,P22_LIMITS.qwen_reservation_cny,input.idempotency_key,0,requestBinding);
  const prompt=[
    'You are a read-only private attachment research analyst. Return strict JSON only.',
    `Return {"analyses":[{"source_id":"${sourceId}","text_expression":"...","hook":"...","copy_pattern":"...","target_audience":"...","audience_need_emotion":"...","media_analysis":[${media.map((entry)=>`{"media_id":"${entry.id}","visual_content":"...","composition":"...","people":"...","scene":"...","emotion":"...","visual_selling_points":["..."],"style_pattern":"..."}`).join(',')}],"virality_drivers":["..."],"reusable_methods":["..."],"rewrite_suggestions":["..."],"signals":["..."],"risks":["..."]}]}.`,
    'Bind every media_id exactly once in the supplied order. Analyze only supplied verified content. Do not invent facts, publish, route, or generate final marketing assets.',
    `Verified filenames and extracted text:\n${baseText.slice(0,48000)}`,
  ].join('\n');
  const parts:any[]=[{type:'text',text:prompt}];
  for(const entry of media) parts.push(entry.kind==='image'?{type:'image_url',image_url:{url:entry.url}}:{type:'video_url',video_url:{url:entry.url}});
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),120000);
  try {
    const model=media.length?'qwen3.5-omni-flash':'qwen-plus';
    const response=await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,temperature:0.2,max_tokens:2600,response_format:{type:'json_object'},messages:[{role:'user',content:media.length?parts:prompt}]}),signal:controller.signal});
    if(!response.ok) throw new P22Error('QWEN_REQUEST_FAILED','附件分析失败。',502);
    const payload=await response.json(); const totalTokens=Number(payload?.usage?.total_tokens);
    if(!Number.isFinite(totalTokens)||totalTokens<=0) throw new P22Error('QWEN_COST_UNVERIFIABLE','无法验证附件分析用量。',502);
    const parsed=(media.length?parseQwenMultimodalAnalyses(payload,[modelItem]):parseQwenAnalyses(payload,[modelItem]))[0];
    const executedAt=new Date().toISOString();
    const persistedText=[baseText.slice(0,2500),`Model analysis (${model}):`,JSON.stringify(parsed)].join('\n\n').slice(0,P22_LIMITS.persist_text);
    const item:any={
      id:sourceId,source_url:sourceUrl,label:`Private attachments (${stableObjects.length})`,platform:'private_attachment',external_id:sourceId,
      content_text:persistedText,content_sha256:await sha256(persistedText),
      provenance:{schema_version:'h5_verified_attachment_provenance_v1',provider:'supabase-storage+dashscope',run_id:input.harness_task_id,thread_id:input.thread_id,collected_at:executedAt,usage_total_usd:0,budget_reservation_id:costRecord.reservation_id,object_bindings:stableObjects},
    };
    item.collection_proof=await issueCollectionProof(proofSecret,userId,item);
    return {items:[item],analyses:[{...parsed,model,executed_at:executedAt,usage:{total_tokens:totalTokens},cost:{recorded_cny:P22_LIMITS.qwen_reservation_cny,reservation_id:costRecord.reservation_id}}],usage:{total_tokens:totalTokens},cost:{recorded_cny:P22_LIMITS.qwen_reservation_cny,tracking:costRecord}};
  } catch(error) { if(error?.name==='AbortError') throw new P22Error('QWEN_TIMEOUT','附件分析超时。',504); throw error; }
  finally { clearTimeout(timer); }
}

async function analyze(db,userId:string,items,proofSecret:string,{persisted=false,idempotencyKey=null,operation='analyze',requestBinding={action:operation,items}}:{persisted?:boolean,idempotencyKey?:string|null,operation?:string,requestBinding?:unknown}={}) {
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
    const costRecord=await recordProviderCost(db,userId,'qwen',operation,P22_LIMITS.qwen_reservation_cny,idempotencyKey,groupIndex,requestBinding);
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
      analyses.push(...(group.multimodal
        ? parseQwenMultimodalAnalyses(payload,group.items).map((row)=>({...row,model:modelName}))
        : parseQwenAnalyses(payload,group.items).map((row)=>({...row,model:modelName}))));
      usageTotal+=totalTokens;
      costRecords.push({recorded_cny:P22_LIMITS.qwen_reservation_cny,tracking:costRecord});
    } catch(error) { if(error?.name==='AbortError') throw new P22Error('QWEN_TIMEOUT','辅助分析超时。',504); throw error; }
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
  const requestBinding={
    ...input,
    evidence_version:loaded.evidence.version,
    evidence_fingerprint:loaded.evidence.fingerprint,
  };
  const result=await analyze(db,userId,[item],proofSecret,{persisted:true,idempotencyKey:input.idempotency_key,operation:input.action,requestBinding});
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
  const requestBinding={
    ...input,
    evidence_version:loaded.evidence.version,
    evidence_fingerprint:loaded.evidence.fingerprint,
    analysis_version:analysis.version,
    analysis_fingerprint:analysis.fingerprint,
  };
  const costRecord=await recordProviderCost(db,userId,'qwen',input.action,P22_LIMITS.qwen_reservation_cny,input.idempotency_key,0,requestBinding);
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),60000);
  try {
    const response=await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'qwen-plus',temperature:0.5,max_tokens:1800,response_format:{type:'json_object'},messages:[{role:'user',content:buildSimilarPostPrompt(loaded.evidence,analysis)}]}),signal:controller.signal});
    if(!response.ok) throw new P22Error('QWEN_REQUEST_FAILED','相似帖子草稿生成失败。',502);
    const payload=await response.json(); const totalTokens=Number(payload?.usage?.total_tokens);
    if(!Number.isFinite(totalTokens)||totalTokens<=0) throw new P22Error('QWEN_COST_UNVERIFIABLE','无法验证草稿生成用量。',502);
    const draft=parseSimilarPostDraft(payload?.choices?.[0]?.message?.content);
    return {draft:{...draft,evidence_id:input.evidence_id,evidence_version:loaded.evidence.version,evidence_fingerprint:loaded.evidence.fingerprint,analysis_id:input.analysis_id,analysis_version:analysis.version,analysis_fingerprint:analysis.fingerprint,model:'qwen-plus',generated_at:new Date().toISOString(),execution_flags:P22_EXECUTION_FLAGS},usage:{total_tokens:totalTokens},cost:{recorded_cny:P22_LIMITS.qwen_reservation_cny,tracking:costRecord},project_id:input.project_id};
  } catch(error) { if(error?.name==='AbortError') throw new P22Error('QWEN_TIMEOUT','相似帖子草稿生成超时。',504); throw error; }
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
      : input.action==='inspect_attachments' ? await inspectAttachments(db,userId,input,proofSecret)
        : input.action==='analyze_persisted' ? await analyzePersisted(db,userId,input,proofSecret)
        : input.action==='generate_similar' ? await generateSimilar(db,userId,input)
          : await analyze(db,userId,input.items,proofSecret,{idempotencyKey:input.idempotency_key,operation:input.action,requestBinding:input});
    return respond(request,{ok:true,schema_version:P22_SCHEMA_VERSION,action:input.action,...result,execution_flags:P22_EXECUTION_FLAGS});
  } catch(error) {
    const safe=publicError(error);
    console.error(JSON.stringify({event:'p22_research_assist_failure',code:safe.code,status:safe.status,details:safe.details}));
    return respond(request,{ok:false,code:safe.code,message:safe.message,details:safe.details,...(safe.diagnostics?{diagnostics:safe.diagnostics}:{}),execution_flags:P22_EXECUTION_FLAGS},safe.status);
  }
});
