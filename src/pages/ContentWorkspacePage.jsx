import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
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
import { formatDate, statusLabel } from '../utils/formatters';

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
        <h2>文案生成、图片/视频生成、内容审核放在同一张卡片里</h2>
        <p>
          不再拆成“生成中心”和“审核中心”。每个内容包从文案、角色、LoRA、参考素材、生成结果到最终送入发布队列，
          都在当前内容卡片内完成。
        </p>
        <div className="button-row">
          <button className="primary-button" type="button" disabled>让 Content Agent 生成内容（需接入动作）</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>选择素材库参考</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>选择角色与 LoRA</button>
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="内容包" value={loading ? '-' : contentPackages.length} hint="文案与素材统一审核" />
        <StatCard label="待审核" value={loading ? '-' : countWhere(contentPackages, (item) => ['draft', 'review'].includes(item.status))} hint="需要人工确认" />
        <StatCard label="生成中" value={loading ? '-' : countWhere(contentPackages, (item) => item.status === 'generating')} hint="等待素材或文案结果" />
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
  const character = findById(data.characters, item.characterId);
  const linkedAssets = assets.filter((asset) => asset.contentId === item.id || asset.id === item.assetId || asset.campaignId === item.campaignId);

  return (
    <article className="content-package-card">
      <button className="card-open" type="button" onClick={onToggle}>{expanded ? '收起' : '展开'}</button>
      <div className="section-head">
        <div>
          <p className="eyebrow">Content Package</p>
          <h3>{item.title}</h3>
          <p>{displayText(item.body, '等待 Content Agent 生成正文')}</p>
        </div>
        <StatusBadge status={item.status} />
      </div>

      <div className="business-grid">
        <Info label="所属 Campaign" value={campaign?.name || campaign?.title} />
        <Info label="关联策略" value={strategy?.name || strategy?.title} />
        <Info label="平台" value={item.platform} />
        <Info label="目标账号" value={account?.account_name || account?.username} />
        <Info label="角色 / LoRA" value={character?.name ? `${character.name}${character.lora ? ` · ${character.lora}` : ''}` : '未选择角色'} />
        <Info label="计划发布时间" value={formatDate(item.scheduledAt)} />
      </div>

      {expanded && (
        <div className="content-package-detail">
          <section className="workspace-block">
            <h4>文案区域</h4>
            <div className="business-grid">
              <Info label="标题" value={item.title} />
              <Info label="Hook" value={item.hook} />
              <Info label="CTA" value={item.cta} />
              <Info label="关键词" value={item.keywords} />
            </div>
            <p className="draft-preview">{displayText(item.body, '暂无正文。后续由 Content Agent 根据已批准策略生成。')}</p>
            <div className="button-row">
              <button className="ghost-button" type="button" disabled>保存草稿</button>
              <button className="ghost-button" type="button" disabled>让 Agent 重写文案</button>
            </div>
          </section>

          <section className="workspace-block">
            <h4>图片 / 视频生成区域</h4>
            <div className="workflow-chain">
              <span>选择角色</span>
              <span>加载 LoRA</span>
              <span>选择参考素材</span>
              <span>选择 Workflow</span>
              <span>生成并回传素材</span>
            </div>
            <div className="button-row">
              <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>去角色库选角色</button>
              <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>去素材库选参考</button>
              <button className="primary-button" type="button" disabled>创建安全预演 / 提交生成</button>
            </div>
          </section>

          <section className="workspace-block">
            <h4>生成结果与审核</h4>
            {linkedAssets.length ? (
              <div className="asset-mini-grid">
                {linkedAssets.slice(0, 6).map((asset) => (
                  <article key={asset.id} className="asset-mini-card">
                    {asset.url && asset.type === 'image' ? <img src={asset.thumbnail || asset.url} alt="" /> : <div className="prompt-card">{statusLabel(asset.type)}</div>}
                    <strong>{asset.name}</strong>
                    <small>{statusLabel(asset.status)} · {formatDate(asset.createdAt)}</small>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-card-inline">暂无生成结果。生成后的图片或视频会直接回到这张内容卡片，同时进入素材库。</div>
            )}
          </section>

          <section className="workspace-block">
            <h4>内容终审</h4>
            <p>选择最终可用素材、确认正文、CTA、标签、发布账号和排期后，才能送入发布队列。送入队列不等于自动发布。</p>
            <button className="primary-button" type="button" disabled>审核通过并送入发布队列</button>
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
