// P19 运营研究工作台（#/research 主路径）。
//
// 单项目聚焦的本地操作链：研究项目 → 有界证据录入 → 确定性本地分析
// （deterministic_local）→ content_knowledge_card_v1 知识卡 → 可审核 Brief
// （ams_brief_review_v1：评论/退回/批准）→ ams_external_handoff_package_v1
// 交接包（仅批准且未过时的当前修订可派生）→ P16 世系审计。
//
// - 全部状态保存在有界、版本化、严格校验的 localStorage（p19_store_v1）；
//   刷新不丢失；导入/导出为本地备份（p19_project_package_v1）。
// - 本页是纯本地草稿：不写 Supabase、不采集、不调用模型、不生成、不路由、不发布；
//   四项执行标志恒为 false 并始终可见。
// - 破坏性操作（移除证据、归档、删除、覆盖导入）都需要二次确认。
// - 已有 staging 五视图只读读者保持不变（fail closed），本页不触碰它。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createP19Store, STORE_MAX_PROJECTS } from '../services/p19-store.js';
import {
  addEvidence,
  archiveProject,
  assembleBrief,
  assembleSynthesisBrief,
  buildKnowledgeCard,
  buildKnowledgeCardsForSelection,
  buildProjectWorkflowState,
  computeSynthesisPartialState,
  createProject,
  deriveHandoffPackage,
  generateSynthesisInsight,
  recordVersionedReanalysis,
  recordVersionedTextReanalysis,
  removeEvidence,
  reviewBrief,
  runAnalysis,
  updateEvidence,
  updateProjectProfile,
  validateSynthesisSelection,
  workbenchError,
} from '../services/p19-workspace-service.js';
import { buildLineageAudit, buildProjectLineageGraph } from '../services/p19-lineage.js';
import {
  P19ConfirmButton,
  P19FlagStrip,
  P19ProjectForm,
} from '../components/integrated-workspace/P19WorkbenchPanels.jsx';
import {
  P36Destinations,
  destinationForRecommendedStep,
} from '../components/integrated-workspace/P36ResearchDestinations.jsx';
import { getStagingRuntimeStatus } from '../services/staging-preview-service.js';
import { useAuth } from '../contexts/auth-context.js';
import { createP20OnlineStore } from '../services/p20-online-store.js';
import { isServerWriteEnabled } from '../services/p19-server-write-adapter.js';
import { deriveP21GuidedState } from '../services/p21-guided-workspace.js';
import { createP22ResearchAssistClient, assessMediaAnalyzability, evidenceMatchesSearchIdentity, findP22Evidence, importSearchSelection, rehydrateEvidenceMediaAndAnalyze, toP19EvidenceInput } from '../services/p22-research-assist.js';
import { saveContentDraftV2 } from '../services/content-creation-service.js';
import './ResearchWorkspacePage.css';

const ACTIVE_PROJECT_KEY = 'p19_active_project_v1';
const IMPORT_MAX_TEXT = 2 * 1024 * 1024;

function readActiveProjectId() {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_PROJECT_KEY) || null;
  } catch {
    return null;
  }
}

function writeActiveProjectId(id) {
  try {
    if (id) globalThis.localStorage?.setItem(ACTIVE_PROJECT_KEY, id);
    else globalThis.localStorage?.removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    // 记忆选中项目失败不影响工作台主体功能
  }
}

function buildOnlineCommand(previous, next) {
  if (!previous || !next) throw workbenchError('ONLINE_COMMAND_MISSING', '在线操作缺少项目快照。');
  if (previous.status !== next.status && next.status === 'archived') {
    return { command: 'project.archive', payload: { project_id: previous.id } };
  }
  const profileFields = ['topic', 'objective', 'audience', 'channel', 'constraints'];
  const patch = {};
  for (const field of profileFields) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) patch[field] = next[field];
  }
  if (Object.keys(patch).length) return { command: 'project.update', payload: { project_id: previous.id, patch } };

  const previousEvidence = new Map(previous.evidence.map((item) => [item.id, item]));
  const nextEvidence = new Map(next.evidence.map((item) => [item.id, item]));
  for (const item of next.evidence) {
    if (!previousEvidence.has(item.id)) {
      return { command: 'evidence.create', payload: { project_id: previous.id, evidence: item } };
    }
    const before = previousEvidence.get(item.id);
    if (before.fingerprint !== item.fingerprint) {
      const evidencePatch = {};
      for (const field of ['source_url', 'label', 'platform', 'content_text', 'recorded_at', 'provenance', 'media_metadata', 'source_metadata', 'media_assets']) {
        if (JSON.stringify(before[field]) !== JSON.stringify(item[field])) evidencePatch[field] = item[field];
      }
      return { command: 'evidence.update', payload: { project_id: previous.id, evidence_id: item.id, expected_fingerprint: before.fingerprint, patch: evidencePatch } };
    }
  }
  for (const item of previous.evidence) {
    if (!nextEvidence.has(item.id)) {
      return { command: 'evidence.remove', payload: { project_id: previous.id, evidence_id: item.id, expected_fingerprint: item.fingerprint } };
    }
  }

  const newAnalysis = next.analyses.find((item) => !previous.analyses.some((before) => before.id === item.id && before.fingerprint === item.fingerprint));
  if (newAnalysis) {
    const before = previous.analyses.find((item) => item.id === newAnalysis.id);
    return { command: 'analysis.create', payload: { project_id: previous.id, expected_fingerprint: before?.fingerprint || null, analysis: newAnalysis } };
  }
  const newCard = next.knowledge_cards.find((item) => !previous.knowledge_cards.some((before) => before.id === item.id && before.version === item.version && before.fingerprint === item.fingerprint));
  if (newCard) {
    const before = previous.knowledge_cards.find((item) => item.id === newCard.id && item.version === newCard.version);
    return { command: 'card.create', payload: { project_id: previous.id, expected_fingerprint: before?.fingerprint || null, card: newCard } };
  }
  if (next.brief && next.brief.fingerprint !== previous.brief?.fingerprint) {
    const decision = next.brief.review?.decision;
    if (decision && decision.value !== 'pending' && decision.value !== previous.brief?.review?.decision?.value) {
      return {
        command: 'brief.decide',
        payload: {
          project_id: previous.id,
          expected_fingerprint: previous.brief?.fingerprint,
          decision: {
            brief_id: previous.brief?.id,
            brief_version: previous.brief?.version,
            value: decision.value,
            rationale: decision.rationale,
            comments: next.brief.review?.comments || [],
            source: 'local_manual',
            decided_at: decision.decided_at,
            decided_by: decision.decided_by,
          },
        },
      };
    }
    const before = previous.brief && previous.brief.id === next.brief.id && previous.brief.version === next.brief.version
      ? previous.brief
      : null;
    return { command: 'brief.assemble', payload: { project_id: previous.id, expected_fingerprint: before?.fingerprint || null, brief: next.brief } };
  }
  if (next.handoff && next.handoff.fingerprint !== previous.handoff?.fingerprint) {
    const before = previous.handoff && previous.handoff.id === next.handoff.id && previous.handoff.version === next.handoff.version
      ? previous.handoff
      : null;
    return { command: 'handoff.create', payload: { project_id: previous.id, expected_fingerprint: before?.fingerprint || null, handoff: next.handoff } };
  }
  throw workbenchError('ONLINE_COMMAND_MISSING', '无法将本次修改绑定到唯一在线命令，已拒绝保存。');
}

