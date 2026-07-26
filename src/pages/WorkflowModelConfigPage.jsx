import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { listPrompts } from '../services/prompt-service';
import { getAssets, loadWorkflowConfigData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import {
  bindCharacterToWorkflow,
  bindPromptTemplateToWorkflow,
  setWorkflowProductionEnabled,
} from '../services/workflow-capability-service';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import { formatDate, statusLabel } from '../utils/formatters';
import {
  buildWorkflowCapability,
  deriveModelAssets,
} from '../utils/workflow-capability-model';

const WORKFLOW_TABS = [
  ['workflows', '工作流'],
  ['models', '模型资产'],
  ['providers', 'Provider'],
  ['tests', '生成测试'],
];

const DETAIL_TABS = [
  ['overview', '概览'],
  ['inputs', '输入映射'],
  ['outputs', '输出映射'],
  ['models', '模型依赖'],
  ['characters', '角色绑定'],
  ['prompts', '提示词模板'],
  ['tests', '测试记录'],
  ['runs', '运行记录'],
  ['advanced', '高级配置'],
];

function durationLabel(milliseconds) {
  if (milliseconds == null) return '待统计';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60000) return `${Math.round(milliseconds / 100) / 10} 秒`;
  return `${Math.round(milliseconds / 6000) / 10} 分钟`;
}

