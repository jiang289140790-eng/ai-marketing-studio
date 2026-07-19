import { useState } from 'react';
import { accountCategories, apiStatuses, platforms } from '../data/navigation';

export function AccountForm({ initialValue, onSubmit, onCancel }) {
  const [form, setForm] = useState({
    platform: 'X',
    account_name: '',
    account_url: '',
    avatar: '',
    account_category: 'brand',
    account_type: 'brand',
    target_audience: '',
    content_strategy: '',
    posting_frequency: '',
    status: 'active',
    api_status: 'not_connected',
    ops_notes: '',
    ...(initialValue || {}),
  });

  function update(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'account_type') next.account_category = value;
      if (field === 'account_category') next.account_type = value;
      return next;
    });
  }

  return (
    <form
      className="form-card"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          ...form,
          account_category: form.account_type || form.account_category || 'brand',
          account_type: form.account_type || form.account_category || 'brand',
        });
      }}
    >
      <div className="form-grid">
        <label>
          平台
          <select value={form.platform} onChange={(event) => update('platform', event.target.value)}>
            {platforms.map((platform) => (
              <option key={platform} value={platform}>
                {platform}
              </option>
            ))}
          </select>
        </label>
        <label>
          账号名称
          <input value={form.account_name} onChange={(event) => update('account_name', event.target.value)} required />
        </label>
        <label>
          账号链接
          <input value={form.account_url || ''} onChange={(event) => update('account_url', event.target.value)} />
        </label>
        <label>
          头像 URL
          <input value={form.avatar || ''} onChange={(event) => update('avatar', event.target.value)} />
        </label>
        <label>
          账号类型
          <select value={form.account_type || form.account_category || 'brand'} onChange={(event) => update('account_type', event.target.value)}>
            {accountCategories.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          账号状态
          <select value={form.status} onChange={(event) => update('status', event.target.value)}>
            <option value="active">正常运营</option>
            <option value="inactive">暂停运营</option>
            <option value="needs_review">需要检查</option>
          </select>
        </label>
        <label>
          API 状态
          <select value={form.api_status || 'not_connected'} onChange={(event) => update('api_status', event.target.value)}>
            {apiStatuses.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          发布频率
          <input value={form.posting_frequency || ''} onChange={(event) => update('posting_frequency', event.target.value)} placeholder="例如：每天 2 条 / 每周 5 条" />
        </label>
        <label className="wide-field">
          目标受众
          <textarea value={form.target_audience || ''} onChange={(event) => update('target_audience', event.target.value)} placeholder="例如：欧美 AI 用户、独立创作者、AI 图片玩家" />
        </label>
        <label className="wide-field">
          内容方向
          <textarea value={form.content_strategy || ''} onChange={(event) => update('content_strategy', event.target.value)} placeholder="例如：AI 角色、AI 图片、AI 工具、教程、案例拆解" />
        </label>
        <label className="wide-field">
          账号运营备注
          <textarea value={form.ops_notes || ''} onChange={(event) => update('ops_notes', event.target.value)} placeholder="记录账号定位、注意事项、选题禁区、增长观察等" />
        </label>
      </div>
      <div className="button-row">
        <button className="primary-button" type="submit">
          保存账号
        </button>
        {onCancel && (
          <button className="ghost-button" type="button" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}
