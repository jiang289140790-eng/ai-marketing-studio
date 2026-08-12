// P19 研究工作台面板组件（纯展示 + 局部表单状态；所有副作用经由页面回调上抛）。
// 暗色视觉体系沿用 P18 词汇；中文文案 UTF-8；状态不只靠颜色（文字 + 图标）。
// 本组件不发起任何网络请求。

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  EXECUTION_FLAG_LABELS,
  MAX_STRING_LENGTH,
  boundedText,
} from '../../services/p19-contracts.js';
import {
  generateEvidenceComparison,
  generateSynthesisInsight,
  getAllAnalysisVersionsForEvidence,
  getLatestAnalysisForEvidence,
  validateSynthesisSelection,
} from '../../services/p19-workspace-service.js';
import {
  P32_BATCH_IMPORT_MAX,
  P32_SEARCH_COUNT_DEFAULT,
  P32_SEARCH_SORT_KEYS,
  P32_SEARCH_SORT_LABELS,
  P32_REDDIT_SORT_KEYS,
  P32_REDDIT_SORT_LABELS,
  computeEngagementMetrics,
  findConflictingEvidence,
  looksLikePublicUrl,
  rankSearchResults,
  rankRedditSearchResults,
} from '../../services/p22-research-assist.js';

const STATE_TEXT = {
  INVALID_SOURCE: { label: '无效来源', tone: 'danger', icon: '⛔' },
  BROKEN: { label: '链路断裂', tone: 'danger', icon: '✕' },
  PARTIAL: { label: '部分完成', tone: 'warn', icon: '◐' },
  COMPLETE: { label: '完整', tone: 'ok', icon: '✓' },
};

function P19Pill({ label, tone = 'neutral', icon }) {
  return (
    <span className={`p19-pill p19-pill-${tone}`} role="status">
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span>{label}</span>
    </span>
  );
}

export function P19FlagStrip() {
  const rows = Object.entries(EXECUTION_FLAG_LABELS).map(([key, label]) => ({ key, label }));
  // 本页执行标志恒为 false：只渲染「未执行」，绝无暗示执行发生的文案。
  return (
    <div className="p19-flag-strip" aria-label="执行标志（恒为未执行）">
      <span className="p19-flag-strip-title">执行标志</span>
      {rows.map((row) => (
        <span className="p19-flag-cell" key={row.key} title="未执行">
          <b>{row.label}</b>
          <i>未执行</i>
        </span>
      ))}
      <span className="p19-flag-note">四项均为 false · 本页不采集、不分析调用、不生成、不路由、不发布</span>
    </div>
  );
}

export function P19ChainProgress({ workflow, onNavigateStep }) {
  if (!workflow) return null;
  return (
    <nav className="p19-chain" aria-label="操作步骤进度">
      {workflow.steps.map((step, index) => {
        const blocking = Array.isArray(step.blocking) ? step.blocking : [];
        const disabled = blocking.length > 0;
        return (
          <button
            className={`p19-chain-step ${step.done ? 'done' : ''} ${disabled ? 'blocked' : ''}`}
            key={step.id}
            type="button"
            onClick={() => onNavigateStep && onNavigateStep(step.id)}
            aria-current={step.done ? 'step' : undefined}
            title={blocking.length > 0 ? `阻塞原因：${blocking.join('；')}` : step.done ? '已完成' : '可操作'}
          >
            <i aria-hidden="true">{step.done ? '✓' : index + 1}</i>
            <b>{step.label}</b>
            {blocking.length > 0 && <small>{boundedText(blocking[0], 36)}</small>}
          </button>
        );
      })}
    </nav>
  );
}

