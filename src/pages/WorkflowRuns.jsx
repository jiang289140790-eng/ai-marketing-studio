import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { platforms, workflowRunStatuses } from '../data/navigation';
import { searchAssets } from '../services/asset-service';
import { listCharacters } from '../services/character-service';
import { listPrompts } from '../services/prompt-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import {
  createWorkflowRun,
  getWorkflowStats,
  listWorkflowRuns,
  saveWorkflowResult,
  updateWorkflowStatus,
} from '../services/workflow-service';
import { durationLabel, formatDate, statusLabel } from '../utils/formatters';

const defaultForm = {
  workflow_id: '',
  tool_id: 'manual-runtime',
  character_id: '',
  prompt_id: '',
  asset_ids: [],
  inputText: '',
  platform: 'Instagram',
  account_category: 'brand',
};

export function WorkflowRuns({ userId }) {
  const [runs, setRuns] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [assets, setAssets] = useState([]);
  const [characters, setCharacters] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const [filters, setFilters] = useState({ status: '', workflowId: '', characterId: '', toolId: '' });
  const [form, setForm] = useState(defaultForm);
  const [resultForm, setResultForm] = useState({});
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    const [nextRuns, nextWorkflows, nextAssets, nextCharacters, nextPrompts] = await Promise.all([
      listWorkflowRuns(userId, filters),
      searchAssets(userId, { type: 'workflow' }),
      searchAssets(userId),
      listCharacters(userId),
      listPrompts(userId),
    ]);
    setRuns(nextRuns);
    setWorkflows(nextWorkflows);
    setAssets(nextAssets);
    setCharacters(nextCharacters);
    setPrompts(nextPrompts);
    setLoading(false);
  }, [userId, filters]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, [refresh]);

  const stats = useMemo(() => getWorkflowStats(runs), [runs]);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function toggleAsset(assetId) {
    setForm((current) => ({
      ...current,
      asset_ids: current.asset_ids.includes(assetId)
        ? current.asset_ids.filter((id) => id !== assetId)
        : [...current.asset_ids, assetId],
    }));
  }

  async function handleCreateRun(event) {
    event.preventDefault();
    try {
      await createWorkflowRun(userId, {
        workflow_id: form.workflow_id || null,
        tool_id: form.tool_id,
        character_id: form.character_id || null,
        prompt_id: form.prompt_id || null,
        asset_ids: form.asset_ids,
        input_data: {
          input: form.inputText,
          platform: form.platform,
          account_category: form.account_category,
        },
      });
      setForm(defaultForm);
      setMessage('Workflow Run 已创建。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleStatus(run, status) {
    try {
      await updateWorkflowStatus(run.id, status);
      setMessage(`任务状态已更新为：${statusLabel(status)}。`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleSaveResult(run) {
    try {
      const result = resultForm[run.id] || {};
      await saveWorkflowResult(userId, run, {
        title: result.title || `${run.workflow?.name || run.tool_id || 'Workflow'} 生成结果`,
        text: result.text || run.prompts?.content || '',
        url: result.url || '',
        thumbnail: result.thumbnail || result.url || '',
        type: result.type || 'image',
        model: result.model || run.workflow?.model || '',
        cost: Number(result.cost || run.cost || 0),
      });
      setResultForm((current) => ({ ...current, [run.id]: {} }));
      setMessage('生成结果已保存：已创建 asset，并写入内容库草稿。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function updateResult(runId, field, value) {
    setResultForm((current) => ({
      ...current,
      [runId]: {
        ...(current[runId] || {}),
        [field]: value,
      },
    }));
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Workflow Runtime Center</p>
          <h2>AI 内容生产闭环</h2>
          <p>从角色、Prompt、素材和 Workflow 出发，记录生成任务，成功后沉淀到素材库和内容库。</p>
        </div>
      </div>

      <div className="workflow-chain">
        <span>角色</span>
        <span>Prompt</span>
        <span>素材</span>
        <span>Workflow</span>
        <span>生成结果</span>
        <span>内容库</span>
      </div>

      <div className="stat-grid">
        <article className="stat-card">
          <span>今日生成任务</span>
          <strong>{loading ? '—' : stats.todayRuns}</strong>
          <small>来自 workflow_runs</small>
        </article>
        <article className="stat-card">
          <span>成功率</span>
          <strong>{loading ? '—' : `${stats.successRate}%`}</strong>
          <small>success / total</small>
        </article>
        <article className="stat-card">
          <span>成本</span>
          <strong>{loading ? '—' : stats.cost.toFixed(2)}</strong>
          <small>累计 cost</small>
        </article>
        <article className="stat-card">
          <span>热门 Workflow</span>
          <strong>{loading ? '—' : stats.topWorkflow}</strong>
          <small>运行次数最多</small>
        </article>
      </div>

      <form className="form-card" onSubmit={handleCreateRun}>
        <div className="form-grid">
          <label>
            Workflow 资产
            <select value={form.workflow_id} onChange={(event) => updateForm('workflow_id', event.target.value)}>
              <option value="">不选择 Workflow 资产</option>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
              ))}
            </select>
          </label>
          <label>
            Tool ID
            <input
              value={form.tool_id}
              onChange={(event) => updateForm('tool_id', event.target.value)}
              placeholder="comfyui / n8n / manual"
            />
          </label>
          <label>
            角色
            <select value={form.character_id} onChange={(event) => updateForm('character_id', event.target.value)}>
              <option value="">不关联角色</option>
              {characters.map((character) => (
                <option key={character.id} value={character.id}>{character.name}</option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <select value={form.prompt_id} onChange={(event) => updateForm('prompt_id', event.target.value)}>
              <option value="">不关联 Prompt</option>
              {prompts.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>{prompt.title}</option>
              ))}
            </select>
          </label>
          <label>
            平台
            <select value={form.platform} onChange={(event) => updateForm('platform', event.target.value)}>
              {platforms.map((platform) => (
                <option key={platform} value={platform}>{platform}</option>
              ))}
            </select>
          </label>
          <label>
            账号分类
            <input value={form.account_category} onChange={(event) => updateForm('account_category', event.target.value)} />
          </label>
          <label className="wide-field">
            输入数据
            <textarea
              value={form.inputText}
              onChange={(event) => updateForm('inputText', event.target.value)}
              placeholder="描述这次生成任务的目标、约束、素材使用方式和想要输出的内容。"
            />
          </label>
        </div>

        <div className="tag-panel">
          <strong>输入素材</strong>
          <div className="tag-row">
            {assets.map((asset) => (
              <button
                key={asset.id}
                className={`tag selectable ${form.asset_ids.includes(asset.id) ? 'active' : ''}`}
                type="button"
                onClick={() => toggleAsset(asset.id)}
              >
                {asset.name}
              </button>
            ))}
            {assets.length === 0 && <span className="tag">暂无素材</span>}
          </div>
        </div>

        <div className="button-row">
          <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId}>
            创建 Run
          </button>
        </div>
      </form>

      {message && <div className="notice">{message}</div>}

      <div className="filter-bar">
        <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
          <option value="">全部状态</option>
          {workflowRunStatuses.map((status) => (
            <option key={status} value={status}>{statusLabel(status)}</option>
          ))}
        </select>
        <select value={filters.workflowId} onChange={(event) => setFilters({ ...filters, workflowId: event.target.value })}>
          <option value="">全部 Workflow</option>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
          ))}
        </select>
        <select value={filters.characterId} onChange={(event) => setFilters({ ...filters, characterId: event.target.value })}>
          <option value="">全部角色</option>
          {characters.map((character) => (
            <option key={character.id} value={character.id}>{character.name}</option>
          ))}
        </select>
        <input placeholder="Tool ID" value={filters.toolId} onChange={(event) => setFilters({ ...filters, toolId: event.target.value })} />
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后这里会从 workflow_runs 表读取生产任务。" />
      ) : runs.length === 0 ? (
        <EmptyState title="暂无 Workflow Run" description="选择角色、Prompt、素材和 Workflow，创建第一条生产任务。" />
      ) : (
        <div className="analysis-list">
          {runs.map((run) => (
            <article className="analysis-card" key={run.id}>
              <div className="card-meta">
                <StatusBadge status={run.status} />
                <span>{run.workflow?.name || run.tool_id || 'Manual Workflow'}</span>
                <span>{durationLabel(run.created_at, run.completed_at)}</span>
                <span>成本 {Number(run.cost || 0).toFixed(2)}</span>
              </div>
              <h3>{run.characters?.name || '未关联角色'} → {run.prompts?.title || '未关联 Prompt'}</h3>
              <p>{run.input_data?.input || '暂无输入描述'}</p>

              <div className="status-actions">
                <button type="button" onClick={() => handleStatus(run, 'running')}>标记运行中</button>
                <button type="button" onClick={() => handleStatus(run, 'failed')}>标记失败</button>
              </div>

              <div className="form-grid compact-form">
                <input placeholder="结果标题" value={resultForm[run.id]?.title || ''} onChange={(event) => updateResult(run.id, 'title', event.target.value)} />
                <input placeholder="结果 URL" value={resultForm[run.id]?.url || ''} onChange={(event) => updateResult(run.id, 'url', event.target.value)} />
                <input placeholder="类型 image/video/text" value={resultForm[run.id]?.type || ''} onChange={(event) => updateResult(run.id, 'type', event.target.value)} />
                <input placeholder="成本" value={resultForm[run.id]?.cost || ''} onChange={(event) => updateResult(run.id, 'cost', event.target.value)} />
                <textarea placeholder="输出文本 / 文案" value={resultForm[run.id]?.text || ''} onChange={(event) => updateResult(run.id, 'text', event.target.value)} />
              </div>

              <button className="primary-button" type="button" onClick={() => handleSaveResult(run)}>
                保存成功结果到素材与内容库
              </button>
              {run.output_data && <pre className="code-preview">{JSON.stringify(run.output_data, null, 2)}</pre>}
              {run.error_message && <div className="notice error">{run.error_message}</div>}
              <small>{formatDate(run.created_at)}</small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
