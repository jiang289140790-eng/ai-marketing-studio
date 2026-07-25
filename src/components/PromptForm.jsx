import { useMemo, useState } from 'react';
import { platforms, promptCategories } from '../data/navigation';
import {
  extractPromptVariables,
  PROMPT_VARIABLE_DEFINITIONS,
  renderPromptTemplate,
} from '../utils/prompt-template-model';

const DEFAULT_IMAGE_TEMPLATE = `{{character_trigger}}, {{visual_direction}}, wearing {{outfit}}, at {{location}}, {{camera}}, designed for {{platform}}, goal: {{content_goal}}`;

export function PromptForm({
  activeCampaignId,
  characters = [],
  initialValue,
  onCancel,
  onSubmit,
  workflows = [],
}) {
  const [form, setForm] = useState(() => ({
    title: initialValue?.title || '',
    category: initialValue?.category || 'image',
    content: initialValue?.content || DEFAULT_IMAGE_TEMPLATE,
    platform: initialValue?.platform || 'X',
    character: initialValue?.character || '',
    purpose: initialValue?.templateMeta?.purpose || '',
    campaign_id: initialValue?.templateMeta?.campaign_id || activeCampaignId || '',
    workflow_id: initialValue?.templateMeta?.workflow_id || '',
    source: initialValue?.templateMeta?.source || 'manual',
    status: initialValue?.templateMeta?.status || 'active',
    change_reason: initialValue ? '' : '初始创建',
  }));
  const [previewValues, setPreviewValues] = useState({});
  const variables = useMemo(() => extractPromptVariables(form.content), [form.content]);
  const preview = useMemo(() => renderPromptTemplate(form.content, previewValues), [form.content, previewValues]);

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  return (
    <form
      className="prompt-template-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ ...form, character: form.character || null });
      }}
    >
      <div className="section-head">
        <div>
          <p className="eyebrow">{initialValue ? '创建新版本' : '新建模板'}</p>
          <h3>{initialValue ? `编辑 ${initialValue.title}` : '保存可复用提示词模板'}</h3>
        </div>
        <button className="ghost-button" type="button" onClick={onCancel}>取消</button>
      </div>

      <div className="prompt-form-grid">
        <label>
          <span>模板名称</span>
          <input value={form.title} onChange={(event) => update('title', event.target.value)} required />
        </label>
        <label>
          <span>类型</span>
          <select value={form.category} onChange={(event) => update('category', event.target.value)}>
            {promptCategories.map((category) => (
              <option key={category.value} value={category.value}>{category.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>用途</span>
          <input value={form.purpose} onChange={(event) => update('purpose', event.target.value)} placeholder="例如：Emma 日常短内容配图" />
        </label>
        <label>
          <span>平台</span>
          <select value={form.platform} onChange={(event) => update('platform', event.target.value)}>
            <option value="">通用平台</option>
            {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
          </select>
        </label>
        <label>
          <span>角色</span>
          <select value={form.character} onChange={(event) => update('character', event.target.value)}>
            <option value="">通用模板，不绑定角色</option>
            {characters.map((character) => (
              <option key={character.id} value={character.id}>{character.display_name || character.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>推荐工作流</span>
          <select value={form.workflow_id} onChange={(event) => update('workflow_id', event.target.value)}>
            <option value="">不指定工作流</option>
            {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
          </select>
        </label>
        <label>
          <span>来源</span>
          <select value={form.source} onChange={(event) => update('source', event.target.value)}>
            <option value="manual">手动新建</option>
            <option value="ai_generated">AI 生成模板</option>
            <option value="content">从当前内容保存</option>
            <option value="strategy">从已批准策略保存</option>
            <option value="workflow">从工作流保存</option>
            <option value="performance">从高表现内容生成</option>
            <option value="knowledge">从知识条目转换</option>
          </select>
        </label>
        <label>
          <span>状态</span>
          <select value={form.status} onChange={(event) => update('status', event.target.value)}>
            <option value="active">可使用</option>
            <option value="draft">草稿</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <label className="wide-field">
          <span>模板正文</span>
          <textarea rows="7" value={form.content} onChange={(event) => update('content', event.target.value)} required />
          <small>仅在你明确保存时进入提示词库；系统不会自动收集所有 Prompt。</small>
        </label>
        {initialValue && (
          <label className="wide-field">
            <span>修改原因</span>
            <input value={form.change_reason} onChange={(event) => update('change_reason', event.target.value)} placeholder="说明本次版本调整的原因" required />
          </label>
        )}
      </div>

      <section className="prompt-variable-builder">
        <div>
          <h4>模板变量</h4>
          <p>点击变量即可插入模板；右侧填写示例值后即时预览。</p>
          <div className="prompt-variable-chips">
            {Object.entries(PROMPT_VARIABLE_DEFINITIONS).map(([name, definition]) => (
              <button
                key={name}
                type="button"
                onClick={() => update('content', `${form.content}${form.content.endsWith(' ') ? '' : ' '}{{${name}}}`)}
              >
                {`{{${name}}}`} · {definition.label}
              </button>
            ))}
          </div>
        </div>
        <div className="prompt-preview-fields">
          {variables.map((variable) => (
            <label key={variable.name}>
              <span>{variable.label}</span>
              <input
                value={previewValues[variable.name] || ''}
                onChange={(event) => setPreviewValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                placeholder={variable.example}
              />
            </label>
          ))}
        </div>
        <div className="prompt-rendered-preview">
          <span>预览结果</span>
          <p>{preview || '输入模板正文后在这里预览。'}</p>
        </div>
      </section>

      <div className="button-row">
        <button className="primary-button" type="submit">{initialValue ? '保存为新版本' : '创建提示词模板'}</button>
        <button className="ghost-button" type="button" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
