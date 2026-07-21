import { useState } from 'react';
import { accountCategories, apiStatuses, platforms } from '../data/navigation';

export function AccountForm({ initialValue, onSubmit, onCancel }) {
  const initialRole = initialValue?.account_role || initialValue?.account_type || initialValue?.account_category;
  const normalizedInitialRole = initialRole === 'brand' || initialRole === 'personal' ? 'owned' : initialRole;
  const [form, setForm] = useState({
    platform: 'X',
    username: '',
    account_name: '',
    account_url: '',
    avatar: '',
    account_role: 'owned',
    account_category: 'owned',
    account_type: 'owned',
    target_audience: '',
    content_strategy: '',
    posting_frequency: '',
    status: 'active',
    api_status: 'not_connected',
    ops_notes: '',
    ...(initialValue || {}),
    ...(normalizedInitialRole ? {
      account_role: normalizedInitialRole,
      account_category: normalizedInitialRole,
      account_type: normalizedInitialRole,
    } : {}),
  });

  function update(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'account_role') {
        next.account_type = value;
        next.account_category = value;
      }
      return next;
    });
  }

  return (
    <form
      className="form-card"
      onSubmit={(event) => {
        event.preventDefault();
        const role = form.account_role || form.account_type || form.account_category || 'owned';
        onSubmit({
          ...form,
          username: form.username || form.account_name,
          account_name: form.account_name || form.username,
          account_role: role,
          account_category: role,
          account_type: role,
        });
      }}
    >
      <div className="form-grid">
        <label>
          平台
          <select value={form.platform} onChange={(event) => update('platform', event.target.value)}>
            {platforms.map((platform) => (
              <option key={platform} value={platform}>{platform}</option>
            ))}
          </select>
        </label>
        <label>
          用户名 / Handle
          <input value={form.username || ''} onChange={(event) => update('username', event.target.value)} placeholder="@username 或 channel" required />
        </label>
        <label>
          显示名称
          <input value={form.account_name || ''} onChange={(event) => update('account_name', event.target.value)} placeholder="账号展示名" />
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
          账号角色
          <select value={form.account_role || form.account_type || 'owned'} onChange={(event) => update('account_role', event.target.value)}>
            {accountCategories.map((category) => (
              <option key={category.value} value={category.value}>{category.label}</option>
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
              <option key={status.value} value={status.value}>{status.label}</option>
            ))}
          </select>
        </label>
        <label>
          发布频率
          <input value={form.posting_frequency || ''} onChange={(event) => update('posting_frequency', event.target.value)} placeholder="例如：每天 2 条 / 每周 5 条" />
        </label>
        <label className="wide-field">
          目标受众
          <textarea value={form.target_audience || ''} onChange={(event) => update('target_audience', event.target.value)} placeholder="可留空，后续由 AI 分析账号自动生成" />
        </label>
        <label className="wide-field">
          内容方向
          <textarea value={form.content_strategy || ''} onChange={(event) => update('content_strategy', event.target.value)} placeholder="例如：AI角色、AI图片、AI工具、教程、案例拆解" />
        </label>
        <label className="wide-field">
          账号运营备注
          <textarea value={form.ops_notes || ''} onChange={(event) => update('ops_notes', event.target.value)} placeholder="记录账号定位、注意事项、选题禁区、增长观察等" />
        </label>
      </div>
      <div className="button-row">
        <button className="primary-button" type="submit">保存账号</button>
        {onCancel && (
          <button className="ghost-button" type="button" onClick={onCancel}>取消</button>
        )}
      </div>
    </form>
  );
}
