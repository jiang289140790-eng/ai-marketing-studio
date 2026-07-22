import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import {
  countWhere,
  displayText,
  findById,
  getAssets,
  getContentPackages,
  loadContentWorkspaceData,
} from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const EMPTY = {
  contentPackages: [],
  legacyContent: [],
  campaigns: [],
  strategies: [],
  accounts: [],
  assets: [],
  legacyAssets: [],
  characters: [],
  workflowRuns: [],
};

export function ContentWorkspacePage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    setLoading(true);
    loadContentWorkspaceData()
      .then((nextData) => setData({ ...EMPTY, ...nextData }))
      .finally(() => setLoading(false));
    return undefined;
  }, [userId]);

  const contentPackages = useMemo(() => getContentPackages(data), [data]);
  const assets = useMemo(() => getAssets(data), [data]);

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待 Supabase 配置" description="配置完成后，内容工作台会读取真实内容和素材。" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看内容工作台。" />;
  }

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">内容工作台</p>
        <h2>文案生成、素材生成、人工审核都在同一张内容卡里完成</h2>
        <p>
          不再拆成“内容生成中心”和“内容审核中心”。每个内容包会显示 Campaign、策略、账号、平台、Hook、正文、CTA、标签、
          视觉需求、角色与 LoRA、参考素材、生成结果、版权确认和最终审核动作。
        </p>
        <div className="button-row">
          <ExecutionButton actionName="让 Content Agent 生成内容">生成内容包</ExecutionButton>
          <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>打开素材库</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>打开角色库</button>
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="内容包" value={loading ? '-' : contentPackages.length} hint="文案、素材、审核统一管理" />
        <StatCard label="待审核" value={loading ? '-' : countWhere(contentPackages, (item) => ['draft', 'review'].includes(item.status))} hint="需要人工确认" />
        <StatCard label="生成中" value={loading ? '-' : countWhere(contentPackages, (item) => item.status === 'generating')} hint="等待 Agent 或 Workflow 结果" />
        <StatCard label="可用素材" value={loading ? '-' : assets.length} hint="来自素材库" />
      </div>

      <div className="content-workspace-list">
        {contentPackages.length ? contentPackages.map((item) => (
          <ContentPackageCard
            key={item.id}
            item={item}
            expanded={expandedId === item.id}
            onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
            data={data}
            assets={assets}
            onNavigate={onNavigate}
          />
        )) : (
          <EmptyState title="暂无内容包" description="策略批准后，Agent 创建的内容包会出现在这里。" />
        )}
      </div>
    </section>
  );
}

function ContentPackageCard({ item, expanded, onToggle, data, assets, onNavigate }) {
  const campaign = findById(data.campaigns, item.campaignId);
  const strategy = findById(data.strategies, item.strategyId);
  const account = findById(data.accounts, item.accountId);
  const referenceAccount = findById(data.accounts, item.referenceAccountId);
  const character = findById(data.characters, item.characterId);
  const linkedAssets = assets.filter((asset) => asset.contentId === item.id || asset.id === item.assetId || asset.campaignId === item.campaignId);
  const missingCharacterReason = character ? null : '无法生成角色素材：当前内容包还没有选择角色。';
  const missingLoraReason = character && !character.lora ? '无法加载 LoRA：该角色详情中还没有绑定 LoRA。' : null;
  const missingAssetReason = linkedAssets.length ? null : '无法创建最终预览：还没有参考素材或生成结果。';

  return (
    <article className="content-package-card">
      <button className="card-open" type="button" onClick={onToggle}>{expanded ? '收起' : '展开'}</button>
      <div className="section-head">
        <div>
          <p className="eyebrow">{item.sourceLabel || 'Content Package'}</p>
          <h3>{item.title}</h3>
          <p>{displayText(item.body, '等待 Content Agent 生成正文')}</p>
        </div>
        <StatusBadge status={item.approvalStatus || item.status} />
      </div>

      <div className="business-grid">
        <Info label="所属 Campaign" value={campaign?.name || campaign?.title} />
        <Info label="关联策略" value={strategy?.name || strategy?.title} />
        <Info label="发布平台" value={item.platform} />
        <Info label="自有账号" value={account?.account_name || account?.username} />
        <Info label="参考账号" value={referenceAccount?.account_name || referenceAccount?.username} />
        <Info label="角色 / LoRA" value={character?.name ? `${character.name}${character.lora ? ` · ${character.lora}` : ' · 未绑定 LoRA'}` : '未选择角色'} />
      </div>

      {expanded && (
        <div className="content-package-detail">
          <section className="workspace-block">
            <h4>文案与语言</h4>
            <div className="business-grid">
              <Info label="标题" value={item.title} />
              <Info label="Hook" value={item.hook} />
              <Info label="CTA" value={item.cta} />
              <Info label="标签" value={item.tags} />
              <Info label="关键词" value={item.keywords} />
              <Info label="语言风格" value={item.languageStyle} />
            </div>
            <p className="draft-preview">{displayText(item.body, '暂无正文。后续由 Content Agent 根据已批准策略生成。')}</p>
            <div className="button-row">
              <ExecutionButton actionName="保存草稿" className="ghost-button">保存草稿</ExecutionButton>
              <ExecutionButton actionName="让 Agent 重写文案" className="ghost-button">Agent 重写</ExecutionButton>
              <ExecutionButton actionName="从 X 链接导入参考">导入 X 参考链接</ExecutionButton>
            </div>
          </section>

          <section className="workspace-block">
            <h4>图片 / 视频生产</h4>
            <div className="workflow-chain">
              <span>选择角色</span>
              <span>加载 LoRA</span>
              <span>确认参考素材权益</span>
              <span>选择 Workflow</span>
              <span>生成并回传素材库</span>
            </div>
            <Info label="视觉需求" value={item.assetRequirement} />
            <div className="button-row">
              <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>去角色库选择角色</button>
              <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>去素材库选择参考</button>
              <ExecutionButton actionName="提交图片生成" reason={missingCharacterReason || missingLoraReason || missingAssetReason || undefined}>提交图片生成</ExecutionButton>
              <ExecutionButton actionName="提交视频生成" className="ghost-button" reason="视频生成暂不在第一批线上执行；需要先接入可信 Media Gateway。">提交视频生成</ExecutionButton>
            </div>
          </section>

          <section className="workspace-block">
            <h4>生成结果</h4>
            {linkedAssets.length ? (
              <div className="asset-mini-grid">
                {linkedAssets.slice(0, 6).map((asset) => (
                  <article key={asset.id} className="asset-mini-card">
                    {asset.url && asset.type === 'image' ? <img src={asset.thumbnail || asset.url} alt="" /> : <div className="prompt-card">{displayText(asset.type)}</div>}
                    <strong>{asset.name}</strong>
                    <small>{displayText(asset.status)} · {formatDate(asset.createdAt)}</small>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-card-inline">暂无生成结果。图片或视频生成成功后，会回到这张内容卡，并同步进入素材库。</div>
            )}
          </section>

          <section className="workspace-block approval-block">
            <h4>内容终审</h4>
            <p>确认正文、CTA、标签、发布账号、排期、最终素材和素材权益后，才能送入发布队列。送入队列不等于自动发布。</p>
            <ExecutionButton actionName="终审通过并创建发布任务" reason="终审动作需要可信服务端创建 publish task，并写入 approval_status=pending。">终审通过，送入发布队列</ExecutionButton>
          </section>
        </div>
      )}
    </article>
  );
}

function Info({ label, value }) {
  return (
    <section>
      <span>{label}</span>
      <strong>{displayText(value)}</strong>
    </section>
  );
}
