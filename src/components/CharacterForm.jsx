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
    return {
      ...base,
      identity: base.content_positioning || base.description || '',
      copyTone: base.prompt_templates?.copy_tone || base.prompt_templates?.tone || '',
      negativePrompt: base.prompt_templates?.negative_prompt || '',
      recommendedWorkflowsText: toText(base.recommended_workflows),
      boundAccountsText: toText(base.lora_info?.bound_account_ids),
      referenceImagesText: toText(base.visual_spec?.reference_images),
      loraConfig: {
        ...parseLoraConfig(base.lora),
        ...(base.lora_info && typeof base.lora_info === 'object' ? base.lora_info : {}),
      },
    };
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
        const {
          tagsText: _tagsText,
          loraConfig,
          identity,
          copyTone,
          negativePrompt,
          recommendedWorkflowsText,
          boundAccountsText,
          referenceImagesText,
          ...payload
        } = form;
        const loraInfo = {
          ...(initialValue?.lora_info || {}),
          ...loraConfig,
          weight: Number(loraConfig.weight || 0.8),
          bound_account_ids: toList(boundAccountsText),
        };
        onSubmit({
          ...payload,
          lora: serializeLoraConfig(loraConfig),
          lora_info: loraInfo,
          content_positioning: identity,
          prompt_templates: {
            ...(initialValue?.prompt_templates || {}),
            copy_tone: copyTone,
            base_prompt: form.prompt || '',
            negative_prompt: negativePrompt,
          },
          recommended_workflows: toList(recommendedWorkflowsText),
          visual_spec: {
            ...(initialValue?.visual_spec || {}),
            reference_images: toList(referenceImagesText),
          },
          status: form.status || 'active',
          tags: parseTags(form.tagsText ?? formatTags(form.tags)),
        });
      }}
    >
      <div className="form-card-heading">
        <p className="eyebrow">{initialValue ? 'Edit Character' : 'New Character'}</p>
        <h3>{initialValue ? `编辑 ${initialValue.name}` : '创建人物角色'}</h3>
        <p>角色设定与角色模型（LoRA）会一起保存，内容工作台可直接读取这些生成参数。</p>
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
        <label className="wide-field">
          人物身份 / 内容定位
          <textarea value={form.identity || ''} onChange={(event) => update('identity', event.target.value)} placeholder="这个角色是谁、服务什么账号、长期承担什么内容身份" />
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
          角色提示词
          <textarea value={form.prompt || ''} onChange={(event) => update('prompt', event.target.value)} />
        </label>
        <label>
          文案语气
          <textarea value={form.copyTone || ''} onChange={(event) => update('copyTone', event.target.value)} placeholder="例如：自然、克制、亲密但不过度承诺" />
        </label>
        <label>
          Negative Prompt
          <textarea value={form.negativePrompt || ''} onChange={(event) => update('negativePrompt', event.target.value)} />
        </label>
        <label className="wide-field">
          推荐工作流，逗号分隔
          <input value={form.recommendedWorkflowsText || ''} onChange={(event) => update('recommendedWorkflowsText', event.target.value)} placeholder="工作流 ID 或名称" />
        </label>
        <label>
          绑定账号 ID，逗号分隔
          <input value={form.boundAccountsText || ''} onChange={(event) => update('boundAccountsText', event.target.value)} />
        </label>
        <label>
          可用状态
          <select value={form.status || 'active'} onChange={(event) => update('status', event.target.value)}>
            <option value="active">可用</option>
            <option value="inactive">暂停使用</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <label className="wide-field">
          角色参考图 URL，逗号分隔
          <textarea value={form.referenceImagesText || ''} onChange={(event) => update('referenceImagesText', event.target.value)} />
        </label>
        <label>
          标签，逗号分隔
          <input value={form.tagsText ?? formatTags(form.tags)} onChange={(event) => update('tagsText', event.target.value)} />
        </label>
      </div>

      <fieldset className="lora-config-fieldset">
        <legend>角色模型（LoRA）配置</legend>
        <p>绑定模型后，图片和视频生成会自动携带对应角色模型、权重与触发词。</p>
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
            关联工作流
            <input value={form.loraConfig.workflow} onChange={(event) => updateLora('workflow', event.target.value)} placeholder="工作流名称或 ID" />
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

function toList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

function toText(value) {
  return toList(value).join(', ');
}
