import { useState } from 'react';
import { platforms, promptCategories } from '../data/navigation';

export function PromptForm({ initialValue, characters = [], onSubmit, onCancel }) {
  const [form, setForm] = useState(
    initialValue || {
      title: '',
      category: 'general',
      content: '',
      platform: 'X',
      character: '',
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
        const { characters: _characters, ...payload } = form;
        onSubmit({ ...payload, character: form.character || null });
      }}
    >
      <div className="form-grid">
        <label>
          标题
          <input value={form.title} onChange={(event) => update('title', event.target.value)} required />
        </label>
        <label>
          分类
          <select value={form.category} onChange={(event) => update('category', event.target.value)}>
            {promptCategories.map((category) => (
              <option key={category.value} value={category.value}>{category.label}</option>
            ))}
          </select>
        </label>
        <label>
          平台
          <select value={form.platform || 'X'} onChange={(event) => update('platform', event.target.value)}>
            {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
          </select>
        </label>
        <label>
          关联角色
          <select value={form.character || ''} onChange={(event) => update('character', event.target.value)}>
            <option value="">不关联角色</option>
            {characters.map((character) => (
              <option key={character.id} value={character.id}>{character.name}</option>
            ))}
          </select>
        </label>
        <label className="wide-field">
          提示词内容
          <textarea value={form.content} onChange={(event) => update('content', event.target.value)} required />
        </label>
      </div>
      <div className="button-row">
        <button className="primary-button" type="submit">保存提示词</button>
        <button className="ghost-button" type="button" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
