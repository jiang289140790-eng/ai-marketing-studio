import { useState } from 'react';
import { accountCategories, contentStatuses, contentTypes, platforms } from '../data/navigation';
import { statusLabel } from '../utils/formatters';

export function ContentForm({ initialValue, assets = [], characters = [], prompts = [], onSubmit, onCancel }) {
  const [form, setForm] = useState({
    title: '',
    content_text: '',
    media_url: '',
    content_type: 'text',
    platform: 'X',
    account_category: 'brand',
    asset_id: '',
    character_id: '',
    prompt_id: '',
    status: 'idea',
    pipeline_stage: 'idea',
    idea_notes: '',
    published_url: '',
    ...(initialValue || {}),
  });

  function update(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'status') next.pipeline_stage = value === 'failed' ? current.pipeline_stage || 'review' : value;
      if (field === 'pipeline_stage') next.status = value;
      return next;
    });
  }

  function normalizedPayload() {
    const {
      assets: _assetRelation,
      characters: _characterRelation,
      prompts: _promptRelation,
      source_analysis: _sourceAnalysisRelation,
      source_intelligence: _sourceIntelligenceRelation,
      ...payload
    } = form;

    return {
      ...payload,
      asset_id: form.asset_id || null,
      character_id: form.character_id || null,
      prompt_id: form.prompt_id || null,
      pipeline_stage: form.pipeline_stage || form.status || 'idea',
      status: form.status || form.pipeline_stage || 'idea',
    };
  }

  return (
    <form
      className="form-card"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(normalizedPayload());
      }}
    >
      <div className="form-grid">
        <label>
          标题
          <input value={form.title} onChange={(event) => update('title', event.target.value)} required />
        </label>
        <label>
          平台
          <select value={form.platform || 'X'} onChange={(event) => update('platform', event.target.value)}>
            {platforms.map((platform) => (
              <option key={platform} value={platform}>{platform}</option>
            ))}
          </select>
        </label>
        <label>
          内容类型
          <select value={form.content_type} onChange={(event) => update('content_type', event.target.value)}>
            {contentTypes.map((type) => (
              <option key={type.value} value={type.value}>{type.label}</option>
            ))}
          </select>
        </label>
        <label>
          账号类型
          <select value={form.account_category || 'brand'} onChange={(event) => update('account_category', event.target.value)}>
            {accountCategories.map((category) => (
              <option key={category.value} value={category.value}>{category.label}</option>
            ))}
          </select>
        </label>
        <label>
          Pipeline 状态
          <select value={form.pipeline_stage || form.status || 'idea'} onChange={(event) => update('pipeline_stage', event.target.value)}>
            {contentStatuses.map((status) => (
              <option key={status} value={status}>{statusLabel(status)}</option>
            ))}
          </select>
        </label>
        <label>
          关联素材
          <select value={form.asset_id || ''} onChange={(event) => update('asset_id', event.target.value)}>
            <option value="">不关联素材</option>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>{asset.name}</option>
            ))}
          </select>
        </label>
        <label>
          关联角色
          <select value={form.character_id || ''} onChange={(event) => update('character_id', event.target.value)}>
            <option value="">不关联角色</option>
            {characters.map((character) => (
              <option key={character.id} value={character.id}>{character.name}</option>
            ))}
          </select>
        </label>
        <label>
          关联提示词
          <select value={form.prompt_id || ''} onChange={(event) => update('prompt_id', event.target.value)}>
            <option value="">不关联提示词</option>
            {prompts.map((prompt) => (
              <option key={prompt.id} value={prompt.id}>{prompt.title}</option>
            ))}
          </select>
        </label>
        <label className="wide-field">
          媒体 URL
          <input value={form.media_url || ''} onChange={(event) => update('media_url', event.target.value)} />
        </label>
        <label className="wide-field">
          发布后 URL
          <input value={form.published_url || ''} onChange={(event) => update('published_url', event.target.value)} placeholder="发布成功后记录真实帖子链接" />
        </label>
        <label className="wide-field">
          内容想法 / 选题备注
          <textarea value={form.idea_notes || ''} onChange={(event) => update('idea_notes', event.target.value)} />
        </label>
        <label className="wide-field">
          正文
          <textarea value={form.content_text || ''} onChange={(event) => update('content_text', event.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button className="primary-button" type="submit">保存内容</button>
        <button className="ghost-button" type="button" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
