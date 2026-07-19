import { useState } from 'react';
import { formatTags, parseTags } from '../utils/tags';

export function CharacterForm({ initialValue, onSubmit, onCancel }) {
  const [form, setForm] = useState(
    initialValue || {
      name: '',
      avatar: '',
      description: '',
      personality: '',
      appearance: '',
      prompt: '',
      lora: '',
      tags: [],
    },
  );

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <form
      className="form-card"
      onSubmit={(event) => {
        event.preventDefault();
        const { tagsText: _tagsText, ...payload } = form;
        onSubmit({ ...payload, tags: parseTags(form.tagsText ?? formatTags(form.tags)) });
      }}
    >
      <div className="form-grid">
        <label>
          角色名称
          <input value={form.name} onChange={(event) => update('name', event.target.value)} required />
        </label>
        <label>
          头像 URL
          <input value={form.avatar || ''} onChange={(event) => update('avatar', event.target.value)} />
        </label>
        <label className="wide-field">
          描述
          <textarea value={form.description || ''} onChange={(event) => update('description', event.target.value)} />
        </label>
        <label>
          性格
          <textarea value={form.personality || ''} onChange={(event) => update('personality', event.target.value)} />
        </label>
        <label>
          外观
          <textarea value={form.appearance || ''} onChange={(event) => update('appearance', event.target.value)} />
        </label>
        <label className="wide-field">
          角色 Prompt
          <textarea value={form.prompt || ''} onChange={(event) => update('prompt', event.target.value)} />
        </label>
        <label>
          LoRA / 模型引用
          <input value={form.lora || ''} onChange={(event) => update('lora', event.target.value)} />
        </label>
        <label>
          标签，逗号分隔
          <input value={form.tagsText ?? formatTags(form.tags)} onChange={(event) => update('tagsText', event.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button className="primary-button" type="submit">保存角色</button>
        <button className="ghost-button" type="button" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
