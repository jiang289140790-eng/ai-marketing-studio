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
  buildKnowledgeCard,
  buildProjectWorkflowState,
  createProject,
  deriveHandoffPackage,
  removeEvidence,
  reviewBrief,
  runAnalysis,
  updateEvidence,
  updateProjectProfile,
  workbenchError,
} from '../services/p19-workspace-service.js';
import { buildLineageAudit, buildProjectLineageGraph } from '../services/p19-lineage.js';
import {
  P19AnalysisList,
  P19BriefSection,
  P19CardList,
  P19ChainProgress,
  P19ConfirmButton,
  P19EvidenceList,
  P19FlagStrip,
  P19HandoffSection,
  P19LineageSection,
  P19ProjectForm,
} from '../components/integrated-workspace/P19WorkbenchPanels.jsx';
import { getStagingRuntimeStatus } from '../services/staging-preview-service.js';
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

export function ResearchWorkspacePage() {
  const storeRef = useRef(null);
  if (storeRef.current == null) storeRef.current = createP19Store();

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

  const reloadProjects = useCallback(() => {
    const result = storeRef.current.listProjects();
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
  }, []);

  const reloadProject = useCallback((id) => {
    const result = storeRef.current.getProject(id);
    if (result.ok) {
      setProject(result.project);
      return result.project;
    }
    setError({ code: result.code, message: result.message });
    setProject(null);
    return null;
  }, []);

  // 初次加载：项目列表 + 激活项目
  useEffect(() => {
    const list = reloadProjects();
    let target = list.find((item) => item.id === activeId) || null;
    if (!target && list.length > 0) target = list[0];
    if (target) {
      setActiveId(target.id);
      writeActiveProjectId(target.id);
      reloadProject(target.id);
    } else {
      writeActiveProjectId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, [activeId]);

  const selectProject = useCallback((id) => {
    setActiveId(id);
    writeActiveProjectId(id);
    reloadProject(id);
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
      const saved = storeRef.current.putProject(next);
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
  }, [project, reloadProject, reloadProjects]);

  // ---- 项目操作 ----
  const handleCreateProject = useCallback(async (form) => {
    const ok = await run('创建项目', async () => {
      const next = await createProject(form);
      const saved = storeRef.current.putProject(next);
      if (!saved.ok) throw workbenchError(saved.code, saved.message);
      setCreating(false);
      return next;
    }, { notice: '项目已创建（本地草稿）。', allowArchived: true });
    if (ok) {
      reloadProjects();
      const list = storeRef.current.listProjects();
      if (list.ok && list.projects.length > 0) {
        const created = list.projects[list.projects.length - 1];
        selectProject(created.id);
      }
    }
  }, [run, reloadProjects, selectProject]);

  const handleSaveProfile = useCallback((patch) => {
    return run('保存项目档案', () => updateProjectProfile(project, patch), { notice: '项目档案已保存；下游 Brief/交接包已标记为过时。' });
  }, [run, project]);

  const handleAddEvidence = useCallback((input) => {
    return run('添加证据', () => addEvidence(project, input), { notice: '证据已添加（仅本地）。' });
  }, [run, project]);

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

  const handleAssembleBrief = useCallback(() => {
    return run('组装 Brief', () => assembleBrief(project), { notice: 'Brief 已组装（版本递增，审核重置为待审核）。' });
  }, [run, project]);

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
      const result = await storeRef.current.exportProjectPackage(project.id);
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
  }, [project]);

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
      const inspected = await storeRef.current.inspectProjectPackage(text);
      if (!inspected.ok) {
        setError({ code: inspected.code, message: inspected.message });
        return;
      }
      if (inspected.replaces_existing) {
        setPendingImport({ text, fileName: file.name, ...inspected });
        setNotice('检测到同 ID 项目：尚未写入。请核对版本与指纹后明确确认替换。');
        return;
      }
      const result = await storeRef.current.importProjectPackage(text);
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
  }, [reloadProjects, selectProject]);

  const handleConfirmImportReplacement = useCallback(async () => {
    if (!pendingImport) return;
    setBusy(true);
    setError(null);
    try {
      const result = await storeRef.current.importProjectPackage(pendingImport.text, {
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
  }, [pendingImport, reloadProjects, selectProject]);

  const handleArchiveProject = useCallback(async (id) => {
    setBusy(true);
    const result = storeRef.current.getProject(id);
    if (result.ok && result.project.status !== 'archived') {
      const next = await archiveProject(result.project);
      const saved = storeRef.current.putProject(next);
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
  }, [reloadProjects, reloadProject]);

  const handleDeleteProject = useCallback((id) => {
    setBusy(true);
    const result = storeRef.current.deleteProject(id);
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
  }, [activeId, reloadProjects, selectProject]);

  const activeRow = useMemo(() => {
    if (!project || !lineage) return null;
    return lineage.rows.find((row) => row.project_id === project.id) || null;
  }, [lineage, project]);

  const archiveDisabled = !project || project.status === 'archived';

  return (
    <section className="p19-workspace" aria-label="运营研究工作台">
      {/* 顶部：标题 + 项目选择 + 执行标志 + 存储状态 */}
      <header className="p19-topbar">
        <div className="p19-topbar-left">
          <p className="p19-eyebrow">运营研究工作台 · 本地草稿模式</p>
          <h2>研究项目 → 证据 → 确定性分析 → 知识卡 → 可审核 Brief → 交接包 → 世系审计</h2>
        </div>
        <div className="p19-topbar-right">
          <span className="p19-storage-chip" title={`本地存储 ${storageSummary.total}/${storageSummary.max} 个项目`}>
            {storageSummary.total}/{storageSummary.max} 项目（localStorage）
          </span>
          <span className={`p19-storage-chip ${stagingStatus.configured ? '' : 'off'}`} title={stagingStatus.configured ? 'staging 五视图只读读者保持可用（本页不写入）' : 'staging 未配置：本页完全离线运行'}>
            {stagingStatus.configured ? 'staging 只读读者可用' : 'staging 未配置'}
          </span>
        </div>
      </header>

      <div className="p19-strip">
        <P19FlagStrip />
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

      {/* 项目选择器 + 项目操作 */}
      <div className="p19-project-bar" role="toolbar" aria-label="项目操作">
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
        <button className="p19-btn p19-btn-primary" type="button" disabled={busy} onClick={() => { setCreating(true); setError(null); }} title="新建一个本地研究项目">
          + 新建项目
        </button>
        <button className="p19-btn p19-btn-ghost" type="button" disabled={busy || !project} onClick={handleExport} title="导出当前项目的本地备份 JSON（仅备份）">
          导出备份
        </button>
        <button className="p19-btn p19-btn-ghost" type="button" disabled={busy} onClick={() => importInputRef.current && importInputRef.current.click()} title="从本地备份 JSON 恢复项目（校验版本/指纹/绑定/标志）">
          导入备份
        </button>
        <input
          ref={importInputRef}
          className="p19-file-input-hidden"
          type="file"
          accept=".json,application/json"
          onChange={(event) => handleImportFile(event.target.files && event.target.files[0])}
          aria-label="选择项目备份 JSON 文件"
        />
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
      </div>

      {pendingImport && (
        <div className="p19-panel p19-import-confirm" role="alert" aria-label="确认替换同 ID 项目">
          <div className="p19-panel-head">
            <h3>同 ID 项目替换确认</h3>
            <span className="p19-panel-note">尚未写入</span>
          </div>
          <p>文件：{pendingImport.fileName}</p>
          <p>项目：{pendingImport.project_id}；当前版本：{pendingImport.replacement_confirmation.existing_version}；导入版本：{pendingImport.incoming_version}</p>
          <p>导入指纹：{pendingImport.incoming_fingerprint}</p>
          <div className="p19-actions">
            <button className="p19-btn p19-btn-danger" type="button" disabled={busy} onClick={handleConfirmImportReplacement}>确认替换此项目</button>
            <button className="p19-btn p19-btn-ghost" type="button" disabled={busy} onClick={() => setPendingImport(null)}>取消</button>
          </div>
        </div>
      )}

      {creating && (
        <div className="p19-panel p19-create-panel">
          <div className="p19-panel-head">
            <h3>新建研究项目</h3>
            <span className="p19-panel-note">最多 {storageSummary.max} 个项目（本地）</span>
          </div>
          <NewProjectForm busy={busy} onCancel={() => setCreating(false)} onCreate={handleCreateProject} />
        </div>
      )}

      {!project && projects.length === 0 && !creating && (
        <div className="p19-welcome">
          <p className="p19-eyebrow">开始第一条研究链</p>
          <h3>创建你的第一个本地研究项目</h3>
          <p className="p19-meta-line">
            全部内容保存在本浏览器（localStorage）：不采集、不调用模型、不生成、不路由、不发布；四项执行标志恒为 false。
          </p>
          <button className="p19-btn p19-btn-primary" type="button" disabled={busy} onClick={() => setCreating(true)}>
            + 新建项目
          </button>
        </div>
      )}

      {project && (
        // 项目作用域确定性重挂载：key 绑定精确的 (project.id, project.version)。
        // 切换项目或版本递增时整棵面板子树重挂载，项目档案/证据编辑与新增/
        // Brief 理由与评论等全部项目级本地表单状态随之重置，绝不留存上一个
        // 项目的表单值（A 项目的值绝不会覆盖 B 项目）。
        <div className="p19-project-scope" key={`${project.id}:${project.version}`}>
          <P19ChainProgress workflow={workflow} />
          <div className="p19-grid">
            <P19ProjectForm project={project} onSave={handleSaveProfile} busy={busy} />
            <P19EvidenceList
              project={project}
              onAdd={handleAddEvidence}
              onUpdate={handleUpdateEvidence}
              onRemove={handleRemoveEvidence}
              onAnalyze={handleRunAnalysis}
              busy={busy}
            />
            <P19AnalysisList project={project} onMakeCard={handleMakeCard} busy={busy} />
            <P19CardList project={project} workflow={workflow} />
            <P19BriefSection project={project} workflow={workflow} onAssemble={handleAssembleBrief} onDecide={handleDecide} busy={busy} />
            <P19HandoffSection project={project} workflow={workflow} onDerive={handleDeriveHandoff} onDownload={handleExport} busy={busy} />
            <P19LineageSection row={activeRow} graph={graph} projects={projects} />
          </div>
        </div>
      )}

      <footer className="p19-footer">
        <p>
          本地草稿：所有记录仅保存在本浏览器的有界本地存储（p19_store_v1），未写入任何后端；
          staging 五视图只读读者保持 fail closed。导入/导出只是本地备份，不是发布任务。
        </p>
        <p className="p19-footer-fine">
          确定性分析 deterministic_local · 人工决定 local_manual · 四项执行标志均为 false · 无采集 / 无模型推理 / 无生成 / 无路由 / 无发布
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
