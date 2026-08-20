/* global fetch */
// G1 验收 #5：真实生产构建浏览器测试（fake 本地 provider/Storage）。
//
// - vite dev 以 VITE_G1_EDGE_BASE_URL 指向本地 fake 前缀启动；
// - 页面内注入 fetch 拦截：/g1-fake/functions/v1/g1-generation-command →
//   内存 fake edge（实现与真实 Edge Function 相同的契约：quote → 显式批准
//   绑定 → 幂等提交 → 状态推进 → 私有产物 blob URL）；
// - 真实点击 quote → 批准 → 提交 → queued/running/completed →
//   私有预览/下载 → 刷新恢复 → 项目切换隔离；
// - 全程零真实 provider/Storage 调用；轮询间隔经 VITE_G1_POLL_INTERVAL_MS
//   收紧到 500ms。

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

// 页面内 fake edge：镜像真实 g1-generation-command 契约（有界校验 + 显式
// 批准绑定 + 幂等重放 + 状态推进 + 短时签名 URL）。作业/报价/产物/提交计数
// 持久化在 localStorage，硬刷新后状态保持（与真实 staging 一致）。
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
    { id: '00000000-0000-4000-8000-000000000001', name: '已批准参考素材', type: 'image', purpose: 'reference', approval: 'approved' },
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
        // P19 证据报价绑定合同镜像（与数据库 g1_resolve_evidence_binding 同语义）：
        // 卡片集 = Brief 引用集（规范排序、去重前拒绝重复）；权威证据集 = 卡片
        // evidence_links[].source_ref 去重排序；请求证据必须精确等于权威集。
        const canonicalCardSet = (brief, project) => {
          const ids = (brief.knowledge_citation_ids || []).slice().sort();
          if (!project || ids.length === 0) return { ok: false, code: 'G1_BINDING_INVALID', message: '知识卡集合不合法。' };
          const seen = new Set();
          for (const id of ids) {
            if (typeof id !== 'string' || !/^kc-[0-9a-f]{24}$/.test(id)) return { ok: false, code: 'G1_BINDING_INVALID', message: '知识卡身份不合法。' };
            if (seen.has(id)) return { ok: false, code: 'G1_BINDING_INVALID', message: '知识卡重复。' };
            seen.add(id);
          }
          const cited = new Set((project.knowledge_cards || []).map((c) => c.id));
          for (const id of ids) if (!cited.has(id)) return { ok: false, code: 'G1_BINDING_MISSING', message: '知识卡不存在。' };
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
          if (derived.length === 0) return { ok: false, code: 'G1_BINDING_INVALID', message: '知识卡未派生任何证据。' };
          if (!Array.isArray(requested) || requested.length === 0) return { ok: false, code: 'G1_BINDING_INVALID', message: '证据数组不合法。' };
          const seen = new Set();
          for (const id of requested) {
            if (typeof id !== 'string' || !/^ev-[0-9a-f]{24}$/.test(id)) return { ok: false, code: 'G1_BINDING_INVALID', message: '证据身份不合法。' };
            if (seen.has(id)) return { ok: false, code: 'G1_BINDING_INVALID', message: '证据重复。' };
            seen.add(id);
          }
          const canon = [...new Set(requested)].sort();
          if (JSON.stringify(canon) !== JSON.stringify(derived)) return { ok: false, code: 'G1_BINDING_MISMATCH', message: '请求证据与权威证据集不精确匹配。' };
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
            return new Response(JSON.stringify(fail('G1_BRIEF_NOT_FOUND', 'Brief 不存在或不可选择。')), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          const project = projectFor(body.project_id);
          // 卡片集必须与 Brief 引用集精确相等（规范排序；重复去重前拒绝）。
          const cardCheck = canonicalCardSet(brief, project);
          if (!cardCheck.ok) {
            return new Response(JSON.stringify(fail(cardCheck.code, cardCheck.message)), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          const requestedCardCanon = [...new Set((Array.isArray(body.knowledge_card_ids) ? body.knowledge_card_ids : []) || [])].sort();
          if (JSON.stringify(requestedCardCanon) !== JSON.stringify(cardCheck.ids)) {
            return new Response(JSON.stringify(fail('G1_BINDING_MISMATCH', '请求知识卡集合与 Brief 引用集不精确匹配。')), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          // 证据集：请求提供时必须精确等于权威集；省略时自动绑定权威集
          // （历史 Brief 无 evidence_ids 时从卡片 evidence_links[].source_ref 派生）。
          let evidenceIds;
          if (body.evidence_ids === undefined || body.evidence_ids === null) {
            evidenceIds = deriveEvidence(brief, project);
            if (evidenceIds.length === 0) {
              return new Response(JSON.stringify(fail('G1_BINDING_INVALID', '知识卡未派生任何证据。')), { status: 400, headers: { 'content-type': 'application/json' } });
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
            return new Response(JSON.stringify(fail('G1_QUOTE_NOT_FOUND', 'quote 不存在。')), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          if (body.quote_fingerprint !== quote.quote_fingerprint || body.request_fingerprint !== quote.request_sha256
            || body.estimated_max_cost_cny !== quote.estimated_max_cost_cny || new Date(body.expires_at) > new Date(quote.expires_at)) {
            return new Response(JSON.stringify(fail('G1_APPROVAL_MISMATCH', '批准对象与 quote 不精确匹配。')), { status: 409, headers: { 'content-type': 'application/json' } });
          }
          const key = body.idempotency_key;
          for (const job of jobs.values()) {
            if (job.idempotency_key === key) {
              return new Response(JSON.stringify(ok({ action: 'approve_submit', data: { job: summarize(job) }, entity: { type: 'generation_job', id: job.id } })), { status: 200, headers: { 'content-type': 'application/json' } });
            }
          }
          const job = {
            id: 'g1j-' + key.slice(0, 24),
            user_id: user,
            project_id: body.project_id,
            idempotency_key: key,
            status: 'queued',
            mode: body.mode,
            model_name: quote.model_name,
            model_version: 1,
            brief_id: body.brief_id,
            brief_version: quote.brief_version,
            request: body,
            quote,
            approval: { source: 'browser', quote_fingerprint: body.quote_fingerprint },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            artifact_count: 0,
            pollCount: 0,
            // 终态诊断展示路径：包含「失败测试」的提示词作业在首次状态读取时
            // 终态失败并携带有界 provider 诊断（与 staging 实测形态一致）。
            failAfterRunning: String(body.prompt || '').includes('失败测试'),
          };
          jobs.set(job.id, job);
          submissionCount += 1;
          save();
          // 模拟 worker：提交后进入 running；下一次 status 完成或终态失败。
          job.status = 'running';
          return new Response(JSON.stringify(ok({ action: 'approve_submit', data: { job: summarize(job) }, entity: { type: 'generation_job', id: job.id } })), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'status') {
          const job = jobs.get(body.job_id);
          if (!job) {
            return new Response(JSON.stringify(fail('G1_JOB_NOT_FOUND', '作业不存在。')), { status: 404, headers: { 'content-type': 'application/json' } });
          }
          if (job.status === 'running') {
            if (job.failAfterRunning) {
              job.status = 'failed';
              job.diagnostics = {
                code: 'G1_PROVIDER_FAILED',
                issues: ["Provider task reached FAILED: InvalidParameter — Input should be '1080P' or '720P': parameters.resolution"],
                provider_code: 'InvalidParameter',
                provider_message: "Input should be '1080P' or '720P': parameters.resolution",
              };
              save();
            } else {
              job.pollCount += 1;
              if (job.pollCount >= 1) {
                job.status = 'completed';
                job.artifact_count = 1;
                const artifactId = 'g1x-' + job.id.slice(4, 28);
                if (!artifacts.has(artifactId)) {
                  const isVideo = String(job.mode || '').startsWith('video');
                  artifacts.set(artifactId, {
                    id: artifactId,
                    job_id: job.id,
                    artifact_version: 1,
                    content_sha256: 'd'.repeat(64),
                    mime_type: isVideo ? 'video/mp4' : 'image/png',
                    byte_size: isVideo ? 128 : 70,
                    width: isVideo ? 16 : 1,
                    height: isVideo ? 9 : 1,
                    storage_path: job.user_id + '/' + job.project_id + '/' + job.id + '/v1/dddddddddddd.' + (isVideo ? 'mp4' : 'png'),
                    model_name: job.model_name,
                    model_version: 1,
                    brief_id: job.brief_id,
                    brief_version: job.brief_version,
                    knowledge_card_ids: (job.request.knowledge_card_ids || []),
                    evidence_ids: (job.request.evidence_ids || []),
                    cost_cny: null,
                    created_at: new Date().toISOString(),
                  });
                  if (String(job.request.prompt || '').includes('恢复诊断测试')) {
                    job.diagnostics = {
                      code: 'G1_WORKER_INTERNAL',
                      issues: ['恢复前的历史诊断。'],
                    };
                  }
                  save();
                }
              }
            }
          }
          const artifactsList = [...artifacts.values()].filter((a) => a.job_id === job.id);
          return new Response(JSON.stringify(ok({
            action: 'status',
            data: {
              job: summarize(job),
              attempts: [{ id: 'g1a-' + job.id.slice(4, 28), attempt_no: 1, state: job.status === 'completed' ? 'succeeded' : job.status === 'failed' ? 'failed' : 'running', diagnostics: job.diagnostics || {} }],
              artifacts: artifactsList,
              events: [],
            },
            entity: { type: 'generation_job', id: job.id },
          })), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'list') {
          const list = [...jobs.values()]
            .filter((job) => job.project_id === body.project_id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .map((job) => summarize(job));
          return new Response(JSON.stringify(ok({ action: 'list', data: { jobs: list } })), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'artifact') {
          const artifact = artifacts.get(body.artifact_id);
          if (!artifact) {
            return new Response(JSON.stringify(fail('ARTIFACT_NOT_FOUND', '产物不存在。')), { status: 404, headers: { 'content-type': 'application/json' } });
          }
          const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
          const video = Uint8Array.from(atob('AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAAAAAAAAAAAAAAAAAAAAA='), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([String(artifact.mime_type || '').startsWith('video/') ? video : png], { type: artifact.mime_type || 'image/png' }));
          return new Response(JSON.stringify(ok({
            action: 'artifact',
            data: { artifact, signed_url: url, expires_in_seconds: 900 },
            entity: { type: 'generation_artifact', id: artifact.id },
          })), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify(fail('ACTION_DENIED', '动作未实现。')), { status: 400, headers: { 'content-type': 'application/json' } });
      })();
    },
  });
})();`;

const SEED_SCRIPT = `
(async () => {
  localStorage.clear();
  const service = await import('/ai-marketing-studio/src/services/p19-workspace-service.js');
  const contracts = await import('/ai-marketing-studio/src/services/p19-contracts.js');
  const stores = await import('/ai-marketing-studio/src/services/p19-store.js');
  const fixedNow = () => '2026-08-16T08:00:00.000Z';
  const digest = async (text) => {
    const bytes = new TextEncoder().encode(text);
    const value = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const makeInput = async (index) => {
    const text = 'G1 浏览器真实帖子 ' + index + '：验证生成执行层。';
    const contentSha = await digest(text);
    const externalId = String(1800000000000000000n + BigInt(index));
    const sourceUrl = 'https://x.com/g1browser/status/' + externalId;
    return {
      source_url: sourceUrl,
      label: 'G1 浏览器帖子 ' + index,
      platform: 'X · Apify',
      content_text: text,
      recorded_at: '2026-08-15T07:00:00.000Z',
      provenance: {
        schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
        method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper',
        source_platform: 'x', source_id: 'g1-browser-' + index,
        external_id: externalId, source_url: sourceUrl, run_id: 'run-g1-browser',
        collected_at: '2026-08-15T07:00:00.000Z', usage_total_usd: 0.01,
        budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        content_sha256: contentSha, collection_proof: '1999999999.' + 'c'.repeat(64),
        statement: 'G1 browser evidence.'
      },
      media_metadata: {
        filename: 'g1-' + index + '.txt', mime_type: 'text/plain; charset=utf-8',
        byte_size: new TextEncoder().encode(text).byteLength,
        last_modified: '2026-08-15T07:00:00.000Z', sha256: contentSha
      },
      source_metadata: {
        author: { name: 'G1 浏览器作者', handle: 'g1browser' + index, user_id: externalId },
        published_at: '2026-08-15T06:00:00.000Z',
        engagement: { likes: index * 100, retweets: index * 20, replies: index * 5, views: index * 30000 }
      },
      media_assets: []
    };
  };
  const store = stores.createP19Store();
  const projectIds = [];
  for (let projectIndex = 1; projectIndex <= 2; projectIndex += 1) {
    let project = await service.createProject({
      topic: projectIndex === 1 ? 'G1 浏览器生成项目' : 'G1 浏览器隔离项目',
      objective: '验证真实浏览器闭环', audience: '测试用户', channel: 'X', constraints: ['只读来源'], now: fixedNow
    });
    // 项目 A 三卡/三证据（历史 Brief 无显式 evidence_ids 的浏览器合同），项目 B 单卡。
    const cardCount = projectIndex === 1 ? 3 : 1;
    for (let cardIndex = 1; cardIndex <= cardCount; cardIndex += 1) {
      const input = await makeInput(projectIndex * 10 + cardIndex);
      project = await service.addEvidence(project, input, { now: fixedNow, hasher: contracts.fingerprintOf });
      const evidence = project.evidence[project.evidence.length - 1];
      project = await service.runAnalysis(project, evidence.id, { now: fixedNow, hasher: contracts.fingerprintOf });
      const analysis = project.analyses[project.analyses.length - 1];
      project = await service.buildKnowledgeCard(project, analysis.id, { now: fixedNow, hasher: contracts.fingerprintOf });
    }
    project = await service.assembleBrief(project, { now: fixedNow, hasher: contracts.fingerprintOf });
    const saved = store.putProject(project);
    if (!saved.ok) throw new Error(saved.code + ': ' + saved.message);
    projectIds.push(project.id);
  }
  localStorage.setItem('p19_active_project_v1', projectIds[0]);
  localStorage.setItem('g1_demo_user_v1', '11111111-1111-4111-8111-111111111111');
  return { projectIds };
})()`;

test('G1 browser harness: 临时 profile 清理拒绝伪造路径与无关 profile（零外部删除）', async () => {
  const root = resolve(tmpdir());
  // 伪造路径：正确前缀形状但非本测试创建（所有权/身份校验）。
  await assert.rejects(removeTempProfile(join(root, 'ams-g1-browser-fake123')), /拒绝删除/);
  // 无关 profile：其他测试（p20/p30 等）的 profile 不得被删除。
  await assert.rejects(removeTempProfile(join(root, 'ams-p20-browser-abc123')), /拒绝删除/);
  // 路径穿越：.. 与 . 段一律拒绝（解析前后双重防线）。
  await assert.rejects(removeTempProfile(join(root, '..', 'Windows', 'System32')), /拒绝删除/);
  await assert.rejects(removeTempProfile(join(root, 'sub', '..', 'ams-g1-browser-abc123')), /拒绝删除/);
  // 空/非字符串输入。
  await assert.rejects(removeTempProfile(null), /拒绝删除/);
  await assert.rejects(removeTempProfile(''), /拒绝删除/);
  // 真实创建 → 可删除；删除后不再可删（只删本次创建且只删一次）。
  const real = await makeTempProfile('ams-g1-browser-');
  assert.equal(existsSync(real), true, 'makeTempProfile 必须真实创建目录');
  await removeTempProfile(real);
  assert.equal(existsSync(real), false, '本测试创建的 profile 必须被删除');
  await assert.rejects(removeTempProfile(real), /拒绝删除/);
});

test('G1 real browser: quote → explicit approval → submit → status → private image/video preview → terminal diagnostics → refresh recovery → project isolation', { timeout: 240_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  const vitePort = await freePort();
  const debugPort = await freePort();
  const profile = await makeTempProfile('ams-g1-browser-');
  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_G1_EDGE_BASE_URL: `http://127.0.0.1:${vitePort}/g1-fake`,
      VITE_G1_POLL_INTERVAL_MS: '500',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let tracker;
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}/ai-marketing-studio/`;
    await waitFor(async () => (await fetch(baseUrl)).ok, { label: 'G1 Vite route' });
    const target = await waitForPageTarget(debugPort);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    tracker = createPageTracker(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 在页面脚本之前注入 fake edge（拦截 /g1-fake 前缀）。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_EDGE_SCRIPT });
    await navigateAndWait(cdp, tracker, baseUrl, { label: 'base page' });
    const seeded = await cdp.evaluate(SEED_SCRIPT);
    assert.equal(seeded.projectIds.length, 2, '必须预置两个独立项目');
    const projectIds = seeded.projectIds;

    // 种子写入后恢复工作区：页面模块在种子写入前已初始化，仅靠 hash 导航不会
    // 重新读取 localStorage；先确定性主文档重载（等待导航提交 + readyState=
    // complete）让应用全新启动并读取种子工作区，再进入 #/generation（页面内
    // location.href 赋值，hash 变化必然触发路由）。
    await reloadAndWait(cdp, tracker, { label: 'seed workspace reload' });
    await cdp.evaluate(`location.href = ${JSON.stringify(`${baseUrl}#/generation`)}`);
    // DOM 就绪（有界轮询，无固定 sleep）：创建面板真实挂载。
    await waitForSelector(cdp, '[data-testid="g1-create-panel"]', { label: 'G1 create panel', timeout: 30_000 });
    // 活动项目就绪：创建面板必须绑定种子项目 A 的 Brief 标题。
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('G1 浏览器生成项目')`), { label: 'seeded project brief' });

    // ---- 表单：image 模式 + prompt → 请求报价 ----
    await cdp.evaluate(`(() => {
      const area = document.querySelector('[data-testid="g1-prompt-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, '一只在森林里的橘猫，阳光下');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click(cdp, { selector: '[data-testid="g1-request-quote"]', label: 'request quote' });
    await waitForSelector(cdp, '[data-testid="g1-quote-panel"]', { label: 'quote panel', timeout: 15_000 });
    const quoteText = await cdp.evaluate(`document.querySelector('[data-testid="g1-quote-panel"]').innerText`);
    assert.match(quoteText, /qwen-image-2\.0/, `quote 必须显示固定模型：${quoteText.slice(0, 200)}`);
    assert.match(quoteText, /¥0\.02 – ¥0\.30/, `quote 必须显示有界费用区间：${quoteText.slice(0, 200)}`);
    assert.match(quoteText, /付费生成 \+ 私有存储写入/, `quote 必须声明付费执行与存储写入`);
    assert.match(quoteText, /第 1 版/, `quote 必须绑定 Brief 版本`);
    // 种子 Brief 是历史形态（evidence_provenance 无 evidence_ids）：fake edge 必须
    // 从被引知识卡 evidence_links[].source_ref 派生权威证据集并绑定（三卡/三证据）。
    assert.match(quoteText, /3 \/ 3/, `quote 必须绑定三卡/三证据（历史 Brief 派生权威集）：${quoteText.slice(0, 200)}`);
    const maxCost = await cdp.evaluate(`document.querySelector('[data-testid="g1-quote-max"]').textContent`);
    assert.match(maxCost, /¥0\.30/, `预估最大费用必须显示：${maxCost}`);

    // ---- 显式批准：未勾选不可提交；勾选后提交 ----
    const disabledBefore = await cdp.evaluate(`document.querySelector('[data-testid="g1-approve-submit"]').disabled`);
    assert.equal(disabledBefore, true, '未勾选批准时提交按钮必须禁用');
    await click(cdp, { selector: '[data-testid="g1-approval-check"]', label: 'approval checkbox' });
    await click(cdp, { selector: '[data-testid="g1-approve-submit"]', label: 'approve and submit' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('作业已创建')`), { label: 'job created message', timeout: 15_000 });
    await waitForSelector(cdp, '[data-testid="g1-job-card"]', { label: 'job card', timeout: 15_000 });

    // ---- 状态推进：queued/running → completed（fake worker 状态机）----
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="g1-job-status"]')?.textContent.includes('已完成')`), { label: 'job completed', timeout: 20_000 });
    const statusText = await cdp.evaluate(`document.querySelector('[data-testid="g1-job-status"]').textContent`);
    assert.equal(statusText, '已完成');

    // ---- 私有产物预览 + 版本历史 + 下载链接 ----
    await click(cdp, { selector: '.g1-job-card', label: 'open job drawer' });
    await waitForSelector(cdp, '[data-testid="g1-job-drawer"]', { label: 'job drawer' });
    await waitForSelector(cdp, '[data-testid="g1-artifact-stage"] img', { label: 'artifact image preview', timeout: 15_000 });
    const imgSrc = await cdp.evaluate(`document.querySelector('[data-testid="g1-artifact-stage"] img').src`);
    assert.match(imgSrc, /^blob:/, `产物预览必须是私有 blob 短时链接：${imgSrc.slice(0, 60)}`);
    const versionHistory = await cdp.evaluate(`document.querySelector('[data-testid="g1-version-history"]').innerText`);
    assert.match(versionHistory, /v1/, `版本历史必须显示第 1 版：${versionHistory}`);
    const downloadHref = await cdp.evaluate(`document.querySelector('[data-testid="g1-artifact-download"]').getAttribute('href')`);
    assert.match(downloadHref, /^blob:/, `下载必须是短时私有链接：${String(downloadHref).slice(0, 60)}`);
    const drawerText = await cdp.evaluate(`document.querySelector('[data-testid="g1-job-drawer"]').innerText`);
    assert.match(drawerText, /第 1 版/, `作业详情必须绑定 Brief 版本`);
    assert.match(drawerText, /3 张/, `作业详情必须显示三张知识卡血缘`);
    assert.match(drawerText, /3 条/, `作业详情必须显示三条证据血缘`);
    const actualCost = await cdp.evaluate(`document.querySelector('[data-testid="g1-actual-cost"]').textContent`);
    assert.equal(actualCost, 'Provider 未返回', 'Provider 未返回实际结算值时不得用报价上限代替');

    // ---- 硬刷新恢复：作业与产物仍在 ----
    await reloadAndWait(cdp, tracker, { label: 'hard refresh' });
    await waitForSelector(cdp, '[data-testid="g1-job-card"]', { label: 'job card after refresh', timeout: 30_000 });
    const statusAfterRefresh = await cdp.evaluate(`document.querySelector('[data-testid="g1-job-status"]')?.textContent`);
    assert.equal(statusAfterRefresh, '已完成', '刷新后作业必须保持已完成');

    // ---- 终态诊断展示：失败视频作业必须在卡片与抽屉显示有界诊断 ----
    await cdp.evaluate(`(() => {
      const select = document.querySelector('[data-testid="g1-mode-select"]');
      const selectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      selectSetter.call(select, 'video_t2v');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const area = document.querySelector('[data-testid="g1-prompt-input"]');
      const areaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      areaSetter.call(area, '失败测试视频：海边日落');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click(cdp, { selector: '[data-testid="g1-request-quote"]', label: 'request video quote' });
    await waitForSelector(cdp, '[data-testid="g1-quote-panel"]', { label: 'video quote panel', timeout: 15_000 });
    await click(cdp, { selector: '[data-testid="g1-approval-check"]', label: 'video approval checkbox' });
    await click(cdp, { selector: '[data-testid="g1-approve-submit"]', label: 'approve video submit' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('作业已创建')`), { label: 'video job created', timeout: 15_000 });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="g1-job-status"]')?.textContent === '失败'`), { label: 'failed job status', timeout: 20_000 });
    const failedDiagnostics = await cdp.evaluate(`document.querySelector('[data-testid="g1-job-diagnostics"]').textContent`);
    assert.match(failedDiagnostics, /InvalidParameter/, `失败作业卡片必须显示有界 provider 诊断：${failedDiagnostics.slice(0, 200)}`);
    assert.match(failedDiagnostics, /1080P|720P/, '诊断必须保留 provider 消息');
    assert.doesNotMatch(failedDiagnostics, /sk-|Bearer |AKLT/, '诊断绝不泄露密钥形态');
    // 抽屉中的作业诊断与尝试诊断同样有界显示。
    await click(cdp, { selector: '.g1-job-card', label: 'open failed job drawer' });
    await waitForSelector(cdp, '[data-testid="g1-job-drawer"]', { label: 'failed job drawer', timeout: 15_000 });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="g1-job-detail-diagnostics"]')?.textContent.includes('InvalidParameter')`), { label: 'drawer terminal diagnostics', timeout: 15_000 });
    await cdp.evaluate(`document.querySelector('[data-testid="g1-job-drawer"] .ghost-button')?.click()`);

    // ---- 视频产物预览：完成视频作业的私有 blob 预览 ----
    await cdp.evaluate(`(() => {
      const area = document.querySelector('[data-testid="g1-prompt-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, '恢复诊断测试：海边日落视频，波浪缓缓推进');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click(cdp, { selector: '[data-testid="g1-request-quote"]', label: 'request second video quote' });
    await waitForSelector(cdp, '[data-testid="g1-quote-panel"]', { label: 'second video quote panel', timeout: 15_000 });
    await click(cdp, { selector: '[data-testid="g1-approval-check"]', label: 'second video approval checkbox' });
    await click(cdp, { selector: '[data-testid="g1-approve-submit"]', label: 'approve second video submit' });
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('[data-testid="g1-job-card"]')].some((card) => card.dataset.status === 'completed' && card.innerText.includes('video_t2v'))`), { label: 'completed video job', timeout: 20_000 });
    await cdp.evaluate(`[...document.querySelectorAll('[data-testid="g1-job-card"]')].find((card) => card.dataset.status === 'completed' && card.innerText.includes('video_t2v')).click()`);
    await waitForSelector(cdp, '[data-testid="g1-artifact-stage"] video', { label: 'artifact video preview', timeout: 15_000 });
    const videoSrc = await cdp.evaluate(`document.querySelector('[data-testid="g1-artifact-stage"] video').src`);
    assert.match(videoSrc, /^blob:/, `视频产物预览必须是私有 blob 短时链接：${videoSrc.slice(0, 60)}`);
    const videoDrawerText = await cdp.evaluate(`document.querySelector('[data-testid="g1-job-drawer"]').innerText`);
    assert.match(videoDrawerText, /video\/mp4/, '视频产物必须显示视频 MIME');
    assert.match(videoDrawerText, /历史诊断（已恢复）：G1_WORKER_INTERNAL/, '已恢复的完成作业必须将旧诊断标记为历史诊断');
    assert.match(videoDrawerText, /实际费用\s*Provider 未返回/, '完成视频未返回结算值时必须明确显示 Provider 未返回');
    const recoveredDiagnosticState = await cdp.evaluate(`document.querySelector('[data-testid="g1-job-detail-diagnostics"]')?.dataset.diagnosticState`);
    assert.equal(recoveredDiagnosticState, 'historical', '已完成作业的旧诊断不得标记为当前活动错误');

    // ---- 项目切换隔离：B 项目不得出现 A 的作业 ----
    await cdp.evaluate(`(() => {
      localStorage.setItem('p19_active_project_v1', ${JSON.stringify(projectIds[1])});
      location.reload();
    })()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('G1 浏览器隔离项目')`), { label: 'project B loaded', timeout: 30_000 });
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('[data-testid="g1-job-card"]').length === 0`), { label: 'project B has no jobs', timeout: 20_000 });
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('还没有生成作业')`), true, 'B 项目必须显示空作业状态');

    // 切回 A：作业仍在（隔离恢复）。
    await cdp.evaluate(`(() => {
      localStorage.setItem('p19_active_project_v1', ${JSON.stringify(projectIds[0])});
      location.reload();
    })()`);
    await waitForSelector(cdp, '[data-testid="g1-job-card"]', { label: 'job card back in project A', timeout: 30_000 });

    // 移动端无横向溢出。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor(() => cdp.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), { label: 'mobile layout settle' });
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'), false, 'mobile page has no horizontal overflow');

    // 全程零真实 provider 调用（fake edge 内部计数；若为真实网络会失败）。
    const fakeSubmissions = await cdp.evaluate(`globalThis.__g1FakeState?.submissions?.() || 0`);
    assert.equal(fakeSubmissions, 3, '全程必须恰好 3 次（fake）provider 提交（图片 + 失败视频 + 完成视频）');
  } catch (error) {
    if (cdp) {
      const extra = await captureDiagnostics(cdp, { tracker });
      if (!String(error.message).includes('诊断快照')) error.message += `\n${extra}`;
    }
    throw error;
  } finally {
    if (cdp) cdp.close();
    await shutdownEdge(edge, profile);
    await killProcessTree(vite);
    await removeTempProfile(profile);
  }
});
