import { useCallback, useState } from 'react';

const PLATFORM_LABELS = {
  x: 'X', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube',
  linkedin: 'LinkedIn', facebook: 'Facebook', xiaohongshu: '小红书',
  douyin: '抖音', weibo: '微博', wechat: '微信', telegram: 'Telegram',
  threads: 'Threads',
};

const FORMAT_LABELS = {
  image_caption: '图文', carousel: '轮播', long_post: '长文',
  short_video_script: '短视频脚本', text_only: '纯文本', infographic: '信息图',
};

const TONE_LABELS = {
  professional: '专业', casual: '随和', inspirational: '励志',
  educational: '教育', humorous: '幽默', urgent: '紧迫',
  empathetic: '共情', authoritative: '权威',
};

const CONFIDENCE_LABELS = {
  explicit: '用户指定', reference: '参考验证', defaults: '默认设置', inferred: 'AI 推断',
};

const CTA_POLICY_LABELS = {
  required: '必须包含 CTA', optional: 'CTA 可选', none: '不含 CTA',
};

const HASHTAG_POLICY_LABELS = {
  required_3_5: '3-5 个标签', optional_0_5: '0-5 个标签', none: '无标签',
};

/**
 * 意图摘要组件。
 * 显示一行 chip 摘要 + 可展开的编辑面板。
 *
 * Props:
 * - intent: object | null - 已解析的意图 { platform, content_format, ... }
 * - summary: string - 摘要文本
 * - loading: boolean
 * - onIntentChange: function(updatedFields) - 用户编辑意图后的回调
 */
export function CreationIntentSummary({ intent, summary, loading, onIntentChange }) {
  const [expanded, setExpanded] = useState(false);
  const [localIntent, setLocalIntent] = useState(() => ({ ...intent }));

  // 当外部 intent 变化时同步
  if (intent && (!localIntent || localIntent.platform !== intent.platform)) {
    // 仅在平台变化时同步，保留用户本地编辑
  }

  const handleFieldChange = useCallback((field, value) => {
    setLocalIntent((prev) => {
      const next = { ...prev, [field]: value };
      if (onIntentChange) onIntentChange({ [field]: value });
      return next;
    });
  }, [onIntentChange]);

  if (!intent) return null;

  const platformLabel = PLATFORM_LABELS[intent.platform] || intent.platform;
  const formatLabel = FORMAT_LABELS[intent.content_format] || intent.content_format;
  const toneLabel = TONE_LABELS[intent.tone] || intent.tone;
  const confidenceLabel = CONFIDENCE_LABELS[intent.confidence] || intent.confidence;

  return (
    <div className="intent-summary-section" role="region" aria-label="内容意图">
      {/* Chip 摘要行 */}
      <div className="intent-chip-row">
        <span className="intent-chip platform">{platformLabel}</span>
        <span className="intent-chip format">{formatLabel}</span>
        <span className="intent-chip tone">{toneLabel}</span>
        <span className="intent-chip language">{intent.language_mode || 'zh-cn'}</span>
        <span className="intent-chip confidence" title={`置信度：${confidenceLabel}`}>
          {confidenceLabel}
        </span>
        <button
          className="text-action intent-edit-toggle"
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? '收起编辑' : '编辑意图'}
        </button>
      </div>

      {/* 摘要行 */}
      {summary && !loading && (
        <p className="intent-summary-line">{summary}</p>
      )}

      {/* 展开的编辑面板 */}
      {expanded && (
        <div className="intent-edit-panel">
          <div className="intent-edit-grid">
            <label className="intent-field">
              <span>平台</span>
              <select
                value={intent.platform}
                onChange={(e) => handleFieldChange('platform', e.target.value)}
              >
                {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="intent-field">
              <span>内容格式</span>
              <select
                value={intent.content_format}
                onChange={(e) => handleFieldChange('content_format', e.target.value)}
              >
                {Object.entries(FORMAT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="intent-field">
              <span>语言模式</span>
              <select
                value={intent.language_mode || 'zh-cn'}
                onChange={(e) => handleFieldChange('language_mode', e.target.value)}
              >
                <option value="zh-cn">简体中文</option>
                <option value="zh-tw">繁體中文</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
                <option value="bilingual_zh_en">中英双语</option>
              </select>
            </label>
            <label className="intent-field">
              <span>长度</span>
              <select
                value={intent.length_profile || 'short'}
                onChange={(e) => handleFieldChange('length_profile', e.target.value)}
              >
                <option value="micro">极短（1-3行）</option>
                <option value="short">简短</option>
                <option value="standard">标准</option>
                <option value="long">长文</option>
              </select>
            </label>
            <label className="intent-field">
              <span>语气</span>
              <select
                value={intent.tone || 'professional'}
                onChange={(e) => handleFieldChange('tone', e.target.value)}
              >
                {Object.entries(TONE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="intent-field">
              <span>CTA 策略</span>
              <select
                value={intent.cta_policy || 'required'}
                onChange={(e) => handleFieldChange('cta_policy', e.target.value)}
              >
                {Object.entries(CTA_POLICY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="intent-field">
              <span>标签策略</span>
              <select
                value={intent.hashtag_policy || 'required_3_5'}
                onChange={(e) => handleFieldChange('hashtag_policy', e.target.value)}
              >
                {Object.entries(HASHTAG_POLICY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="intent-provenance-row">
            <small>
              置信度：{CONFIDENCE_LABELS[intent.confidence] || intent.confidence}
              {intent.provenance ? ` · 来源：${intent.provenance}` : ''}
              {intent.audience ? ` · 受众：${intent.audience}` : ''}
            </small>
          </div>
        </div>
      )}
    </div>
  );
}