/** 二次点击确认按钮：破坏性操作必须显式确认。 */
export function P19ConfirmButton({ label, confirmLabel, onConfirm, disabled, disabledReason, tone = 'danger' }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      className={`p19-btn p19-btn-${tone} ${armed ? 'armed' : ''}`}
      type="button"
      disabled={Boolean(disabled)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
      title={disabled && disabledReason ? disabledReason : armed ? confirmLabel : label}
      aria-label={armed ? confirmLabel : label}
      aria-disabled={Boolean(disabled)}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

export function P19ProjectForm({ project, onSave, busy }) {
  const [topic, setTopic] = useState(project.topic);
  const [objective, setObjective] = useState(project.objective);
  const [audience, setAudience] = useState(project.audience);
  const [channel, setChannel] = useState(project.channel);
  const [constraintsText, setConstraintsText] = useState((project.constraints || []).join('\n'));
  const save = () => {
    const constraints = constraintsText
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20);
    onSave({ topic: topic.trim(), objective: objective.trim(), audience: audience.trim(), channel: channel.trim(), constraints });
  };
  return (
    <div className="p19-panel">
      <div className="p19-panel-head">
        <h3>研究项目档案</h3>
        <span className="p19-panel-note">编辑后下游 Brief/交接包将自动标记为过时</span>
      </div>
      <form className="p19-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <label className="p19-field">
          <span>研究主题（必填）</span>
          <input type="text" value={topic} maxLength={MAX_STRING_LENGTH} onChange={(event) => setTopic(event.target.value)} />
        </label>
        <label className="p19-field">
          <span>研究目标（必填）</span>
          <textarea rows={2} value={objective} maxLength={MAX_STRING_LENGTH} onChange={(event) => setObjective(event.target.value)} />
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
          <button className="p19-btn p19-btn-primary" type="submit" disabled={busy}>
            {busy ? '保存中…' : '保存项目档案'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** 本地媒体元数据：仅读取文件名/MIME/大小/修改时间并计算 SHA-256，绝不上传或保存原始字节。 */
export function P19MediaMetaInput({ value, onChange }) {
  const [metaError, setMetaError] = useState('');
  const inputRef = useRef(null);
  const pick = async (file) => {
    setMetaError('');
    if (!file) {
      onChange(null);
      return;
    }
    if (file.size > 512 * 1024 * 1024) {
      setMetaError('文件超过 512MiB 元数据边界，已拒绝（本页从不保存文件内容）。');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
      const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      onChange({
        filename: String(file.name).slice(0, 200),
        mime_type: String(file.type || 'application/octet-stream').slice(0, 100),
        byte_size: file.size,
        last_modified: new Date(file.lastModified || Date.now()).toISOString().slice(0, 80),
        sha256,
      });
    } catch {
      setMetaError('计算文件元数据失败：只计算 SHA-256，不读取内容。');
    }
  };
  return (
    <div className="p19-field">
      <span>本地媒体元数据（可选，不上传文件）</span>
      <div className="p19-media-row">
        <input
          ref={inputRef}
          className="p19-file-input"
          type="file"
          onChange={(event) => pick(event.target.files && event.target.files[0])}
          aria-label="选择本地文件以读取元数据（不会上传）"
        />
        {value && (
          <button
            className="p19-btn p19-btn-ghost"
            type="button"
            onClick={() => { onChange(null); if (inputRef.current) inputRef.current.value = ''; }}
          >
            清除元数据
          </button>
        )}
      </div>
      {value ? (
        <p className="p19-meta-line" title={value.sha256}>
          仅元数据：{boundedText(value.filename, 40)} · {value.mime_type} · {value.byte_size} 字节 · SHA-256 {value.sha256.slice(0, 12)}…
        </p>
      ) : (
        <p className="p19-meta-line">未附加媒体元数据（文件内容永不进入本页存储）。</p>
      )}
      {metaError && <p className="p19-error-text">{metaError}</p>}
    </div>
  );
}

export function P19EvidenceList({ project, onAdd, onUpdate, onRemove, onAnalyze, busy }) {
  const [editingId, setEditingId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ source_url: '', label: '', platform: '', content_text: '', media_metadata: null });
  const resetForm = () => setForm({ source_url: '', label: '', platform: '', content_text: '', media_metadata: null });
  const evidence = project.evidence || [];
  const submit = async () => {
    const payload = {
      source_url: form.source_url.trim(),
      label: form.label.trim(),
      platform: form.platform.trim(),
      content_text: form.content_text,
      media_metadata: form.media_metadata,
    };
    const saved = editingId
      ? await onUpdate(editingId, payload)
      : await onAdd(payload);
    if (saved) {
      setEditingId(null);
      setShowAdd(false);
      resetForm();
    }
  };
  const startEdit = (record) => {
    setEditingId(record.id);
    setShowAdd(true);
    setForm({
      source_url: record.source_url,
      label: record.label,
      platform: record.platform,
      content_text: record.content_text,
      media_metadata: record.media_metadata || null,
    });
  };
  return (
    <div className="p19-panel">
      <div className="p19-panel-head">
        <h3>证据采集（本地手工录入）</h3>
        <span className="p19-panel-note">共 {evidence.length} 条 · 不采集、不联网</span>
      </div>
      {evidence.length === 0 && !showAdd && (
        <p className="p19-empty-note">还没有证据。点击「添加证据」录入第一条手工证据。</p>
      )}
      {!showAdd && (
        <div className="p19-form-actions">
          <button className="p19-btn p19-btn-primary" type="button" onClick={() => { setShowAdd(true); setEditingId(null); resetForm(); }} disabled={busy}>
            + 添加证据
          </button>
        </div>
      )}
      {showAdd && (
        <form className="p19-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <label className="p19-field">
            <span>来源 URL（必填，http/https）</span>
            <input type="url" value={form.source_url} maxLength={1000} onChange={(event) => setForm({ ...form, source_url: event.target.value })} />
          </label>
          <label className="p19-field">
            <span>标签（必填）</span>
            <input type="text" value={form.label} maxLength={200} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </label>
          <label className="p19-field">
            <span>平台（必填）</span>
            <input type="text" value={form.platform} maxLength={80} onChange={(event) => setForm({ ...form, platform: event.target.value })} />
          </label>
          <label className="p19-field">
            <span>内容文本（必填，≤5000 字符）</span>
            <textarea rows={4} value={form.content_text} maxLength={MAX_STRING_LENGTH} onChange={(event) => setForm({ ...form, content_text: event.target.value })} />
          </label>
          <P19MediaMetaInput value={form.media_metadata} onChange={(media_metadata) => setForm({ ...form, media_metadata })} />
          <div className="p19-form-actions">
            <button className="p19-btn p19-btn-primary" type="submit" disabled={busy}>
              {editingId ? '保存证据修改' : '添加证据'}
            </button>
            <button className="p19-btn p19-btn-ghost" type="button" onClick={() => { setShowAdd(false); setEditingId(null); resetForm(); }} disabled={busy}>
              取消
            </button>
          </div>
        </form>
      )}
      <ul className="p19-evidence-list">
        {evidence.map((record) => (
          <li className="p19-evidence-item" key={record.id}>
            <div className="p19-evidence-top">
              <strong>{boundedText(record.label, 60)}</strong>
              <P19Pill label="manual_local" tone="ok" />
            </div>
            <p className="p19-meta-line">
              {boundedText(record.platform, 24)} · {boundedText(record.source_url, 48)}
            </p>
            {record.source_metadata?.author && (
              <p className="p19-meta-line">
                作者：{boundedText(record.source_metadata.author.name || record.source_metadata.author.handle || '未知', 40)}
                {record.source_metadata.author.handle ? ` @${boundedText(record.source_metadata.author.handle, 30)}` : ''}
                {record.source_metadata.published_at ? ` · ${boundedText(record.source_metadata.published_at, 16)}` : ''}
              </p>
            )}
            <p className="p19-evidence-text">{boundedText(record.content_text, 220)}</p>
            {Array.isArray(record.media_assets) && record.media_assets.length > 0 && (
              <p className="p19-meta-line">
                真实媒体 {record.media_assets.length} 项（按顺序绑定）：{record.media_assets.slice(0, 3).map((asset) => `#${asset.order + 1} ${boundedText(asset.kind, 6)}`).join(' · ')}
                {record.media_assets.length > 3 ? ' …' : ''}
              </p>
            )}
            {record.media_metadata && (
              <p className="p19-meta-line" title={record.media_metadata.sha256}>
                媒体元数据：{boundedText(record.media_metadata.filename, 40)} · {record.media_metadata.byte_size} 字节 · {record.media_metadata.sha256.slice(0, 12)}…
              </p>
            )}
            <div className="p19-evidence-actions">
              <button className="p19-btn p19-btn-ghost" type="button" disabled={busy} onClick={() => onAnalyze(record.id)} title="对这条证据运行确定性本地分析（deterministic_local，不调用模型）">
                运行确定性分析
              </button>
              <button className="p19-btn p19-btn-ghost" type="button" disabled={busy} onClick={() => startEdit(record)} title="编辑证据会使下游分析/知识卡/Brief 过时">
                编辑
              </button>
              <P19ConfirmButton
                label="移除"
                confirmLabel="确认移除？"
                onConfirm={() => onRemove(record.id)}
                disabled={busy}
                disabledReason="移除证据会同时剪除依赖它的分析/知识卡/Brief/交接包"
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function P19AnalysisList({ project, onMakeCard, busy }) {
  const analyses = project.analyses || [];
  const evidenceById = new Map((project.evidence || []).map((item) => [item.id, item]));
  return (
    <div className="p19-panel">
      <div className="p19-panel-head">
        <h3>来源分析（多模态模型 / deterministic_local）</h3>
        <span className="p19-panel-note">模型结果精确绑定保存 · 确定性规则补充 · 无费用隐藏项</span>
      </div>
      <p className="p19-provenance-line">
        带媒体来源的 P29 分析把服务端多模态 Qwen 结果按来源与媒体精确绑定持久化（model_analysis 扩展）；纯文本来源沿用确定性本地规则（来源 URL 形状、文本长度、关键词频次、语气标记、媒体元数据边界、人工来源可信度），绝不调用任何模型。
      </p>
      {analyses.length === 0 && <p className="p19-empty-note">还没有分析记录。在证据卡片上点击「运行确定性分析」，或在智能研究面板一键生成多模态分析。</p>}
      <ul className="p19-analysis-list">
        {analyses.map((analysis) => {
          const evidence = evidenceById.get(analysis.evidence_id);
          const modelAnalysis = analysis.model_analysis;
          return (
            <li className="p19-analysis-item" key={analysis.id}>
              <div className="p19-analysis-top">
                <strong>{boundedText(analysis.result.summary.label, 48)}</strong>
                {modelAnalysis
                  ? <P19Pill label={boundedText(modelAnalysis.model, 30)} tone="ok" icon="◇" />
                  : <P19Pill label="deterministic_local" tone="ok" icon="⚙" />}
              </div>
              <p className="p19-meta-line">
                证据：{evidence ? boundedText(evidence.label, 40) : '（证据已移除，绑定失效）'} · 规则 {analysis.rule_ids.length} 条 · {analysis.provenance.generated_by}
              </p>
              {modelAnalysis && (
                <div className="p19-findings">
                  <b>多模态结论（已绑定保存，模型 {boundedText(modelAnalysis.model, 40)}）：</b>
                  <p className="p19-evidence-text">{boundedText(modelAnalysis.result.text_expression, 240)}</p>
                  <ul className="p19-comment-list">
                    {(modelAnalysis.result.media_analysis || []).map((row) => (
                      <li key={row.media_id}>画面（{row.media_id}）：{boundedText(row.visual_content, 140)}</li>
                    ))}
                    <li>信号：{(modelAnalysis.result.signals || []).slice(0, 3).join('；') || '无'} · 风险：{(modelAnalysis.result.risks || []).slice(0, 3).join('；') || '无'}</li>
                  </ul>
                </div>
              )}
              <ul className="p19-rule-list">
                {(analysis.result.rules || []).slice(0, 6).map((rule) => (
                  <li key={rule.rule_id}>
                    <b>{rule.label}：</b>
                    <span>{ruleOutputText(rule)}</span>
                  </li>
                ))}
              </ul>
              <div className="p19-evidence-actions">
                <button className="p19-btn p19-btn-primary" type="button" disabled={busy} onClick={() => onMakeCard(analysis.id)} title="把这条分析转成校验过的 content_knowledge_card_v1 知识卡">
                  生成知识卡
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ruleOutputText(rule) {
  const output = rule.output || {};
  if (rule.rule_id === 'keyword_frequency') {
    const list = Array.isArray(output.keywords) ? output.keywords : [];
    return list.length > 0 ? list.slice(0, 5).join('、') : output.note || '无';
  }
  if (rule.rule_id === 'source_url_shape') {
    const urlShape = output.protocol ? `${output.protocol}//${output.hostname}` : '';
    return urlShape || output.note || '—';
  }
  if (rule.rule_id === 'text_length_profile') return `${output.characters} 字符 / ${output.words} 词 / ${output.sentences} 句`;
  if (rule.rule_id === 'tone_indicators') return `感叹 ${output.exclamations} · 疑问 ${output.questions} · 表情 ${output.emoji}`;
  if (rule.rule_id === 'media_metadata_bounds') return output.present ? `元数据边界 ${output.all_bounds_ok ? '通过' : '未通过'}` : output.note || '无';
  if (rule.rule_id === 'manual_provenance_trust') return output.trust_status || '—';
  return '—';
}

export function P19CardList({ project, workflow }) {
  const cards = project.knowledge_cards || [];
  return (
    <div className="p19-panel">
      <div className="p19-panel-head">
        <h3>知识卡（content_knowledge_card_v1）</h3>
        <span className="p19-panel-note">共 {cards.length} 张 · 校验后才可进入 Brief</span>
      </div>
      {cards.length === 0 && <p className="p19-empty-note">还没有知识卡。在分析卡片上点击「生成知识卡」。</p>}
      <ul className="p19-card-list">
        {cards.map((card) => (
          <li className="p19-card-item" key={card.id}>
            <div className="p19-card-top">
              <strong>{boundedText(card.source_observations.post_text, 60)}</strong>
              <P19Pill label={card.validation_status} tone="ok" />
            </div>
            <p className="p19-meta-line">
              分析 {boundedText(card.analysis_id, 20)} · 信任 {card.trust_status} · 引用 {card.evidence_links.length} 条
              {card.analysis_provenance ? ` · 模型 ${boundedText(card.analysis_provenance.model, 30)}（媒体 ${card.analysis_provenance.media_ids.length} 项）` : ''}
            </p>
            <p className="p19-evidence-text">钩子：{boundedText(card.creative_analysis.hook, 120)}</p>
            <p className="p19-meta-line">可复用特征：{card.generation_guidance.must_preserve.slice(0, 4).join('、')}</p>
            <p className="p19-provenance-line">生成就绪：{card.generation_readiness.usable ? `可用（${card.generation_readiness.score} 分）` : '不可用'} · 过时：{workflow?.card_stale_ids?.includes(card.id) ? '是' : '无'}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function P19BriefSection({ project, workflow, onAssemble, onDecide, busy, onlineMode = false }) {
  const [rationale, setRationale] = useState('');
  const [comment, setComment] = useState('');
  const brief = project.brief || null;
  const decision = brief && brief.review && brief.review.decision ? brief.review.decision : null;
  const stale = Boolean(workflow && workflow.brief_stale);
  const approved = Boolean(decision && decision.value === 'approved');
  const returned = Boolean(decision && decision.value === 'return_for_revision');
  const canReview = Boolean(brief) && brief.status === 'pending_review' && !stale && !approved;
  const canSubmitReview = canReview && Boolean(rationale.trim());
  // 引用证据数（经知识卡 → 分析 → 证据的去重绑定）与媒体计数。
  const citedEvidenceCount = useMemo(() => {
    if (!brief) return 0;
    const analysisById = new Map((project.analyses || []).map((row) => [row.id, row]));
    const ids = new Set((project.knowledge_cards || [])
      .filter((card) => brief.knowledge_citation_ids.includes(card.id))
      .map((card) => analysisById.get(card.analysis_id)?.evidence_id)
      .filter(Boolean));
    return ids.size;
  }, [brief, project.analyses, project.knowledge_cards]);
  const decide = (value) => {
    onDecide(value, rationale.trim(), comment.trim());
    setRationale('');
    setComment('');
  };
  return (
    <div className="p19-panel">
      <div className="p19-panel-head">
        <h3>内容策划草案（待你确认）</h3>
        {brief ? (
          <span className="p19-panel-note">
            第 {brief.version} 版 · {brief.status === 'approved' ? '已批准' : brief.status === 'returned' ? '已退回' : '待确认'}
            {stale ? ' · 已过时' : ''}
          </span>
        ) : (
          <span className="p19-panel-note">尚未生成</span>
        )}
      </div>
      {!brief && (
        <>
          <p className="p19-empty-note">草案由证据、来源分析（多模态模型结果或确定性规则）与知识卡组装；任何上游变化都会使旧草案过时并要求重新生成。</p>
          <div className="p19-form-actions">
            <button className="p19-btn p19-btn-primary" type="button" disabled={busy || (project.knowledge_cards || []).length === 0} title={(project.knowledge_cards || []).length === 0 ? '至少需要一张知识卡' : '生成内容策划草案（版本递增，确认状态重置）'} onClick={onAssemble}>
              生成内容策划草案
            </button>
          </div>
        </>
      )}
      {brief && (
        <>
          <p className="p19-provenance-line">
            <strong>主题：</strong>{boundedText(brief.topic, 80)} · <strong>目标：</strong>{boundedText(brief.objective, 120)}
          </p>
          <p className="p19-provenance-line">
            引用知识卡 {brief.knowledge_citation_ids.length} 张 · 引用证据 {citedEvidenceCount} 条
            {brief.analysis_provenance ? ` · 绑定媒体 ${brief.analysis_provenance.media_count} 项（${boundedText(brief.analysis_provenance.model, 40)}）` : ''}
          </p>
          {brief.multimodal_findings && brief.multimodal_findings.length > 0 && (
            <div className="p19-findings">
              <b>系统结论（来自绑定保存的多模态分析）：</b>
              <ul className="p19-comment-list">
                {brief.multimodal_findings.map((item, index) => <li key={index}>{boundedText(item, 220)}</li>)}
              </ul>
            </div>
          )}
          {brief.p32_synthesis && (
            <div className="p32-synthesis-brief-summary" aria-label="多帖综合洞察摘要">
              <b>多帖综合洞察摘要（精确选中 {brief.p32_synthesis.selected_evidence_ids.length} 条证据，不调用模型）：</b>
              {P32_SYNTHESIS_SECTION_META.map((meta) => (
                <div className="p32-synthesis-brief-item" key={meta.key}>
                  <span className="p32-synthesis-brief-label">{meta.label}：</span>
                  <span className="p32-synthesis-brief-text">
                    {(brief.p32_synthesis.summary[meta.key] || []).map((item) => boundedText(item, 140)).join(' · ') || '—'}
                  </span>
                </div>
              ))}
              <p className="p32-synthesis-brief-meta">
                综合 identity：{brief.p32_synthesis.synthesis_id}
                {' · '}指纹 {String(brief.p32_synthesis.fingerprint).slice(0, 12)}…
                {' · '}引用知识卡（精确选中范围，未选中卡绝不混入）：{(brief.knowledge_citation_ids || []).map((cardId) => cardId.slice(0, 16)).join('、')}
              </p>
            </div>
          )}
          <p className="p19-meta-line">
            批准本草案后即可派生 P5 交接包；本页不会生成内容、选择工作流、路由、创建任务或发布，四项执行标志恒为 false。
          </p>
          {stale && (
            <p className="p19-blocking-note">
              ⛔ 草案已过时：{workflow.brief_stale_reasons.join('；')}。请「重新生成草案」后再确认。
            </p>
          )}
          {decision ? (
            <p className="p19-provenance-line">
              决定：<b>{decision.value === 'approved' ? '批准' : '退回修改'}</b>（来源 {decision.source}）· {decision.decided_at} · 理由：{boundedText(decision.rationale, 100)}
            </p>
          ) : (
            <p className="p19-meta-line">尚无确认决定。批准前必须确保草案未过时。</p>
          )}
          {(brief.review.comments || []).length > 0 && (
            <ul className="p19-comment-list">
              {brief.review.comments.map((item, index) => <li key={index}>「{boundedText(item, 120)}」</li>)}
            </ul>
          )}
          <div className="p19-brief-actions">
            <button className="p19-btn p19-btn-primary" type="button" disabled={busy} onClick={onAssemble} title="上游内容变化后必须重新生成草案才能重新确认">
              重新生成草案（第 {brief.version + 1} 版）
            </button>
            <label className="p19-field p19-inline-field">
              <span>确认意见（必填，≤500 字）</span>
              <textarea rows={2} value={rationale} maxLength={500} onChange={(event) => setRationale(event.target.value)} disabled={!canReview} />
            </label>
            <div className="p19-review-actions">
              <button
                className="p19-btn p19-btn-approve"
                type="button"
                disabled={busy || !canSubmitReview}
                title={!canReview ? (stale ? '草案已过时，先重新生成' : approved ? '本版已批准' : '先生成草案') : !rationale.trim() ? '请先填写确认意见' : '批准（approved + local_manual）后才可派生交接包'}
                onClick={() => decide('approved')}
              >
                批准草案
              </button>
              <button
                className="p19-btn p19-btn-return"
                type="button"
                disabled={busy || !canSubmitReview}
                title={!canReview ? (stale ? '草案已过时，先重新生成' : approved ? '本版已批准' : '先生成草案') : '退回修改（return_for_revision）'}
                onClick={() => decide('return_for_revision')}
              >
                退回修改
              </button>
            </div>
            <label className="p19-field p19-inline-field">
              <span>评论（可选，≤1000 字，随决定一起记录）</span>
              <textarea rows={2} value={comment} maxLength={1000} onChange={(event) => setComment(event.target.value)} disabled={busy || returned || approved} />
            </label>
          </div>
          <details className="p19-details">
            <summary>查看技术细节（id / 版本 / 来源绑定）</summary>
            <pre className="p19-pre">{JSON.stringify({
              brief_id: brief.id,
              brief_version: brief.version,
              schema_version: brief.schema_version,
              review_schema_version: brief.review.schema_version,
              knowledge_citation_ids: brief.knowledge_citation_ids,
              analysis_provenance: brief.analysis_provenance,
              evidence_provenance_fingerprint: brief.evidence_provenance_fingerprint,
              project_fingerprint: brief.project_fingerprint,
            }, null, 2)}</pre>
          </details>
          <p className="p19-provenance-line">{onlineMode ? '确认决定会保存到当前 staging 账号的工作区（local_manual 表示由人工作出决定，不是模型自动批准）。' : '确认决定与评论只记录在本浏览器（local_manual）；退回后请修改内容并重新生成草案。'}</p>
        </>
      )}
    </div>
  );
}

export function P19HandoffSection({ project, workflow, onDerive, onDownload, busy }) {
  const handoff = project.handoff || null;
  const stale = Boolean(workflow && workflow.handoff_stale);
  const canDerive = Boolean(workflow && workflow.brief_approved && !workflow.brief_stale && !handoff);
  const reason = !workflow ? '未计算' : workflow.brief_approved ? (workflow.brief_stale ? 'Brief 已过时：' + (workflow.brief_stale_reasons[0] || '') : handoff ? '当前版本交接包已存在' : '') : '当前 Brief 修订尚未被人工批准';
  return (
    <div className="p19-panel">
      <div className="p19-panel-head">
        <h3>P5 交接包（ams_external_handoff_package_v1）</h3>
        <span className="p19-panel-note">仅本地人工批准后的当前 Brief 修订可派生</span>
      </div>
      {!handoff ? (
        <>
          <p className="p19-empty-note">还没有交接包。批准 Brief 且未过时时可派生；派生即不可修改，仅可随 Brief 重建作废。</p>
          <div className="p19-form-actions">
            <button className="p19-btn p19-btn-primary" type="button" disabled={busy || !canDerive} title={canDerive ? '派生精确 P5 交接包（四项执行标志恒 false）' : `不可派生：${reason}`} onClick={onDerive}>
              派生 P5 交接包
            </button>
          </div>
          {!canDerive && reason && <p className="p19-blocking-note">⛔ 阻塞原因：{reason}</p>}
        </>
      ) : (
        <>
          <p className="p19-provenance-line">
            <strong>{handoff.id}</strong> · v{handoff.version} · {handoff.status}
          </p>
          <p className="p19-provenance-line">
            绑定 Brief {handoff.brief_provenance.brief_id} 第 {handoff.brief_provenance.brief_version} 版（{handoff.brief_provenance.brief_status}）· 决定 {handoff.human_decision.source} @ {handoff.human_decision.decided_at}
          </p>
          <p className="p19-provenance-line">知识引用 {handoff.knowledge_citations.length} 条 · 来源轨迹 {handoff.source_trace.origin} / {handoff.source_trace.created_from}</p>
          {stale && <p className="p19-blocking-note">⛔ 交接包已过时：{workflow.handoff_stale_reasons.join('；')}</p>}
          <div className="p19-form-actions">
            <button className="p19-btn p19-btn-ghost" type="button" disabled={busy} onClick={onDownload} title="下载本项目的本地备份 JSON（仅本地备份，不发布）">
              下载交接包 JSON（本地备份）
            </button>
          </div>
          <details className="p19-details">
            <summary>查看完整交接包载荷</summary>
            <pre className="p19-pre">{JSON.stringify(handoff, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  );
}

export function P19LineageSection({ row, graph, projects }) {
  if (!row) return null;
  const info = STATE_TEXT[row.state] || STATE_TEXT.PARTIAL;
  const nodesByType = new Map();
  (graph && graph.nodes || []).forEach((node) => {
    const list = nodesByType.get(node.type) || [];
    list.push(node);
    nodesByType.set(node.type, list);
  });
  return (
    <div className="p19-panel">
      <div className="p19-panel-head">
        <h3>世系审计（P16 状态模型）</h3>
        <span className="p19-panel-note">INVALID_SOURCE &gt; BROKEN &gt; PARTIAL &gt; COMPLETE</span>
      </div>
      <div className="p19-lineage-row">
        <P19Pill label={`${info.icon} ${info.label}`} tone={info.tone} />
        <span className="p19-meta-line">项目 {boundedText(row.project_id, 24)} · 最深步骤 {row.deepest_step}/7 · 审计 {row.evaluated_at}</span>
      </div>
      {row.reasons.length > 0 && (
        <ul className="p19-comment-list">
          {row.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
        </ul>
      )}
      {graph && (
        <div className="p19-graph">
          {(['research_project', 'evidence_record', 'deterministic_analysis', 'knowledge_card', 'content_brief', 'review_decision', 'handoff_package']).map((type) => {
            const nodes = nodesByType.get(type) || [];
            if (nodes.length === 0) return null;
            return (
              <div className="p19-graph-row" key={type}>
                <span className="p19-graph-type">{type}</span>
                <span className="p19-graph-nodes">
                  {nodes.map((node) => (
                    <span className={`p19-graph-node p19-node-${node.source_state}`} key={node.id} title={node.reason || node.id}>
                      {boundedText(node.id, 22)}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="p19-provenance-line">共 {projects ? projects.length : 0} 个项目参与审计（行上限 100、原因上限 8，全部为有界固定文案）。</p>
    </div>
  );
}

// ---- P32-A 多帖证据库与版本化重新分析 -------------------------------------------

function formatPublishedShort(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return '';
  return text.slice(0, 16).replace('T', ' ');
}

function engagementSummary(engagement) {
  if (!engagement || typeof engagement !== 'object') return null;
  const parts = [];
  for (const [key, label] of [['likes', '赞'], ['retweets', '转'], ['replies', '评']]) {
    if (Number.isInteger(engagement[key])) parts.push(`${label}${engagement[key]}`);
  }
  if (Number.isInteger(engagement.reddit_score)) parts.push(`Score ${engagement.reddit_score}`);
  if (Number.isInteger(engagement.reddit_comments)) parts.push(`评论 ${engagement.reddit_comments}`);
  if (Number.isFinite(engagement.reddit_upvote_ratio)) parts.push(`赞成率 ${(engagement.reddit_upvote_ratio * 100).toFixed(1)}%`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * P32-A 同一项目多帖证据库：显示所有已保存证据（含作者/时间/媒体数/互动/
 * Evidence ID/分析状态/版本计数/Knowledge/Brief 链接状态），并提供
 * 「用 Qwen 重新分析」操作与版本历史查看。
 */
export function P32EvidenceLibrary({ project, onReanalyze, onMakeCard, busy }) {
  const evidence = project.evidence || [];
  const [historyEvidenceId, setHistoryEvidenceId] = useState(null);

  if (evidence.length === 0) {
    return (
      <div className="p19-panel p32-library">
        <div className="p19-panel-head">
          <h3>证据库（已保存）</h3>
          <span className="p19-panel-note">尚无已保存证据</span>
        </div>
        <p className="p19-empty-note">保存来自「智能找资料」的帖子后，可从证据库中进行 Qwen 重新分析和多帖比较。</p>
      </div>
    );
  }

  return (
    <div className="p19-panel p32-library" aria-label="证据库">
      <div className="p19-panel-head">
        <h3>证据库（已保存 {evidence.length} 条）</h3>
        <span className="p19-panel-note">来源/分析状态/版本 — 可重新分析、比较</span>
      </div>
      <ul className="p32-evidence-cards">
        {evidence.map((record) => {
          const latestAnalysis = getLatestAnalysisForEvidence(project, record.id);
          const allVersions = getAllAnalysisVersionsForEvidence(project, record.id);
          const modelAnalysis = latestAnalysis && latestAnalysis.model_analysis;
          const isV2 = modelAnalysis && modelAnalysis.schema_version === 'p32_multimodal_model_v2';
          const hasQwenAnalysis = Boolean(modelAnalysis);
          const isDeterministic = latestAnalysis && !modelAnalysis;
          const card = latestAnalysis && (project.knowledge_cards || []).find((c) => c.analysis_id === latestAnalysis.id);
          const briefLinked = card && project.brief && (project.brief.knowledge_citation_ids || []).includes(card.id);
          const sourceMeta = record.source_metadata || {};
          const author = sourceMeta.author || {};
          const hasMedia = Array.isArray(record.media_assets) && record.media_assets.length > 0;
          const canReanalyze = record.provenance?.manual === false;

          return (
            <li className="p32-evidence-card" key={record.id}>
              <div className="p32-evidence-card-top">
                <div className="p32-evidence-card-id">
                  <strong>{boundedText(record.label, 60)}</strong>
                  <span className="p32-evidence-id" title={record.id}>ID: {record.id.slice(0, 16)}…</span>
                </div>
                <div className="p32-evidence-card-badges">
                  {record.provenance?.manual === false
                    ? <span className="p32-badge p32-badge-source">P22 采集</span>
                    : <span className="p32-badge p32-badge-manual">手工录入</span>}
                  {hasQwenAnalysis
                    ? <span className={`p32-badge ${isV2 ? 'p32-badge-v2' : 'p32-badge-v1'}`} title={`模型 ${modelAnalysis.model} · ${modelAnalysis.executed_at}`}>Qwen {isV2 ? 'v2' : 'v1'}</span>
                    : isDeterministic
                      ? <span className="p32-badge p32-badge-det">确定性分析</span>
                      : <span className="p32-badge p32-badge-none">未分析</span>}
                  {allVersions.length > 1 && <span className="p32-badge p32-badge-versions">{allVersions.length} 个版本</span>}
                </div>
              </div>
              <div className="p32-evidence-card-meta">
                {author.name && <span>作者：{boundedText(author.name, 30)}</span>}
                {author.handle && <span>@{boundedText(author.handle, 20)}</span>}
                {sourceMeta.published_at && <span>发布时间：{formatPublishedShort(sourceMeta.published_at)}</span>}
                {sourceMeta.community && <span>社区：r/{boundedText(sourceMeta.community, 32)}</span>}
                {hasMedia && <span>媒体 {record.media_assets.length} 项</span>}
              </div>
              {sourceMeta.engagement && (
                <div className="p32-evidence-card-engagement">
                  互动：{engagementSummary(sourceMeta.engagement) || '—'}
                </div>
              )}
              <p className="p19-meta-line">
                {boundedText(record.source_url, 60)}
              </p>
              {modelAnalysis && (
                <div className="p32-analysis-quick">
                  <span className="p32-analysis-model">{boundedText(modelAnalysis.model, 30)} · v{latestAnalysis.version}</span>
                  <span className="p32-analysis-summary">{boundedText(modelAnalysis.result.text_expression || '', 120)}</span>
                </div>
              )}
              <div className="p32-evidence-card-actions">
                {canReanalyze && (
                  <button
                    className="p19-btn p19-btn-primary"
                    type="button"
                    disabled={busy}
                    onClick={() => onReanalyze(record.id)}
                    title="使用当前 Qwen 多模态模型重新分析此证据（追加新版本，不覆写旧分析）"
                  >
                    用 Qwen 重新分析
                  </button>
                )}
                {latestAnalysis && !card && (
                  <button
                    className="p19-btn p19-btn-ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => onMakeCard(latestAnalysis.id)}
                    title="将最新分析转为知识卡"
                  >
                    生成知识卡
                  </button>
                )}
                {card && (
                  <span className={`p32-linkage ${briefLinked ? 'linked' : ''}`}>
                    知识卡{briefLinked ? ' ✓ 已入草案' : ' 已生成'}
                  </span>
                )}
                {allVersions.length > 1 && (
                  <button
                    className="p19-btn p19-btn-ghost"
                    type="button"
                    onClick={() => setHistoryEvidenceId(historyEvidenceId === record.id ? null : record.id)}
                  >
                    {historyEvidenceId === record.id ? '收起版本历史' : `查看 ${allVersions.length} 个版本`}
                  </button>
                )}
              </div>
              {historyEvidenceId === record.id && allVersions.length > 1 && (
                <P32AnalysisHistory versions={allVersions} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * P32-A 分析版本历史：按时间倒序显示该证据的所有分析版本，
 * 每个版本显示模型/时间/文本摘要/逐媒体发现。旧版本只读，不可修改。
 */
function P32AnalysisHistory({ versions }) {
  return (
    <div className="p32-history" aria-label="分析版本历史">
      <h4>分析版本历史</h4>
      {versions.map((analysis) => {
        const ext = analysis.model_analysis;
        if (!ext) {
          return (
            <div className="p32-history-item" key={analysis.id}>
              <div className="p32-history-head">
                <span className="p32-history-version">v{analysis.version}</span>
                <span className="p32-history-kind">确定性本地分析（无模型）</span>
                <span className="p32-history-time">{analysis.provenance.executed_at}</span>
              </div>
            </div>
          );
        }
        const isV2 = ext.schema_version === 'p32_multimodal_model_v2';
        return (
          <div className="p32-history-item" key={analysis.id}>
            <div className="p32-history-head">
              <span className="p32-history-version">v{analysis.version}</span>
              <span className="p32-history-kind">{boundedText(ext.model, 30)} {isV2 ? '(v2)' : '(v1)'}</span>
              <span className="p32-history-time">{ext.executed_at}</span>
            </div>
            <p className="p32-history-text">{boundedText(ext.result.text_expression || '', 200)}</p>
            {isV2 && ext.result.hook && (
              <p className="p32-history-detail">钩子：{boundedText(ext.result.hook, 160)}</p>
            )}
            {isV2 && ext.result.target_audience && (
              <p className="p32-history-detail">受众：{boundedText(ext.result.target_audience, 100)}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * P32-A 多选比较：允许选择 2-5 条已保存证据，进行确定性逐条比较。
 * 选择在项目切换时重置；不跨项目污染。
 *
 * P32-C：面板底部新增「生成综合知识与待审核 Brief」主按钮与确定性综合洞察
 * 预览（不调用模型、无额外费用、不自动批准/交接/发布）；选择每次渲染都
 * 重新严格验证（缺失/过时/跨项目/重复/错绑时给出原位置可操作提示）。
 */
export function P32ComparisonView({ project, selectedIds, onSelectionChange, onSynthesize, busy, outcome }) {
  const evidence = project.evidence || [];
  const hasAnalyzable = evidence.some((record) => {
    const latest = getLatestAnalysisForEvidence(project, record.id);
    return latest && latest.model_analysis;
  });

  const toggleSelect = useCallback((evidenceId) => {
    const next = selectedIds.includes(evidenceId)
      ? selectedIds.filter((id) => id !== evidenceId)
      : [...selectedIds, evidenceId];
    if (next.length > 5) return; // 最多 5 条
    onSelectionChange(next);
  }, [selectedIds, onSelectionChange]);

  const comparison = useMemo(() => {
    if (selectedIds.length < 2) return null;
    return generateEvidenceComparison(project, selectedIds);
  }, [project, selectedIds]);

  // P32-C：精确选择前置校验（每次渲染重算：证据变化/项目切换/刷新后绝不沿用旧结论）。
  const synthesisVerdict = useMemo(
    () => validateSynthesisSelection(project, selectedIds),
    [project, selectedIds],
  );
  const synthesisPreview = useMemo(() => {
    if (!synthesisVerdict.valid) return null;
    try {
      return generateSynthesisInsight(project, selectedIds);
    } catch {
      return null;
    }
  }, [project, selectedIds, synthesisVerdict.valid]);

  return (
    <div className="p19-panel p32-compare" aria-label="多帖比较">
      <div className="p19-panel-head">
        <h3>多帖比较（选择 2–5 条已保存证据）</h3>
        <span className="p19-panel-note">已选 {selectedIds.length} / 5</span>
      </div>
      {evidence.length === 0 && (
        <p className="p19-empty-note">还没有已保存证据。在「智能找资料」中保存帖子后即可比较。</p>
      )}
      {evidence.length > 0 && !hasAnalyzable && (
        <p className="p19-empty-note">已保存证据中尚无 Qwen 多模态分析结果。请先保存带媒体的来源或对已有证据运行「用 Qwen 重新分析」。</p>
      )}

      {/* 选择网格 */}
      <div className="p32-compare-select-grid">
        {evidence.map((record) => {
          const latest = getLatestAnalysisForEvidence(project, record.id);
          const hasAnalysis = Boolean(latest && latest.model_analysis);
          const analysisStale = Boolean(hasAnalysis && (latest.evidence_fingerprint !== record.fingerprint || latest.evidence_version !== record.version));
          const isSelected = selectedIds.includes(record.id);
          const sourceMeta = record.source_metadata || {};
          const author = sourceMeta.author || {};
          return (
            <label
              className={`p32-compare-chip ${isSelected ? 'selected' : ''} ${!hasAnalysis || analysisStale ? 'no-analysis' : ''}`}
              key={record.id}
              title={!hasAnalysis ? '该证据缺少多模态分析，比较/综合时将显示缺失警告' : analysisStale ? '该证据的分析已过时：请先在证据库点击「用 Qwen 重新分析」' : `选择此证据进行多帖比较`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleSelect(record.id)}
                disabled={(analysisStale || !hasAnalysis) && selectedIds.length >= 5 && !isSelected}
                aria-label={`选择 ${boundedText(record.label, 40)} 进行比较`}
              />
              <span className="p32-chip-label">
                <strong>{boundedText(record.label, 30)}</strong>
                <small>
                  {author.name || author.handle || '未知作者'}
                  {sourceMeta.published_at ? ` · ${formatPublishedShort(sourceMeta.published_at)}` : ''}
                </small>
                {!hasAnalysis && <small className="p32-chip-warn">无多模态分析：先点「用 Qwen 重新分析」</small>}
                {hasAnalysis && analysisStale && <small className="p32-chip-warn">分析已过时：先点「用 Qwen 重新分析」</small>}
              </span>
            </label>
          );
        })}
      </div>

      {selectedIds.length > 0 && selectedIds.length < 2 && (
        <p className="p19-meta-line">请至少再选择 1 条证据以开始比较（共需 2–5 条）。</p>
      )}

      {/* 比较结果 */}
      {comparison && comparison.valid && (
        <div className="p32-compare-results">
          <div className="p32-compare-summary">
            <h4>确定性比较摘要（派生自 {comparison.rows.length} 条选定记录，不调用模型）</h4>
            {comparison.summary.warnings.length > 0 && (
              <p className="p19-blocking-note">
                ⚠ 警告：{comparison.summary.warnings.join('；')}
              </p>
            )}
            <div className="p32-summary-grid">
              {comparison.summary.commonDrivers.length > 0 && (
                <div className="p32-summary-item">
                  <b>共同传播驱动力：</b>
                  <span>{comparison.summary.commonDrivers.join(' · ')}</span>
                </div>
              )}
              {comparison.summary.commonRisks.length > 0 && (
                <div className="p32-summary-item">
                  <b>共同风险点：</b>
                  <span>{comparison.summary.commonRisks.join(' · ')}</span>
                </div>
              )}
              {comparison.summary.highestEngagementSignal && (
                <div className="p32-summary-item">
                  <b>最高互动信号：</b>
                  <span>{boundedText(comparison.summary.highestEngagementSignal.hook, 80)}（互动总计 {comparison.summary.highestEngagementSignal.total}）</span>
                </div>
              )}
              {comparison.summary.diverseHooks.length >= 2 && (
                <div className="p32-summary-item">
                  <b>差异化钩子：</b>
                  <span>{comparison.summary.diverseHooks.map((h) => boundedText(h, 60)).join(' ‖ ')}</span>
                </div>
              )}
            </div>
          </div>

          <div className="p32-compare-columns">
            {comparison.rows.map((row) => (
              <div className={`p32-compare-column ${row.analysisMissing ? 'missing' : ''}`} key={row.evidenceId}>
                <div className="p32-compare-col-head">
                  <strong>{boundedText(row.evidence.label, 40)}</strong>
                  {row.analysisMissing
                    ? <span className="p32-pill-warn">分析缺失</span>
                    : <span className="p32-pill-ok">{row.schemaVersion === 'p32_multimodal_model_v2' ? 'Qwen v2' : 'Qwen v1'} · v{row.analysisVersion}</span>}
                </div>
                {!row.analysisMissing && (
                  <>
                    <div className="p32-compare-field">
                      <b>钩子：</b>
                      <p>{boundedText(row.hook, 160)}</p>
                    </div>
                    {row.audience && (
                      <div className="p32-compare-field">
                        <b>受众：</b>
                        <p>{boundedText(row.audience, 100)}</p>
                      </div>
                    )}
                    <div className="p32-compare-field">
                      <b>视觉模式：</b>
                      <p>{boundedText(row.visualPattern, 140)}</p>
                    </div>
                    <div className="p32-compare-field">
                      <b>传播驱动力：</b>
                      <ul className="p32-compare-list">
                        {row.propagationDrivers.map((d, i) => <li key={i}>{boundedText(d, 120)}</li>)}
                      </ul>
                    </div>
                    <div className="p32-compare-field">
                      <b>可复用公式：</b>
                      <ul className="p32-compare-list">
                        {row.reusableFormula.slice(0, 3).map((f, i) => <li key={i}>{boundedText(f, 120)}</li>)}
                      </ul>
                    </div>
                    <div className="p32-compare-field">
                      <b>风险：</b>
                      <ul className="p32-compare-list">
                        {row.risks.map((r, i) => <li key={i}>{boundedText(r, 120)}</li>)}
                      </ul>
                    </div>
                    <p className="p19-meta-line">共 {row.totalVersions} 个分析版本</p>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {comparison && !comparison.valid && (
        <p className="p19-blocking-note">{comparison.reason}</p>
      )}

      {/* P32-C 综合知识与待审核 Brief 入口（确定性派生，绝不调用模型） */}
      <div className="p32-synthesis-zone" aria-label="多帖综合洞察与待审核 Brief">
        <div className="p32-synthesis-actions">
          <button
            className="p19-btn p19-btn-primary"
            type="button"
            disabled={Boolean(busy) || selectedIds.length < 2 || !synthesisVerdict.valid}
            title={selectedIds.length < 2
              ? '请先选择 2–5 条已保存证据'
              : !synthesisVerdict.valid
                ? synthesisVerdict.reason
                : '从每条最新有效 Qwen 分析确定性派生综合洞察，并为本次选择生成/复用知识卡、组装新的待审核 Brief'}
            onClick={onSynthesize}
          >
            {busy ? '综合生成中…' : '生成综合知识与待审核 Brief'}
          </button>
          <span className="p32-synthesis-note">
            使用已保存分析 · 无额外模型费用 · 不会自动批准 / 不生成交接包 / 不发布
          </span>
        </div>
        {selectedIds.length >= 2 && !synthesisVerdict.valid && (
          <>
            <p className="p19-blocking-note">⛔ {synthesisVerdict.reason}</p>
            {synthesisVerdict.issues.length > 0 && (
              <ul className="p32-synthesis-issues">
                {synthesisVerdict.issues.map((issueText, index) => <li key={index}>{issueText}</li>)}
              </ul>
            )}
          </>
        )}
        {outcome && (
          <p className="p32-synthesis-outcome" role="status">
            综合完成：选中 {outcome.selected} 条 · 知识卡复用 {outcome.reused} / 新建或重建 {outcome.created}
            {' · '}Brief 第 {outcome.briefVersion} 版（{outcome.briefStatus === 'pending_review' ? '待人工审核 pending' : outcome.briefStatus}）
            {' · '}无模型调用、无额外费用
          </p>
        )}
        {synthesisPreview && (
          <P32SynthesisPreview project={project} synthesis={synthesisPreview} />
        )}
      </div>
    </div>
  );
}

/** 有界计数展示：缺失指标显示「—」，绝不伪造为 0。 */
function formatSynthesisCount(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function formatSynthesisRate(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(2)}%`;
}

const P32_SYNTHESIS_SECTION_META = [
  { key: 'common_topics', label: '共同主题' },
  { key: 'high_performance_structures', label: '高表现内容结构 / 钩子' },
  { key: 'visual_styles', label: '图片或视频风格' },
  { key: 'audience_sentiment', label: '受众情绪与传播驱动' },
  { key: 'reusable_formula', label: '可复用内容公式' },
  { key: 'risks_do_not_copy', label: '风险与不应复制的部分' },
];

/**
 * P32-C 综合洞察预览：确定性派生（不调用模型），展示六项洞察、真实指标
 * 依据（缺失显示「—」）与 Evidence → Analysis 版本 → 知识卡 → Brief 的
 * 精确来源链。
 */
function P32SynthesisPreview({ project, synthesis }) {
  const cards = project.knowledge_cards || [];
  const brief = project.brief || null;
  const evidenceById = new Map((project.evidence || []).map((item) => [item.id, item]));
  const chainRows = (synthesis.source_snapshot || []).map((snap) => {
    const evidence = evidenceById.get(snap.evidence_id) || null;
    const card = cards.find((item) => item.analysis_id === snap.analysis_id
      && item.analysis_fingerprint === snap.analysis_fingerprint
      && item.analysis_version === snap.analysis_version) || null;
    const briefLinked = Boolean(card && brief && (brief.knowledge_citation_ids || []).includes(card.id));
    return { snap, evidence, card, briefLinked };
  });
  const briefBound = Boolean(brief && brief.p32_synthesis && brief.p32_synthesis.synthesis_id === synthesis.id);
  return (
    <div className="p32-synthesis-preview">
      <div className="p32-synthesis-preview-head">
        <h4>多帖综合洞察预览（派生自 {synthesis.selected_evidence_ids.length} 条选定记录的最新有效 Qwen 分析，不调用模型）</h4>
        <span className="p32-synthesis-id" title={synthesis.id}>综合 ID：{synthesis.id.slice(0, 16)}… · 指纹 {synthesis.fingerprint.slice(0, 12)}…</span>
      </div>
      <div className="p32-synthesis-sections">
        {P32_SYNTHESIS_SECTION_META.map((meta) => (
          <div className="p32-synthesis-section" key={meta.key}>
            <b>{meta.label}：</b>
            <ul className="p32-synthesis-list">
              {(synthesis.sections[meta.key] || []).map((item, index) => <li key={index}>{boundedText(item, 200)}</li>)}
            </ul>
          </div>
        ))}
      </div>
      <div className="p32-synthesis-metrics" aria-label="真实互动指标依据">
        <b>高表现判断的真实指标依据（缺失显示「—」，绝不伪造为 0）：</b>
        <div className="p32-synthesis-metrics-table">
          <div className="p32-synthesis-metrics-row p32-synthesis-metrics-head">
            <span>证据</span>
            {['浏览', '点赞', '转发', '回复', '引用', '收藏', '总互动', '互动率'].map((label) => <span key={label}>{label}</span>)}
          </div>
          {(synthesis.engagement_basis || []).map((basis) => (
            <div className="p32-synthesis-metrics-row" key={basis.evidence_id}>
              <span title={basis.evidence_id}>{boundedText(basis.evidence_label, 24)}</span>
              <span>{formatSynthesisCount(basis.views)}</span>
              <span>{formatSynthesisCount(basis.likes)}</span>
              <span>{formatSynthesisCount(basis.retweets)}</span>
              <span>{formatSynthesisCount(basis.replies)}</span>
              <span>{formatSynthesisCount(basis.quotes)}</span>
              <span>{formatSynthesisCount(basis.bookmarks)}</span>
              <span>{formatSynthesisCount(basis.total_engagement)}</span>
              <span>{formatSynthesisRate(basis.engagement_rate)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="p32-synthesis-chain" aria-label="精确来源链">
        <b>精确来源链（Evidence → 分析版本 → 知识卡 → Brief）：</b>
        <ol className="p32-synthesis-chain-list">
          {chainRows.map((row) => (
            <li key={row.snap.evidence_id}>
              证据 {row.snap.evidence_id.slice(0, 16)}…
              （{boundedText(row.evidence?.label || '已不在项目', 28)}）
              → 分析 {row.snap.analysis_id.slice(0, 16)}… v{row.snap.analysis_version}（{row.snap.model_schema_version}）
              → 知识卡 {row.card ? `${row.card.id.slice(0, 16)}…` : '待生成（点击上方主按钮）'}
              → Brief {row.briefLinked ? '已引用 ✓' : briefBound ? '综合已入草案' : '未入草案'}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ---- P32-B 热门主题搜索：批量关键词搜索 → 指标排序 → 勾选 1–5 条导入当前项目 ----

const P32_SEARCH_COUNT_OPTIONS = [5, 10, 15, 20];

function formatSearchCount(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function formatSearchRate(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(2)}%`;
}

function formatPublishedShortUtc(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return '时间未知';
  return `${text.slice(0, 16).replace('T', ' ')} UTC`;
}

function SearchMediaPreview({ assets }) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  return (
    <div className="p32-search-media" data-media-count={assets.length}>
      {assets.slice(0, 3).map((asset) => {
        const isVideo = asset.kind === 'video' || String(asset.mime_type || '').startsWith('video/');
        return isVideo
          ? <video key={asset.id} src={asset.media_url} controls preload="metadata" data-media-order={asset.order} aria-label={`媒体 ${asset.order + 1}`} />
          : <img key={asset.id} src={asset.media_url} alt={`媒体 ${asset.order + 1}`} loading="lazy" data-media-order={asset.order} />;
      })}
      {assets.length > 3 && <span className="p32-search-media-more">+{assets.length - 3} 项媒体</span>}
    </div>
  );
}

/**
 * P32-B 热门主题搜索面板（与「智能找资料」的单帖 URL 读取清楚区分）：
 * - 输入关键词批量搜索 X 公共帖子（默认 10、最多 20 条，服务端构造 Actor 输入）；
 * - 五种确定性排序（views/likes/retweets/total_engagement/engagement_rate），
 *   缺失指标显示「—」绝不伪造为 0，排序口径明确说明不是 X 官方热门榜；
 * - 勾选 1–5 条一次导入当前项目 Evidence；已导入来源明确标记并禁止重复导入；
 * - 搜索批次状态由页面持有：切换项目、重新搜索或刷新后旧选择立即失效。
 */
export function P32HotTopicSearchPanel({
  project,
  busy,
  client,
  searchState,
  onSearchStateChange,
  onImport,
  importError,
}) {
  const [keyword, setKeyword] = useState('');
  const [platform, setPlatform] = useState('x');
  const [subreddit, setSubreddit] = useState('');
  const [redditSort, setRedditSort] = useState('relevance');
  const [timeFilter, setTimeFilter] = useState('all');
  const [count, setCount] = useState(P32_SEARCH_COUNT_DEFAULT);
  const [sortKey, setSortKey] = useState('views');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const batch = searchState?.batch || null;
  const selectedIds = Array.isArray(searchState?.selectedIds) ? searchState.selectedIds : [];
  const isReddit = (batch?.platform || platform) === 'reddit';
  const displaySortKeys = isReddit ? P32_REDDIT_SORT_KEYS : P32_SEARCH_SORT_KEYS;
  const displaySortLabels = isReddit ? P32_REDDIT_SORT_LABELS : P32_SEARCH_SORT_LABELS;
  const effectiveSortKey = displaySortKeys.includes(sortKey) ? sortKey : displaySortKeys[0];
  const results = batch
    ? (isReddit ? rankRedditSearchResults(batch.items || [], effectiveSortKey) : rankSearchResults(batch.items || [], effectiveSortKey))
    : [];
  const selectedCount = selectedIds.length;
  // 页面级 P32 导入错误镜像：项目版本变化会确定性重挂载本面板（清空本地
  // error 状态），因此在线部分失败的结构化错误必须由页面持有并在此镜像，
  // 保证「已确认 N 条成功 / 剩余 M 条」在重挂载后仍精确可见。
  const mirroredImportError = importError && typeof importError === 'object'
    && String(importError.code || '').startsWith('P32_')
    ? importError
    : null;

  const runSearch = async () => {
    const cleanKeyword = keyword.trim();
    // 每次实际触发搜索都先让旧批次与选择失效；任何本地校验或上游失败都不得
    // 继续显示、选择或导入旧结果。空关键词时按钮本身禁用，Enter 仍安全清空。
    onSearchStateChange(null);
    if (!cleanKeyword) {
      setError('请输入搜索关键词。');
      return;
    }
    if (looksLikePublicUrl(cleanKeyword)) {
      setError('热门主题搜索不接受链接作为关键词；读取单帖请使用「智能找资料」面板的链接模式。');
      return;
    }
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const response = platform === 'reddit'
        ? await client.searchReddit(cleanKeyword, { count, sort: redditSort, subreddit: subreddit.trim() || null, timeFilter })
        : await client.search(cleanKeyword, count, 'latest');
      const items = Array.isArray(response.items) ? response.items : [];
      if (!response.search_batch_id || !items.length) {
        throw new Error('搜索未返回可导入的结果（无来源证明）。');
      }
      onSearchStateChange({
        batch: {
          batch_id: response.search_batch_id,
          project_id: project.id,
          platform: String(response.platform || platform),
          keyword: String(response.keyword || cleanKeyword),
          count: Number(response.count) || count,
          sort_intent: String(response.sort_intent || 'latest'),
          time_filter: response.time_filter || null,
          subreddit: response.subreddit || null,
          collected_at: String(response.collected_at || ''),
          cost: response.cost || null,
          items,
        },
        selectedIds: [],
      });
      const costText = response.cost
        ? `本次费用 ¥${response.cost.actual_cny ?? response.cost.recorded_cny ?? 0}（预留 ¥${response.cost.recorded_cny ?? 0}）`
        : '费用记录不可用';
      setMessage(`已找到 ${items.length} 条公开来源（最多 ${count} 条），尚未保存。${costText}。`);
    } catch (cause) {
      setError(String(cause?.message || cause));
    } finally {
      setWorking(false);
    }
  };

  const toggleSelect = (id, alreadyImported) => {
    if (alreadyImported) return;
    const next = selectedIds.includes(id)
      ? selectedIds.filter((selected) => selected !== id)
      : [...selectedIds, id];
    if (next.length > P32_BATCH_IMPORT_MAX) return; // 最多 5 条
    onSearchStateChange({ batch, selectedIds: next });
  };

  const importSelected = async () => {
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const outcome = await onImport(selectedIds);
      // 以页面返回的精确导入数为准（幂等重试时选择数可能大于新导入数）。
      if (outcome && outcome.ok) {
        const skipped = outcome.alreadyImported > 0 ? `（另有 ${outcome.alreadyImported} 条已导入，已跳过）` : '';
        setMessage(`已导入 ${outcome.imported} 条到当前项目${skipped}；结果保留「已导入」标记，可在证据库继续 Qwen 重新分析或多帖比较。`);
      }
    } catch (cause) {
      setError(String(cause?.message || cause));
    } finally {
      setWorking(false);
    }
  };

  const capabilitiesReady = Boolean(client && project && project.status === 'active');

  return (
    <div className="p32-search" aria-label="热门主题搜索">
      <div className="p32-search-head">
        <div>
          <span className="p22-kicker">P32-B/D · 跨平台热门主题搜索</span>
          <h4>热门主题搜索（批量导入当前项目）</h4>
        </div>
        <span className="p32-search-mode-note">与「智能找资料」的单帖 URL 读取区分：本面板按关键词批量搜索 X 或 Reddit</span>
      </div>
      <p className="p19-panel-note">
        输入关键词搜索 X 或 Reddit 公共帖子（默认 10、最多 20 条，来源带服务端证明）；按真实平台指标
        确定性排序后，勾选 1–5 条导入当前项目 Evidence（导入前整批验证，在线失败后权威重载并幂等续传，绝不谎报全成功）。
        不自动批准 Brief、不自动路由、不生成、不发布。
      </p>
      <div className="p32-search-query-row">
        <label className="p32-search-count">
          <span>平台</span>
          <select value={platform} onChange={(event) => { const value = event.target.value; setPlatform(value); setSortKey(value === 'reddit' ? 'reddit_score' : 'views'); onSearchStateChange(null); }} aria-label="搜索平台">
            <option value="x">X</option>
            <option value="reddit">Reddit</option>
          </select>
        </label>
        <input
          value={keyword}
          maxLength={120}
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') runSearch(); }}
          placeholder="输入研究关键词（例如：AI 营销 出海）"
          aria-label="热门主题搜索关键词"
        />
        <label className="p32-search-count">
          <span>条数</span>
          <select value={count} onChange={(event) => setCount(Number(event.target.value))} aria-label="搜索结果条数">
            {P32_SEARCH_COUNT_OPTIONS.map((option) => <option value={option} key={option}>{option}</option>)}
          </select>
        </label>
        {platform === 'reddit' && (
          <>
            <input value={subreddit} maxLength={32} onChange={(event) => setSubreddit(event.target.value.replace(/^r\//i, ''))} placeholder="subreddit（可选）" aria-label="限定 subreddit" />
            <label className="p32-search-count"><span>平台排序</span><select value={redditSort} onChange={(event) => setRedditSort(event.target.value)} aria-label="Reddit 平台排序"><option value="relevance">相关</option><option value="hot">热门</option><option value="new">最新</option><option value="top">高分</option><option value="comments">评论</option></select></label>
            <label className="p32-search-count"><span>时间</span><select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value)} aria-label="Reddit 时间范围"><option value="all">不限</option><option value="hour">一小时</option><option value="day">一天</option><option value="week">一周</option><option value="month">一月</option><option value="year">一年</option></select></label>
          </>
        )}
        <button className="p19-btn p19-btn-primary" type="button" disabled={busy || working || !capabilitiesReady || !keyword.trim()} onClick={runSearch}>
          {working ? '搜索中…' : '搜索公开帖子'}
        </button>
      </div>
      {error && <p className="p19-error-text" role="alert">{error}</p>}
      {!error && mirroredImportError && (
        <p className="p19-error-text" role="alert">{mirroredImportError.code}：{mirroredImportError.message}</p>
      )}
      {message && <p className="p22-message" role="status">{message}</p>}
      {batch && (
        <div className="p32-search-batch-line">
          批次 {batch.batch_id} · {batch.platform === 'reddit' ? `Reddit${batch.subreddit ? ` / r/${batch.subreddit}` : ''}` : 'X'} · 关键词「{boundedText(batch.keyword, 40)}」 · 采集 {formatPublishedShortUtc(batch.collected_at)}
          {batch.cost ? ` · 费用记录 ¥${batch.cost.actual_cny ?? batch.cost.recorded_cny ?? 0}（预留 ¥${batch.cost.recorded_cny ?? 0}）` : ''}
        </div>
      )}
      {results.length > 0 && (
        <div className="p32-search-results">
          <div className="p32-search-toolbar">
            <label className="p32-search-sort">
              <span>{isReddit ? '排序（使用真实 Reddit 快照指标）' : '排序（本地展示口径，不是 X 官方热门榜）'}</span>
              <select value={effectiveSortKey} onChange={(event) => setSortKey(event.target.value)} aria-label="结果排序方式">
                {displaySortKeys.map((key) => <option value={key} key={key}>{displaySortLabels[key]}</option>)}
              </select>
            </label>
            <span className="p32-search-selection">已选 {selectedCount} / {P32_BATCH_IMPORT_MAX}</span>
            <button
              className="p19-btn p19-btn-primary"
              type="button"
              disabled={busy || working || selectedCount < 1}
              title={selectedCount < 1 ? '请先勾选 1–5 条结果' : `导入所选 ${selectedCount} 条到当前项目`}
              onClick={importSelected}
            >
              导入所选到当前项目（{selectedCount}）
            </button>
          </div>
          <p className="p32-search-sort-note">
            {isReddit
              ? 'Reddit 排序是本地确定性展示口径，不是 Reddit 官方排行榜；score 是采集时刻的净得分快照，不是投票总数。总互动 = score + 评论数；互动速率使用 Actor 明确返回的赞成率，未返回时显示「—」，绝不伪造为 0。'
              : '排序口径：按所选真实指标降序；缺失指标排在可用指标之后（显示「—」，绝不伪造为 0）；主指标相同时按发布时间（较新在前）与完整来源身份稳定排序。总互动 = 点赞 + 转发 + 回复 + 引用 + 收藏；互动率 = 总互动 ÷ 浏览量（浏览量非正或总互动不可用时显示「—」）。'}
          </p>
          <ul className="p32-search-list">
            {results.map((item) => {
              const metrics = computeEngagementMetrics(item);
              const conflicting = findConflictingEvidence(project, item);
              const alreadyImported = Boolean(conflicting);
              const metadata = item.source_metadata || {};
              const author = metadata.author || {};
              const media = Array.isArray(item.media_assets) ? item.media_assets : [];
              const isSelected = selectedIds.includes(item.id);
              const engagementRaw = metadata.engagement || {};
              const rawCount = (key) => (Number.isInteger(engagementRaw[key]) ? engagementRaw[key] : null);
              const redditTotal = Number.isInteger(engagementRaw.reddit_score) && Number.isInteger(engagementRaw.reddit_comments)
                ? engagementRaw.reddit_score + engagementRaw.reddit_comments
                : null;
              const metricCells = isReddit ? [
                ['reddit_score', 'Score', Number.isInteger(engagementRaw.reddit_score) ? engagementRaw.reddit_score : null],
                ['reddit_comments', '评论', Number.isInteger(engagementRaw.reddit_comments) ? engagementRaw.reddit_comments : null],
                ['reddit_total_engagement', '总互动', redditTotal],
                ['reddit_interaction_rate', '互动速率', Number.isFinite(engagementRaw.reddit_upvote_ratio) ? engagementRaw.reddit_upvote_ratio : null],
              ] : [
                ['views', '浏览', metrics.views],
                ['likes', '点赞', metrics.likes],
                ['retweets', '转发', metrics.retweets],
                ['replies', '回复', rawCount('replies')],
                ['bookmarks', '收藏', rawCount('bookmarks')],
                ['total', '总互动', metrics.total_engagement],
                ['rate', '互动率', metrics.engagement_rate],
              ];
              return (
                <li className={`p32-search-card ${alreadyImported ? 'imported' : ''} ${isSelected ? 'selected' : ''}`} key={item.id}>
                  <div className="p32-search-card-head">
                    <label className="p32-search-select">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={alreadyImported || (selectedCount >= P32_BATCH_IMPORT_MAX && !isSelected)}
                        onChange={() => toggleSelect(item.id, alreadyImported)}
                        aria-label={`选择 ${boundedText(item.label, 40)} 导入当前项目`}
                      />
                      <span className="p32-search-check-label">{alreadyImported ? '已导入' : '选择'}</span>
                    </label>
                    <span className="p32-search-author">
                      {author.name || author.handle || '未知作者'}{author.handle ? ` @${boundedText(author.handle, 20)}` : ''}
                    </span>
                    <span className="p32-search-meta">{isReddit ? `Reddit${metadata.community ? ` · r/${metadata.community}` : ''}` : 'X'} · {formatPublishedShortUtc(metadata.published_at)}</span>
                    {alreadyImported && (
                      <span className="p32-search-imported" title={conflicting.id}>已导入 ✓</span>
                    )}
                  </div>
                  <div className="p32-search-label">
                    <span className="p32-search-text">{boundedText(item.label, 120)}</span>
                    <a href={item.source_url} target="_blank" rel="noreferrer">查看原始来源</a>
                  </div>
                  <SearchMediaPreview assets={media} />
                  <div className="p32-search-metrics" data-sort-key={sortKey}>
                    {metricCells.map(([key, label, value]) => (
                      <span className="p32-search-metric" data-metric={key} key={key}>
                        <b>{label}</b>
                        <i>{key === 'rate' || key === 'reddit_interaction_rate' ? formatSearchRate(value) : formatSearchCount(value)}</i>
                      </span>
                    ))}
                  </div>
                  <p className="p32-search-text">{boundedText(item.content_text, 220)}</p>
                  <small className="p22-media-hashes">
                    正文 SHA-256：{String(item.content_sha256 || '').slice(0, 16)}…
                    {media.slice(0, 2).map((asset) => (
                      <span key={asset.id} title={`${asset.hash?.algorithm || ''}（${asset.hash?.kind || ''}）`}>
                        · 媒体{asset.order + 1} {String(asset.hash?.value || '').slice(0, 12)}…
                      </span>
                    ))}
                    {media.length > 2 && <span> 等 {media.length} 项</span>}
                    <span> · Run：{String(item.provenance?.run_id || '未提供').slice(0, 48)}</span>
                  </small>
                  {alreadyImported && (
                    <p className="p32-search-imported-note">
                      该来源已作为证据导入当前项目（{boundedText(conflicting.label, 40)}），禁止重复导入。
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