export function ResearchWorkspacePage() {
  const { isAuthenticated, loading: authLoading, userId } = useAuth();
  const onlineMode = isAuthenticated && isServerWriteEnabled();
  // 稳定客户端实例：useState 惰性初始化（渲染期间绝不读写 ref.current）。
  // 三个实例只创建一次且跨渲染稳定；项目切换由 key 与 activeId effect 隔离，
  // 瞬态搜索状态（hotSearchState）绝不会被跨项目复用。
  const [store] = useState(() => createP19Store());
  const [onlineStore] = useState(() => createP20OnlineStore());
  const [assistClient] = useState(() => createP22ResearchAssistClient());

  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(readActiveProjectId);
  const [project, setProject] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [lineage, setLineage] = useState(null);
  const [graph, setGraph] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);
  const [pendingImport, setPendingImport] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [comparedEvidenceIds, setComparedEvidenceIds] = useState([]);
  // P32-C 综合成功结果（选中条数/卡复用新建数/Brief 版本与状态）。切换项目、
  // 归档、刷新或证据变化后严格重新验证；绝不跨项目复用旧结论。
  const [synthesisOutcome, setSynthesisOutcome] = useState(null);
  // P32-B 热门主题搜索瞬态状态：{ batch, selectedIds }。切换项目、重新搜索或刷新后
  // 立即失效，绝不把旧选择导入其他项目（见 activeId 清理 effect）。
  const [hotSearchState, setHotSearchState] = useState(null);
  // 本会话已保存的相似帖子草稿记录（绑定项目/来源/分析身份）。切换项目即清空，
  // 产物页只展示当前项目内的草稿，绝不跨项目泄漏。
  const [savedDrafts, setSavedDrafts] = useState([]);
  const importInputRef = useRef(null);

  const stagingStatus = useMemo(() => getStagingRuntimeStatus(), []);
  const storageSummary = useMemo(() => {
    const active = projects.find((item) => item.id === activeId) || null;
    return {
      total: projects.length,
      max: STORE_MAX_PROJECTS,
      active: active
        ? {
          topic: active.topic,
          version: active.version,
          status: active.status,
          evidence: active.evidence_count,
          analyses: active.analysis_count,
          cards: active.card_count,
        }
        : null,
    };
  }, [projects, activeId]);

  const reloadProjects = useCallback(async () => {
    if (onlineMode) {
      try {
        const onlineProjects = await onlineStore.listProjects();
        setProjects(onlineProjects);
        setError(null);
        return onlineProjects;
      } catch (cause) {
        setError({ code: cause?.code || 'ONLINE_LOAD_FAILED', message: String(cause?.message || cause).slice(0, 300) });
        return [];
      }
    }
    const result = store.listProjects();
    if (result.ok) {
      setProjects(result.projects);
      return result.projects;
    }
    if (result.code === 'EMPTY_STORE') {
      setProjects([]);
      setError(null);
      return [];
    }
    setError({ code: result.code, message: result.message });
    return [];
  }, [onlineMode, onlineStore, store]);

  const reloadProject = useCallback(async (id) => {
    if (onlineMode) {
      try {
        const onlineProject = await onlineStore.getProject(id);
        setProject(onlineProject);
        setError(null);
        return onlineProject;
      } catch (cause) {
        setError({ code: cause?.code || 'ONLINE_LOAD_FAILED', message: String(cause?.message || cause).slice(0, 300) });
        setProject(null);
        return null;
      }
    }
    const result = store.getProject(id);
    if (result.ok) {
      setProject(result.project);
      return result.project;
    }
    setError({ code: result.code, message: result.message });
    setProject(null);
    return null;
  }, [onlineMode, onlineStore, store]);

  // 初次加载：项目列表 + 激活项目
  useEffect(() => {
    if (authLoading) return undefined;
    let cancelled = false;
    const load = async () => {
      const list = await reloadProjects();
      if (cancelled) return;
      let target = list.find((item) => item.id === activeId) || null;
      if (!target && list.length > 0) target = list[0];
      if (target) {
        setActiveId(target.id);
        writeActiveProjectId(target.id);
        await reloadProject(target.id);
      } else {
        setProject(null);
        writeActiveProjectId(null);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [activeId, authLoading, onlineMode, reloadProject, reloadProjects]);

  // 项目变化 → 工作流状态 + 世系审计 + 图谱
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!project) {
        setWorkflow(null);
        setLineage(null);
        setGraph(null);
        return;
      }
      const [wf, audit, g] = await Promise.all([
        buildProjectWorkflowState(project),
        Promise.resolve(buildLineageAudit([project])),
        Promise.resolve(buildProjectLineageGraph(project)),
      ]);
      if (cancelled) return;
      setWorkflow(wf);
      setLineage(audit);
      setGraph(g);
    };
    refresh();
    return () => { cancelled = true; };
  }, [project]);

  useEffect(() => {
    setPendingImport(null);
    setProfileOpen(false);
    setComparedEvidenceIds([]);
    // P32-C：切换项目必须清空综合结果（旧结论绝不跨项目复用）。
    setSynthesisOutcome(null);
    // P32-B：切换项目必须清空瞬态搜索结果与选择，防止旧选择导入其他项目。
    setHotSearchState(null);
    // 切换项目必须清空本会话草稿记录（草稿绑定项目/来源/分析身份，绝不跨项目展示）。
    setSavedDrafts([]);
  }, [activeId]);

  const selectProject = useCallback(async (id) => {
    setActiveId(id);
    writeActiveProjectId(id);
    await reloadProject(id);
    setError(null);
    setNotice(null);
  }, [reloadProject]);

  /** 统一执行路径：领域操作 → 写存储 → 重载快照。返回是否成功。 */
  const run = useCallback(async (label, action, options = {}) => {
    // 归档只读门禁：已归档项目拒绝编辑/分析/审核/交接（创建新项目除外），
    // 归档快照绝不会被后续编辑复活。
    if (project && project.status === 'archived' && !options.allowArchived) {
      setError({ code: 'PROJECT_ARCHIVED', message: '项目已归档（只读）：编辑/分析/审核/交接操作已拒绝；归档快照不会被修改。' });
      return false;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      if (onlineMode) {
        const spec = typeof options.onlineCommand === 'function'
          ? options.onlineCommand(next, project)
          : buildOnlineCommand(project, next);
        const persisted = await onlineStore.execute(spec.command, spec.payload, spec.options);
        if (persisted) setProject(persisted);
        await reloadProjects();
        if (options.notice) setNotice(options.notice.replace(/本地/g, '在线'));
        return true;
      }
      const saved = store.putProject(next);
      if (!saved.ok) {
        setError({ code: saved.code, message: saved.message });
        return false;
      }
      reloadProject(next.id);
      reloadProjects();
      if (options.notice) setNotice(options.notice);
      return true;
    } catch (cause) {
      const message = cause && cause.bounded ? cause.message : String((cause && cause.message) || cause).slice(0, 300);
      setError({ code: (cause && cause.code) || 'UNEXPECTED_ERROR', message });
      return false;
    } finally {
      setBusy(false);
    }
  }, [onlineMode, onlineStore, project, reloadProject, reloadProjects, store]);

  // ---- 项目操作 ----
  const handleCreateProject = useCallback(async (form) => {
    if (onlineMode) {
      setBusy(true);
      setError(null);
      try {
        const created = await onlineStore.execute('project.create', { project: form });
        setCreating(false);
        setProject(created);
        setActiveId(created.id);
        writeActiveProjectId(created.id);
        await reloadProjects();
        setNotice('项目已保存到在线工作区。');
      } catch (cause) {
        setError({ code: cause?.code || 'ONLINE_CREATE_FAILED', message: String(cause?.message || cause).slice(0, 300) });
      } finally {
        setBusy(false);
      }
      return;
    }
    const ok = await run('创建项目', async () => {
      const next = await createProject(form);
      const saved = store.putProject(next);
      if (!saved.ok) throw workbenchError(saved.code, saved.message);
      setCreating(false);
      return next;
    }, { notice: '项目已创建（本地草稿）。', allowArchived: true });
    if (ok) {
      reloadProjects();
      const list = store.listProjects();
      if (list.ok && list.projects.length > 0) {
        const created = list.projects[list.projects.length - 1];
        selectProject(created.id);
      }
    }
  }, [onlineMode, onlineStore, reloadProjects, run, selectProject, store]);

  const handleSaveProfile = useCallback((patch) => {
    const fields = ['topic', 'objective', 'audience', 'channel', 'constraints'];
    const hasChanges = fields.some((field) => JSON.stringify(project?.[field]) !== JSON.stringify(patch?.[field]));
    if (!hasChanges) {
      setError(null);
      setNotice('项目档案没有修改，无需保存。');
      return Promise.resolve(true);
    }
    return run('保存项目档案', () => updateProjectProfile(project, patch), { notice: '项目档案已保存；下游 Brief/交接包已标记为过时。' });
  }, [run, project]);

  const handleAddEvidence = useCallback((input) => {
    return run('添加证据', () => addEvidence(project, input), { notice: '证据已添加（仅本地）。' });
  }, [run, project]);

  const handleSaveAssistedEvidence = useCallback(async (item) => {
    if (!project || project.status === 'archived') {
      setError({ code: 'PROJECT_ARCHIVED', message: '项目已归档，不能保存新的研究来源。' });
      return false;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const input = await toP19EvidenceInput(item);
      let evidence = findP22Evidence(project, item);
      if (evidence) return true;
      const afterEvidence = await addEvidence(project, input);
      evidence = findP22Evidence(afterEvidence, item);
      if (!evidence) throw workbenchError('EVIDENCE_IDENTITY_MISSING', '无法绑定新证据身份，已拒绝保存。');
      let persisted = afterEvidence;
      if (onlineMode) {
        const spec = buildOnlineCommand(project, afterEvidence);
        persisted = await onlineStore.execute(spec.command, spec.payload, spec.options);
      } else {
        const saved = store.putProject(afterEvidence);
        if (!saved.ok) throw workbenchError(saved.code, saved.message);
      }
      setProject(persisted);
      await reloadProjects();
      setNotice('来源证据已保存。下一步可分析帖子/视频；分析结果由你确认后才会保存。');
      return true;
    } catch (cause) {
      if (onlineMode && project?.id) {
        try {
          const recovered = await onlineStore.getProject(project.id);
          setProject(recovered);
        } catch {
          // Keep the original bounded pipeline error; a later explicit reload remains available.
        }
      }
      const message = cause && cause.bounded ? cause.message : String((cause && cause.message) || cause).slice(0, 300);
      setError({ code: (cause && cause.code) || 'P23_PIPELINE_FAILED', message });
      return false;
    } finally {
      setBusy(false);
    }
  }, [onlineMode, onlineStore, project, reloadProjects, store]);

  const handleSaveAnalysisPreview = useCallback(async (evidenceId, modelResult, usage, cost) => {
    if (!project) return null;
    const evidence = project.evidence.find((item) => item.id === evidenceId);
    if (!evidence) throw workbenchError('EVIDENCE_NOT_FOUND', '要保存分析的证据不存在。');
    const recorder = evidence.media_assets?.length ? recordVersionedReanalysis : recordVersionedTextReanalysis;
    const afterAnalysis = await recorder(project, evidenceId, {
      source_id: modelResult.source_id,
      model: modelResult.model,
      result: {
        text_expression: modelResult.text_expression || '', hook: modelResult.hook || '', copy_pattern: modelResult.copy_pattern || '',
        target_audience: modelResult.target_audience || '', audience_need_emotion: modelResult.audience_need_emotion || '',
        media_analysis: modelResult.media_analysis || [], virality_drivers: modelResult.virality_drivers || [], reusable_methods: modelResult.reusable_methods || [],
        rewrite_suggestions: modelResult.rewrite_suggestions || [], signals: modelResult.signals || [], risks: modelResult.risks || [],
      },
      executed_at: new Date().toISOString(), usage: usage || { total_tokens: 0 },
      // M3 费用绑定（范围 10）：把服务端实际返回的费用记录与预留身份随分析保存；
      // 服务端只接受实际费用字段，绝不虚构或把零费用伪装为付费模型调用。
      cost: cost || undefined,
      _request_identity: `analysis-preview:${evidenceId}:${Date.now()}`,
    });
    let persisted = afterAnalysis;
    if (onlineMode) {
      const spec = buildOnlineCommand(project, afterAnalysis);
      persisted = await onlineStore.execute(spec.command, spec.payload, spec.options);
    } else {
      const saved = store.putProject(afterAnalysis); if (!saved.ok) throw workbenchError(saved.code, saved.message);
    }
    setProject(persisted); await reloadProjects();
    setNotice('分析结果已保存为新版本；原证据和旧分析保持不变。');
    return (persisted.analyses || []).filter((row) => row.evidence_id === evidenceId).sort((a, b) => b.version - a.version)[0] || null;
  }, [onlineMode, onlineStore, project, reloadProjects, store]);

  const handleSaveSimilarDraft = useCallback(async (draft, evidence, analysis) => {
    if (!userId) throw workbenchError('AUTH_REQUIRED', '请先登录后保存草稿。');
    if (draft.evidence_id !== evidence.id || draft.evidence_version !== evidence.version || draft.evidence_fingerprint !== evidence.fingerprint
      || draft.analysis_id !== analysis.id || draft.analysis_version !== analysis.version || draft.analysis_fingerprint !== analysis.fingerprint) {
      throw workbenchError('DRAFT_SOURCE_BINDING_MISMATCH', '草稿与保存时的证据/分析版本不一致，请重新生成。');
    }
    const result = { title: draft.title, main_copy: draft.main_copy, cta: draft.cta, hashtags: draft.hashtags, visual_description: draft.media_idea, platform: evidence.provenance?.source_platform || 'x', content_format: 'text_only' };
    const intent = { platform: evidence.provenance?.source_platform || 'x', content_format: 'text_only', language_mode: 'zh-cn', length_profile: 'short', tone: 'engaging', cta_policy: draft.cta ? 'required' : 'none', hashtag_policy: draft.hashtags?.length ? 'required_3_5' : 'none' };
    const saved = await saveContentDraftV2(userId, result, intent, { source: 'p35_saved_analysis_similar_post', model: draft.model, usage: draft.usage || {}, evidenceReferences: [{ evidence_id: evidence.id, fingerprint: evidence.fingerprint }], knowledgeReferences: { analysis_id: analysis.id, analysis_version: analysis.version, fingerprint: analysis.fingerprint } });
    setSavedDrafts((previous) => [...previous.slice(-19), {
      projectId: project?.id || evidence.project_id || null,
      evidenceId: evidence.id,
      evidenceLabel: evidence.label,
      analysisId: analysis.id,
      analysisVersion: analysis.version,
      title: draft.title,
      savedId: saved?.id || 'saved',
      savedAt: new Date().toISOString(),
    }]);
    setNotice('相似帖子草稿已保存到内容库；未审核、未路由、未发布。');
    return saved;
  }, [project, userId]);

  const handleUpdateEvidence = useCallback((evidenceId, patch) => {
    return run('编辑证据', () => updateEvidence(project, evidenceId, patch), { notice: '证据已更新；下游分析/知识卡/Brief 已标记为过时。' });
  }, [run, project]);

  const handleRemoveEvidence = useCallback((evidenceId) => {
    return run('移除证据', () => removeEvidence(project, evidenceId), { notice: '证据已移除；依赖它的分析/知识卡/Brief/交接包已同步剪除（项目保持内部绑定）。' });
  }, [run, project]);

  const handleRunAnalysis = useCallback((evidenceId) => {
    return run('确定性分析', () => runAnalysis(project, evidenceId), { notice: '确定性本地分析完成（deterministic_local，未调用任何模型）。' });
  }, [run, project]);

  const handleMakeCard = useCallback((analysisId) => {
    return run('生成知识卡', () => buildKnowledgeCard(project, analysisId), { notice: '知识卡已构建并通过 content_knowledge_card_v1 校验。' });
  }, [run, project]);

  const handleVersionedReanalyze = useCallback(async (evidenceId) => {
    if (!project || project.status === 'archived') {
      setError({ code: 'PROJECT_ARCHIVED', message: '项目已归档，不能重新分析。' });
      return false;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const evidence = (project.evidence || []).find((item) => item.id === evidenceId);
      if (!evidence) throw workbenchError('EVIDENCE_NOT_FOUND', '要重新分析的证据不存在。');
      // P38 失败关闭：旧合同媒体（URL 哈希/t.co/非白名单/类型失配/缺内容字节）
      // 不得直接交给 Qwen —— 必须先原位恢复媒体（重新采集媒体并分析）。
      const mediaGate = assessMediaAnalyzability(evidence);
      if (!mediaGate.analyzable) {
        throw workbenchError('P38_MEDIA_NOT_VERIFIED', `该来源的媒体尚未完成安全验证（${String(mediaGate.issues[0] || '旧媒体绑定').slice(0, 120)}）：请先在「分析」页点击「重新采集媒体并分析」恢复媒体后再重新分析。`);
      }
      const item = {
        id: evidence.provenance?.source_id || evidence.id,
        source_url: evidence.source_url,
        label: evidence.label,
        platform: evidence.provenance?.source_platform || 'x',
        content_text: evidence.content_text,
        external_id: evidence.provenance?.external_id || null,
        content_sha256: evidence.media_metadata?.sha256 || evidence.provenance?.content_sha256 || '',
        source_metadata: evidence.source_metadata,
        media_assets: evidence.media_assets || [],
        provenance: {
          schema_version: 'p22_collected_source_v1',
          provider: evidence.provenance?.provider || '',
          run_id: evidence.provenance?.run_id || '',
          collected_at: evidence.provenance?.collected_at || evidence.recorded_at,
          usage_total_usd: evidence.provenance?.usage_total_usd || 0,
          budget_reservation_id: evidence.provenance?.budget_reservation_id || '',
        },
        collection_proof: evidence.provenance?.collection_proof || '',
      };
      const response = await assistClient.analyze([item]);
      const modelResult = (response.analyses || []).find((row) => row.source_id === evidence.provenance?.source_id);
      if (!modelResult) throw workbenchError('ANALYSIS_IDENTITY_MISSING', '模型分析没有精确绑定来源身份，已停止。');
      const recordAnalysis = evidence.media_assets?.length ? recordVersionedReanalysis : recordVersionedTextReanalysis;
      const afterAnalysis = await recordAnalysis(project, evidenceId, {
        source_id: modelResult.source_id,
        model: modelResult.model,
        result: {
          text_expression: modelResult.text_expression || '',
          hook: modelResult.hook || '',
          copy_pattern: modelResult.copy_pattern || '',
          target_audience: modelResult.target_audience || '',
          audience_need_emotion: modelResult.audience_need_emotion || '',
          media_analysis: modelResult.media_analysis || [],
          virality_drivers: modelResult.virality_drivers || [],
          reusable_methods: modelResult.reusable_methods || [],
          rewrite_suggestions: modelResult.rewrite_suggestions || [],
          signals: modelResult.signals || [],
          risks: modelResult.risks || [],
        },
        executed_at: new Date().toISOString(),
        usage: response.usage || { total_tokens: 0 },
        // M3 费用绑定（范围 10）：服务端实际费用记录随分析保存（实际字段才绑定）。
        cost: response.cost || undefined,
        _request_identity: `reanalysis:${evidenceId}:${Date.now()}`,
      });
      setProject(afterAnalysis);
      if (onlineMode) {
        const spec = buildOnlineCommand(project, afterAnalysis);
        const persisted = await onlineStore.execute(spec.command, spec.payload, spec.options);
        if (persisted) setProject(persisted);
      } else {
        const saved = store.putProject(afterAnalysis);
        if (!saved.ok) throw workbenchError(saved.code, saved.message);
      }
      await reloadProjects();
      const versions = (afterAnalysis.analyses || []).filter((item) => item.evidence_id === evidenceId);
      setNotice(`Qwen 重新分析完成（第 ${versions.length} 个版本已追加，旧版本保留不变）。`);
      return true;
    } catch (cause) {
      if (onlineMode && project?.id) {
        try { const recovered = await onlineStore.getProject(project.id); setProject(recovered); } catch { /* keep pipeline error */ }
      }
      const message = cause && cause.bounded ? cause.message : String((cause && cause.message) || cause).slice(0, 300);
      setError({ code: (cause && cause.code) || 'REANALYSIS_FAILED', message });
      return false;
    } finally {
      setBusy(false);
    }
  }, [assistClient, onlineMode, onlineStore, project, reloadProjects, store]);

  /**
   * P38 一键「重新采集媒体并分析」：旧合同媒体（URL 哈希/t.co/非白名单/类型
   * 失配/缺内容字节）在原位恢复后才会调用 Qwen。
   *
   * 完整链（顺序严格，任一步失败立即失败关闭且零 Qwen 调用）：
   * collect_url（仅一次，规范 source_url）→ 唯一身份绑定 → 一次
   * evidence.update（不创建新证据；版本 +1、指纹变化，下游旧分析/知识卡/
   * Brief/交接按现有合同失效或过时）→ 权威在线读取确认同一 evidence_id 的
   * 新版本与媒体指纹 → analyze_persisted → 结果仅预览（由用户确认保存）。
   * 需登录在线工作区：重新采集与 Qwen 均经已认证命令边界执行。
   */
  const handleRehydrateAndAnalyze = useCallback(async (evidenceId) => {
    if (!project || project.status === 'archived') {
      setError({ code: 'PROJECT_ARCHIVED', message: '项目已归档，不能恢复媒体或重新分析。' });
      return null;
    }
    if (!onlineMode) {
      setError({ code: 'P38_ONLINE_REQUIRED', message: '重新采集媒体需要登录在线工作区（经已认证命令边界原位升级）。' });
      return null;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await rehydrateEvidenceMediaAndAnalyze({
        project,
        evidenceId,
        client: assistClient,
        updateEvidenceFn: updateEvidence,
        buildCommandFn: buildOnlineCommand,
        executeCommandFn: (command, payload, options) => onlineStore.execute(command, payload, options),
      });
      setProject(result.project);
      await reloadProjects();
      setNotice('媒体已重新采集并通过安全验证；同一证据已原位升级（版本与媒体指纹更新），Qwen 分析结果预览中，确认后才会保存。');
      return result;
    } catch (cause) {
      // 在线部分失败后重载权威项目：响应丢失但写入已成功的情况绝不误报。
      if (onlineMode && project?.id) {
        try {
          const recovered = await onlineStore.getProject(project.id);
          setProject(recovered);
        } catch {
          // 保留原始有界错误；后续显式刷新仍然可用。
        }
      }
      const message = cause && cause.bounded ? cause.message : String((cause && cause.message) || cause).slice(0, 300);
      setError({ code: (cause && cause.code) || 'P38_REHYDRATION_FAILED', message });
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [assistClient, onlineMode, onlineStore, project, reloadProjects]);

  /**
   * P32-B 批量导入所选搜索结果到当前项目：先在前端工作区层面原子重验证
   * （项目 ID、搜索批次 ID 重算、结果身份、正文哈希、collection proof、媒体与来源快照），
   * 任一条无效时当前项目完全不变；全部有效才执行写入。不自动批准 Brief、
   * 不自动路由、不生成、不发布。
   *
   * 在线模式不具备远端跨命令事务原子性，准确表述为「导入前整批验证 + 失败后
   * 权威重载 + 幂等续传」：逐条确定性幂等 evidence.create（服务端按证据身份幂等）。
   * 任何一步失败立即重载权威项目，并按权威 Evidence 与原始选择的
   * URL/external_id/content hash 身份重新对账（响应丢失但写入已成功的情况绝不
   * 误报为待重试），返回结构化 P32_ONLINE_BATCH_PARTIAL（已确认导入数量 +
   * 可安全重试的剩余身份），绝不把部分结果展示为全成功；同一选择重试只写入
   * 尚未导入的身份（skipAlreadyImported），不产生重复 Evidence，最终完整导入。
   * 离线分支保持 addEvidenceBatch 真正单次原子保存。
   */
  const handleImportHotSearch = useCallback(async (selectedIds) => {
    if (!project || project.status === 'archived') {
      setError({ code: 'PROJECT_ARCHIVED', message: '项目已归档，不能导入搜索结果。' });
      return false;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await importSearchSelection({
        project,
        batch: hotSearchState?.batch,
        selectedIds,
        nowMs: Date.now(),
        // 在线逐条命令不具备数据库事务原子性：重试必须幂等（同一选择只写入
        // 尚未导入的身份，绝不产生重复记录）。离线分支保持真正单次原子保存。
        skipAlreadyImported: onlineMode,
      });
      const newRecords = (result.project.evidence || []).filter((record) => !(project.evidence || []).some((existing) => existing.id === record.id));
      let persisted = result.project;
      if (onlineMode) {
        // 全部已在前端预验证；逐条写入，任一步失败立即重载权威状态并结构化报错。
        persisted = project;
        try {
          for (const record of newRecords) {
            persisted = await onlineStore.execute('evidence.create', { project_id: project.id, evidence: record });
          }
        } catch {
          // 以重载后的权威 Evidence 按身份重新对账：已确认成功数量绝不依赖本地
          // 响应观测（响应丢失但写入已成功的情况绝不能误报为待重试）。
          let authoritative = persisted;
          try {
            authoritative = await onlineStore.getProject(project.id);
          } catch {
            // 重载失败时以最后一次成功命令返回的项目为准。
          }
          setProject(authoritative);
          const batchItemById = new Map(result.items.map((item) => [item.id, item]));
          const authoritativeEvidence = Array.isArray(authoritative?.evidence) ? authoritative.evidence : [];
          const confirmedRecords = newRecords.filter((record) => {
            const source = batchItemById.get(record?.provenance?.source_id);
            return Boolean(source) && authoritativeEvidence.some((row) => evidenceMatchesSearchIdentity(row, source));
          });
          const pendingRecords = newRecords.filter((record) => !confirmedRecords.includes(record));
          const pendingLabels = pendingRecords.map((record) => String(record.label || record.id).slice(0, 40));
          const partialError = workbenchError(
            'P32_ONLINE_BATCH_PARTIAL',
            `在线导入未全部完成（已确认 ${confirmedRecords.length} 条成功）：剩余 ${pendingRecords.length} 条尚未导入${pendingLabels.length ? `（待重试：${pendingLabels.join('、')}）` : ''}，已重载服务端权威状态；可直接重试同一选择，不会产生重复记录。`,
          );
          partialError.details = {
            imported: confirmedRecords.length,
            pending: pendingRecords.length,
            pending_ids: pendingRecords.map((record) => record.id),
          };
          throw partialError;
        }
        setProject(persisted);
      } else {
        const saved = store.putProject(result.project);
        if (!saved.ok) throw workbenchError(saved.code, saved.message);
      }
      await reloadProjects();
      // 保留结果批次（用于「已导入」标记），只清空选择。
      setHotSearchState((previous) => (previous ? { ...previous, selectedIds: [] } : previous));
      if (result.imported > 0) {
        setNotice(`已导入 ${result.imported} 条搜索结果到当前项目（Evidence 状态为待分析，可逐条 Qwen 重新分析或多帖比较）。`);
      } else if (result.alreadyImported > 0) {
        setNotice(`所选 ${result.alreadyImported} 条结果均已导入当前项目，无需重复导入。`);
      }
      // 导入后滚动/聚焦到 Evidence 列表。
      globalThis.setTimeout(() => {
        const library = globalThis.document?.querySelector('.p32-library');
        if (library) {
          library.scrollIntoView({ behavior: 'smooth', block: 'start' });
          library.setAttribute('tabindex', '-1');
          library.focus({ preventScroll: true });
        }
      }, 120);
      return { ok: true, imported: result.imported, alreadyImported: result.alreadyImported };
    } catch (cause) {
      if (onlineMode && project?.id) {
        try {
          const recovered = await onlineStore.getProject(project.id);
          setProject(recovered);
        } catch {
          // Keep the original bounded import error; a later explicit reload remains available.
        }
      }
      const message = cause && cause.bounded ? cause.message : String((cause && cause.message) || cause).slice(0, 300);
      setError({
        code: (cause && cause.code) || 'P32_IMPORT_FAILED',
        message,
        ...(cause && cause.details && typeof cause.details === 'object' ? { details: cause.details } : {}),
      });
      // 失败也向面板抛出（面板本地显示精确错误；页面顶栏已重载权威状态）。
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [hotSearchState, onlineMode, onlineStore, project, reloadProjects, store]);

  const handleAssembleBrief = useCallback(() => {
    return run('组装 Brief', () => assembleBrief(project), { notice: 'Brief 已组装（版本递增，审核重置为待审核）。' });
  }, [run, project]);

  /**
   * P32-C 综合生成：从当前多帖比较选择确定性派生综合洞察（绝不调用模型），
   * 为每条选中 Evidence 的最新有效 Qwen 分析生成/复用知识卡，再用「精确选中
   * 知识卡范围」入口组装一份新的待人工审核 Brief（任何旧人工决定重置；绝不
   * 自动批准、绝不创建交接包）。
   *
   * 在线模式不具备远端跨命令事务原子性：知识卡与 Brief 通过既有
   * card.create / brief.assemble 命令边界逐条保存；任一步失败立即重载权威
   * 项目，按最新有效分析绑定对账并返回结构化 P32_ONLINE_SYNTHESIS_PARTIAL
   * （已确认知识卡数 + Brief 是否已组装），绝不把部分结果展示为全成功；
   * 同一选择重试完全幂等（已存在的卡复用、已组装的 Brief 版本递增），
   * 绝不产生重复知识卡，最终完整完成。
   */
  const handleSynthesizeBrief = useCallback(async () => {
    if (!project || project.status === 'archived') {
      setError({ code: 'PROJECT_ARCHIVED', message: '项目已归档，不能生成综合知识与 Brief。' });
      return false;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setSynthesisOutcome(null);
    const nowIso = () => new Date().toISOString();
    try {
      const verdict = validateSynthesisSelection(project, comparedEvidenceIds);
      if (!verdict.valid) {
        throw workbenchError('P32_SYNTHESIS_INVALID_SELECTION', verdict.reason);
      }
      // 综合洞察只由已保存的 Qwen 分析确定性派生：无模型调用、无额外费用。
      const synthesis = generateSynthesisInsight(project, comparedEvidenceIds, { now: nowIso });
      const selectedIds = synthesis.selected_evidence_ids;
      let current = project;
      let reusedCount = 0;
      let createdCount = 0;
      if (onlineMode) {
        for (const binding of verdict.bindings) {
          const afterCard = await buildKnowledgeCard(current, binding.analysis.id, { now: nowIso });
          if (afterCard.fingerprint !== current.fingerprint) {
            const spec = buildOnlineCommand(current, afterCard);
            current = await onlineStore.execute(spec.command, spec.payload, spec.options);
            createdCount += 1;
          } else {
            current = afterCard;
            reusedCount += 1;
          }
        }
        const afterBrief = await assembleSynthesisBrief(current, { selectedEvidenceIds: selectedIds, now: nowIso });
        const spec = buildOnlineCommand(current, afterBrief);
        current = await onlineStore.execute(spec.command, spec.payload, spec.options);
        setProject(current);
      } else {
        const cardsResult = await buildKnowledgeCardsForSelection(project, selectedIds, { now: nowIso });
        current = cardsResult.project;
        reusedCount = cardsResult.reusedCount;
        createdCount = cardsResult.createdCount;
        const afterBrief = await assembleSynthesisBrief(current, { selectedEvidenceIds: selectedIds, now: nowIso });
        const saved = store.putProject(afterBrief);
        if (!saved.ok) throw workbenchError(saved.code, saved.message);
        current = afterBrief;
        setProject(current);
      }
      await reloadProjects();
      const brief = current.brief;
      const outcome = {
        selected: selectedIds.length,
        reused: reusedCount,
        created: createdCount,
        briefVersion: brief ? brief.version : 0,
        briefStatus: brief ? brief.status : null,
        synthesisId: synthesis.id,
      };
      setSynthesisOutcome(outcome);
      setNotice(`综合完成：选中 ${outcome.selected} 条 · 知识卡复用 ${outcome.reused} / 新建或重建 ${outcome.created} · Brief 第 ${outcome.briefVersion} 版（待人工审核 pending）。无模型调用、无额外费用；不会自动批准或生成交接包。`);
      // 成功后滚动/聚焦到目的地导航（Brief 详情位于「产物」目的地）。
      globalThis.setTimeout(() => {
        const section = globalThis.document?.querySelector('.p36-tabs');
        if (section) {
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          section.setAttribute('tabindex', '-1');
          section.focus({ preventScroll: true });
        }
      }, 120);
      return true;
    } catch (cause) {
      if (onlineMode && project?.id) {
        try {
          const recovered = await onlineStore.getProject(project.id);
          setProject(recovered);
          // 结构化部分完成对账（绝不谎报完整成功）。
          const partial = computeSynthesisPartialState(recovered, comparedEvidenceIds);
          if (partial.cards_pending > 0 || !partial.brief_assembled) {
            const partialError = workbenchError(
              'P32_ONLINE_SYNTHESIS_PARTIAL',
              `在线综合未全部完成（已确认 ${partial.cards_confirmed} 张知识卡 / Brief ${partial.brief_assembled ? '已组装' : '未组装'}）：剩余 ${partial.cards_pending} 张知识卡待续传。已重载服务端权威状态；可直接重试同一选择（幂等：已存在卡复用、绝不产生重复卡）。`,
            );
            partialError.details = partial;
            setError({ code: partialError.code, message: partialError.message, details: partialError.details });
            return false;
          }
        } catch {
          // 保留原始有界错误；后续显式刷新仍然可用。
        }
      }
      const message = cause && cause.bounded ? cause.message : String((cause && cause.message) || cause).slice(0, 300);
      setError({ code: (cause && cause.code) || 'P32_SYNTHESIS_FAILED', message });
      return false;
    } finally {
      setBusy(false);
    }
  }, [comparedEvidenceIds, onlineMode, onlineStore, project, reloadProjects, store]);

  const handleDecide = useCallback((value, rationale, comment) => {
    return run('记录审核决定', () => reviewBrief(project, { decision: value, rationale, comment }), {
      notice: value === 'approved' ? 'Brief 已人工批准（approved + local_manual）。' : 'Brief 已退回修改（return_for_revision）。',
    });
  }, [run, project]);

  const handleDeriveHandoff = useCallback(() => {
    return run('派生交接包', () => deriveHandoffPackage(project), { notice: 'P5 交接包已派生并通过边界校验；四项执行标志均为 false。' });
  }, [run, project]);

  // ---- 导出 / 导入（本地备份）----
  const handleExport = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const result = await store.exportProjectPackage(project.id);
      if (!result.ok) {
        setError({ code: result.code, message: result.message });
        return;
      }
      const blob = new globalThis.Blob([result.text], { type: 'application/json' });
      const url = globalThis.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `p19-project-${project.id}.json`;
      anchor.click();
      globalThis.URL.revokeObjectURL(url);
      setNotice('项目备份已导出到本地（仅备份，不是发布任务）。');
    } catch (cause) {
      setError({ code: 'EXPORT_FAILED', message: String((cause && cause.message) || cause).slice(0, 300) });
    } finally {
      setBusy(false);
    }
  }, [project, store]);

  const handleImportFile = useCallback(async (file) => {
    if (!file) return;
    setPendingImport(null);
    setBusy(true);
    setError(null);
    try {
      if (file.size > IMPORT_MAX_TEXT) {
        setError({ code: 'IMPORT_TOO_LARGE', message: '导入文件超过 2 MiB 上限，已拒绝。' });
        return;
      }
      const text = await file.text();
      const inspected = await store.inspectProjectPackage(text);
      if (!inspected.ok) {
        setError({ code: inspected.code, message: inspected.message });
        return;
      }
      if (onlineMode) {
        const onlineProjects = await onlineStore.listProjects();
        if (onlineProjects.some((item) => item.id === inspected.project_id)) {
          setError({
            code: 'IMPORT_PROJECT_COLLISION',
            message: '在线工作区已存在相同 project_id；不会静默覆盖或合并。',
          });
          return;
        }
        setPendingImport({ ...inspected, fileName: file.name, online: true });
        setNotice('备份已通过版本、指纹和绑定校验；尚未上传，请确认后原子导入在线工作区。');
        return;
      }
      if (inspected.replaces_existing) {
        setPendingImport({ text, fileName: file.name, ...inspected });
        setNotice('检测到同 ID 项目：尚未写入。请核对版本与指纹后明确确认替换。');
        return;
      }
      const result = await store.importProjectPackage(text);
      if (!result.ok) {
        setError({ code: result.code, message: result.message });
        return;
      }
      reloadProjects();
      selectProject(result.project_id);
      setNotice('项目已从本地备份导入并校验（版本/指纹/绑定/标志全部通过）。');
    } catch (cause) {
      setError({ code: 'IMPORT_FAILED', message: String((cause && cause.message) || cause).slice(0, 300) });
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
      setBusy(false);
    }
  }, [onlineMode, onlineStore, reloadProjects, selectProject, store]);

  const handleConfirmImportReplacement = useCallback(async () => {
    if (!pendingImport) return;
    setBusy(true);
    setError(null);
    try {
      if (pendingImport.online) {
        const imported = await onlineStore.importPackage(pendingImport.pkg);
        setPendingImport(null);
        setProject(imported);
        setActiveId(imported.id);
        writeActiveProjectId(imported.id);
        await reloadProjects();
        setNotice('备份已按完整身份原子导入在线工作区；本机备份未删除。');
        return;
      }
      const result = await store.importProjectPackage(pendingImport.text, {
        replacement_confirmation: pendingImport.replacement_confirmation,
      });
      if (!result.ok) {
        setPendingImport(null);
        setError({ code: result.code, message: result.message });
        return;
      }
      setPendingImport(null);
      reloadProjects();
      selectProject(result.project_id);
      setNotice('已按准确项目 ID、现有版本和导入指纹确认替换。');
    } catch (cause) {
      setPendingImport(null);
      setError({ code: 'IMPORT_FAILED', message: String((cause && cause.message) || cause).slice(0, 300) });
    } finally {
      setBusy(false);
    }
  }, [onlineStore, pendingImport, reloadProjects, selectProject, store]);

  const handleArchiveProject = useCallback(async (id) => {
    if (onlineMode) {
      setBusy(true);
      setError(null);
      try {
        const persisted = await onlineStore.execute('project.archive', { project_id: id });
        setProject(persisted);
        await reloadProjects();
        setNotice('项目已在线归档并保持只读。');
      } catch (cause) {
        setError({ code: cause?.code || 'ONLINE_ARCHIVE_FAILED', message: String(cause?.message || cause).slice(0, 300) });
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    const result = store.getProject(id);
    if (result.ok && result.project.status !== 'archived') {
      const next = await archiveProject(result.project);
      const saved = store.putProject(next);
      if (!saved.ok) setError({ code: saved.code, message: saved.message });
      else {
        setNotice('项目已归档（本地）。');
        // 重载归档快照：后续编辑只能看到 archived 快照并被只读门禁拒绝，
        // 无法复活归档前的 active 修订。
        reloadProject(id);
      }
    }
    reloadProjects();
    setBusy(false);
  }, [onlineMode, onlineStore, reloadProject, reloadProjects, store]);

  const handleDeleteProject = useCallback((id) => {
    if (onlineMode) {
      setError({ code: 'ONLINE_DELETE_DISABLED', message: '在线项目不提供破坏性删除；请使用归档。' });
      return;
    }
    setBusy(true);
    const result = store.deleteProject(id);
    if (!result.ok) setError({ code: result.code, message: result.message });
    else {
      setNotice('项目已从本地删除（破坏性操作完成）。');
      const remaining = reloadProjects();
      const replacement = remaining.find((item) => item.id === activeId && item.id !== id) || remaining[0] || null;
      if (replacement) selectProject(replacement.id);
      else {
        setActiveId(null);
        writeActiveProjectId(null);
        setProject(null);
      }
    }
    setBusy(false);
  }, [activeId, onlineMode, reloadProjects, selectProject, store]);

  const activeRow = useMemo(() => {
    if (!project || !lineage) return null;
    return lineage.rows.find((row) => row.project_id === project.id) || null;
  }, [lineage, project]);

  const archiveDisabled = !project || project.status === 'archived';
  // P21 引导逻辑保留：建议下一步（推荐步骤 → 目的地）作为导航区的轻量提示，
  // 不再渲染七步长链或引导/完整视图切换。
  const guidedState = useMemo(
    () => deriveP21GuidedState({ workflow, project }),
    [workflow, project],
  );
  const recommendedDestination = useMemo(() => {
    if (!project || project.status === 'archived') return null;
    if (guidedState.complete) return null;
    return destinationForRecommendedStep(guidedState.recommended_step_id);
  }, [guidedState, project]);

  return (
    <section className="p19-workspace p36-workspace" aria-label="运营研究工作台">
      {/* 顶部：标题 + 存储状态 + 项目选择 + 新建 + 更多（导入/导出/归档/删除/档案） */}
      <header className="p36-topbar">
        <div className="p36-topbar-left">
          <p className="p19-eyebrow">研究工作台</p>
          <h2>{project ? `${project.topic.slice(0, 40)}` : '采集 → 分析 → 创作 → 产物'}</h2>
          <p className="p36-topbar-sub">{onlineMode ? '在线工作区 · 保存经命令边界写入当前账号' : '本机草稿 · 有界本地存储，未写入任何后端'}</p>
        </div>
        <div className="p36-topbar-right">
          <span className={`p19-storage-chip ${onlineMode ? 'online' : 'off'}`} data-testid="p20-persistence-mode">
            {onlineMode ? '在线工作区 · 已同步' : '本机草稿 · 未上传'}
          </span>
          {!onlineMode && (
            <span className="p19-storage-chip" title={`本地存储 ${storageSummary.total}/${storageSummary.max} 个项目`}>
              {storageSummary.total}/{storageSummary.max} 项目（localStorage）
            </span>
          )}
          <span className={`p19-storage-chip ${stagingStatus.configured ? '' : 'off'}`} title={stagingStatus.configured ? 'staging 五视图只读读者保持可用（本页不写入）' : 'staging 未配置：本页完全离线运行'}>
            {stagingStatus.configured ? 'staging 只读读者可用' : 'staging 未配置'}
          </span>
        </div>
      </header>

      {/* 执行标志：四项恒为 false，始终可见（紧凑单行） */}
      <div className="p19-strip p36-flagline">
        <P19FlagStrip />
      </div>

      {/* 项目选择 + 新建 + 更多菜单（导入/导出/归档/删除/项目档案等次级操作） */}
      <div className="p36-projectbar" role="toolbar" aria-label="项目操作">
        <label className="p19-field p19-project-select">
          <span>当前研究项目</span>
          <select
            value={activeId || ''}
            onChange={(event) => selectProject(event.target.value)}
            disabled={busy || projects.length === 0}
            aria-label="选择研究项目"
          >
            {projects.length === 0 && <option value="">（无项目）</option>}
            {projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.topic.slice(0, 32)}{item.status === 'archived' ? '（已归档）' : ''}
              </option>
            ))}
          </select>
        </label>
        <button className="p19-btn p19-btn-primary" type="button" disabled={busy} onClick={() => { setCreating(true); setError(null); }} title={onlineMode ? '新建一个在线研究项目' : '新建一个本地研究项目'}>
          + 新建项目
        </button>
        <details className="p36-more" aria-label="更多项目操作">
          <summary className="p19-btn p19-btn-ghost">更多</summary>
          <div className="p36-more-menu">
            <button className="p19-btn p19-btn-ghost" type="button" disabled={busy || !project} onClick={() => { setProfileOpen(true); }} title="编辑研究主题/目标/受众/渠道/约束（保存后下游 Brief/交接包标记过时）">
              项目档案
            </button>
            <button className="p19-btn p19-btn-ghost" type="button" disabled={busy || !project} onClick={handleExport} title="导出当前项目的本地备份 JSON（仅备份）">
              导出备份
            </button>
            <button className="p19-btn p19-btn-ghost" type="button" disabled={busy} onClick={() => importInputRef.current && importInputRef.current.click()} title="从本地备份 JSON 恢复项目（校验版本/指纹/绑定/标志）">
              导入备份
            </button>
            <P19ConfirmButton
              key={`archive-arm:${activeId}`}
              label={project && project.status === 'archived' ? '已归档' : '归档项目'}
              confirmLabel="确认归档？"
              onConfirm={() => handleArchiveProject(activeId)}
              disabled={busy || archiveDisabled}
              disabledReason="归档后项目不再参与工作链（可在列表中选择查看）"
              tone="ghost"
            />
            <P19ConfirmButton
              key={`delete-arm:${activeId}`}
              label="删除项目"
              confirmLabel="确认永久删除？"
              onConfirm={() => handleDeleteProject(activeId)}
              disabled={busy || !project}
              disabledReason="删除会从本地存储移除整个项目（建议先导出备份）"
              tone="danger"
            />
            <p className="p19-meta-line p36-more-note">
              导入/导出只是本地备份，不是发布任务；破坏性操作仍需二次确认。
            </p>
          </div>
        </details>
        <input
          ref={importInputRef}
          className="p19-file-input-hidden"
          type="file"
          accept=".json,application/json"
          onChange={(event) => handleImportFile(event.target.files && event.target.files[0])}
          aria-label="选择项目备份 JSON 文件"
        />
      </div>

      {error && (
        <div className="p19-error-banner" role="alert">
          <b>操作被拒绝（fail closed）：</b>
          <span>{error.message}</span>
          {error.code === 'CORRUPT_STORE' && (
            <p className="p19-recovery-hint">
              本地存储损坏：所有写入已被拒绝且原有数据保持不变（未被覆盖）。
              必须先清除本站点损坏的本地数据，再重新进入页面并导入备份 JSON；损坏状态下导入同样会失败关闭。
            </p>
          )}
          <button className="p19-btn p19-btn-ghost" type="button" onClick={() => setError(null)} aria-label="关闭错误提示">×</button>
        </div>
      )}
      {notice && (
        <div className="p19-notice-banner" role="status">
          <span>{notice}</span>
          <button className="p19-btn p19-btn-ghost" type="button" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
        </div>
      )}

      {pendingImport && (
        <div className="p19-panel p19-import-confirm" role="alert" aria-label={pendingImport.online ? '确认导入在线工作区' : '确认替换同 ID 项目'}>
          <div className="p19-panel-head">
            <h3>{pendingImport.online ? '确认导入在线工作区' : '同 ID 项目替换确认'}</h3>
            <span className="p19-panel-note">尚未写入</span>
          </div>
          <p>文件：{pendingImport.fileName}</p>
          <p>
            项目：{pendingImport.project_id}；
            {pendingImport.online ? `导入版本：${pendingImport.incoming_version}` : `当前版本：${pendingImport.replacement_confirmation.existing_version}；导入版本：${pendingImport.incoming_version}`}
          </p>
          <p>导入指纹：{pendingImport.incoming_fingerprint}</p>
          <div className="p19-actions">
            <button className={`p19-btn ${pendingImport.online ? 'p19-btn-primary' : 'p19-btn-danger'}`} type="button" disabled={busy} onClick={handleConfirmImportReplacement}>
              {pendingImport.online ? '确认原子导入' : '确认替换此项目'}
            </button>
            <button className="p19-btn p19-btn-ghost" type="button" disabled={busy} onClick={() => setPendingImport(null)}>取消</button>
          </div>
        </div>
      )}

      {creating && (
        <div className="p19-panel p19-create-panel">
          <div className="p19-panel-head">
            <h3>新建研究项目</h3>
          <span className="p19-panel-note">{onlineMode ? '保存到当前账号的在线工作区' : `最多 ${storageSummary.max} 个项目（本地）`}</span>
          </div>
          <NewProjectForm busy={busy} onCancel={() => setCreating(false)} onCreate={handleCreateProject} />
        </div>
      )}

      {!project && projects.length === 0 && !creating && (
        <div className="p19-welcome">
          <p className="p19-eyebrow">开始第一条研究链</p>
          <h3>创建你的第一个研究项目</h3>
          <p className="p19-meta-line">
            {onlineMode
              ? '项目保存在当前账号的在线工作区：先建项目，再采集来源、保存分析、生成草稿，每步都由你确认。'
              : '全部内容保存在本浏览器（localStorage）：不采集、不调用模型、不生成、不路由、不发布；四项执行标志恒为 false。'}
          </p>
          <button className="p19-btn p19-btn-primary" type="button" disabled={busy} onClick={() => setCreating(true)}>
            + 新建项目
          </button>
        </div>
      )}

      {project && (
        // 项目作用域：P36Destinations 以 key={project.id} 挂载 —— 切换项目时
        // 整棵目的地子树重挂载，采集输入/结果、选中来源/分析、分析预览、草稿与
        // 保存标记全部重置，绝不留存上一个项目的瞬态状态（A 项目绝不泄漏到 B）。
        // 页面级瞬态状态（热门搜索批次、综合结果、草稿记录）由 activeId effect
        // 显式清空，形成第二道隔离。
        <div className="p19-project-scope" key={project.id}>
          <P36Destinations
            key={project.id}
            project={project}
            workflow={workflow}
            onlineMode={onlineMode}
            busy={busy}
            assistClient={assistClient}
            onSaveEvidence={handleSaveAssistedEvidence}
            onSaveAnalysisPreview={handleSaveAnalysisPreview}
            onReanalyze={handleVersionedReanalyze}
            onRehydrateAndAnalyze={handleRehydrateAndAnalyze}
            onRunDeterministic={handleRunAnalysis}
            onMakeCard={handleMakeCard}
            onSaveDraft={handleSaveSimilarDraft}
            hotSearchState={hotSearchState}
            onHotSearchStateChange={setHotSearchState}
            onImportHotSearch={handleImportHotSearch}
            importError={error}
            comparedEvidenceIds={comparedEvidenceIds}
            onComparedSelectionChange={setComparedEvidenceIds}
            synthesisOutcome={synthesisOutcome}
            onSynthesize={handleSynthesizeBrief}
            onAddEvidence={handleAddEvidence}
            onUpdateEvidence={handleUpdateEvidence}
            onRemoveEvidence={handleRemoveEvidence}
            onAssembleBrief={handleAssembleBrief}
            onDecide={handleDecide}
            onDeriveHandoff={handleDeriveHandoff}
            onDownload={handleExport}
            activeRow={activeRow}
            graph={graph}
            projects={projects}
            savedDrafts={savedDrafts}
            recommendedDestination={recommendedDestination}
            recommendedLabel={guidedState.label}
          />
        </div>
      )}

      {profileOpen && project && (
        <div className="p36-settings-overlay" role="presentation" onClick={() => setProfileOpen(false)}>
          <div className="p36-settings-drawer" role="dialog" aria-label="项目档案设置" onClick={(event) => event.stopPropagation()}>
            <div className="p36-settings-head">
              <h3>项目档案</h3>
              <button className="p19-btn p19-btn-ghost" type="button" onClick={() => setProfileOpen(false)} aria-label="关闭项目档案">×</button>
            </div>
            <P19ProjectForm key={project.id} project={project} onSave={handleSaveProfile} busy={busy} />
            <p className="p19-meta-line">编辑档案并保存后，下游 Brief/交接包会自动标记为过时并要求重新生成。</p>
          </div>
        </div>
      )}

      <footer className="p19-footer">
        <p>
          {onlineMode
            ? '在线工作区：保存操作通过已认证命令边界写入当前账号的数据空间；刷新或更换浏览器后可重新读取。在线项目不提供破坏性删除，只能归档。'
            : '本地草稿：所有记录仅保存在本浏览器的有界本地存储（p19_store_v1），未写入任何后端；导入/导出只是本地备份，不是发布任务。'}
        </p>
        <p className="p19-footer-fine">
          来源分析：多模态模型结果按来源与媒体精确绑定保存（model_analysis）或确定性本地规则 · 人工决定 local_manual · 四项执行标志均为 false · 无生成 / 无路由 / 无发布
        </p>
      </footer>
    </section>
  );
}

