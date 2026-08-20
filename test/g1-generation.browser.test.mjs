/* global fetch */
// G1 éªŒæ”¶ #5ï¼šçœŸå®žç”Ÿäº§æž„å»ºæµè§ˆå™¨æµ‹è¯•ï¼ˆfake æœ¬åœ° provider/Storageï¼‰ã€‚
//
// - vite dev ä»¥ VITE_G1_EDGE_BASE_URL æŒ‡å‘æœ¬åœ° fake å‰ç¼€å¯åŠ¨ï¼›
// - é¡µé¢å†…æ³¨å…¥ fetch æ‹¦æˆªï¼š/g1-fake/functions/v1/g1-generation-command â†’
//   å†…å­˜ fake edgeï¼ˆå®žçŽ°ä¸ŽçœŸå®ž Edge Function ç›¸åŒçš„å¥‘çº¦ï¼šquote â†’ æ˜¾å¼æ‰¹å‡†
//   ç»‘å®š â†’ å¹‚ç­‰æäº¤ â†’ çŠ¶æ€æŽ¨è¿› â†’ ç§æœ‰äº§ç‰© blob URLï¼‰ï¼›
// - çœŸå®žç‚¹å‡» quote â†’ æ‰¹å‡† â†’ æäº¤ â†’ queued/running/completed â†’
//   ç§æœ‰é¢„è§ˆ/ä¸‹è½½ â†’ åˆ·æ–°æ¢å¤ â†’ é¡¹ç›®åˆ‡æ¢éš”ç¦»ï¼›
// - å…¨ç¨‹é›¶çœŸå®ž provider/Storage è°ƒç”¨ï¼›è½®è¯¢é—´éš”ç» VITE_G1_POLL_INTERVAL_MS
//   æ”¶ç´§åˆ° 500msã€‚

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  EDGE, freePort, waitFor, waitForPageTarget, CdpClient, createPageTracker,
  navigateAndWait, reloadAndWait, waitForSelector, click, captureDiagnostics,
  makeTempProfile, removeTempProfile, shutdownEdge, killProcessTree,
} from './helpers/cdp-browser-harness.mjs';

const ROOT = join(import.meta.dirname, '..');

