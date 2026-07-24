import { useState } from 'react';
import { formatTags, parseTags } from '../utils/tags';
import { parseLoraConfig, serializeLoraConfig } from '../utils/lora';

export function CharacterForm({ initialValue, onSubmit, onCancel }) {
  const [form, setForm] = useState(() => {
    const base = initialValue || {
      name: '',
      avatar: '',
      description: '',
      personality: '',
      appearance: '',
      prompt: '',
      lora: '',
      tags: [],
    };
    return { ...base, loraConfig: parseLoraConfig(base.lora) };
  });

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateLora(field, value) {
    setForm((current) => ({
      ...current,
      loraConfig: { ...current.loraConfig, [field]: value },
    }));
  }

  return (
    <form
      className="form-card character-form"
      onSubmit={(event) => {
        event.preventDefault();
        const { tagsText: _tagsText, loraConfig, ...payload } = form;
        onSubmit({
          ...payload,
          lora: serializeLoraConfig(loraConfig),
          tags: parseTags(form.tagsText ?? formatTags(form.tags)),
        });
      }}
    >
      <div className="form-card-heading">
        <p className="eyebrow">{initialValue ? 'Edit Character' : 'New Character'}</p>
        <h3>{initialValue ? `编辑 ${initialValue.name}` : '创建人物角色'}</h3>
        <p>角色设定与 LoRA 会一起保存，内容工作台可直接读取这些生成参数。</p>
      </div>
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
          标签，逗号分隔
          <input value={form.tagsText ?? formatTags(form.tags)} onChange={(event) => update('tagsText', event.target.value)} />
        </label>
      </div>

      <fieldset className="lora-config-fieldset">
        <legend>LoRA 配置</legend>
        <p>绑定模型后，图片和视频生成会自动携带对应 LoRA、权重与触发词。</p>
        <div className="form-grid">
          <label>
            显示名称
            <input value={form.loraConfig.name} onChange={(event) => updateLora('name', event.target.value)} placeholder="例如：Nina Voss Character LoRA" />
          </label>
          <label>
            模型 / Civitai 引用
            <input value={form.loraConfig.model} onChange={(event) => updateLora('model', event.target.value)} placeholder="模型名称、ID 或 URL" />
          </label>
          <label>
            版本
            <input value={form.loraConfig.version} onChange={(event) => updateLora('version', event.target.value)} placeholder="例如：v1.0" />
          </label>
          <label>
            模型文件名
            <input value={form.loraConfig.filename} onChange={(event) => updateLora('filename', event.target.value)} placeholder="例如：nina_voss_v1.safetensors" />
          </label>
          <label>
            默认权重
            <input type="number" min="0" max="2" step="0.05" value={form.loraConfig.weight} onChange={(event) => updateLora('weight', event.target.value)} />
          </label>
          <label>
            关联 Workflow
            <input value={form.loraConfig.workflow} onChange={(event) => updateLora('workflow', event.target.value)} placeholder="Workflow 名称或 ID" />
          </label>
          <label className="wide-field">
            触发词
            <textarea value={form.loraConfig.trigger_words} onChange={(event) => updateLora('trigger_words', event.target.value)} placeholder="多个触发词可用逗号分隔" />
          </label>
        </div>
        <div className="lora-capability-row">
          <label className="checkbox-row">
            <input type="checkbox" checked={form.loraConfig.image_enabled} onChange={(event) => updateLora('image_enabled', event.target.checked)} />
            用于图片生成
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={form.loraConfig.video_enabled} onChange={(event) => updateLora('video_enabled', event.target.checked)} />
            用于视频生成
          </label>
        </div>
      </fieldset>

      <div className="button-row">
        <button className="primary-button" type="submit">保存角色</button>
        <button className="ghost-button" type="button" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
