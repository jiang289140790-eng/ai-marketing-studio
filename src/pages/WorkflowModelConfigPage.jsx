import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { getAssets, loadWorkflowConfigData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

export function WorkflowModelConfigPage({ userId }) {
  const [data, setData] = useState({ comfyWorkflows: [], characters: [], assets: [], legacyAssets: [], workflowRuns: [] });

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    loadWorkflowConfigData().then((nextData) => setData({ comfyWorkflows: [], characters: [], assets: [], legacyAssets: [], workflowRuns: [], ...nextData }));
    return undefined;
  }, [userId]);

  const modelAssets = useMemo(() => getAssets(data).filter((asset) => ['workflow', 'lora'].includes(asset.type)), [data]);

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待数据服务配置" description="配置完成后，这里会显示工作流与模型配置。" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看工作流与模型配置。" />;
  }

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">工作流与模型配置</p>
        <h2>工作流、角色模型（LoRA）、角色和素材生成能力集中管理</h2>
        <p>
          不单独创建角色模型页面。角色模型（LoRA）进入角色库详情，工作流作为模型配置参与内容工作台的素材生成。
          这里只做配置总览，不显示密钥、内网地址或复杂模型参数。
        </p>
      </div>

      <div className="stat-grid compact">
        <StatCard label="可用工作流" value={data.comfyWorkflows.length} hint="用于图片 / 视频生成" />
        <StatCard label="角色" value={data.characters.length} hint="可绑定 LoRA" />
        <StatCard label="模型资产" value={modelAssets.length} hint="工作流 / 角色模型" />
        <StatCard label="最近生成任务" value={data.workflowRuns.length} hint="素材生产记录" />
      </div>

      <div className="asset-grid">
        {data.comfyWorkflows.length ? data.comfyWorkflows.map((workflow) => (
          <article className="asset-card" key={workflow.id}>
            <div className="prompt-card">{workflow.mode || workflow.category || '工作流'}</div>
            <h3>{workflow.name || '未命名工作流'}</h3>
            <p>{workflow.description || workflow.model || workflow.checkpoint || '用于内容工作台的素材生成流程。'}</p>
            <div className="card-meta">
              <StatusBadge status={workflow.status || 'active'} />
              <span>{workflow.category || workflow.mode || '通用生成'}</span>
            </div>
            <small>{formatDate(workflow.created_at || workflow.updated_at)}</small>
          </article>
        )) : <EmptyState title="暂无工作流配置" description="导入 ComfyUI 工作流后会出现在这里，并可被内容工作台调用。" />}
      </div>
    </section>
  );
}
