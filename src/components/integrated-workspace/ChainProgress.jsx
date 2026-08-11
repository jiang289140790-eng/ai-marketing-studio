// 完整智能内容链进度：可视化展示从证据到世系的各阶段状态
export function ChainProgress({ workspace, currentStage, onNavigate }) {
  if (!workspace) return null;

  const stages = [
    {
      id: 'research',
      label: '研究证据',
      hint: '来源身份、引用与采集状态',
      count: (workspace.evidence || []).length,
      active: currentStage === 'research',
      navTarget: 'research',
    },
    {
      id: 'analysis',
      label: '分析',
      hint: '文本/多模态分析摘要',
      count: (workspace.analyses || []).length,
      active: currentStage === 'analysis',
      navTarget: 'research',
    },
    {
      id: 'knowledge',
      label: '知识卡',
      hint: '带引用的已验证知识条目',
      count: (workspace.knowledgeCards || []).length,
      active: currentStage === 'knowledge',
      navTarget: 'knowledge',
    },
    {
      id: 'brief',
      label: '可审核 Brief',
      hint: '约束、执行标志与人工审核',
      count: workspace.brief ? 1 : 0,
      active: currentStage === 'brief',
      navTarget: 'knowledge',
    },
    {
      id: 'handoff',
      label: 'P5 交接包',
      hint: '交接清单与执行边界',
      count: workspace.handoff ? 1 : 0,
      active: currentStage === 'handoff',
      navTarget: 'knowledge',
    },
    {
      id: 'lineage',
      label: 'P16 世系',
      hint: '数据来源与完整性追踪',
      count: (workspace.lineage?.entries || []).length,
      active: currentStage === 'lineage',
      navTarget: 'dashboard',
    },
  ];

  return (
    <div className="iw-chain-progress">
      <div className="iw-chain-header">
        <span className="iw-eyebrow">智能内容链</span>
        <h4>研究证据 → 分析 → 知识卡 → 可审核 Brief → P5 交接包 → P16 世系</h4>
      </div>
      <div className="iw-chain-steps">
        {stages.map((stage, index) => (
          <button
            className={`iw-chain-step ${stage.active ? 'active' : ''} ${stage.count > 0 ? 'has-data' : 'empty'}`}
            key={stage.id}
            type="button"
            onClick={() => onNavigate && onNavigate(stage.navTarget)}
            title={stage.hint}
          >
            <span className="iw-chain-step-num">{index + 1}</span>
            <div className="iw-chain-step-body">
              <strong>{stage.label}</strong>
              <small>{stage.hint}</small>
              <span className="iw-chain-step-count">{stage.count}</span>
            </div>
            {index < stages.length - 1 && (
              <span className="iw-chain-arrow">→</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// 来源/数据模式标签
export function WorkspaceSourceBanner({ workspace }) {
  if (!workspace) return null;

  const isDemo = workspace.demoOnly === true;
  const isLive = workspace.status === 'live';
  const isFailClosed = workspace.status === 'fail_closed';

  return (
    <div className={`iw-source-banner ${isDemo ? 'iw-demo' : isLive ? 'iw-live' : isFailClosed ? 'iw-error' : ''}`}>
      {isDemo && (
        <>
          <span className="iw-source-badge iw-badge-demo">验收演示项目</span>
          <span>本地演示数据 — 不代表任何真实数据读取或执行</span>
        </>
      )}
      {isLive && (
        <>
          <span className="iw-source-badge iw-badge-live">实时 Staging</span>
          <span>Supabase api schema · 仅 SELECT 只读</span>
        </>
      )}
      {isFailClosed && (
        <>
          <span className="iw-source-badge iw-badge-error">数据异常</span>
          <span>{workspace.note || '数据读取失败，fail closed'}</span>
        </>
      )}
    </div>
  );
}

// 下一步操作指引
export function NextActionBar({ workspace, currentStage }) {
  if (!workspace) return null;

  const actions = {
    research: { label: '查看分析 →', target: 'research', hint: '浏览分析摘要与多模态洞察' },
    analysis: { label: '查看知识卡 →', target: 'knowledge', hint: '浏览带引用的知识条目' },
    knowledge: { label: '查看 Brief →', target: 'knowledge', hint: '审核 Brief 与执行边界' },
    brief: { label: '查看交接包 →', target: 'knowledge', hint: '查看 P5 交接清单' },
    handoff: { label: '查看世系 →', target: 'dashboard', hint: '追溯完整数据链路' },
    lineage: { label: '返回总览 →', target: 'dashboard', hint: '回到 AI 运营指挥中心' },
  };

  const action = actions[currentStage] || actions.research;

  return (
    <div className="iw-next-action">
      <span className="iw-next-action-label">下一步操作</span>
      <strong>{action.hint}</strong>
    </div>
  );
}
