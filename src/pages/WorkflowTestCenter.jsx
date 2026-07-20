import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { listContent } from '../services/content-service';
import {
  comfyWorkflowCategories,
  generateImageAssetForContent,
  listComfyWorkflows,
} from '../services/media-gateway-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

export function WorkflowTestCenter({ userId }) {
  const [workflows, setWorkflows] = useState([]);
  const [contents, setContents] = useState([]);
  const [filters, setFilters] = useState({ search: '', category: '', status: 'active' });
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [selectedContentId, setSelectedContentId] = useState('');
  const [runningWorkflowId, setRunningWorkflowId] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    try {
      const [nextWorkflows, nextContents] = await Promise.all([
        listComfyWorkflows(userId, {
          mode: filters.category === 'video_generation' ? undefined : 'image',
          status: filters.status,
          category: filters.category,
          search: filters.search,
        }),
        listContent(userId, {}),
      ]);
      setWorkflows(nextWorkflows);
      setContents(nextContents);
      if (!selectedWorkflowId && nextWorkflows[0]) setSelectedWorkflowId(nextWorkflows[0].id);
      if (!selectedContentId && nextContents[0]) setSelectedContentId(nextContents[0].id);
    } finally {
      setLoading(false);
    }
  }, [filters, selectedContentId, selectedWorkflowId, userId]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  const selectedContent = useMemo(
    () => contents.find((item) => item.id === selectedContentId) || contents[0] || null,
    [contents, selectedContentId],
  );

  async function handleTestGenerate(workflow) {
    if (!selectedContent) {
      setMessage('请先在内容库准备一条内容草稿，再测试生成素材。');
      return;
    }

    setRunningWorkflowId(workflow.id);
    setMessage('');
    try {
      const result = await generateImageAssetForContent(userId, selectedContent, {
        workflow_id: workflow.id,
        category: workflow.category,
        source: 'workflow_test_center',
      });
      setMessage(`测试生成完成，已保存到素材库。Asset ID: ${result.asset_id || '—'}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setRunningWorkflowId('');
    }
  }

  function categoryLabel(value) {
    return comfyWorkflowCategories.find((category) => category.value === value)?.label || value;
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">ComfyUI Workflow Registry</p>
          <h2>Workflow Test Center</h2>
          <p>验证生产 Workflow：选择内容草稿和 ComfyUI Workflow，触发 Media Gateway 生成图片并保存到素材库。</p>
        </div>
      </div>

      {message && <div className={`notice ${message.includes('完成') ? '' : 'error'}`}>{message}</div>}

      <div className="form-grid">
        <label>
          测试内容
          <select value={selectedContentId} onChange={(event) => setSelectedContentId(event.target.value)}>
            <option value="">选择内容草稿</option>
            {contents.map((content) => (
              <option key={content.id} value={content.id}>
                {content.title} · {content.platform || '未选平台'}
              </option>
            ))}
          </select>
        </label>
        <label>
          搜索 Workflow
          <input value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="名称 / 模型 / LoRA" />
        </label>
        <label>
          分类
          <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
            <option value="">全部分类</option>
            {comfyWorkflowCategories.map((category) => (
              <option key={category.value} value={category.value}>{category.label}</option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="">全部状态</option>
            <option value="active">active</option>
            <option value="draft">draft</option>
            <option value="archived">archived</option>
          </select>
        </label>
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置 Supabase 后，这里会读取 comfy_workflows 和内容库。" />
      ) : workflows.length === 0 ? (
        <EmptyState
          title={loading ? '正在读取 Workflow' : '暂无 ComfyUI Workflow'}
          description="先用 scripts/comfy-workflow-registry.mjs 扫描并同步生产 Workflow，再到这里测试生成。"
        />
      ) : (
        <div className="content-grid">
          {workflows.map((workflow) => (
            <article className="content-card" key={workflow.id}>
              <div className="media-placeholder">{workflow.mode || 'workflow'}</div>
              <div>
                <div className="card-meta">
                  <span>{categoryLabel(workflow.category)}</span>
                  <span>{workflow.model || 'custom'}</span>
                  <StatusBadge status={workflow.status} />
                </div>
                <h3>{workflow.name}</h3>
                <p>{workflow.description || '从 ComfyUI workflow JSON 注册。'}</p>
                <dl>
                  <div><dt>版本</dt><dd>{workflow.version || '1.0.0'}</dd></div>
                  <div><dt>Checkpoint</dt><dd>{workflow.checkpoint || '—'}</dd></div>
                  <div><dt>LoRA</dt><dd>{workflow.loras?.length ? workflow.loras.join(', ') : '—'}</dd></div>
                  <div><dt>ControlNet</dt><dd>{workflow.controlnets?.length ? workflow.controlnets.join(', ') : '—'}</dd></div>
                  <div><dt>输入映射</dt><dd>{Object.keys(workflow.node_mappings || {}).join(', ') || '—'}</dd></div>
                  <div><dt>同步时间</dt><dd>{workflow.last_synced_at ? formatDate(workflow.last_synced_at) : '—'}</dd></div>
                </dl>
                <details>
                  <summary>查看输入参数</summary>
                  <pre className="code-preview">{JSON.stringify(workflow.input_schema || {}, null, 2)}</pre>
                </details>
                <div className="table-actions">
                  <button
                    type="button"
                    onClick={() => handleTestGenerate(workflow)}
                    disabled={runningWorkflowId === workflow.id || workflow.mode === 'video'}
                  >
                    {runningWorkflowId === workflow.id ? '生成中...' : '测试生成'}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
