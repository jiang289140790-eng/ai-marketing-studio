import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { StatCard } from '../components/StatCard';
import { agentStatuses, agentTaskStatuses, agentTypes, contentTypes, platforms } from '../data/navigation';
import { listSocialAccounts } from '../services/account-service';
import {
  createAgent,
  deleteAgent,
  executeAgentTask,
  getAgentStats,
  listAgentRuns,
  listAgents,
  listAgentTasks,
  updateAgent,
} from '../services/agent-service';
import { searchAssets } from '../services/asset-service';
import { listCharacters } from '../services/character-service';
import { listPrompts } from '../services/prompt-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

const defaultAgent = {
  name: '',
  description: '',
  type: 'content_generator',
  model: 'gpt-4.1-mini',
  system_prompt: '',
  status: 'active',
  schedule: '{}',
};

const defaultTask = {
  agent_id: '',
  account_id: '',
  platform: 'Instagram',
  goal: '',
  brief: '',
  content_type: 'text',
  character_id: '',
  prompt_id: '',
  workflow_id: '',
  tool_id: 'agent-runtime',
  cost: 0,
};

export function AgentCenter({ userId }) {
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [runs, setRuns] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [characters, setCharacters] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [assetInputs, setAssetInputs] = useState([]);
  const [agentForm, setAgentForm] = useState(defaultAgent);
  const [taskForm, setTaskForm] = useState(defaultTask);
  const [filters, setFilters] = useState({ status: '', agentId: '', taskType: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    const [nextAgents, nextTasks, nextRuns, nextAccounts, nextCharacters, nextPrompts, nextWorkflows, nextAssets] = await Promise.all([
      listAgents(userId),
      listAgentTasks(userId, filters),
      listAgentRuns(userId),
      listSocialAccounts(userId),
      listCharacters(userId),
      listPrompts(userId),
      searchAssets(userId, { type: 'workflow' }),
      searchAssets(userId),
    ]);
    setAgents(nextAgents);
    setTasks(nextTasks);
    setRuns(nextRuns);
    setAccounts(nextAccounts);
    setCharacters(nextCharacters);
    setPrompts(nextPrompts);
    setWorkflows(nextWorkflows);
    setAssetInputs(nextAssets);
    setLoading(false);
  }, [userId, filters]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, [refresh]);

  const stats = useMemo(() => getAgentStats(agents, tasks), [agents, tasks]);
  const selectedAgent = agents.find((agent) => agent.id === taskForm.agent_id);
  const selectedAccount = accounts.find((account) => account.id === taskForm.account_id);
  const selectedCharacter = characters.find((character) => character.id === taskForm.character_id);

  function setAgentField(field, value) {
    setAgentForm((current) => ({ ...current, [field]: value }));
  }

  function setTaskField(field, value) {
    setTaskForm((current) => ({ ...current, [field]: value }));
  }

  async function handleCreateAgent(event) {
    event.preventDefault();
    try {
      const schedule = agentForm.schedule.trim() ? JSON.parse(agentForm.schedule) : {};
      await createAgent(userId, { ...agentForm, schedule });
      setAgentForm(defaultAgent);
      setMessage('Agent 已保存。');
      await refresh();
    } catch (error) {
      setMessage(`保存失败：${error.message}`);
    }
  }

  async function handleAgentStatus(agent, status) {
    try {
      await updateAgent(agent.id, { status });
      setMessage(`Agent 状态已更新为：${statusLabel(status)}。`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleDeleteAgent(agent) {
    try {
      await deleteAgent(agent.id);
      setMessage(`已删除 Agent：${agent.name}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleExecuteTask(event) {
    event.preventDefault();
    if (!selectedAgent) {
      setMessage('请先选择一个 Agent。');
      return;
    }

    try {
      await executeAgentTask(userId, selectedAgent, {
        account_id: taskForm.account_id || null,
        account_name: selectedAccount?.account_name || '',
        account_category: selectedAccount?.account_type || selectedAccount?.account_category || 'brand',
        platform: taskForm.platform,
        goal: taskForm.goal,
        brief: taskForm.brief,
        content_type: taskForm.content_type,
        character_id: taskForm.character_id || null,
        character_name: selectedCharacter?.name || '',
        prompt_id: taskForm.prompt_id || null,
        workflow_id: taskForm.workflow_id || null,
        tool_id: taskForm.tool_id,
        cost: Number(taskForm.cost || 0),
        asset_ids: assetInputs.filter((asset) => asset.selected).map((asset) => asset.id),
      });
      setTaskForm(defaultTask);
      setAssetInputs((current) => current.map((asset) => ({ ...asset, selected: false })));
      setMessage('Agent 已执行，输入/输出日志已写入 agent_runs。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function toggleAsset(assetId) {
    setAssetInputs((current) => current.map((asset) => (
      asset.id === assetId ? { ...asset, selected: !asset.selected } : asset
    )));
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Agent Runtime</p>
          <h2>AI Agent 调度中心</h2>
          <p>只保留三个核心 Agent：内容生成、素材生成、分析。每次执行都会保存输入、输出、状态、成本和耗时。</p>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="Agent数量" value={loading ? '—' : stats.totalAgents} hint="agents" />
        <StatCard label="启用Agent" value={loading ? '—' : stats.activeAgents} hint="active" />
        <StatCard label="任务数量" value={loading ? '—' : stats.totalTasks} hint="agent_tasks" />
        <StatCard label="运行日志" value={loading ? '—' : runs.length} hint="agent_runs" />
        <StatCard label="任务成功率" value={loading ? '—' : `${stats.successRate}%`} hint="success / total" />
        <StatCard label="失败任务" value={loading ? '—' : stats.failedTasks} hint="failed" />
      </div>

      <form className="form-card" onSubmit={handleCreateAgent}>
        <div className="section-head">
          <div>
            <p className="eyebrow">Agent Config</p>
            <h2>创建 / 保存 Agent</h2>
          </div>
        </div>
        <div className="form-grid">
          <label>
            名称
            <input value={agentForm.name} onChange={(event) => setAgentField('name', event.target.value)} required />
          </label>
          <label>
            类型
            <select value={agentForm.type} onChange={(event) => setAgentField('type', event.target.value)}>
              {agentTypes.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </label>
          <label>
            模型
            <input value={agentForm.model} onChange={(event) => setAgentField('model', event.target.value)} placeholder="GPT / Claude / Qwen / local" />
          </label>
          <label>
            状态
            <select value={agentForm.status} onChange={(event) => setAgentField('status', event.target.value)}>
              {agentStatuses.map((status) => (
                <option key={status.value} value={status.value}>{status.label}</option>
              ))}
            </select>
          </label>
          <label className="wide-field">
            描述
            <textarea value={agentForm.description} onChange={(event) => setAgentField('description', event.target.value)} />
          </label>
          <label className="wide-field">
            System Prompt
            <textarea value={agentForm.system_prompt} onChange={(event) => setAgentField('system_prompt', event.target.value)} />
          </label>
          <label className="wide-field">
            Schedule JSON
            <textarea value={agentForm.schedule} onChange={(event) => setAgentField('schedule', event.target.value)} placeholder='{"mode":"manual"}' />
          </label>
        </div>
        <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId}>保存 Agent</button>
      </form>

      <form className="form-card" onSubmit={handleExecuteTask}>
        <div className="section-head">
          <div>
            <p className="eyebrow">Task Runner</p>
            <h2>执行 Agent 任务</h2>
          </div>
        </div>
        <div className="form-grid">
          <label>
            Agent
            <select value={taskForm.agent_id} onChange={(event) => setTaskField('agent_id', event.target.value)} required>
              <option value="">选择 Agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name} · {statusLabel(agent.type)}</option>
              ))}
            </select>
          </label>
          <label>
            账号
            <select value={taskForm.account_id} onChange={(event) => setTaskField('account_id', event.target.value)}>
              <option value="">不指定账号</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.account_name} · {account.platform}</option>
              ))}
            </select>
          </label>
          <label>
            平台
            <select value={taskForm.platform} onChange={(event) => setTaskField('platform', event.target.value)}>
              {platforms.map((platform) => (
                <option key={platform} value={platform}>{platform}</option>
              ))}
            </select>
          </label>
          <label>
            内容类型
            <select value={taskForm.content_type} onChange={(event) => setTaskField('content_type', event.target.value)}>
              {contentTypes.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </label>
          <label>
            角色
            <select value={taskForm.character_id} onChange={(event) => setTaskField('character_id', event.target.value)}>
              <option value="">不指定角色</option>
              {characters.map((character) => (
                <option key={character.id} value={character.id}>{character.name}</option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <select value={taskForm.prompt_id} onChange={(event) => setTaskField('prompt_id', event.target.value)}>
              <option value="">不指定 Prompt</option>
              {prompts.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>{prompt.title}</option>
              ))}
            </select>
          </label>
          <label>
            Workflow
            <select value={taskForm.workflow_id} onChange={(event) => setTaskField('workflow_id', event.target.value)}>
              <option value="">不指定 Workflow</option>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
              ))}
            </select>
          </label>
          <label>
            本次成本
            <input type="number" min="0" step="0.0001" value={taskForm.cost} onChange={(event) => setTaskField('cost', event.target.value)} />
          </label>
          <label className="wide-field">
            内容目标
            <textarea value={taskForm.goal} onChange={(event) => setTaskField('goal', event.target.value)} placeholder="例如：为 X 生成一条 AI 工具增长内容。" />
          </label>
          <label className="wide-field">
            Brief
            <textarea value={taskForm.brief} onChange={(event) => setTaskField('brief', event.target.value)} />
          </label>
        </div>

        <div className="tag-panel">
          <strong>可选输入素材</strong>
          <div className="tag-row">
            {assetInputs.map((asset) => (
              <button key={asset.id} className={`tag selectable ${asset.selected ? 'active' : ''}`} type="button" onClick={() => toggleAsset(asset.id)}>
                {asset.name}
              </button>
            ))}
            {assetInputs.length === 0 && <span className="tag">暂无素材</span>}
          </div>
        </div>

        <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId}>创建并执行任务</button>
      </form>

      {message && <div className="notice">{message}</div>}

      <div className="content-grid">
        {agents.map((agent) => (
          <article className="content-card" key={agent.id}>
            <div className="card-meta">
              <StatusBadge status={agent.status} />
              <span>{statusLabel(agent.type)}</span>
            </div>
            <h3>{agent.name}</h3>
            <p>{agent.description || '暂无描述'}</p>
            <div className="tag-row">
              <span className="tag">{agent.model || '未指定模型'}</span>
              <span className="tag">{formatDate(agent.created_at)}</span>
            </div>
            <div className="status-actions">
              <button type="button" onClick={() => handleAgentStatus(agent, 'active')}>启用</button>
              <button type="button" onClick={() => handleAgentStatus(agent, 'paused')}>暂停</button>
              <button type="button" onClick={() => handleAgentStatus(agent, 'inactive')}>停用</button>
              <button type="button" onClick={() => handleDeleteAgent(agent)}>删除</button>
            </div>
          </article>
        ))}
      </div>

      <div className="filter-bar">
        <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
          <option value="">全部任务状态</option>
          {agentTaskStatuses.map((status) => (
            <option key={status} value={status}>{statusLabel(status)}</option>
          ))}
        </select>
        <select value={filters.agentId} onChange={(event) => setFilters({ ...filters, agentId: event.target.value })}>
          <option value="">全部 Agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>
        <select value={filters.taskType} onChange={(event) => setFilters({ ...filters, taskType: event.target.value })}>
          <option value="">全部任务类型</option>
          <option value="content_generation">内容生成</option>
          <option value="asset_generation">素材生成</option>
          <option value="analysis">分析</option>
        </select>
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后这里会读取 agents、agent_tasks 和 agent_runs。" />
      ) : tasks.length === 0 ? (
        <EmptyState title="暂无 Agent 任务" description="创建一个 Agent，然后执行第一条内容生产任务。" />
      ) : (
        <div className="analysis-list">
          {tasks.map((task) => (
            <article className="analysis-card" key={task.id}>
              <div className="card-meta">
                <StatusBadge status={task.status} />
                <span>{task.agents?.name || '未知 Agent'}</span>
                <span>{statusLabel(task.task_type)}</span>
              </div>
              <h3>{task.input_data?.goal || '未填写任务目标'}</h3>
              <p>{task.input_data?.brief || '暂无 brief'}</p>
              {task.result && <pre className="code-preview">{JSON.stringify(task.result, null, 2)}</pre>}
              <small>
                创建：{formatDate(task.created_at)}
                {task.completed_at ? ` · 完成：${formatDate(task.completed_at)}` : ''}
              </small>
            </article>
          ))}
        </div>
      )}

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Agent Run</th>
              <th>状态</th>
              <th>成本</th>
              <th>耗时</th>
              <th>输出</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 12).map((run) => (
              <tr key={run.id}>
                <td>{run.agent_name}<br /><small>{formatDate(run.created_at)}</small></td>
                <td><StatusBadge status={run.status} /></td>
                <td>{Number(run.cost || 0).toFixed(4)}</td>
                <td>{Number(run.duration || 0)}ms</td>
                <td>{run.error_message || run.output?.kind || run.output?.summary || '—'}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan="5">暂无 Agent 运行日志</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
