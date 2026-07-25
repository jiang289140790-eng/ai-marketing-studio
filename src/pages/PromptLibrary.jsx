import { useCallback, useEffect, useMemo, useState } from 'react';
import { ContextAIBox } from '../components/ContextAIBox';
import { EmptyState } from '../components/EmptyState';
import { MoreActionsMenu } from '../components/MoreActionsMenu';
import { PromptForm } from '../components/PromptForm';
import { StatusBadge } from '../components/StatusBadge';
import { useConfirmation } from '../contexts/confirmation-context';
import { platforms, promptCategories } from '../data/navigation';
import { buildContentContext } from '../services/context-ai-service';
import { listCharacters } from '../services/character-service';
import { readRows } from '../services/ops-service';
import {
  createPrompt,
  deletePrompt,
  listPrompts,
  listPromptVersions,
  updatePrompt,
} from '../services/prompt-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import { formatDate } from '../utils/formatters';
import {
  getPromptCategoryLabel,
  promptTemplateStatus,
  promptTemplateVersion,
  renderPromptTemplate,
} from '../utils/prompt-template-model';

const SOURCE_LABELS = {
  manual: '手动新建',
  ai_generated: 'AI 生成模板',
  content: '当前内容',
  strategy: '已批准策略',
  workflow: '工作流',
  performance: '高表现内容',
  knowledge: '知识条目',
  manual_task: '能力中心任务',
};

