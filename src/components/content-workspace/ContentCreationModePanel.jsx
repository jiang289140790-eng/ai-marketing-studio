import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateQuickContent, generateFromBrief, reviseContent, saveContentDraft } from '../../services/content-creation-service';
import { isSupabaseConfigured } from '../../services/supabase-client';

const MAX_INPUT_LENGTH = 500;
const MAX_REVISE_LENGTH = 500;
const MAX_REVISE_ROUNDS = 5;

/**
 * 三模式内容创建面板。
 *
 * Props:
 * - mode: 'quick' | 'brief'
 * - brief: object | null (仅 brief 模式)
 * - userId: string
 * - onNavigate: function
 * - onDraftCountChange: function(number) - 草稿数量变化回调
 */
export function ContentCreationModePanel({ mode, brief, userId, onNavigate: _onNavigate, onDraftCountChange }) {
  // 输入状态
  const [inputText, setInputText] = useState('');
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);

  // 生成结果
  const [result, setResult] = useState(null); // { data, meta, summary }
  const [showCandidates, setShowCandidates] = useState(false);
  const [showFullDetails, setShowFullDetails] = useState(false);

  // 修改状态
  const [reviseFeedback, setReviseFeedback] = useState('');
  const [reviseHistory, setReviseHistory] = useState([]); // [{ feedback, result }]
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState(null);

  const inputRef = useRef(null);

  // Brief 模式：显示 brief 摘要
  const briefSummaryDisplay = useMemo(() => {
    if (mode !== 'brief' || !brief) return null;
    let status = '';
    if (brief.status === 'approved') status = '已批准';
    else if (brief.status === 'pending') status = '待审批';
    else if (brief.status === 'returned') status = '已退回';
    else if (brief.status === 'stale') status = '已过期';
    else status = brief.status || '未知';
    return {
      id: brief.id,
      name: brief.name || brief.title || '未命名简报',
      status,
      statusApproved: brief.status === 'approved',
      summary: brief.summary || brief.description || '暂无摘要',
      version: brief.version || null,
      fingerprint: brief.fingerprint || null,
      schemaVersion: brief.schema_version || null,
      knowledgeCitationIds: Array.isArray(brief.knowledge_citation_ids) ? brief.knowledge_citation_ids : [],
      evidenceProvenance: brief.evidence_provenance && typeof brief.evidence_provenance === 'object'
        ? brief.evidence_provenance
        : {},
    };
  }, [mode, brief]);

  // 自动聚焦输入框
  useEffect(() => {
    if (mode === 'quick' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [mode]);

  // 重置状态当模式切换时
  useEffect(() => {
    setInputText('');
    setError('');
    setResult(null);
    setShowCandidates(false);
    setShowFullDetails(false);
    setReviseFeedback('');
    setReviseHistory([]);
    setSaving(false);
    setSavedId(null);
    setGenerating(false);
  }, [mode, brief?.id]);

  // ----- 快速生成 -----
  const handleQuickGenerate = useCallback(async () => {
    const trimmed = inputText.trim();
    if (!trimmed) {
      setError('请输入你想要生成的内容需求。');
      return;
    }
    if (trimmed.length > MAX_INPUT_LENGTH) {
      setError(`输入不能超过 ${MAX_INPUT_LENGTH} 个字符。`);
      return;
    }
    if (!isSupabaseConfigured) {
      setError('数据服务未配置，无法生成内容。');
      return;
    }
    if (!userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setGenerating(true);
    try {
      const previous = reviseHistory.length > 0
        ? reviseHistory[reviseHistory.length - 1].result
        : null;
      const response = await generateQuickContent(trimmed, previous);
      setResult({ data: response.data, meta: response.meta, summary: response.data?.summary || '' });
      setShowCandidates(false);
      setShowFullDetails(false);
    } catch (err) {
      setError(err?.message || '生成失败，请稍后重试。');
      setResult(null);
    } finally {
      setGenerating(false);
    }
  }, [inputText, userId, reviseHistory]);

  // ----- 从 Brief 生成 -----
  const handleBriefGenerate = useCallback(async () => {
    if (!briefSummaryDisplay) {
      setError('无法读取简报信息。');
      return;
    }
    if (!briefSummaryDisplay.statusApproved) {
      setError(`简报状态为「${briefSummaryDisplay.status}」，只有已批准的简报才能生成内容。`);
      return;
    }
    if (!isSupabaseConfigured) {
      setError('数据服务未配置，无法生成内容。');
      return;
    }
    if (!userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setGenerating(true);
    try {
      const response = await generateFromBrief(brief);
      setResult({ data: response.data, meta: response.meta, summary: response.data?.summary || '' });
      setShowCandidates(false);
      setShowFullDetails(false);
    } catch (err) {
      setError(err?.message || '从 Brief 生成失败，请稍后重试。');
      setResult(null);
    } finally {
      setGenerating(false);
    }
  }, [brief, briefSummaryDisplay, userId]);

  // ----- 继续修改 -----
  const handleRevise = useCallback(async () => {
    const trimmed = reviseFeedback.trim();
    if (!trimmed) {
      setError('请输入修改意见。');
      return;
    }
    if (trimmed.length > MAX_REVISE_LENGTH) {
      setError(`修改意见不能超过 ${MAX_REVISE_LENGTH} 个字符。`);
      return;
    }
    if (reviseHistory.length >= MAX_REVISE_ROUNDS) {
      setError(`最多支持 ${MAX_REVISE_ROUNDS} 轮修改。`);
      return;
    }
    if (!result?.data) {
      setError('没有可修改的内容。');
      return;
    }
    if (!isSupabaseConfigured || !userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setGenerating(true);
    try {
      const response = await reviseContent(trimmed, result.data);
      const newHistory = [...reviseHistory, { feedback: trimmed, result: result.data }];
      setReviseHistory(newHistory);
      setResult({ data: response.data, meta: response.meta, summary: response.data?.summary || '' });
      setReviseFeedback('');
      setShowCandidates(false);
      setShowFullDetails(false);
    } catch (err) {
      setError(err?.message || '修改失败，请稍后重试。');
    } finally {
      setGenerating(false);
    }
  }, [reviseFeedback, reviseHistory, result, userId]);

  // ----- 确认保存 -----
  const handleSave = useCallback(async () => {
    if (!result?.data) {
      setError('没有可保存的内容。');
      return;
    }
    if (savedId) {
      setError('已经保存过了。');
      return;
    }
    if (!userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setSaving(true);
    try {
      const context = {
        originalInput: inputText || '',
        summary: result.summary || '',
        usage: result.meta?.total_tokens ? { total_tokens: result.meta.total_tokens } : {},
        provider: result.meta?.provider || 'dashscope/qwen',
        model: result.meta?.model || 'qwen-plus',
        source: mode === 'brief' ? 'generate_from_brief' : 'quick_generate',
        briefReferences: mode === 'brief' && brief ? {
          source_view: brief.source_type || 'ke_content_briefs_v1',
          brief_id: brief.id,
          brief_version: brief.version,
          brief_fingerprint: brief.fingerprint,
          brief_schema_version: brief.schema_version,
          brief_status: brief.status,
        } : null,
        knowledgeReferences: mode === 'brief' && brief
          ? [...(brief.knowledge_citation_ids || [])]
          : null,
        evidenceReferences: mode === 'brief' && brief
          ? JSON.parse(JSON.stringify(brief.evidence_provenance || {}))
          : null,
      };
      const saved = await saveContentDraft(userId, result.data, context);
      setSavedId(saved.id);
      if (onDraftCountChange) onDraftCountChange(1);
    } catch (err) {
      setError(err?.message || '保存失败。');
    } finally {
      setSaving(false);
    }
  }, [result, savedId, userId, inputText, mode, brief, onDraftCountChange]);

  // ----- 键盘提交 -----
  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (mode === 'quick') {
        handleQuickGenerate();
      } else if (mode === 'brief') {
        handleBriefGenerate();
      }
    }
  }, [mode, handleQuickGenerate, handleBriefGenerate]);

  // 快速生成面板
  if (mode === 'quick') {
    return (
      <div className="creation-mode-panel quick-generate-panel" role="region" aria-label="快速生成一条内容">
        {!result ? (
          <div className="quick-input-section">
            <div className="quick-input-header">
              <h3>描述你的内容需求</h3>
              <p>输入一句话描述，AI 将自动补全平台、受众、风格、Hook、CTA 和视觉方案。</p>
            </div>
            <div className="quick-input-group">
              <textarea
                ref={inputRef}
                className="quick-input-textarea"
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  setError('');
                }}
                onKeyDown={handleKeyDown}
                placeholder="例如：为独立创业者写一篇关于AI提效的 X 贴文，要专业但不生硬"
                rows={3}
                maxLength={MAX_INPUT_LENGTH}
                disabled={generating}
                aria-label="一句话内容需求"
              />
              <div className="quick-input-footer">
                <small>{inputText.length}/{MAX_INPUT_LENGTH}</small>
                <button
                  className="primary-button generate-button"
                  type="button"
                  onClick={handleQuickGenerate}
                  disabled={generating || !inputText.trim()}
                  aria-busy={generating}
                >
                  {generating ? '生成中...' : '智能生成'}
                </button>
              </div>
            </div>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
          </div>
        ) : (
          <div className="generation-result-section">
            {/* 摘要行 */}
            <div className="result-summary-bar">
              <span className="result-summary-text">{result.summary}</span>
              <button
                className="text-action"
                type="button"
                onClick={() => {
                  setResult(null);
                  setReviseHistory([]);
                  setSavedId(null);
                }}
                disabled={generating || saving}
              >
                重新生成
              </button>
            </div>

            {/* 主版本 */}
            <div className="main-version-card">
              <div className="version-header">
                <span className="version-badge primary">主版本</span>
              </div>
              <div className="main-copy-display">
                <h4 className="main-hook">{result.data?.hook}</h4>
                <p className="main-body">{result.data?.main_copy}</p>
                <div className="main-meta">
                  <span className="main-cta">{result.data?.cta}</span>
                  <div className="main-hashtags">
                    {(result.data?.hashtags || []).map((tag) => (
                      <span className="hashtag-chip" key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* 完整详情（折叠） */}
            <details
              className="collapse-panel full-details-panel"
              open={showFullDetails}
              onToggle={(e) => setShowFullDetails(e.currentTarget.open)}
            >
              <summary>完整账号/平台/风格、知识与证据</summary>
              <div className="full-details-grid">
                <div className="detail-item"><span className="detail-label">平台</span><strong>{result.data?.platform}</strong></div>
                <div className="detail-item"><span className="detail-label">受众</span><strong>{result.data?.audience}</strong></div>
                <div className="detail-item"><span className="detail-label">语气/风格</span><strong>{result.data?.tone}</strong></div>
                <div className="detail-item"><span className="detail-label">内容目标</span><strong>{result.data?.content_goal}</strong></div>
                <div className="detail-item"><span className="detail-label">视觉类型</span><strong>{result.data?.visual_type}</strong></div>
                <div className="detail-item"><span className="detail-label">画幅</span><strong>{result.data?.aspect_ratio}</strong></div>
                <div className="detail-item detail-full"><span className="detail-label">视觉描述</span><strong>{result.data?.visual_description}</strong></div>
              </div>
              <div className="detail-meta-row">
                <small>Provider: {result.meta?.provider} · Model: {result.meta?.model} · Tokens: {result.meta?.total_tokens}</small>
              </div>
            </details>

            {/* 候选版本（折叠） */}
            {(result.data?.candidates || []).length > 0 && (
              <details
                className="collapse-panel candidates-panel"
                open={showCandidates}
                onToggle={(e) => setShowCandidates(e.currentTarget.open)}
              >
                <summary>候选版本（{result.data.candidates.length}）</summary>
                <div className="candidates-list">
                  {result.data.candidates.map((candidate, index) => (
                    <div className="candidate-card" key={index}>
                      <span className="version-badge">候选 {index + 1}</span>
                      <strong>{candidate.hook}</strong>
                      <p>{candidate.copy}</p>
                      {candidate.cta && <small>CTA: {candidate.cta}</small>}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* 修改意见输入 */}
            {!savedId && (
              <div className="revise-section">
                <label className="revise-label">
                  <span>继续修改（可选，输入自然语言反馈）</span>
                  <div className="revise-input-row">
                    <input
                      className="revise-input"
                      value={reviseFeedback}
                      onChange={(e) => {
                        setReviseFeedback(e.target.value);
                        setError('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleRevise();
                        }
                      }}
                      placeholder="例如：语气更温和一些，改成小红书风格"
                      maxLength={MAX_REVISE_LENGTH}
                      disabled={generating || saving}
                      aria-label="修改意见"
                    />
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={handleRevise}
                      disabled={generating || saving || !reviseFeedback.trim() || reviseHistory.length >= MAX_REVISE_ROUNDS}
                    >
                      {generating ? '修改中...' : '继续修改'}
                    </button>
                  </div>
                  <small className="revise-hint">
                    {reviseHistory.length > 0 ? `已修改 ${reviseHistory.length} 次（最多 ${MAX_REVISE_ROUNDS} 次）` : `最多 ${MAX_REVISE_ROUNDS} 轮修改`}
                  </small>
                </label>
                {reviseHistory.length > 0 && (
                  <details className="collapse-panel revise-history-panel">
                    <summary>修改记录（{reviseHistory.length}）</summary>
                    <div className="revise-history-list">
                      {reviseHistory.map((entry, index) => (
                        <div className="revise-history-item" key={index}>
                          <small>第 {index + 1} 次修改</small>
                          <em>"{entry.feedback}"</em>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* 操作按钮 */}
            <div className="result-actions">
              {!savedId ? (
                <>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={handleSave}
                    disabled={saving || generating}
                  >
                    {saving ? '保存中...' : '确认保存'}
                  </button>
                </>
              ) : (
                <div className="save-success-section">
                  <div className="notice success" role="status">
                    内容已保存为草稿（ID: {savedId}）。
                  </div>
                  <div className="next-steps">
                    <p>下一步可执行操作（需后续门禁开启）：</p>
                    <button className="ghost-button" type="button" disabled>
                      生成视觉素材
                    </button>
                    <button className="ghost-button" type="button" disabled>
                      加入发布队列
                    </button>
                    <p className="form-hint">视觉素材生成和发布队列功能暂未在 P30 开放，属于后续里程碑。当前可前往素材库手动上传或从草稿箱查看已保存内容。</p>
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // 从 Brief 生成面板
  if (mode === 'brief') {
    if (!brief) {
      return (
        <div className="creation-mode-panel brief-generate-panel" role="region" aria-label="从 Brief 生成">
          <div className="empty-card-inline">请先在运营工作台中选择一个已批准的 Brief。</div>
        </div>
      );
    }

    const isApproved = briefSummaryDisplay?.statusApproved;
    const canGenerate = isApproved && userId && isSupabaseConfigured;

    return (
      <div className="creation-mode-panel brief-generate-panel" role="region" aria-label="从 Brief 生成">
        <div className="brief-selection-display">
          <div className="brief-header">
            <h3>从 Brief 生成内容</h3>
            <span className={`status-badge ${isApproved ? 'approved' : 'draft'}`}>
              {briefSummaryDisplay.status}
            </span>
          </div>

          {/* Brief 摘要 */}
          <div className="brief-summary-card">
            <div className="brief-summary-row">
              <span className="detail-label">简报名称</span>
              <strong>{briefSummaryDisplay.name}</strong>
            </div>
            <div className="brief-summary-row">
              <span className="detail-label">版本</span>
              <strong>{briefSummaryDisplay.version || '未指定'}</strong>
            </div>
          </div>

          {/* 知识引用、证据来源、高级设置（折叠） */}
          <details className="collapse-panel brief-advanced-panel">
            <summary>知识引用、证据来源与高级设置</summary>
            <div className="brief-advanced-content">
              <p className="brief-summary-text">{briefSummaryDisplay.summary}</p>
              {brief.target_audience && (
                <div className="detail-item"><span className="detail-label">目标受众</span><strong>{brief.target_audience}</strong></div>
              )}
              {brief.platforms && (
                <div className="detail-item"><span className="detail-label">发布渠道</span><strong>{Array.isArray(brief.platforms) ? brief.platforms.join(', ') : String(brief.platforms)}</strong></div>
              )}
              {brief.constraints && (
                <div className="detail-item"><span className="detail-label">约束条件</span><strong>{brief.constraints}</strong></div>
              )}
            </div>
          </details>

          {/* 生成按钮 */}
          {!result && (
            <div className="brief-generate-action">
              <button
                className="primary-button"
                type="button"
                onClick={handleBriefGenerate}
                disabled={generating || !canGenerate}
              >
                {generating ? '生成中...' : !canGenerate ? (isApproved ? '请先登录' : '简报未批准——无法生成') : '基于此 Brief 生成内容'}
              </button>
              {!isApproved && (
                <p className="form-hint">
                  {brief.status === 'pending' ? '简报尚在审批中，请等待审批完成后生成。'
                    : brief.status === 'returned' ? '简报已被退回，需要修改后重新提交。'
                    : brief.status === 'stale' ? '简报已过期，需要更新后重新提交。'
                    : `简报状态为「${brief.status || '未知'}」，只有已批准（approved）的简报才能生成内容。`}
                </p>
              )}
              {error && (
                <div className="notice error" role="alert">{error}</div>
              )}
            </div>
          )}

          {/* 生成结果（复用快速生成的 result section） */}
          {result && (
            <div className="generation-result-section">
              <div className="result-summary-bar">
                <span className="result-summary-text">{result.summary}</span>
              </div>

              <div className="main-version-card">
                <div className="version-header">
                  <span className="version-badge primary">主版本</span>
                </div>
                <div className="main-copy-display">
                  <h4 className="main-hook">{result.data?.hook}</h4>
                  <p className="main-body">{result.data?.main_copy}</p>
                  <div className="main-meta">
                    <span className="main-cta">{result.data?.cta}</span>
                    <div className="main-hashtags">
                      {(result.data?.hashtags || []).map((tag) => (
                        <span className="hashtag-chip" key={tag}>{tag}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <details
                className="collapse-panel full-details-panel"
                open={showFullDetails}
                onToggle={(e) => setShowFullDetails(e.currentTarget.open)}
              >
                <summary>完整账号/平台/风格、知识与证据</summary>
                <div className="full-details-grid">
                  <div className="detail-item"><span className="detail-label">平台</span><strong>{result.data?.platform}</strong></div>
                  <div className="detail-item"><span className="detail-label">受众</span><strong>{result.data?.audience}</strong></div>
                  <div className="detail-item"><span className="detail-label">语气/风格</span><strong>{result.data?.tone}</strong></div>
                  <div className="detail-item"><span className="detail-label">内容目标</span><strong>{result.data?.content_goal}</strong></div>
                  <div className="detail-item"><span className="detail-label">视觉类型</span><strong>{result.data?.visual_type}</strong></div>
                  <div className="detail-item"><span className="detail-label">画幅</span><strong>{result.data?.aspect_ratio}</strong></div>
                  <div className="detail-item detail-full"><span className="detail-label">视觉描述</span><strong>{result.data?.visual_description}</strong></div>
                </div>
              </details>

              {(result.data?.candidates || []).length > 0 && (
                <details
                  className="collapse-panel candidates-panel"
                  open={showCandidates}
                  onToggle={(e) => setShowCandidates(e.currentTarget.open)}
                >
                  <summary>候选版本（{result.data.candidates.length}）</summary>
                  <div className="candidates-list">
                    {result.data.candidates.map((candidate, index) => (
                      <div className="candidate-card" key={index}>
                        <span className="version-badge">候选 {index + 1}</span>
                        <strong>{candidate.hook}</strong>
                        <p>{candidate.copy}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {!savedId && (
                <div className="revise-section">
                  <label className="revise-label">
                    <span>继续修改（可选）</span>
                    <div className="revise-input-row">
                      <input
                        className="revise-input"
                        value={reviseFeedback}
                        onChange={(event) => { setReviseFeedback(event.target.value); setError(''); }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            handleRevise();
                          }
                        }}
                        placeholder="例如：更简洁，突出核心收益"
                        maxLength={MAX_REVISE_LENGTH}
                        disabled={generating || saving}
                        aria-label="修改意见"
                      />
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={handleRevise}
                        disabled={generating || saving || !reviseFeedback.trim() || reviseHistory.length >= MAX_REVISE_ROUNDS}
                      >
                        {generating ? '修改中...' : '继续修改'}
                      </button>
                    </div>
                  </label>
                </div>
              )}

              {!savedId ? (
                <div className="result-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={handleSave}
                    disabled={saving || generating}
                  >
                    {saving ? '保存中...' : '确认保存'}
                  </button>
                </div>
              ) : (
                <div className="save-success-section">
                  <div className="notice success" role="status">内容已保存为草稿（ID: {savedId}）。</div>
                  <div className="next-steps">
                    <p>下一步可执行操作（需后续门禁开启）：</p>
                    <button className="ghost-button" type="button" disabled>生成视觉素材</button>
                    <button className="ghost-button" type="button" disabled>加入发布队列</button>
                  </div>
                </div>
              )}

              {error && (
                <div className="notice error" role="alert">{error}</div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
