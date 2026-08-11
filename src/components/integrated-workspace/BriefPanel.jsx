import { useState, useCallback } from 'react';
import { loadBriefReviewState, saveBriefReviewState } from '../../services/integrated-workspace-service.js';

// 可审核 Brief 面板：展示 Brief 详情，支持本地 approve/return/comment
export function BriefPanel({ brief, executionFlags }) {
  const briefId = brief?.id || '';
  // 从 localStorage 载入本地审核状态（如有）
  const [reviewState, setReviewState] = useState(() => {
    const saved = loadBriefReviewState(briefId);
    return saved || brief.humanDecision || {
      status: 'pending',
      statusLabel: '待审核',
      reviewer: null,
      reviewedAt: null,
      decision: null,
      comment: '',
    };
  });

  const [comment, setComment] = useState(reviewState.comment || '');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const handleApprove = useCallback(() => {
    const next = {
      ...reviewState,
      status: 'approved',
      statusLabel: '已批准',
      decision: 'approved',
      reviewedAt: new Date().toISOString(),
      comment,
    };
    setSaving(true);
    const ok = saveBriefReviewState(briefId, next);
    setSaving(false);
    if (ok) {
      setReviewState(next);
      setSaveMessage('已保存：Brief 已批准（仅本地 localStorage，未写入 Supabase）');
    } else {
      setSaveMessage('保存失败：localStorage 写入异常');
    }
  }, [briefId, comment, reviewState]);

  const handleReturn = useCallback(() => {
    const next = {
      ...reviewState,
      status: 'returned',
      statusLabel: '已退回',
      decision: 'returned',
      reviewedAt: new Date().toISOString(),
      comment,
    };
    setSaving(true);
    const ok = saveBriefReviewState(briefId, next);
    setSaving(false);
    if (ok) {
      setReviewState(next);
      setSaveMessage('已保存：Brief 已退回修改（仅本地 localStorage，未写入 Supabase）');
    } else {
      setSaveMessage('保存失败：localStorage 写入异常');
    }
  }, [briefId, comment, reviewState]);

  const handleSaveComment = useCallback(() => {
    const next = {
      ...reviewState,
      comment,
      reviewedAt: new Date().toISOString(),
    };
    setSaving(true);
    const ok = saveBriefReviewState(briefId, next);
    setSaving(false);
    if (ok) {
      setReviewState(next);
      setSaveMessage('已保存评论（仅本地 localStorage，未写入 Supabase）');
    } else {
      setSaveMessage('保存失败：localStorage 写入异常');
    }
  }, [briefId, comment, reviewState]);

  if (!brief) {
    return (
      <div className="iw-panel iw-empty-panel">
        <span className="iw-empty-icon">—</span>
        <strong>暂无可用 Brief</strong>
        <p>当前数据源中不包含可审核的 Brief 记录。</p>
      </div>
    );
  }

  const flags = executionFlags || brief.executionFlags || {};
  const flagEntries = [
    ['generation_executed', '生成'],
    ['routing_executed', '路由'],
    ['network_executed', '网络'],
    ['publish_executed', '发布'],
  ];

  return (
    <div className="iw-brief-panel">
      {/* Brief 头部 */}
      <div className="iw-brief-header">
        <div>
          <span className="iw-eyebrow">可审核 Brief</span>
          <h3>{brief.title || brief.topic}</h3>
          <span className={`iw-badge iw-badge-${reviewState.status === 'approved' ? 'success' : reviewState.status === 'returned' ? 'error' : 'warning'}`}>
            {reviewState.statusLabel}
          </span>
        </div>
      </div>

      {/* 主题与目标 */}
      {brief.topic && (
        <div className="iw-brief-section">
          <h4>研究主题</h4>
          <p><strong>{brief.topic}</strong></p>
        </div>
      )}
      {brief.objective && (
        <div className="iw-brief-section">
          <h4>目标</h4>
          <p>{brief.objective}</p>
        </div>
      )}

      {/* 结构建议 */}
      {brief.structuralGuidance && brief.structuralGuidance.length > 0 && (
        <div className="iw-brief-section">
          <h4>结构建议（来自分析）</h4>
          <ul className="iw-brief-list">
            {brief.structuralGuidance.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 约束 */}
      {brief.constraints && brief.constraints.length > 0 && (
        <div className="iw-brief-section">
          <h4>约束</h4>
          <ul className="iw-brief-list">
            {brief.constraints.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 绑定知识卡 */}
      {brief.boundKnowledgeCardIds && brief.boundKnowledgeCardIds.length > 0 && (
        <div className="iw-brief-section">
          <h4>引用知识卡</h4>
          <div className="iw-source-list">
            {brief.boundKnowledgeCardIds.map((id) => (
              <span className="iw-source-chip" key={id}>
                <code>{id}</code>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 绑定证据 */}
      {brief.boundEvidenceIds && brief.boundEvidenceIds.length > 0 && (
        <div className="iw-brief-section">
          <h4>证据溯源</h4>
          <div className="iw-source-list">
            {brief.boundEvidenceIds.map((id) => (
              <span className="iw-source-chip" key={id}>
                <code>{id}</code>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 执行标志 */}
      <div className="iw-brief-section">
        <h4>执行标志（全部严格 false）</h4>
        <div className="iw-flag-grid">
          {flagEntries.map(([key, label]) => (
            <div
              className={`iw-flag-cell ${flags[key] ? 'on' : ''}`}
              key={key}
            >
              <span>{label}</span>
              <strong>{flags[key] ? '已执行' : '未执行'}</strong>
            </div>
          ))}
        </div>
      </div>

      {/* 人工审核区 */}
      <div className="iw-brief-section iw-review-section">
        <h4>人工审核（仅本地 localStorage）</h4>
        <div className="iw-review-status">
          <span>当前状态：</span>
          <strong>{reviewState.statusLabel}</strong>
          {reviewState.reviewedAt && (
            <small> · {new Date(reviewState.reviewedAt).toLocaleString()}</small>
          )}
        </div>
        <textarea
          className="iw-review-comment"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="输入审核意见或评论..."
        />
        <div className="iw-review-actions">
          <button
            className="iw-btn iw-btn-approve"
            type="button"
            disabled={saving || reviewState.status === 'approved'}
            onClick={handleApprove}
          >
            批准 Brief
          </button>
          <button
            className="iw-btn iw-btn-return"
            type="button"
            disabled={saving || reviewState.status === 'returned'}
            onClick={handleReturn}
          >
            退回修改
          </button>
          <button
            className="iw-btn iw-btn-comment"
            type="button"
            disabled={saving}
            onClick={handleSaveComment}
          >
            保存评论
          </button>
        </div>
        {saveMessage && (
          <p className="iw-save-message">{saveMessage}</p>
        )}
        <p className="iw-localstorage-note">
          审核状态仅保存在浏览器 localStorage 中（key: p18_brief_review_v1_{'{briefId}'}），
          不写入 Supabase，不触发任何网络请求。
        </p>
      </div>

      {/* 出处 */}
      <p className="iw-card-provenance">{brief.provenance}</p>
    </div>
  );
}
