// P19 研究工作台面板组件（纯展示 + 局部表单状态；所有副作用经由页面回调上抛）。
// 暗色视觉体系沿用 P18 词汇；中文文案 UTF-8；状态不只靠颜色（文字 + 图标）。
// 本组件不发起任何网络请求。

import { useRef, useState } from 'react';
import {
  EXECUTION_FLAG_LABELS,
  MAX_STRING_LENGTH,
  boundedText,
} from '../../services/p19-contracts.js';

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
            <p className="p19-evidence-text">{boundedText(record.content_text, 220)}</p>
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
        <h3>确定性本地分析（deterministic_local）</h3>
        <span className="p19-panel-note">显式规则 · 无模型 · 无费用</span>
      </div>
      <p className="p19-provenance-line">
        所有分析均由固定规则在本机计算（来源 URL 形状、文本长度、关键词频次、语气标记、媒体元数据边界、人工来源可信度），绝不调用任何模型。
      </p>
      {analyses.length === 0 && <p className="p19-empty-note">还没有分析记录。在证据卡片上点击「运行确定性分析」。</p>}
      <ul className="p19-analysis-list">
        {analyses.map((analysis) => {
          const evidence = evidenceById.get(analysis.evidence_id);
          return (
            <li className="p19-analysis-item" key={analysis.id}>
              <div className="p19-analysis-top">
                <strong>{boundedText(analysis.result.summary.label, 48)}</strong>
                <P19Pill label="deterministic_local" tone="ok" icon="⚙" />
              </div>
              <p className="p19-meta-line">
                证据：{evidence ? boundedText(evidence.label, 40) : '（证据已移除，绑定失效）'} · 规则 {analysis.rule_ids.length} 条 · {analysis.provenance.generated_by}
              </p>
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
  const decide = (value) => {
    onDecide(value, rationale.trim(), comment.trim());
    setRationale('');
    setComment('');
  };
  return (
    <div className="p19-panel">
      <div className="p19-panel-head">
        <h3>可审核 Brief（ams_brief_review_v1）</h3>
        {brief ? (
          <span className="p19-panel-note">
            第 {brief.version} 版 · {brief.status === 'approved' ? '已批准' : brief.status === 'returned' ? '已退回' : '待审核'}
            {stale ? ' · 已过时' : ''}
          </span>
        ) : (
          <span className="p19-panel-note">尚未组装</span>
        )}
      </div>
      {!brief && (
        <>
          <p className="p19-empty-note">Brief 由知识卡与项目档案确定性组装；任何上游变化都会使旧 Brief 过时并要求重建。</p>
          <div className="p19-form-actions">
            <button className="p19-btn p19-btn-primary" type="button" disabled={busy || (project.knowledge_cards || []).length === 0} title={(project.knowledge_cards || []).length === 0 ? '至少需要一张知识卡' : '组装可审核 Brief（版本递增，审核重置）'} onClick={onAssemble}>
              组装 Brief
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
            引用知识卡 {brief.knowledge_citation_ids.length} 张 · 结构建议 {brief.structural_guidance.length} 条 · {brief.version_note || ''}
          </p>
          {stale && (
            <p className="p19-blocking-note">
              ⛔ Brief 已过时：{workflow.brief_stale_reasons.join('；')}。请「重建 Brief」后再审核。
            </p>
          )}
          {decision ? (
            <p className="p19-provenance-line">
              决定：<b>{decision.value === 'approved' ? '批准' : '退回修改'}</b>（来源 {decision.source}）· {decision.decided_at} · 理由：{boundedText(decision.rationale, 100)}
            </p>
          ) : (
            <p className="p19-meta-line">尚无审核决定。批准前必须确保 Brief 未过时。</p>
          )}
          {(brief.review.comments || []).length > 0 && (
            <ul className="p19-comment-list">
              {brief.review.comments.map((item, index) => <li key={index}>「{boundedText(item, 120)}」</li>)}
            </ul>
          )}
          <div className="p19-brief-actions">
            <button className="p19-btn p19-btn-primary" type="button" disabled={busy} onClick={onAssemble} title="上游内容变化后必须重建 Brief 才能重新审核">
              重建 Brief（第 {brief.version + 1} 版）
            </button>
            <label className="p19-field p19-inline-field">
              <span>审核意见（必填，≤500 字）</span>
              <textarea rows={2} value={rationale} maxLength={500} onChange={(event) => setRationale(event.target.value)} disabled={!canReview} />
            </label>
            <div className="p19-review-actions">
              <button
                className="p19-btn p19-btn-approve"
                type="button"
                disabled={busy || !canSubmitReview}
                title={!canReview ? (stale ? 'Brief 已过时，先重建' : approved ? '本版已批准' : '先组装 Brief') : !rationale.trim() ? '请先填写审核意见' : '批准（approved + local_manual）后才可派生交接包'}
                onClick={() => decide('approved')}
              >
                批准 Brief
              </button>
              <button
                className="p19-btn p19-btn-return"
                type="button"
                disabled={busy || !canSubmitReview}
                title={!canReview ? (stale ? 'Brief 已过时，先重建' : approved ? '本版已批准' : '先组装 Brief') : '退回修改（return_for_revision）'}
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
          <p className="p19-provenance-line">{onlineMode ? '审核决定会保存到当前 staging 账号的工作区（local_manual 表示由人工作出决定，不是模型自动批准）。' : '审核决定与评论只记录在本浏览器（local_manual）；退回后请修改内容并重建 Brief。'}</p>
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