function NewProjectForm({ busy, onCancel, onCreate }) {
  const [topic, setTopic] = useState('');
  const [objective, setObjective] = useState('');
  const [audience, setAudience] = useState('');
  const [channel, setChannel] = useState('');
  const [constraintsText, setConstraintsText] = useState('');
  const submit = (event) => {
    event.preventDefault();
    onCreate({
      topic: topic.trim(),
      objective: objective.trim(),
      audience: audience.trim(),
      channel: channel.trim(),
      constraints: constraintsText.split('\n').map((item) => item.trim()).filter(Boolean).slice(0, 20),
    });
  };
  return (
    <form className="p19-form" onSubmit={submit}>
      <label className="p19-field">
        <span>研究主题（必填）</span>
        <input type="text" value={topic} maxLength={5000} onChange={(event) => setTopic(event.target.value)} />
      </label>
      <label className="p19-field">
        <span>研究目标（必填）</span>
        <textarea rows={2} value={objective} maxLength={5000} onChange={(event) => setObjective(event.target.value)} />
      </label>
      <label className="p19-field">
        <span>目标受众（必填）</span>
        <input type="text" value={audience} maxLength={200} onChange={(event) => setAudience(event.target.value)} />
      </label>
      <label className="p19-field">
        <span>目标渠道（必填）</span>
        <input type="text" value={channel} maxLength={200} onChange={(event) => setChannel(event.target.value)} />
      </label>
      <label className="p19-field">
        <span>约束（每行一条，最多 20 条）</span>
        <textarea rows={3} value={constraintsText} onChange={(event) => setConstraintsText(event.target.value)} />
      </label>
      <div className="p19-form-actions">
        <button className="p19-btn p19-btn-primary" type="submit" disabled={busy || !topic.trim() || !objective.trim() || !audience.trim() || !channel.trim()} title={!topic.trim() ? '主题必填' : '创建本地研究项目'}>
          {busy ? '创建中…' : '创建项目'}
        </button>
        <button className="p19-btn p19-btn-ghost" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