// é¡µé¢å†… fake edgeï¼šé•œåƒçœŸå®ž g1-generation-command å¥‘çº¦ï¼ˆæœ‰ç•Œæ ¡éªŒ + æ˜¾å¼
// æ‰¹å‡†ç»‘å®š + å¹‚ç­‰é‡æ”¾ + çŠ¶æ€æŽ¨è¿› + çŸ­æ—¶ç­¾å URLï¼‰ã€‚ä½œä¸š/æŠ¥ä»·/äº§ç‰©/æäº¤è®¡æ•°
// æŒä¹…åŒ–åœ¨ localStorageï¼Œç¡¬åˆ·æ–°åŽçŠ¶æ€ä¿æŒï¼ˆä¸ŽçœŸå®ž staging ä¸€è‡´ï¼‰ã€‚
const FAKE_EDGE_SCRIPT = `
(() => {
  const EDGE_SCHEMA = 'g1_generation_command_v1';
  const readMap = (key) => {
    try { return new Map(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Map(); }
  };
  const writeMap = (key, map) => localStorage.setItem(key, JSON.stringify([...map.entries()]));
  const jobs = readMap('g1_fake_jobs_v1');
  const quotes = readMap('g1_fake_quotes_v1');
  const artifacts = readMap('g1_fake_artifacts_v1');
  let submissionCount = Number(localStorage.getItem('g1_fake_submissions_v1') || 0);
  const save = () => {
    writeMap('g1_fake_jobs_v1', jobs);
    writeMap('g1_fake_quotes_v1', quotes);
    writeMap('g1_fake_artifacts_v1', artifacts);
    localStorage.setItem('g1_fake_submissions_v1', String(submissionCount));
  };
  const refAssets = [
    { id: '00000000-0000-4000-8000-000000000001', name: 'å·²æ‰¹å‡†å‚è€ƒç´ æ', type: 'image', purpose: 'reference', approval: 'approved' },
  ];
  const providers = [
    { provider_id: 'bailian', mode: 'image', model_name: 'qwen-image-2.0', model_version: 1, enabled: true, price_cny_min: 0.02, price_cny_max: 0.3, max_prompt_chars: 2000, max_negative_prompt_chars: 500, allowed_aspect_ratios: ['1:1','4:3','3:4','16:9','9:16','21:9'], max_duration_seconds: 0, allowed_resolutions: [], reference_required: false },
    { provider_id: 'bailian', mode: 'video_t2v', model_name: 'happyhorse-1.0-t2v', model_version: 1, enabled: true, price_cny_min: 0.5, price_cny_max: 8, max_prompt_chars: 2000, max_negative_prompt_chars: 500, allowed_aspect_ratios: ['16:9','9:16','1:1'], max_duration_seconds: 10, allowed_resolutions: ['720p','1080p'], reference_required: false },
    { provider_id: 'bailian', mode: 'video_i2v', model_name: 'happyhorse-1.0-i2v', model_version: 1, enabled: true, price_cny_min: 0.8, price_cny_max: 12, max_prompt_chars: 2000, max_negative_prompt_chars: 500, allowed_aspect_ratios: ['16:9','9:16','1:1'], max_duration_seconds: 10, allowed_resolutions: ['720p','1080p'], reference_required: true },
  ];
  const sha256 = async (text) => {
    const bytes = new TextEncoder().encode(text);
    const value = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(value)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const canonicalRequest = (req) => JSON.stringify({
    schema_version: 'g1_generation_request_v1',
    project_id: req.project_id,
    brief_id: req.brief_id,
    mode: req.mode,
    prompt: req.prompt,
    negative_prompt: req.negative_prompt || null,
    aspect_ratio: req.aspect_ratio || (req.mode === 'image' ? '1:1' : '16:9'),
    duration_seconds: req.duration_seconds || null,
    resolution: req.resolution || null,
    reference_asset_id: req.reference_asset_id || null,
    knowledge_card_ids: (req.knowledge_card_ids || []).slice().sort(),
    evidence_ids: (req.evidence_ids || []).slice().sort(),
  });
  const ok = (payload, extra = {}) => ({ ok: true, schema_version: EDGE_SCHEMA, ...payload, ...extra });
  const fail = (code, message) => ({ ok: false, code, message, diagnostics: { issues: [message] } });
  const summarize = (job) => ({
    id: job.id,
    project_id: job.project_id,
    status: job.status,
    mode: job.mode,
    model_name: job.model_name,
    model_version: 1,
    attempt_count: 1,
    max_attempts: 2,
    brief_id: job.brief_id,
    brief_version: job.brief_version,
    artifact_count: job.artifact_count || 0,
    created_at: job.created_at,
    updated_at: job.updated_at,
    diagnostics: job.diagnostics || {},
  });

  globalThis.__g1FakeState = { submissions: () => submissionCount };

  window.fetch = new Proxy(window.fetch, {
    apply(target, thisArg, args) {
      const url = String(args[0] || '');
      if (!url.includes('/g1-fake/functions/v1/g1-generation-command')) {
        return Reflect.apply(target, thisArg, args);
      }
      return (async () => {
        const body = JSON.parse(String(args[1]?.body || '{}'));
        const user = String(args[1]?.headers?.['x-ams-demo-user'] || 'demo-user');
        const modeFor = (mode) => providers.find((p) => p.mode === mode);
        const briefFor = (projectId) => {
          try {
            const raw = localStorage.getItem('p19_workspace_store_v1');
            if (!raw) return null;
            const envelope = JSON.parse(raw);
            const list = envelope.projects || [];
            const project = list.find((p) => p.id === projectId);
            return project?.brief || null;
          } catch { return null; }
        };
        const projectFor = (projectId) => {
          try {
            const raw = localStorage.getItem('p19_workspace_store_v1');
            if (!raw) return null;
            const envelope = JSON.parse(raw);
            const list = envelope.projects || [];
            return list.find((p) => p.id === projectId) || null;
          } catch { return null; }
        };
        // P19 è¯æ®æŠ¥ä»·ç»‘å®šåˆåŒé•œåƒï¼ˆä¸Žæ•°æ®åº“ g1_resolve_evidence_binding åŒè¯­ä¹‰ï¼‰ï¼š
        // å¡ç‰‡é›† = Brief å¼•ç”¨é›†ï¼ˆè§„èŒƒæŽ’åºã€åŽ»é‡å‰æ‹’ç»é‡å¤ï¼‰ï¼›æƒå¨è¯æ®é›† = å¡ç‰‡
        // evidence_links[].source_ref åŽ»é‡æŽ’åºï¼›è¯·æ±‚è¯æ®å¿…é¡»ç²¾ç¡®ç­‰äºŽæƒå¨é›†ã€‚
        const canonicalCardSet = (brief, project) => {
          const ids = (brief.knowledge_citation_ids || []).slice().sort();
          if (!project || ids.length === 0) return { ok: false, code: 'G1_BINDING_INVALID', message: 'çŸ¥è¯†å¡é›†åˆä¸åˆæ³•ã€‚' };
          const seen = new Set();
          for (const id of ids) {
            if (typeof id !== 'string' || !/^kc-[0-9a-f]{24}$/.test(id)) return { ok: false, code: 'G1_BINDING_INVALID', message: 'çŸ¥è¯†å¡èº«ä»½ä¸åˆæ³•ã€‚' };
            if (seen.has(id)) return { ok: false, code: 'G1_BINDING_INVALID', message: 'çŸ¥è¯†å¡é‡å¤ã€‚' };
            seen.add(id);
          }
          const cited = new Set((project.knowledge_cards || []).map((c) => c.id));
          for (const id of ids) if (!cited.has(id)) return { ok: false, code: 'G1_BINDING_MISSING', message: 'çŸ¥è¯†å¡ä¸å­˜åœ¨ã€‚' };
          return { ok: true, ids };
        };
        const deriveEvidence = (brief, project) => {
          const refs = new Set();
          const cardById = new Map((project?.knowledge_cards || []).map((c) => [c.id, c]));
          for (const cardId of (brief.knowledge_citation_ids || [])) {
            const card = cardById.get(cardId);
            for (const link of (card?.evidence_links || [])) {
              const ref = link && typeof link === 'object' ? link.source_ref : null;
              if (typeof ref === 'string' && /^ev-[0-9a-f]{24}$/.test(ref)) refs.add(ref);
            }
          }
          return [...refs].sort();
        };
        const canonicalEvidenceCheck = (brief, project, requested) => {
          const derived = deriveEvidence(brief, project);
          if (derived.length === 0) return { ok: false, code: 'G1_BINDING_INVALID', message: 'çŸ¥è¯†å¡æœªæ´¾ç”Ÿä»»ä½•è¯æ®ã€‚' };
          if (!Array.isArray(requested) || requested.length === 0) return { ok: false, code: 'G1_BINDING_INVALID', message: 'è¯æ®æ•°ç»„ä¸åˆæ³•ã€‚' };
          const seen = new Set();
          for (const id of requested) {
            if (typeof id !== 'string' || !/^ev-[0-9a-f]{24}$/.test(id)) return { ok: false, code: 'G1_BINDING_INVALID', message: 'è¯æ®èº«ä»½ä¸åˆæ³•ã€‚' };
            if (seen.has(id)) return { ok: false, code: 'G1_BINDING_INVALID', message: 'è¯æ®é‡å¤ã€‚' };
            seen.add(id);
          }
          const canon = [...new Set(requested)].sort();
          if (JSON.stringify(canon) !== JSON.stringify(derived)) return { ok: false, code: 'G1_BINDING_MISMATCH', message: 'è¯·æ±‚è¯æ®ä¸Žæƒå¨è¯æ®é›†ä¸ç²¾ç¡®åŒ¹é…ã€‚' };
          return { ok: true, ids: derived };
        };
        if (body.action === 'providers') {
          return new Response(JSON.stringify(ok({ action: 'providers', data: { registry: providers } })), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'list_reference_assets') {
          return new Response(JSON.stringify(ok({ action: 'list_reference_assets', data: { assets: refAssets } })), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'quote') {
          const brief = briefFor(body.project_id);
          if (!brief || !['pending_review', 'approved'].includes(brief.status)) {
            return new Response(JSON.stringify(fail('G1_BRIEF_NOT_FOUND', 'Brief ä¸å­˜åœ¨æˆ–ä¸å¯é€‰æ‹©ã€‚')), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          const project = projectFor(body.project_id);
          // å¡ç‰‡é›†å¿…é¡»ä¸Ž Brief å¼•ç”¨é›†ç²¾ç¡®ç›¸ç­‰ï¼ˆè§„èŒƒæŽ’åºï¼›é‡å¤åŽ»é‡å‰æ‹’ç»ï¼‰ã€‚
          const cardCheck = canonicalCardSet(brief, project);
          if (!cardCheck.ok) {
            return new Response(JSON.stringify(fail(cardCheck.code, cardCheck.message)), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          const requestedCardCanon = [...new Set((Array.isArray(body.knowledge_card_ids) ? body.knowledge_card_ids : []) || [])].sort();
          if (JSON.stringify(requestedCardCanon) !== JSON.stringify(cardCheck.ids)) {
            return new Response(JSON.stringify(fail('G1_BINDING_MISMATCH', 'è¯·æ±‚çŸ¥è¯†å¡é›†åˆä¸Ž Brief å¼•ç”¨é›†ä¸ç²¾ç¡®åŒ¹é…ã€‚')), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          // è¯æ®é›†ï¼šè¯·æ±‚æä¾›æ—¶å¿…é¡»ç²¾ç¡®ç­‰äºŽæƒå¨é›†ï¼›çœç•¥æ—¶è‡ªåŠ¨ç»‘å®šæƒå¨é›†
          // ï¼ˆåŽ†å² Brief æ—  evidence_ids æ—¶ä»Žå¡ç‰‡ evidence_links[].source_ref æ´¾ç”Ÿï¼‰ã€‚
          let evidenceIds;
          if (body.evidence_ids === undefined || body.evidence_ids === null) {
            evidenceIds = deriveEvidence(brief, project);
            if (evidenceIds.length === 0) {
              return new Response(JSON.stringify(fail('G1_BINDING_INVALID', 'çŸ¥è¯†å¡æœªæ´¾ç”Ÿä»»ä½•è¯æ®ã€‚')), { status: 400, headers: { 'content-type': 'application/json' } });
            }
          } else {
            const evCheck = canonicalEvidenceCheck(brief, project, body.evidence_ids);
            if (!evCheck.ok) {
              return new Response(JSON.stringify(fail(evCheck.code, evCheck.message)), { status: 400, headers: { 'content-type': 'application/json' } });
            }
            evidenceIds = evCheck.ids;
          }
          const requestSha = await sha256(canonicalRequest({ ...body, knowledge_card_ids: cardCheck.ids, evidence_ids: evidenceIds }));
          const quote = {
            schema_version: 'g1_quote_v1',
            quote_id: 'g1q-' + requestSha.slice(0, 24),
            user_id: user,
            project_id: body.project_id,
            mode: body.mode,
            provider: 'bailian',
            model_name: modeFor(body.mode).model_name,
            model_version: 1,
            price_cny_min: modeFor(body.mode).price_cny_min,
            price_cny_max: modeFor(body.mode).price_cny_max,
            estimated_max_cost_cny: modeFor(body.mode).price_cny_max,
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            request_sha256: requestSha,
            brief_id: body.brief_id,
            brief_version: brief.version || 1,
            brief_fingerprint: brief.fingerprint || 'b'.repeat(64),
            project_revision: 1,
            knowledge_card_ids: cardCheck.ids,
            evidence_ids: evidenceIds,
            reference_asset_id: body.reference_asset_id || null,
            will_use_storage: true,
            will_write: true,
            will_pay: true,
            will_execute: true,
          };
          const quoteFingerprint = await sha256(JSON.stringify(quote));
          quote.quote_fingerprint = quoteFingerprint;
          if (!quotes.has(quote.quote_id)) { quotes.set(quote.quote_id, quote); save(); }
          return new Response(JSON.stringify(ok({ action: 'quote', data: { quote }, entity: { type: 'quote', id: quote.quote_id } })), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'approve_submit') {
          const quote = quotes.get(body.quote_id);
          if (!quote) {
            return new Response(JSON.stringify(fail('G1_QUOTE_NOT_FOUND', 'quote ä¸å­˜åœ¨ã€‚')), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          if (body.quote_fingerprint !== quote.quote_fingerprint || body.request_fingerprint !== quote.request_sha256
            || body.estimated_max_cost_cny !== quote.estimated_max_cost_cny || new Date(body.expires_at) > new Date(quote.expires_at)) {
            return new Response(JSON.stringify(fail('G1_APPROVAL_MISMATCH', 'æ‰¹å‡†å¯¹è±¡ä¸Ž quote ä¸ç²¾ç¡®åŒ¹é…ã€‚')), { status: 409, headers: { 'content-type': 'application/json' } });
          }
          const key = body.idempotency_key;
          for (const job of jobs.values()) {
            if (job.idempotency_key === key) {
              return new Response(JSON.stringify(ok({ action: 'approve_submit', data: { job: summarize(job) }, entity: { type: 'generation_job', id: job.id ã¹¶‰žËkºwµçRkšr³’æ/–&7šÎ£–”™…­”•‘—¾ò#š.›š"¨€½œÄµ™…­”ƒ–&7žò¾ò'Ž4(€€€…Ý…¥Ð‘À¹Í•¹ A…”¹…‘‘MÉ¥ÁÑQ½Ù…±Õ…Ñ•=¹9•Ý½Õµ•¹Ðœ°ìÍ½ÕÉ”è-}}MI%APô¤ì4(€€€…Ý…¥Ð¹…Ù¥…Ñ•¹‘]…¥Ð¡‘À°ÑÉ…­•È°‰…Í•UÉ°°ì±…‰•°è€‰…Í”Á…”œô¤ì4(€€€½¹ÍÐÍ••‘•€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡M}MI%AP¤ì4(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡Í••‘•¹ÁÉ½©•Ñ%‘Ì¹±•¹Ñ °€È°€Ÿ–þ¦†ï¦Šžö»’â“’â«ž.³ž®/¦†çžn¸œ¤ì4(€€€½¹ÍÐÁÉ½©•Ñ%‘Ì€ôÍ••‘•¹ÁÉ½©•Ñ%‘Ìì4(4(€€€€¼¼ƒžž7–¶C–g–—–B;š‹–’7–Þ—’ös–2ë¾òk¦†×¦v‹š¢‡–v_–r£žž7–¶C–g–—–&7–ÞË–"w–ž/–2[¾ò3’î¦v€¡…Í ƒ–¾ó¢"«’â7’òh4(€€€€¼¼ƒ¦7šZÃ¢¾ï–>X±½…±MÑ½É…—¾òo–#ž†»–ºkšŸ’âïšZš†¦7¢ö÷¾ò#ž¶'–ú–¾ó¢"«š>C’ê€¬É•…‘åMÑ…Ñ”ô4(€€€€¼¼½µÁ±•Ñ—¾ò'¢º§–êSžR£–£šZÃ–B¿–*£–æÛ¢¾ï–>[žž7–¶C–Þ—’ös–2ë¾ò3–7¢þo–”€Œ½•¹•É…Ñ¥½»¾ò#¦†×¦v‹–4(€€€€¼¼±½…Ñ¥½¸¹¡É•˜ƒ¢Ö/–ó¾ò1¡…Í ƒ–>c–2[–þžÛ¢ž›–>G¢Þ¿žRÇ¾ò'Ž4(€€€…Ý…¥ÐÉ•±½…‘¹‘]…¥Ð¡‘À°ÑÉ…­•È°ì±…‰•°è€Í••Ý½É­ÍÁ…”É•±½…œô¤ì4(€€€…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡±½…Ñ¥½¸¹¡É•˜€ô€‘í)M=8¹ÍÑÉ¥¹¥™ä¡€‘í‰…Í•UÉ±ôŒ½•¹•É…Ñ¥½¹€¥õ€¤ì4(€€€€¼¼=4ƒ–ÂÇžî«¾ò#šr'žV3¢ö»¢¾‹¾ò3š^ƒ–në–ºhÍ±••Ã¾ò'¾òk–"o–îë¦v‹švÿžr–º{š2¢ö÷Ž4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÉ•…Ñ”µÁ…¹•°‰tœ°ì±…‰•°è€ÄÉ•…Ñ”Á…¹•°œ°Ñ¥µ•½ÕÐè€ÌÁ|ÀÀÀô¤ì(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÈµÝ½É­ÍÁ…”‰tœ°ì±…‰•°è€ÈÍ¥µÁ±¥™¥•Ý½É­ÍÁ…”œ°Ñ¥µ•½ÕÐè€ÌÁ|ÀÀÀô¤ì(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÈµ™±½Ü‰tœ°ì±…‰•°è€ÈÕ¥‘•™±½Üœ°Ñ¥µ•½ÕÐè€ÌÁ|ÀÀÀô¤ì(€€€€¼¼ƒšÒï–*£¦†çžn»–ÂÇžî«¾òk–"o–îë¦v‹švÿ–þ¦†ïžîG–ºkžž7–¶C¦†çžn¸ƒžj	É¥•˜ƒš‚¦ŠcŽ(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹‰½‘ä¹¥¹¹•ÉQ•áÐ¹¥¹±Õ‘•Ì ÄƒšÖ?¢ž#–f£žRš"C¦†çžn¸œ¥€¤°ì±…‰•°è€Í••‘•ÁÉ½©•Ð‰É¥•˜œô¤ì(€€€½¹ÍÐÍ½ÕÉ•MÕµµ…Éä€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÈµÍ½ÕÉ”µÍÕµµ…Éä‰tœ¤¹¥¹¹•ÉQ•áÑ€¤ì(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡Í½ÕÉ•MÕµµ…Éä°€¼Ìƒ–òƒž~—¢¾–6„ƒ
Ü€Ìƒšv‡¢¾š6¸¼°Èƒ–þ¦†ï¢«–*£žîG–ºk–öO–&4	É¥•˜ƒžj’â'–6‡’â'¢¾š6»¾òh‘íÍ½ÕÉ•MÕµµ…Éåõ€¤ì((€€€€¼¼ƒžºšÒš¢‡–ò?–ò–Ï–þ¦†ï–ž†»š:Ÿ–"Û–:|Äƒš¢‡–ò?–B#–B3¾ò3’âS’â7¢ž›–>G’îï’öW¢¾ßšÆŽ(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÈµµ½‘”µ¥µ…”‰tœ¤¹•ÑÑÑÉ¥‰ÕÑ” …É¥„µÁÉ•ÍÍ•œ¥€¤°€ÑÉÕ”œ¤ì(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÈµµ½‘”µÙ¥‘•¼‰tœ°±…‰•°è€ÈÙ¥‘•¼µ½‘”œô¤ì(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµµ½‘”µÍ•±•Ð‰tœ¤¹Ù…±Õ•€¤°€Ù¥‘•½}ÐÉØœ¤ì(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÈµµ½‘”µ¥µ…”‰tœ°±…‰•°è€È¥µ…”µ½‘”œô¤ì(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµµ½‘”µÍ•±•Ð‰tœ¤¹Ù…±Õ•€¤°€¥µ…”œ¤ì(4(€€€€¼¼€´´´´ƒ¢†£–6W¾òi¥µ…”ƒš¢‡–ò<€¬ÁÉ½µÁÐƒŠHƒ¢¾ßšÆš*—’îÜ€´´´´4(€€€…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡€  ¤€ôøì4(€€€€€½¹ÍÐ…É•„€ô‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÁÉ½µÁÐµ¥¹ÁÕÐ‰tœ¤ì4(€€€€€½¹ÍÐÍ•ÑÑ•È€ô=‰©•Ð¹•Ñ=Ý¹AÉ½Á•ÉÑå•ÍÉ¥ÁÑ½È¡Ý¥¹‘½Ü¹!Q51Q•áÑÉ•…±•µ•¹Ð¹ÁÉ½Ñ½ÑåÁ”°€Ù…±Õ”œ¤¹Í•Ðì4(€€€€€Í•ÑÑ•È¹…±°¡…É•„°€Ÿ’â–>«–r£šŽ»šz_¦3žjš¦cž2¯¾ò3¦bÏ–'’â,œ¤ì4(€€€€€…É•„¹‘¥ÍÁ…Ñ¡Ù•¹Ð¡¹•ÜÙ•¹Ð ¥¹ÁÕÐœ°ì‰Õ‰‰±•ÌèÑÉÕ”ô¤¤ì4(€€€ô¤ ¥€¤ì4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÉ•ÅÕ•ÍÐµÅÕ½Ñ”‰tœ°±…‰•°è€É•ÅÕ•ÍÐÅÕ½Ñ”œô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÅÕ½Ñ”µÁ…¹•°‰tœ°ì±…‰•°è€ÅÕ½Ñ”Á…¹•°œ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(€€€½¹ÍÐÅÕ½Ñ•Q•áÐ€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÅÕ½Ñ”µÁ…¹•°‰tœ¤¹¥¹¹•ÉQ•áÑ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡ÅÕ½Ñ•Q•áÐ°€½ÅÝ•¸µ¥µ…”´Ép¸À¼°ÅÕ½Ñ”ƒ–þ¦†ïšbûž’ë–në–ºkš¢‡–z/¾òh‘íÅÕ½Ñ•Q•áÐ¹Í±¥” À°€ÈÀÀ¥õ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡ÅÕ½Ñ•Q•áÐ°€¿
”Áp¸ÀÈƒŠLƒ
”Áp¸ÌÀ¼°ÅÕ½Ñ”ƒ–þ¦†ïšbûž’ëšr'žV3¢ÒçžR£–2ë¦^Ó¾òh‘íÅÕ½Ñ•Q•áÐ¹Í±¥” À°€ÈÀÀ¥õ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡ÅÕ½Ñ•Q•áÐ°€¿’îc¢ÒçžRš"@p¬ƒžžšr'–¶c–
£–g–”¼°ÅÕ½Ñ”ƒ–þ¦†ï–ŽÃšb;’îc¢Òçš&Ÿ¢†3’â;–¶c–
£–g–•€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡ÅÕ½Ñ•Q•áÐ°€¿ž²°€Äƒž& ¼°ÅÕ½Ñ”ƒ–þ¦†ïžîG–ºh	É¥•˜ƒž&#šr±€¤ì4(€€€€¼¼ƒžž7–¶@	É¥•˜ƒšb¿–:–>Ë–ö‹š¾ò!•Ù¥‘•¹•}ÁÉ½Ù•¹…¹”ƒš^€•Ù¥‘•¹•}¥‘Ï¾ò'¾òi™…­”•‘”ƒ–þ¦†ì4(€€€€¼¼ƒ’î;¢Š¯–òWž~—¢¾–6„•Ù¥‘•¹•}±¥¹­Ímt¹Í½ÕÉ•}É•˜ƒšÒûžRšv–¢¢¾š6»¦n–æÛžîG–ºk¾ò#’â'–6„¿’â'¢¾š6»¾ò'Ž4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡ÅÕ½Ñ•Q•áÐ°€¼Ìp¼€Ì¼°ÅÕ½Ñ”ƒ–þ¦†ïžîG–ºk’â'–6„¿’â'¢¾š6»¾ò#–:–>È	É¥•˜ƒšÒûžRšv–¢¦n¾ò'¾òh‘íÅÕ½Ñ•Q•áÐ¹Í±¥” À°€ÈÀÀ¥õ€¤ì4(€€€½¹ÍÐµ…á½ÍÐ€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÅÕ½Ñ”µµ…à‰tœ¤¹Ñ•áÑ½¹Ñ•¹Ñ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡µ…á½ÍÐ°€¿
”Áp¸ÌÀ¼°ƒ¦Š’òÃšr–’Ÿ¢ÒçžR£–þ¦†ïšbûž’ë¾òh‘íµ…á½ÍÑõ€¤ì4(4(€€€€¼¼€´´´´ƒšbû–ò?š&ç–¾òkšr«–.û¦'’â7–>¿š>C’ê“¾òo–.û¦'–B;š>C’ê€´´´´4(€€€½¹ÍÐ‘¥Í…‰±•‘	•™½É”€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÁÁÉ½Ù”µÍÕ‰µ¥Ð‰tœ¤¹‘¥Í…‰±•‘€¤ì4(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡‘¥Í…‰±•‘	•™½É”°ÑÉÕ”°€Ÿšr«–.û¦'š&ç–š^Ûš>C’ê“š2'¦J»–þ¦†ïžšžR œ¤ì4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÁÁÉ½Ù…°µ¡•¬‰tœ°±…‰•°è€…ÁÁÉ½Ù…°¡•­‰½àœô¤ì4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÁÁÉ½Ù”µÍÕ‰µ¥Ð‰tœ°±…‰•°è€…ÁÁÉ½Ù”…¹ÍÕ‰µ¥Ðœô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹‰½‘ä¹¥¹¹•ÉQ•áÐ¹¥¹±Õ‘•Ì Ÿ’ös’âk–ÞË–"o–îèœ¥€¤°ì±…‰•°è€©½ˆÉ•…Ñ•µ•ÍÍ…”œ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ…É‰tœ°ì±…‰•°è€©½ˆ…Éœ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(4(€€€€¼¼€´´´´ƒž*Ûšš:£¢þo¾òiÅÕ•Õ•½ÉÕ¹¹¥¹œƒŠH½µÁ±•Ñ•“¾ò!™…­”Ý½É­•Èƒž*Ûššrë¾ò$´´´´4(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµÍÑ…ÑÕÌ‰tœ¤ü¹Ñ•áÑ½¹Ñ•¹Ð¹¥¹±Õ‘•Ì Ÿ–ÞË–º3š"@œ¥€¤°ì±…‰•°è€©½ˆ½µÁ±•Ñ•œ°Ñ¥µ•½ÕÐè€ÈÁ|ÀÀÀô¤ì4(€€€½¹ÍÐÍÑ…ÑÕÍQ•áÐ€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµÍÑ…ÑÕÌ‰tœ¤¹Ñ•áÑ½¹Ñ•¹Ñ€¤ì4(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡ÍÑ…ÑÕÍQ•áÐ°€Ÿ–ÞË–º3š"@œ¤ì4(4(€€€€¼¼€´´´´ƒžžšr'’êŸž&§¦Š¢ž €¬ƒž&#šr³–:–>È€¬ƒ’â/¢ö÷¦Nûš:”€´´´´4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€œ¹œÄµ©½ˆµ…Éœ°±…‰•°è€½Á•¸©½ˆ‘É…Ý•Èœô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ‘É…Ý•È‰tœ°ì±…‰•°è€©½ˆ‘É…Ý•Èœô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÉÑ¥™…ÐµÍÑ…”‰t¥µœœ°ì±…‰•°è€…ÉÑ¥™…Ð¥µ…”ÁÉ•Ù¥•Üœ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(€€€½¹ÍÐ¥µMÉŒ€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÉÑ¥™…ÐµÍÑ…”‰t¥µœœ¤¹ÍÉ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡¥µMÉŒ°€½y‰±½ˆè¼°ƒ’êŸž&§¦Š¢ž#–þ¦†ïšb¿žžšr$‰±½ˆƒž~·š^Û¦Nûš:—¾òh‘í¥µMÉŒ¹Í±¥” À°€ØÀ¥õ€¤ì4(€€€½¹ÍÐÙ•ÉÍ¥½¹!¥ÍÑ½Éä€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÙ•ÉÍ¥½¸µ¡¥ÍÑ½Éä‰tœ¤¹¥¹¹•ÉQ•áÑ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡Ù•ÉÍ¥½¹!¥ÍÑ½Éä°€½ØÄ¼°ƒž&#šr³–:–>Ë–þ¦†ïšbûž’ëž²°€Äƒž&#¾òh‘íÙ•ÉÍ¥½¹!¥ÍÑ½Éåõ€¤ì4(€€€½¹ÍÐ‘½Ý¹±½…‘!É•˜€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÉÑ¥™…Ðµ‘½Ý¹±½…‰tœ¤¹•ÑÑÑÉ¥‰ÕÑ” ¡É•˜œ¥€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡‘½Ý¹±½…‘!É•˜°€½y‰±½ˆè¼°ƒ’â/¢ö÷–þ¦†ïšb¿ž~·š^Ûžžšr'¦Nûš:—¾òh‘íMÑÉ¥¹œ¡‘½Ý¹±½…‘!É•˜¤¹Í±¥” À°€ØÀ¥õ€¤ì4(€€€½¹ÍÐ‘É…Ý•ÉQ•áÐ€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ‘É…Ý•È‰tœ¤¹¥¹¹•ÉQ•áÑ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡‘É…Ý•ÉQ•áÐ°€¿ž²°€Äƒž& ¼°ƒ’ös’âk¢¾›š–þ¦†ïžîG–ºh	É¥•˜ƒž&#šr±€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡‘É…Ý•ÉQ•áÐ°€¼Ìƒ–ò€¼°ƒ’ös’âk¢¾›š–þ¦†ïšbûž’ë’â'–òƒž~—¢¾–6‡¢†žòa€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡‘É…Ý•ÉQ•áÐ°€¼Ìƒšv„¼°ƒ’ös’âk¢¾›š–þ¦†ïšbûž’ë’â'šv‡¢¾š6»¢†žòa€¤ì4(€€€½¹ÍÐ…ÑÕ…±½ÍÐ€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÑÕ…°µ½ÍÐ‰tœ¤¹Ñ•áÑ½¹Ñ•¹Ñ€¤ì4(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡…ÑÕ…±½ÍÐ°€AÉ½Ù¥‘•Èƒšr«¢þS–nxœ°€AÉ½Ù¥‘•Èƒšr«¢þS–n{–º{¦fžîOžº_–óš^Û’â7–ú_žR£š*—’îß’â+¦fC’îšnüœ¤ì4(4(€€€€¼¼€´´´´ƒž†³–"ßšZÃš‹–’7¾òk’ös’âk’â;’êŸž&§’î7–r €´´´´4(€€€…Ý…¥ÐÉ•±½…‘¹‘]…¥Ð¡‘À°ÑÉ…­•È°ì±…‰•°è€¡…ÉÉ•™É•Í œô¤ì(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ…É‰tœ°ì±…‰•°è€©½ˆ…É…™Ñ•ÈÉ•™É•Í œ°Ñ¥µ•½ÕÐè€ÌÁ|ÀÀÀô¤ì(€€€½¹ÍÐÍÑ…ÑÕÍ™Ñ•ÉI•™É•Í €ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµÍÑ…ÑÕÌ‰tœ¤ü¹Ñ•áÑ½¹Ñ•¹Ñ€¤ì(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡ÍÑ…ÑÕÍ™Ñ•ÉI•™É•Í °€Ÿ–ÞË–º3š"@œ°€Ÿ–"ßšZÃ–B;’ös’âk–þ¦†ï’þwš2–ÞË–º3š"@œ¤ì(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ‘É…Ý•È‰tœ°ì±…‰•°è€È…ÕÑ½µ…Ñ¥Œ±…Ñ•ÍÐÉ•ÍÕ±ÐÉ•½Ù•Éäœ°Ñ¥µ•½ÕÐè€ÌÁ|ÀÀÀô¤ì(4(€€€€¼¼€´´´´ƒžî#š¢¾+šZ·–ÆWž’ë¾òk–’Ç¢Ò—¢ž¦ŠG’ös’âk–þ¦†ï–r£–6‡ž&’â;š*÷–Æ'šbûž’ëšr'žV3¢¾+šZ´€´´´´4(€€€…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡€  ¤€ôøì4(€€€€€½¹ÍÐÍ•±•Ð€ô‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµµ½‘”µÍ•±•Ð‰tœ¤ì4(€€€€€½¹ÍÐÍ•±•ÑM•ÑÑ•È€ô=‰©•Ð¹•Ñ=Ý¹AÉ½Á•ÉÑå•ÍÉ¥ÁÑ½È¡Ý¥¹‘½Ü¹!Q51M•±•Ñ±•µ•¹Ð¹ÁÉ½Ñ½ÑåÁ”°€Ù…±Õ”œ¤¹Í•Ðì4(€€€€€Í•±•ÑM•ÑÑ•È¹…±°¡Í•±•Ð°€Ù¥‘•½}ÐÉØœ¤ì4(€€€€€Í•±•Ð¹‘¥ÍÁ…Ñ¡Ù•¹Ð¡¹•ÜÙ•¹Ð ¡…¹”œ°ì‰Õ‰‰±•ÌèÑÉÕ”ô¤¤ì4(€€€€€½¹ÍÐ…É•„€ô‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÁÉ½µÁÐµ¥¹ÁÕÐ‰tœ¤ì4(€€€€€½¹ÍÐ…É•…M•ÑÑ•È€ô=‰©•Ð¹•Ñ=Ý¹AÉ½Á•ÉÑå•ÍÉ¥ÁÑ½È¡Ý¥¹‘½Ü¹!Q51Q•áÑÉ•…±•µ•¹Ð¹ÁÉ½Ñ½ÑåÁ”°€Ù…±Õ”œ¤¹Í•Ðì4(€€€€€…É•…M•ÑÑ•È¹…±°¡…É•„°€Ÿ–’Ç¢Ò—šÖ/¢¾W¢ž¦ŠG¾òkšÖß¢úçš^—¢Bôœ¤ì4(€€€€€…É•„¹‘¥ÍÁ…Ñ¡Ù•¹Ð¡¹•ÜÙ•¹Ð ¥¹ÁÕÐœ°ì‰Õ‰‰±•ÌèÑÉÕ”ô¤¤ì4(€€€ô¤ ¥€¤ì4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÉ•ÅÕ•ÍÐµÅÕ½Ñ”‰tœ°±…‰•°è€É•ÅÕ•ÍÐÙ¥‘•¼ÅÕ½Ñ”œô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÅÕ½Ñ”µÁ…¹•°‰tœ°ì±…‰•°è€Ù¥‘•¼ÅÕ½Ñ”Á…¹•°œ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÁÁÉ½Ù…°µ¡•¬‰tœ°±…‰•°è€Ù¥‘•¼…ÁÁÉ½Ù…°¡•­‰½àœô¤ì4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÁÁÉ½Ù”µÍÕ‰µ¥Ð‰tœ°±…‰•°è€…ÁÁÉ½Ù”Ù¥‘•¼ÍÕ‰µ¥Ðœô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹‰½‘ä¹¥¹¹•ÉQ•áÐ¹¥¹±Õ‘•Ì Ÿ’ös’âk–ÞË–"o–îèœ¥€¤°ì±…‰•°è€Ù¥‘•¼©½ˆÉ•…Ñ•œ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµÍÑ…ÑÕÌ‰tœ¤ü¹Ñ•áÑ½¹Ñ•¹Ð€ôôô€Ÿ–’Ç¢Ò”€¤°ì±…‰•°è€™…¥±•©½ˆÍÑ…ÑÕÌœ°Ñ¥µ•½ÕÐè€ÈÁ|ÀÀÀô¤ì4(€€€½¹ÍÐ™…¥±•‘¥…¹½ÍÑ¥Ì€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ‘¥…¹½ÍÑ¥Ì‰tœ¤¹Ñ•áÑ½¹Ñ•¹Ñ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡™…¥±•‘¥…¹½ÍÑ¥Ì°€½%¹Ù…±¥‘A…É…µ•Ñ•È¼°ƒ–’Ç¢Ò—’ös’âk–6‡ž&–þ¦†ïšbûž’ëšr'žV0ÁÉ½Ù¥‘•Èƒ¢¾+šZ·¾òh‘í™…¥±•‘¥…¹½ÍÑ¥Ì¹Í±¥” À°€ÈÀÀ¥õ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡™…¥±•‘¥…¹½ÍÑ¥Ì°€¼ÄÀàÁAðÜÈÁ@¼°€Ÿ¢¾+šZ·–þ¦†ï’þwžVdÁÉ½Ù¥‘•ÈƒšÚ#š¼œ¤ì4(€€€…ÍÍ•ÉÐ¹‘½•Í9½Ñ5…Ñ ¡™…¥±•‘¥…¹½ÍÑ¥Ì°€½Í¬µñ	•…É•Èñ-1P¼°€Ÿ¢¾+šZ·žîw’â7šÎ¦rË–¾¦J—–ö‹šœ¤ì4(€€€€¼¼ƒš*÷–Æ'’â·žj’ös’âk¢¾+šZ·’â;–Âw¢¾W¢¾+šZ·–B3š‚ßšr'žV3šbûž’ëŽ4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€œ¹œÄµ©½ˆµ…Éœ°±…‰•°è€½Á•¸™…¥±•©½ˆ‘É…Ý•Èœô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ‘É…Ý•È‰tœ°ì±…‰•°è€™…¥±•©½ˆ‘É…Ý•Èœ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ‘•Ñ…¥°µ‘¥…¹½ÍÑ¥Ì‰tœ¤ü¹Ñ•áÑ½¹Ñ•¹Ð¹¥¹±Õ‘•Ì %¹Ù…±¥‘A…É…µ•Ñ•Èœ¥€¤°ì±…‰•°è€‘É…Ý•ÈÑ•Éµ¥¹…°‘¥…¹½ÍÑ¥Ìœ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(€€€…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ‘É…Ý•È‰t€¹¡½ÍÐµ‰ÕÑÑ½¸œ¤ü¹±¥¬ ¥€¤ì4(4(€€€€¼¼€´´´´ƒ¢ž¦ŠG’êŸž&§¦Š¢ž#¾òk–º3š"C¢ž¦ŠG’ös’âkžjžžšr$‰±½ˆƒ¦Š¢ž €´´´´4(€€€…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡€  ¤€ôøì4(€€€€€½¹ÍÐ…É•„€ô‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÁÉ½µÁÐµ¥¹ÁÕÐ‰tœ¤ì4(€€€€€½¹ÍÐÍ•ÑÑ•È€ô=‰©•Ð¹•Ñ=Ý¹AÉ½Á•ÉÑå•ÍÉ¥ÁÑ½È¡Ý¥¹‘½Ü¹!Q51Q•áÑÉ•…±•µ•¹Ð¹ÁÉ½Ñ½ÑåÁ”°€Ù…±Õ”œ¤¹Í•Ðì4(€€€€€Í•ÑÑ•È¹…±°¡…É•„°€Ÿš‹–’7¢¾+šZ·šÖ/¢¾W¾òkšÖß¢úçš^—¢B÷¢ž¦ŠG¾ò3šÎ‹šÖ«žòOžòOš:£¢þlœ¤ì4(€€€€€…É•„¹‘¥ÍÁ…Ñ¡Ù•¹Ð¡¹•ÜÙ•¹Ð ¥¹ÁÕÐœ°ì‰Õ‰‰±•ÌèÑÉÕ”ô¤¤ì4(€€€ô¤ ¥€¤ì4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÉ•ÅÕ•ÍÐµÅÕ½Ñ”‰tœ°±…‰•°è€É•ÅÕ•ÍÐÍ•½¹Ù¥‘•¼ÅÕ½Ñ”œô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµÅÕ½Ñ”µÁ…¹•°‰tœ°ì±…‰•°è€Í•½¹Ù¥‘•¼ÅÕ½Ñ”Á…¹•°œ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÁÁÉ½Ù…°µ¡•¬‰tœ°±…‰•°è€Í•½¹Ù¥‘•¼…ÁÁÉ½Ù…°¡•­‰½àœô¤ì4(€€€…Ý…¥Ð±¥¬¡‘À°ìÍ•±•Ñ½Èè€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÁÁÉ½Ù”µÍÕ‰µ¥Ð‰tœ°±…‰•°è€…ÁÁÉ½Ù”Í•½¹Ù¥‘•¼ÍÕ‰µ¥Ðœô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡l¸¸¹‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ…É‰tœ¥t¹Í½µ” ¡…É¤€ôø…É¹‘…Ñ…Í•Ð¹ÍÑ…ÑÕÌ€ôôô€½µÁ±•Ñ•œ€˜˜…É¹¥¹¹•ÉQ•áÐ¹¥¹±Õ‘•Ì Ù¥‘•½}ÐÉØœ¤¥€¤°ì±…‰•°è€½µÁ±•Ñ•Ù¥‘•¼©½ˆœ°Ñ¥µ•½ÕÐè€ÈÁ|ÀÀÀô¤ì4(€€€…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡l¸¸¹‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ…É‰tœ¥t¹™¥¹ ¡…É¤€ôø…É¹‘…Ñ…Í•Ð¹ÍÑ…ÑÕÌ€ôôô€½µÁ±•Ñ•œ€˜˜…É¹¥¹¹•ÉQ•áÐ¹¥¹±Õ‘•Ì Ù¥‘•½}ÐÉØœ¤¤¹±¥¬ ¥€¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÉÑ¥™…ÐµÍÑ…”‰tÙ¥‘•¼œ°ì±…‰•°è€…ÉÑ¥™…ÐÙ¥‘•¼ÁÉ•Ù¥•Üœ°Ñ¥µ•½ÕÐè€ÄÕ|ÀÀÀô¤ì4(€€€½¹ÍÐÙ¥‘•½MÉŒ€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ…ÉÑ¥™…ÐµÍÑ…”‰tÙ¥‘•¼œ¤¹ÍÉ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡Ù¥‘•½MÉŒ°€½y‰±½ˆè¼°ƒ¢ž¦ŠG’êŸž&§¦Š¢ž#–þ¦†ïšb¿žžšr$‰±½ˆƒž~·š^Û¦Nûš:—¾òh‘íÙ¥‘•½MÉŒ¹Í±¥” À°€ØÀ¥õ€¤ì4(€€€½¹ÍÐÙ¥‘•½É…Ý•ÉQ•áÐ€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ‘É…Ý•È‰tœ¤¹¥¹¹•ÉQ•áÑ€¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡Ù¥‘•½É…Ý•ÉQ•áÐ°€½Ù¥‘•½p½µÀÐ¼°€Ÿ¢ž¦ŠG’êŸž&§–þ¦†ïšbûž’ë¢ž¦ŠD5%5œ¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡Ù¥‘•½É…Ý•ÉQ•áÐ°€¿–:–>Ë¢¾+šZ·¾ò#–ÞËš‹–’7¾ò'¾òiÅ}]=I-I}%9QI90¼°€Ÿ–ÞËš‹–’7žj–º3š"C’ös’âk–þ¦†ï–Âš^Ÿ¢¾+šZ·š‚¢ºÃ’âë–:–>Ë¢¾+šZ´œ¤ì4(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡Ù¥‘•½É…Ý•ÉQ•áÐ°€¿–º{¦f¢ÒçžR¡qÌ©AÉ½Ù¥‘•Èƒšr«¢þS–nx¼°€Ÿ–º3š"C¢ž¦ŠGšr«¢þS–n{žîOžº_–óš^Û–þ¦†ïšb;ž†»šbûž’èAÉ½Ù¥‘•Èƒšr«¢þS–nxœ¤ì4(€€€½¹ÍÐÉ•½Ù•É•‘¥…¹½ÍÑ¥MÑ…Ñ”€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ‘•Ñ…¥°µ‘¥…¹½ÍÑ¥Ì‰tœ¤ü¹‘…Ñ…Í•Ð¹‘¥…¹½ÍÑ¥MÑ…Ñ•€¤ì4(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡É•½Ù•É•‘¥…¹½ÍÑ¥MÑ…Ñ”°€¡¥ÍÑ½É¥…°œ°€Ÿ–ÞË–º3š"C’ös’âkžjš^Ÿ¢¾+šZ·’â7–ú_š‚¢ºÃ’âë–öO–&7šÒï–*£¦Rg¢¾¼œ¤ì4(4(€€€€¼¼€´´´´ƒ¦†çžn»–"š6‹¦jSžšï¾òiƒ¦†çžn»’â7–ú_–ëž:Àƒžj’ös’âh€´´´´4(€€€…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡€  ¤€ôøì4(€€€€€±½…±MÑ½É…”¹Í•Ñ%Ñ•´ ÀÄå}…Ñ¥Ù•}ÁÉ½©•Ñ}ØÄœ°€‘í)M=8¹ÍÑÉ¥¹¥™ä¡ÁÉ½©•Ñ%‘ÍlÅt¥ô¤ì4(€€€€€±½…Ñ¥½¸¹É•±½… ¤ì4(€€€ô¤ ¥€¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹‰½‘ä¹¥¹¹•ÉQ•áÐ¹¥¹±Õ‘•Ì ÄƒšÖ?¢ž#–f£¦jSžšï¦†çžn¸œ¥€¤°ì±…‰•°è€ÁÉ½©•Ð±½…‘•œ°Ñ¥µ•½ÕÐè€ÌÁ|ÀÀÀô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ…É‰tœ¤¹±•¹Ñ €ôôô€Á€¤°ì±…‰•°è€ÁÉ½©•Ð¡…Ì¹¼©½‰Ìœ°Ñ¥µ•½ÕÐè€ÈÁ|ÀÀÀô¤ì4(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹‰½‘ä¹¥¹¹•ÉQ•áÐ¹¥¹±Õ‘•Ì Ÿ¢þcšÊ‡šr'žRš"C¢ºÃ–öTœ¥€¤°ÑÉÕ”°€ƒ¦†çžn»–þ¦†ïšbûž’ëž¦ë’ös’âkž*Ûšœ¤ì(4(€€€€¼¼ƒ–"–nx¾òk’ös’âk’î7–r£¾ò#¦jSžšïš‹–’7¾ò'Ž4(€€€…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡€  ¤€ôøì4(€€€€€±½…±MÑ½É…”¹Í•Ñ%Ñ•´ ÀÄå}…Ñ¥Ù•}ÁÉ½©•Ñ}ØÄœ°€‘í)M=8¹ÍÑÉ¥¹¥™ä¡ÁÉ½©•Ñ%‘ÍlÁt¥ô¤ì4(€€€€€±½…Ñ¥½¸¹É•±½… ¤ì4(€€€ô¤ ¥€¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½ÉM•±•Ñ½È¡‘À°€m‘…Ñ„µÑ•ÍÑ¥ô‰œÄµ©½ˆµ…É‰tœ°ì±…‰•°è€©½ˆ…É‰…¬¥¸ÁÉ½©•Ðœ°Ñ¥µ•½ÕÐè€ÌÁ|ÀÀÀô¤ì4(4(€€€€¼¼ƒžžï–*£ž®¿š^ƒš¢«–BGšê‹–ëŽ4(€€€…Ý…¥Ð‘À¹Í•¹ µÕ±…Ñ¥½¸¹Í•Ñ•Ù¥•5•ÑÉ¥Í=Ù•ÉÉ¥‘”œ°ìÝ¥‘Ñ è€ÌäÀ°¡•¥¡Ðè€àÐÐ°‘•Ù¥•M…±•…Ñ½Èè€Ä°µ½‰¥±”èÑÉÕ”ô¤ì4(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôø‘À¹•Ù…±Õ…Ñ”¡‘½Õµ•¹Ð¹‘½Õµ•¹Ñ±•µ•¹Ð¹ÍÉ½±±]¥‘Ñ €ðô‘½Õµ•¹Ð¹‘½Õµ•¹Ñ±•µ•¹Ð¹±¥•¹Ñ]¥‘Ñ¡€¤°ì±…‰•°è€µ½‰¥±”±…å½ÕÐÍ•ÑÑ±”œô¤ì4(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡…Ý…¥Ð‘À¹•Ù…±Õ…Ñ” ‘½Õµ•¹Ð¹‘½Õµ•¹Ñ±•µ•¹Ð¹ÍÉ½±±]¥‘Ñ €ø‘½Õµ•¹Ð¹‘½Õµ•¹Ñ±•µ•¹Ð¹±¥•¹Ñ]¥‘Ñ œ¤°™…±Í”°€µ½‰¥±”Á…”¡…Ì¹¼¡½É¥é½¹Ñ…°½Ù•É™±½Üœ¤ì4(4(€€€€¼¼ƒ–£ž¢/¦nÛžr–ºxÁÉ½Ù¥‘•Èƒ¢ÂžR£¾ò!™…­”•‘”ƒ–¦£¢º‡šVÃ¾òo¢.—’âëžr–º{žöGžîs’òk–’Ç¢Ò—¾ò'Ž4(€€€½¹ÍÐ™…­•MÕ‰µ¥ÍÍ¥½¹Ì€ô…Ý…¥Ð‘À¹•Ù…±Õ…Ñ”¡±½‰…±Q¡¥Ì¹}}œÅ…­•MÑ…Ñ”ü¹ÍÕ‰µ¥ÍÍ¥½¹Ìü¸ ¤ñð€Á€¤ì4(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡™…­•MÕ‰µ¥ÍÍ¥½¹Ì°€Ì°€Ÿ–£ž¢/–þ¦†ïšÃ––ô€Ìƒš²‡¾ò!™…­—¾ò%ÁÉ½Ù¥‘•Èƒš>C’ê“¾ò#–nûž&€¬ƒ–’Ç¢Ò—¢ž¦ŠD€¬ƒ–º3š"C¢ž¦ŠG¾ò$œ¤ì4(€ô…Ñ €¡•ÉÉ½È¤ì4(€€€¥˜€¡‘À¤ì4(€€€€€½¹ÍÐ•áÑÉ„€ô…Ý…¥Ð…ÁÑÕÉ•¥…¹½ÍÑ¥Ì¡‘À°ìÑÉ…­•Èô¤ì4(€€€€€¥˜€ …MÑÉ¥¹œ¡•ÉÉ½È¹µ•ÍÍ…”¤¹¥¹±Õ‘•Ì Ÿ¢¾+šZ·–þ¯žœœ¤¤•ÉÉ½È¹µ•ÍÍ…”€¬ôq¸‘í•áÑÉ…õ€ì4(€€€ô4(€€€Ñ¡É½Ü•ÉÉ½Èì4(€ô™¥¹…±±äì4(€€€¥˜€¡‘À¤‘À¹±½Í” ¤ì4(€€€…Ý…¥ÐÍ¡ÕÑ‘½Ý¹‘”¡•‘”°ÁÉ½™¥±”¤ì4(€€€…Ý…¥Ð­¥±±AÉ½•ÍÍQÉ•”¡Ù¥Ñ”¤ì4(€€€…Ý…¥ÐÉ•µ½Ù•Q•µÁAÉ½™¥±”¡ÁÉ½™¥±”¤ì4(€ô4)ô¤ì4(