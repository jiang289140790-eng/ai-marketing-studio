import { useState } from 'react';
import { assetTypes } from '../data/navigation';
import { formatTags, parseTags } from '../utils/tags';

export function AssetForm({ initialValue, onSubmit, onCancel }) {
  const [form, setForm] = useState(
    initialValue || {
      name: '',
      type: 'image',
      url: '',
      thumbnail: '',
      prompt: '',
      model: '',
      workflowText: '',
      tags: [],
      source: 'manual',
    },
  );

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function normalizedPayload() {
    let workflow = null;
    if (form.workflowText) {
      try {
        workflow = JSON.parse(form.workflowText);
      } catch {
        workflow = { raw: form.workflowText };
      }
    }

    return {
      name: form.name,
      type: form.type,
      url: form.url || null,
      thumbnail: form.thumbnail || form.url || null,
      prompt: form.prompt || null,
      model: form.model || null,
      workflow,
      tags: parseTags(form.tagsText ?? formatTags(form.tags)),
      source: form.source || 'manual',
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
          名称
          <input value={form.name} onChange={(event) => update('name', event.target.value)} required />
        </label>
        <label>
          类型
          <select value={form.type} onChange={(event) => update('type', event.target.value)}>
            {assetTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
        </label>
        <label>
          URL
          <input value={form.url || ''} onChange={(event) => update('url', event.target.value)} />
        </label>
        <label>
          缩略图
          <input value={form.thumbnail || ''} onChange={(event) => update('thumbnail', event.target.value)} />
        </label>
        <label>
          模型 / LoRA
          <input value={form.model || ''} onChange={(event) => update('model', event.target.value)} />
        </label>
        <label>
          标签，逗号分隔
          <input value={form.tagsText ?? formatTags(form.tags)} onChange={(event) => update('tagsText', event.target.value)} />
        </label>
        <label className="wide-field">
          Prompt
          <textarea value={form.prompt || ''} onChange={(event) => update('prompt', event.target.value)} />
        </label>
        <label className="wide-field">
          Workflow JSON / 说明
          <textarea value={form.workflowText || ''} onChange={(event) => update('workflowText', event.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button className="primary-button" type="submit">保存资产</button>
        <button className="ghost-button" type="button" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