export function PromptLibrary({
  activeCampaignId,
  campaignContext,
  dataScope = 'campaign',
  userId,
  detailId,
  onNavigate,
}) {
  const { confirm } = useConfirmation();
  const [allPrompts, setAllPrompts] = useState([]);
  const [characters, setCharacters] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [versions, setVersions] = useState([]);
  const [activeCategory, setActiveCategory] = useState('');
  const [filters, setFilters] = useState({ search: '', platform: '', character: '' });
  const [isCreating, setIsCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detailTab, setDetailTab] = useState('overview');
  const [message, setMessage] = useState('');
  const [contextAIOpen, setContextAIOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    const [nextPrompts, nextCharacters, nextWorkflows] = await Promise.all([
      listPrompts(userId, filters),
      listCharacters(userId),
      readRows('comfyWorkflows'),
    ]);
    const scopeOptions = { scope: dataScope, campaignContext, activeCampaignId, includeGlobal: true };
    setAllPrompts(filterRecordsForAuxiliaryScope(nextPrompts, scopeOptions));
    setCharacters(filterRecordsForAuxiliaryScope(nextCharacters, scopeOptions));
    setWorkflows(filterRecordsForAuxiliaryScope(nextWorkflows, scopeOptions));
  }, [activeCampaignId, campaignContext, dataScope, filters, userId]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  useEffect(() => {
    if (!detailId || !allPrompts.length) return;
    setSelected(allPrompts.find((prompt) => String(prompt.id) === String(detailId)) || null);
  }, [allPrompts, detailId]);

  useEffect(() => {
    if (!selected?.id || !userId) {
      setVersions([]);
      return;
    }
    listPromptVersions(userId, selected.id).then(setVersions).catch((error) => setMessage(error.message));
  }, [selected?.id, userId]);

  const prompts = useMemo(() => (
    allPrompts.filter((prompt) => !activeCategory || prompt.category === activeCategory)
  ), [activeCategory, allPrompts]);

  async function handleSave(payload) {
    try {
      if (editing) {
        await updatePrompt(editing.id, payload);
        setMessage('已创建新的模板版本，旧版本保留在版本历史中。');
      } else {
        await createPrompt(userId, payload);
        setMessage('提示词模板已创建。');
      }
      setEditing(null);
      setIsCreating(false);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleDelete(prompt) {
    const accepted = await confirm({
      title: '删除提示词模板？',
      message: `将删除“${prompt.title || '未命名模板'}”。已生成内容不会受影响，但工作流绑定需要重新选择。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!accepted) return;
    try {
      await deletePrompt(prompt.id);
      if (selected?.id === prompt.id) {
        setSelected(null);
        onNavigate('prompts');
      }
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleAISave(payload) {
    try {
      await createPrompt(userId, {
        ...payload,
        campaign_id: activeCampaignId,
        source: 'ai_generated',
        purpose: '由 AI 辅助生成的可复用模板',
      });
      setMessage('AI 模板已按你的明确操作保存；其它生成 Prompt 不会自动入库。');
      setContextAIOpen(false);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function openDetail(prompt) {
    setSelected(prompt);
    setDetailTab('overview');
    onNavigate('prompts', prompt.id);
  }

  return (
    <section className="page-stack prompt-capability-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">提示词模板中心</p>
          <h2>保存真正可复用的生成模板</h2>
          <p>模板负责结构与变量；角色 LoRA 继续由角色库管理，真实执行能力由工作流页面管理。</p>
        </div>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => setIsCreating(true)} disabled={!userId}>新建提示词</button>
          <button className="ghost-button" type="button" onClick={() => setContextAIOpen(true)} disabled={!userId}>AI 生成模板</button>
        </div>
      </div>

      <div className="capability-tabs" role="tablist" aria-label="提示词模板分类">
        <button className={!activeCategory ? 'active' : ''} type="button" onClick={() => setActiveCategory('')}>全部</button>
        {promptCategories.map((category) => (
          <button
            className={activeCategory === category.value ? 'active' : ''}
            key={category.value}
            type="button"
            onClick={() => setActiveCategory(category.value)}
          >
            {category.label}
          </button>
        ))}
      </div>

      <div className="filter-bar">
        <input placeholder="搜索名称、用途或正文" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <select value={filters.platform} onChange={(event) => setFilters({ ...filters, platform: event.target.value })}>
          <option value="">全部平台</option>
          {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
        </select>
        <select value={filters.character} onChange={(event) => setFilters({ ...filters, character: event.target.value })}>
          <option value="">全部角色</option>
          {characters.map((character) => (
            <option key={character.id} value={character.id}>{character.display_name || character.name}</option>
          ))}
        </select>
      </div>

      {(isCreating || editing) && (
        <PromptForm
          activeCampaignId={activeCampaignId}
          initialValue={editing}
          characters={characters}
          workflows={workflows}
          onSubmit={handleSave}
          onCancel={() => {
            setIsCreating(false);
            setEditing(null);
          }}
        />
      )}

      {message && <div className="notice">{message}</div>}

      {!isSupabaseConfigured ? (
        <EmptyState title="提示词数据服务未连接" reason="当前页面无法读取 prompts。" prerequisite="请先恢复 Supabase 连接。" actionHref="#/connections" actionLabel="检查平台连接" />
      ) : prompts.length === 0 ? (
        <div className="prompt-empty-state">
          <h3>当前范围还没有提示词模板</h3>
          <p>只有你明确保存的模板才会进入这里。可以从已批准策略、当前内容开始，也可以手动新建。</p>
          <div className="button-row">
            <button className="primary-button" type="button" onClick={() => setContextAIOpen(true)}>从当前策略生成模板</button>
            <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>从当前内容保存</button>
            <button className="ghost-button" type="button" onClick={() => setIsCreating(true)}>新建提示词</button>
          </div>
        </div>
      ) : (
        <div className="prompt-template-grid">
          {prompts.map((prompt) => {
            const workflow = workflows.find((item) => String(item.id) === String(prompt.workflow_id));
            return (
              <article className="prompt-template-card" key={prompt.id}>
                <button className="card-open" type="button" onClick={() => openDetail(prompt)}>查看详情</button>
                <div className="card-meta">
                  <span>{getPromptCategoryLabel(prompt.category)}</span>
                  <span>{prompt.platform || '通用平台'}</span>
                  <StatusBadge status={promptTemplateStatus(prompt)} />
                </div>
                <h3>{prompt.title}</h3>
                <p>{prompt.templateMeta?.purpose || '可复用生成模板'}</p>
                <div className="prompt-card-metrics">
                  <span>版本 v{promptTemplateVersion(prompt)}</span>
                  <span>变量 {prompt.variables.length}</span>
                  <span>使用 {prompt.usageCount}</span>
                  <span>成功率 {prompt.successRate == null ? '待验证' : `${prompt.successRate}%`}</span>
                </div>
                <dl className="business-detail-list">
                  <div><dt>角色</dt><dd>{prompt.characters?.name || '通用'}</dd></div>
                  <div><dt>推荐工作流</dt><dd>{workflow?.name || '未绑定'}</dd></div>
                  <div><dt>最近使用</dt><dd>{prompt.lastUsedAt ? formatDate(prompt.lastUsedAt) : '尚未使用'}</dd></div>
                  <div><dt>来源</dt><dd>{SOURCE_LABELS[prompt.templateMeta?.source] || '手动新建'}</dd></div>
                </dl>
                <div className="table-actions">
                  <button type="button" onClick={() => setEditing(prompt)}>创建新版本</button>
                  <MoreActionsMenu>
                    <button className="danger-action" type="button" onClick={() => handleDelete(prompt)}>删除模板</button>
                  </MoreActionsMenu>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {selected && (
        <aside className="detail-panel capability-detail-drawer">
          <div className="section-head">
            <div>
              <p className="eyebrow">提示词模板详情</p>
              <h2>{selected.title}</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => {
              setSelected(null);
              onNavigate('prompts');
            }}>关闭</button>
          </div>
          <div className="capability-tabs">
            {[
              ['overview', '概览'],
              ['template', '模板正文'],
              ['variables', '变量与预览'],
              ['workflow', '推荐能力'],
              ['versions', '版本历史'],
              ['usage', '使用记录'],
            ].map(([value, label]) => (
              <button className={detailTab === value ? 'active' : ''} key={value} type="button" onClick={() => setDetailTab(value)}>{label}</button>
            ))}
          </div>
          {detailTab === 'overview' && (
            <dl className="business-detail-list detail-grid">
              <div><dt>类型</dt><dd>{getPromptCategoryLabel(selected.category)}</dd></div>
              <div><dt>用途</dt><dd>{selected.templateMeta?.purpose || '未填写'}</dd></div>
              <div><dt>平台</dt><dd>{selected.platform || '通用'}</dd></div>
              <div><dt>角色</dt><dd>{selected.characters?.name || '通用'}</dd></div>
              <div><dt>Campaign 范围</dt><dd>{selected.campaign_id ? campaignContext?.campaign?.name || '当前运营活动' : '全局模板'}</dd></div>
              <div><dt>版本</dt><dd>v{promptTemplateVersion(selected)}</dd></div>
              <div><dt>状态</dt><dd><StatusBadge status={promptTemplateStatus(selected)} /></dd></div>
              <div><dt>来源</dt><dd>{SOURCE_LABELS[selected.templateMeta?.source] || '手动新建'}</dd></div>
            </dl>
          )}
          {detailTab === 'template' && <pre className="prompt-template-body">{selected.content}</pre>}
          {detailTab === 'variables' && (
            <div className="prompt-variable-detail">
              <div className="prompt-variable-chips">
                {selected.variables.map((variable) => <span key={variable.name}>{`{{${variable.name}}}`} · {variable.label}</span>)}
              </div>
              <div className="prompt-rendered-preview">
                <span>示例预览</span>
                <p>{renderPromptTemplate(selected.content)}</p>
              </div>
            </div>
          )}
          {detailTab === 'workflow' && (
            <dl className="business-detail-list">
              <div><dt>推荐工作流</dt><dd>{workflows.find((item) => String(item.id) === String(selected.workflow_id))?.name || '尚未绑定'}</dd></div>
              <div><dt>角色 LoRA</dt><dd>在角色库管理，本页面不复制配置</dd></div>
            </dl>
          )}
          {detailTab === 'versions' && (
            <div className="version-history-list">
              {versions.map((version) => (
                <article key={version.id}>
                  <strong>v{version.version}</strong>
                  <span>{version.changeReason}</span>
                  <small>{formatDate(version.created_at)} · {SOURCE_LABELS[version.source] || version.source}</small>
                </article>
              ))}
            </div>
          )}
          {detailTab === 'usage' && (
            <dl className="business-detail-list">
              <div><dt>使用次数</dt><dd>{selected.usageCount}</dd></div>
              <div><dt>成功率</dt><dd>{selected.successRate == null ? '尚无运行样本' : `${selected.successRate}%`}</dd></div>
              <div><dt>最近使用</dt><dd>{selected.lastUsedAt ? formatDate(selected.lastUsedAt) : '尚未使用'}</dd></div>
            </dl>
          )}
        </aside>
      )}

      <ContextAIBox
        open={contextAIOpen}
        mode="x_copy_prompt"
        context={buildContentContext({
          campaign: campaignContext?.campaign,
          contentPackage: { title: '可复用提示词模板', platform: filters.platform || 'X' },
          character: characters.find((item) => item.id === filters.character),
        })}
        onApply={(result) => handleAISave({
          title: result.title || 'AI 生成提示词模板',
          category: result.category || 'caption',
          content: result.content || JSON.stringify(result, null, 2),
          platform: result.platform || filters.platform || 'X',
          character: result.character || filters.character || null,
        })}
        onSavePrompt={handleAISave}
        onClose={() => setContextAIOpen(false)}
      />
    </section>
  );
}