export function WorkflowModelConfigPage({
  activeCampaignId,
  auxiliaryMode = 'normal',
  campaignContext,
  dataScope = 'campaign',
  onNavigate,
  userId,
}) {
  const [rawData, setRawData] = useState({
    comfyWorkflows: [],
    characters: [],
    assets: [],
    legacyAssets: [],
    workflowRuns: [],
  });
  const [prompts, setPrompts] = useState([]);
  const [activeTab, setActiveTab] = useState('workflows');
  const [selected, setSelected] = useState(null);
  const [detailTab, setDetailTab] = useState('overview');
  const [bindingPrompt, setBindingPrompt] = useState('');
  const [bindingCharacter, setBindingCharacter] = useState('');
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    const [nextData, nextPrompts] = await Promise.all([
      loadWorkflowConfigData(),
      listPrompts(userId),
    ]);
    const scopeOptions = { scope: dataScope, campaignContext, activeCampaignId, includeGlobal: true };
    setRawData({
      comfyWorkflows: filterRecordsForAuxiliaryScope(nextData.comfyWorkflows, scopeOptions),
      characters: filterRecordsForAuxiliaryScope(nextData.characters, scopeOptions),
      assets: filterRecordsForAuxiliaryScope(nextData.assets, scopeOptions),
      legacyAssets: filterRecordsForAuxiliaryScope(nextData.legacyAssets, scopeOptions),
      workflowRuns: filterRecordsForAuxiliaryScope(nextData.workflowRuns, scopeOptions),
    });
    setPrompts(filterRecordsForAuxiliaryScope(nextPrompts, scopeOptions));
  }, [activeCampaignId, campaignContext, dataScope, userId]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  const assets = useMemo(() => getAssets(rawData), [rawData]);
  const workflows = useMemo(() => (
    rawData.comfyWorkflows.map((workflow) => buildWorkflowCapability(workflow, {
      characters: rawData.characters,
      prompts,
      runs: rawData.workflowRuns,
      assets,
    }))
  ), [assets, prompts, rawData.characters, rawData.comfyWorkflows, rawData.workflowRuns]);
  const models = useMemo(() => deriveModelAssets(workflows), [workflows]);
  const providers = useMemo(() => {
    const map = new Map();
    workflows.forEach((workflow) => {
      const current = map.get(workflow.provider) || { name: workflow.provider, workflows: 0, active: 0, runs: 0 };
      current.workflows += 1;
      current.active += workflow.productionEnabled ? 1 : 0;
      current.runs += workflow.runCount;
      map.set(workflow.provider, current);
    });
    return [...map.values()];
  }, [workflows]);

  const selectedId = selected?.id;

  useEffect(() => {
    if (!selectedId) return;
    const refreshed = workflows.find((workflow) => String(workflow.id) === String(selectedId));
    if (refreshed) setSelected(refreshed);
  }, [selectedId, workflows]);

  async function toggleWorkflow(workflow) {
    try {
      await setWorkflowProductionEnabled(userId, workflow, !workflow.productionEnabled);
      setMessage(workflow.productionEnabled ? '工作流已停用，不会继续进入生产选择。' : '工作流已启用。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function bindPrompt(workflow) {
    if (!bindingPrompt) return;
    try {
      await bindPromptTemplateToWorkflow(userId, workflow, bindingPrompt);
      setMessage('提示词模板已绑定到工作流。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function bindCharacter(workflow) {
    const character = rawData.characters.find((item) => String(item.id) === String(bindingCharacter));
    if (!character) return;
    try {
      await bindCharacterToWorkflow(userId, workflow, character);
      setMessage(`${character.display_name || character.name} 已绑定到工作流。LoRA 配置仍由角色库管理。`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function openWorkflow(workflow, tab = 'overview') {
    setSelected(workflow);
    setDetailTab(tab);
    setBindingPrompt(workflow.boundPrompts[0]?.id || '');
    setBindingCharacter(workflow.boundCharacters[0]?.id || '');
  }

  function openSafeTest(workflow) {
    setMessage('已进入安全测试配置，不会在本页面自动调用付费工作流。');
    onNavigate('workspace', '', {
      workflow_id: workflow.id,
      test_mode: 'safe_preview',
      campaign_id: activeCampaignId || '',
      day: 1,
    });
  }

  if (!isSupabaseConfigured) {
    return <EmptyState title="生成能力数据服务未连接" reason="无法读取工作流、模型与运行记录。" prerequisite="请先恢复 Supabase 连接。" actionHref="#/connections" actionLabel="检查连接" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看工作流与模型配置。" />;
  }

  return (
    <section className="page-stack workflow-capability-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">工作流与模型能力中心</p>
          <h2>管理真实可执行的生成能力</h2>
          <p>工作流负责执行，通用模型在这里展示；Emma 等角色 LoRA 继续只在角色库维护。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setActiveTab('tests')}>查看生成测试</button>
      </div>

      <div className="capability-tabs" role="tablist" aria-label="工作流能力分类">
        {WORKFLOW_TABS.map(([value, label]) => (
          <button className={activeTab === value ? 'active' : ''} key={value} type="button" onClick={() => setActiveTab(value)}>{label}</button>
        ))}
      </div>

      {message && <div className="notice">{message}</div>}

      {activeTab === 'workflows' && (
        workflows.length ? (
          <div className="workflow-capability-grid">
            {workflows.map((workflow) => (
              <article className="workflow-capability-card" key={workflow.id}>
                <div className="workflow-card-heading">
                  <div>
                    <span>{workflow.mode === 'video' ? '视频工作流' : '图片工作流'}</span>
                    <h3>{workflow.name}</h3>
                  </div>
                  <StatusBadge status={workflow.availabilityStatus} />
                </div>
                <dl className="business-detail-list">
                  <div><dt>Provider</dt><dd>{workflow.provider}</dd></div>
                  <div><dt>基础模型</dt><dd>{workflow.baseModel}</dd></div>
                  <div><dt>输入 / 输出</dt><dd>{workflow.inputType} → {workflow.outputType}</dd></div>
                  <div><dt>支持 LoRA</dt><dd>{workflow.supportsLora ? '支持' : '不支持'}</dd></div>
                  <div><dt>支持角色</dt><dd>{workflow.boundCharacters.map((item) => item.display_name || item.name).join('、') || '尚未绑定'}</dd></div>
                  <div><dt>生产启用</dt><dd>{workflow.productionEnabled ? '已启用' : '已停用'}</dd></div>
                  <div><dt>最近测试</dt><dd>{workflow.latestTestAt ? formatDate(workflow.latestTestAt) : '尚未测试'}</dd></div>
                  <div><dt>平均耗时</dt><dd>{durationLabel(workflow.averageDurationMs)}</dd></div>
                  <div><dt>预估成本</dt><dd>{workflow.estimatedCost == null ? '待统计' : workflow.estimatedCost.toFixed(4)}</dd></div>
                  <div><dt>最近任务</dt><dd>{workflow.latestRun?.status ? statusLabel(workflow.latestRun.status) : '暂无任务'}</dd></div>
                </dl>
                {workflow.latestTestAsset?.url && (
                  <img className="workflow-test-thumbnail" src={workflow.latestTestAsset.url} alt={`${workflow.name} 最近测试`} />
                )}
                <div className="table-actions">
                  <button type="button" onClick={() => openWorkflow(workflow)}>查看详情</button>
                  <button type="button" onClick={() => openSafeTest(workflow)}>测试运行</button>
                  <button type="button" onClick={() => toggleWorkflow(workflow)}>{workflow.productionEnabled ? '停用' : '启用'}</button>
                  <button type="button" onClick={() => openWorkflow(workflow, 'characters')}>绑定角色</button>
                  <button type="button" onClick={() => openWorkflow(workflow, 'prompts')}>绑定提示词模板</button>
                  <button type="button" onClick={() => onNavigate('generation')}>查看任务</button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="当前范围没有工作流" reason="当前 Campaign 和角色没有关联可用工作流。" prerequisite="先在角色库配置推荐工作流，或切换到全部历史查看。" actionHref="#/characters" actionLabel="前往角色库" />
        )
      )}

      {activeTab === 'models' && (
        <div className="model-capability-grid">
          {models.length ? models.map((model) => (
            <article className="model-capability-card" key={model.id}>
              <span>{model.type}</span>
              <h3>{model.name}</h3>
              <p>由工作流 {model.workflowName} 使用</p>
              <StatusBadge status={model.status} />
            </article>
          )) : (
            <EmptyState title="尚未识别通用模型资产" reason="当前工作流没有声明基础模型、Checkpoint、VAE 或 ControlNet。" prerequisite="先同步工作流模型依赖。" actionHref="#/workflows" actionLabel="刷新工作流" />
          )}
          <article className="model-role-boundary-card">
            <h3>角色 LoRA 不在这里管理</h3>
            <p>Emma S1 LoRA 等持续身份资产保留在角色库，避免与通用模型重复。</p>
            <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>查看角色库</button>
          </article>
        </div>
      )}

      {activeTab === 'providers' && (
        <div className="provider-capability-grid">
          {providers.map((provider) => (
            <article key={provider.name}>
              <h3>{provider.name}</h3>
              <dl className="business-detail-list">
                <div><dt>工作流</dt><dd>{provider.workflows}</dd></div>
                <div><dt>生产启用</dt><dd>{provider.active}</dd></div>
                <div><dt>历史任务</dt><dd>{provider.runs}</dd></div>
                <div><dt>凭据</dt><dd>已隐藏，仅服务端使用</dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}

      {activeTab === 'tests' && (
        <div className="workflow-test-list">
          {rawData.workflowRuns.length ? rawData.workflowRuns.map((run) => {
            const workflow = workflows.find((item) => String(item.id) === String(run.workflow_id) || item.name === run.tool_id);
            const character = rawData.characters.find((item) => String(item.id) === String(run.character_id));
            return (
              <article key={run.id}>
                <div>
                  <strong>{workflow?.name || run.tool_id || '未识别工作流'}</strong>
                  <span>{character?.display_name || character?.name || '通用角色'} · {formatDate(run.created_at)}</span>
                </div>
                <StatusBadge status={run.status} />
                <button type="button" onClick={() => onNavigate('generation', run.id)}>查看任务</button>
              </article>
            );
          }) : (
            <EmptyState title="还没有生成测试记录" reason="当前范围没有 workflow_runs。" prerequisite="选择一个工作流并先完成安全测试配置。" actionHref="#/workflows" actionLabel="选择工作流" />
          )}
        </div>
      )}

      {selected && (
        <aside className="detail-panel capability-detail-drawer">
          <div className="section-head">
            <div>
              <p className="eyebrow">工作流详情</p>
              <h2>{selected.name}</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setSelected(null)}>关闭</button>
          </div>
          <div className="capability-tabs detail-tabs">
            {DETAIL_TABS.map(([value, label]) => (
              <button className={detailTab === value ? 'active' : ''} key={value} type="button" onClick={() => setDetailTab(value)}>{label}</button>
            ))}
          </div>

          {detailTab === 'overview' && (
            <dl className="business-detail-list detail-grid">
              <div><dt>类型</dt><dd>{selected.mode || selected.category || '图片'}</dd></div>
              <div><dt>Provider</dt><dd>{selected.provider}</dd></div>
              <div><dt>基础模型</dt><dd>{selected.baseModel}</dd></div>
              <div><dt>状态</dt><dd><StatusBadge status={selected.availabilityStatus} /></dd></div>
              <div><dt>生产启用</dt><dd>{selected.productionEnabled ? '已启用' : '已停用'}</dd></div>
              <div><dt>最近测试</dt><dd>{selected.latestTestAt ? formatDate(selected.latestTestAt) : '尚未测试'}</dd></div>
              <div><dt>平均耗时</dt><dd>{durationLabel(selected.averageDurationMs)}</dd></div>
              <div><dt>预估成本</dt><dd>{selected.estimatedCost == null ? '待统计' : selected.estimatedCost.toFixed(4)}</dd></div>
            </dl>
          )}
          {detailTab === 'inputs' && (
            <div className="mapping-list">
              {(selected.input_schema?.required || Object.keys(selected.input_schema?.properties || {})).map((input) => <span key={input}>{input}</span>)}
            </div>
          )}
          {detailTab === 'outputs' && (
            <div className="mapping-list">
              {Object.keys(selected.output_schema?.properties || {}).map((output) => <span key={output}>{output}</span>)}
            </div>
          )}
          {detailTab === 'models' && (
            <dl className="business-detail-list">
              <div><dt>基础模型</dt><dd>{selected.model || '未声明'}</dd></div>
              <div><dt>Checkpoint</dt><dd>{selected.checkpoint?.split('/').at(-1) || '未声明'}</dd></div>
              <div><dt>LoRA 支持</dt><dd>{selected.supportsLora ? '支持；具体角色 LoRA 请到角色库查看' : '不支持'}</dd></div>
            </dl>
          )}
          {detailTab === 'characters' && (
            <div className="binding-panel">
              <p>已绑定：{selected.boundCharacters.map((item) => item.display_name || item.name).join('、') || '暂无'}</p>
              <div className="button-row">
                <select value={bindingCharacter} onChange={(event) => setBindingCharacter(event.target.value)}>
                  <option value="">选择角色</option>
                  {rawData.characters.map((character) => <option key={character.id} value={character.id}>{character.display_name || character.name}</option>)}
                </select>
                <button className="primary-button" type="button" disabled={!bindingCharacter} onClick={() => bindCharacter(selected)}>绑定角色</button>
              </div>
              <small>这里只建立工作流关系，不复制或修改角色 LoRA。</small>
            </div>
          )}
          {detailTab === 'prompts' && (
            <div className="binding-panel">
              <p>已绑定：{selected.boundPrompts.map((prompt) => prompt.title).join('、') || '暂无'}</p>
              <div className="button-row">
                <select value={bindingPrompt} onChange={(event) => setBindingPrompt(event.target.value)}>
                  <option value="">选择提示词模板</option>
                  {prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.title}</option>)}
                </select>
                <button className="primary-button" type="button" disabled={!bindingPrompt} onClick={() => bindPrompt(selected)}>绑定模板</button>
              </div>
            </div>
          )}
          {detailTab === 'tests' && (
            <div className="workflow-test-detail">
              {selected.latestTestAsset?.url && <img src={selected.latestTestAsset.url} alt="最近测试结果" />}
              <p>最近测试：{selected.latestTestAt ? formatDate(selected.latestTestAt) : '尚未测试'}</p>
              <button className="primary-button" type="button" onClick={() => openSafeTest(selected)}>配置安全测试</button>
            </div>
          )}
          {detailTab === 'runs' && (
            <div className="workflow-test-list">
              {rawData.workflowRuns
                .filter((run) => String(run.workflow_id) === String(selected.id) || run.tool_id === selected.name)
                .map((run) => (
                  <article key={run.id}>
                    <span>{formatDate(run.created_at)}</span>
                    <StatusBadge status={run.status} />
                    <button type="button" onClick={() => onNavigate('generation', run.id)}>查看任务</button>
                  </article>
                ))}
            </div>
          )}
          {detailTab === 'advanced' && (
            auxiliaryMode === 'advanced' ? (
              <div className="advanced-config-summary">
                <p>工作流版本：{selected.version || '—'}</p>
                <p>节点数：{Object.keys(selected.workflow_json || {}).length}</p>
                <p>默认参数字段：{Object.keys(selected.default_params || {}).join('、') || '—'}</p>
                <p>完整工作流 JSON、内网地址、Token 和 Secret 不在前端展示。</p>
              </div>
            ) : (
              <p className="notice">切换页面顶部“高级模式”后可查看脱敏技术摘要。</p>
            )
          )}
        </aside>
      )}
    </section>
  );
}
