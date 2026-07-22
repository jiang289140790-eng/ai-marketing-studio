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
  normalizeList,
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
  publishTasks: [],
};

const VIDEO_MODES = [
  ['text_to_video', '文生视频'],
  ['image_to_video', '图生视频'],
  ['first_frame', '首帧生视频'],
  ['first_last_frame', '首尾帧生视频'],
  ['reference_video', '参考视频生成'],
  ['character_lora_video', '角色 LoRA 视频'],
  ['multi_shot', '多镜头分段生成'],
];

const IMAGE_REQUIREMENT_FIELDS = [
  ['subject', '画面主体'],
  ['character', '人物角色'],
  ['scene', '场景'],
  ['clothing', '服装'],
  ['expression', '表情'],
  ['composition', '构图'],
  ['lighting', '光线'],
  ['color', '色调'],
  ['aspect_ratio', '图片比例'],
  ['size', '图片尺寸'],
  ['lora', 'LoRA'],
  ['lora_weight', 'LoRA 权重'],
  ['positive_prompt', '正向提示词'],
  ['negative_prompt', '负向提示词'],
  ['reference_assets', '参考素材'],
];

const VIDEO_REQUIREMENT_FIELDS = [
  ['type', '视频类型'],
  ['script', '视频脚本'],
  ['duration', '时长'],
  ['aspect_ratio', '画幅'],
  ['shot_count', '镜头数量'],
  ['shots', '分镜'],
  ['camera_motion', '镜头运动'],
  ['character_action', '人物动作'],
  ['scene_change', '场景变化'],
  ['first_frame', '首帧要求'],
  ['last_frame', '尾帧要求'],
  ['reference_video', '参考视频'],
  ['lora', 'LoRA'],
  ['model', '生成模型'],
  ['negative_prompt', 'negative prompt'],
];

export function ContentWorkspacePage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

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
    return <EmptyState title="等待 Supabase 配置" description="配置完成后，内容工作台会读取真实内容、素材、角色和生成任务。" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看内容工作台。" />;
  }

  return (
    <section className="page-stack content-workspace-page">
      <div className="hero-panel">
        <p className="eyebrow">内容工作台</p>
        <h2>内容审核、角色 LoRA、素材引用、图片/视频生成放在同一个工作流里</h2>
        <p>
          这里不是简化版列表。每张内容卡都会连接 Campaign、策略、账号、角色、LoRA、素材、生成任务和发布队列。
          你从这里完成：查看内容 → 补素材 → 生成图片/视频 → 人工审核 → 进入发布。
        </p>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>打开素材库</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>打开角色库</button>
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="内容包" value={loading ? '-' : contentPackages.length} hint="content_packages + content_library" />
        <StatCard label="待审核" value={loading ? '-' : countWhere(contentPackages, (item) => ['draft', 'review'].includes(item.reviewStatus))} hint="需要人工确认" />
        <StatCard label="生成中" value={loading ? '-' : countWhere(contentPackages, (item) => item.status === 'generating')} hint="等待 Workflow 结果" />
        <StatCard label="可用素材" value={loading ? '-' : assets.length} hint="素材库与历史素材" />
      </div>

      <div className="content-workspace-list">
        {contentPackages.length ? contentPackages.map((item) => (
          <ContentPackageCard
            key={`${item.sourceKey}-${item.id}`}
            item={item}
            data={data}
            assets={assets}
            onNavigate={onNavigate}
          />
        )) : (
          <EmptyState title="暂无内容包" description="当前数据库没有可审核内容。Content Factory 生成后，会进入这里继续素材生成和终审。" />
        )}
      </div>

    </section>
  );
}

function ContentPackageCard({ item, data, assets, onNavigate }) {
  const campaign = findById(data.campaigns, item.campaignId);
  const strategy = findById(data.strategies, item.strategyId);
  const account = findById(data.accounts, item.accountId);
  const linkedAssets = assetsForContent(item, assets);
  const [studioOpen, setStudioOpen] = useState(true);

  return (
    <article className="content-package-card">
      <div className="content-card-header section-head">
        <div>
          <p className="eyebrow">{item.sourceLabel}</p>
          <h3>{item.title}</h3>
          <p className="body-preview">{truncate(displayText(item.body, '等待生成正文'), 220)}</p>
        </div>
        <div className="badge-stack">
          <StatusBadge status={item.reviewStatus || item.status} />
          <StatusBadge status={item.platform} />
        </div>
      </div>

      <div className="content-card-meta">
        <Info label="Campaign" value={campaign?.name || campaign?.title} />
        <Info label="平台" value={item.platform} />
        <Info label="目标账号" value={account?.account_name || account?.username || account?.account_url} />
        <Info label="素材" value={linkedAssets.length} />
        <Info label="创建" value={formatDate(item.createdAt)} />
      </div>

      <div className="asset-strip" aria-label="内容素材预览">
        {linkedAssets.slice(0, 4).map((asset) => (
          <div className="asset-thumb" key={asset.id}>
            <AssetPreview asset={asset} compact />
            <span>{asset.name}</span>
          </div>
        ))}
        {!linkedAssets.length && <span className="muted-line">暂无素材，进入下方工作室添加参考或生成新素材。</span>}
      </div>

      <div className="button-row content-card-quick-actions">
        <button className="ghost-button" type="button" onClick={() => setStudioOpen((current) => !current)}>
          {studioOpen ? '收起工作室' : '查看详情与生成工作室'}
        </button>
        <ExecutionButton
          action="save_draft"
          actionName="让 Content Agent 整理文案与素材"
          className="ghost-button"
          resourceType="content_package"
          resourceId={item.id}
          payload={{ content_package_id: item.id, campaign_id: item.campaignId, strategy_id: strategy?.id, mode: 'organize_copy_and_assets' }}
        >
          让 Content Agent 整理文案与素材
        </ExecutionButton>
      </div>

      <details
        className="generation-studio"
        open={studioOpen}
        onToggle={(event) => setStudioOpen(event.currentTarget.open)}
      >
        <summary>🎬 人物 LoRA 图片 / 视频生成</summary>
        <p className="strategy-link-note">关联策略：{strategy?.name || strategy?.title || '未找到关联策略，将只使用当前内容包要求'}</p>
        <ContentPackageStudio item={item} data={data} assets={assets} onNavigate={onNavigate} />
      </details>
    </article>
  );
}

function ContentPackageStudio({ item, data, assets, onNavigate }) {
  const campaign = findById(data.campaigns, item.campaignId);
  const strategy = findById(data.strategies, item.strategyId);
  const account = findById(data.accounts, item.accountId);
  const referenceAccount = findById(data.accounts, item.referenceAccountId);
  const [selectedCharacterId, setSelectedCharacterId] = useState(item.characterId || '');
  const [selectedAssetIds, setSelectedAssetIds] = useState(item.referenceAssetIds || []);
  const [activeMediaPanel, setActiveMediaPanel] = useState(null);
  const [videoMode, setVideoMode] = useState('character_lora_video');
  const [draft, setDraft] = useState(() => ({
    title: item.title || '',
    hook: item.hook || '',
    body: item.body || '',
    cta: item.cta || '',
    tags: normalizeList(item.tags).join(', '),
    scheduledAt: toLocalDateTimeValue(item.scheduledAt),
    feedback: '',
  }));
  const [xUrl, setXUrl] = useState('');
  const [referenceSource, setReferenceSource] = useState(item.sourceAccount || referenceAccount?.account_name || '');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [forceRemote, setForceRemote] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [selectedGeneratedId, setSelectedGeneratedId] = useState('');
  const selectedCharacter = findById(data.characters, selectedCharacterId) || findById(data.characters, item.characterId);
  const lora = getLoraInfo(selectedCharacter, item);
  const linkedAssets = assetsForContent(item, assets);
  const referenceAssets = assets.filter((asset) => {
    const metadata = safeJson(asset.raw?.metadata);
    return ['image', 'video'].includes(String(asset.type).toLowerCase())
      && asset.status === 'completed'
      && (metadata.role === 'reference' || asset.source === 'upload' || asset.source === 'x');
  });
  const selectedAssets = assets.filter((asset) => selectedAssetIds.includes(asset.id));
  const runs = runsForContent(item, data.workflowRuns || []);
  const publishTask = (data.publishTasks || []).find((task) => String(task.content_package_id || task.content_id) === String(item.id));
  const imageReq = normalizeRequirement(item.imageRequirements || item.assetRequirement);
  const videoReq = normalizeRequirement(item.videoRequirements || item.assetRequirement);
  const parsedX = parseXUrl(xUrl);
  const needsReference = activeMediaPanel === 'video'
    && ['image_to_video', 'first_frame', 'first_last_frame', 'reference_video', 'multi_shot'].includes(videoMode);
  const missingGenerationReason = !selectedCharacter
    ? '请先选择人物角色'
    : !hasLora(lora)
      ? '该角色还没有配置 LoRA，请先前往角色库配置'
      : needsReference && selectedAssetIds.length === 0 && selectedFiles.length === 0 && !parsedX
        ? '当前生成方式需要选择参考素材、上传文件或导入 X 链接'
        : undefined;
  const finalReviewReason = !draft.body.trim()
    ? '请先确认正文'
    : !draft.cta.trim()
      ? '请先确认 CTA'
      : selectedAssets.length === 0 && linkedAssets.length === 0
        ? '请先确认至少一个可用素材'
        : undefined;

  function toggleAsset(assetId) {
    setSelectedAssetIds((current) => (
      current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]
    ));
  }

  const generationPayload = {
    content_package_id: item.id,
    campaign_id: item.campaignId,
    strategy_id: item.strategyId,
    character_id: selectedCharacter?.id,
    lora_id: item.loraId || lora.id,
    lora_weight: lora.weight || lora.strength || 0.8,
    reference_asset_ids: selectedAssetIds,
    generation_mode: videoMode,
    image_requirements: item.imageRequirements,
    video_requirements: item.videoRequirements,
    target_platform: item.platform,
    aspect_ratio: imageReq.aspect_ratio || videoReq.aspect_ratio || '9:16',
    reference_source: referenceSource,
    force_remote: forceRemote,
    media_type: activeMediaPanel,
  };

  return (
    <div className="inline-content-studio" aria-label={`${item.title} 的内容生成工作室`}>

        <section className="workspace-block">
          <h3>基础信息</h3>
          <div className="content-card-meta">
            <Info label="标题" value={item.title} />
            <Info label="平台" value={item.platform} />
            <Info label="Campaign" value={campaign?.name || campaign?.title} />
            <Info label="策略" value={strategy?.name || strategy?.title} />
            <Info label="目标账号" value={account?.account_name || account?.username} />
            <Info label="来源账号" value={referenceAccount?.account_name || item.sourceAccount} />
            <Info label="创建时间" value={formatDate(item.createdAt)} />
            <Info label="当前状态" value={item.status} />
            <Info label="发布队列" value={publishTask ? `${publishTask.status || 'pending'} · ${publishTask.id}` : '尚未进入发布队列'} />
          </div>
        </section>

        <section className="workspace-block">
          <h3>文案内容</h3>
          <div className="editor-grid">
            <label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>Hook<input value={draft.hook} onChange={(event) => setDraft({ ...draft, hook: event.target.value })} /></label>
            <label>CTA<input value={draft.cta} onChange={(event) => setDraft({ ...draft, cta: event.target.value })} /></label>
            <label>标签<input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></label>
          </div>
          <label className="full-editor">正文<textarea rows="7" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></label>
          <div className="content-card-meta">
            <Info label="关键词" value={item.keywords} />
            <Info label="语言风格" value={item.languageStyle} />
            <Info label="可复刻策略" value={item.replicateStrategy} />
            <Info label="发布建议" value={item.publishSuggestion} />
          </div>
          <label className="full-editor">给 Agent 的改写意见<textarea rows="3" value={draft.feedback} onChange={(event) => setDraft({ ...draft, feedback: event.target.value })} /></label>
          <div className="button-row">
            <ExecutionButton
              action="save_draft"
              actionName="保存草稿"
              className="ghost-button"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, draft }}
            >
              保存草稿
            </ExecutionButton>
            <ExecutionButton
              action="rewrite_content"
              actionName="Agent 改写文案"
              className="ghost-button"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, feedback: draft.feedback, draft }}
              reason={!draft.feedback.trim() ? '请先填写改写意见' : undefined}
            >
              Agent 改写
            </ExecutionButton>
            <ExecutionButton
              action="review_generated_asset"
              actionName="确认文案可用"
              className="ghost-button"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, review_type: 'copy', approved: true, draft }}
            >
              确认文案可用
            </ExecutionButton>
          </div>
        </section>

        <section className="workspace-block media-generation-shell">
          <div className="media-generation-heading">
            <div>
              <p className="eyebrow">视觉内容生成</p>
              <h3>选择要生成的内容</h3>
            </div>
            <span>点击图片或视频后展开对应设置</span>
          </div>
          <div className="media-generation-switch" role="group" aria-label="选择图片或视频生成">
            <button
              className={`media-generation-option ${activeMediaPanel === 'image' ? 'active' : ''}`}
              type="button"
              aria-expanded={activeMediaPanel === 'image'}
              onClick={() => setActiveMediaPanel((current) => current === 'image' ? null : 'image')}
            >
              <span className="media-generation-icon">▧</span>
              <span>
                <strong>图片生成</strong>
                <small>图片要求、角色 LoRA、参考素材与生图</small>
              </span>
              <b>{activeMediaPanel === 'image' ? '收起' : '展开'}</b>
            </button>
            <button
              className={`media-generation-option ${activeMediaPanel === 'video' ? 'active' : ''}`}
              type="button"
              aria-expanded={activeMediaPanel === 'video'}
              onClick={() => setActiveMediaPanel((current) => current === 'video' ? null : 'video')}
            >
              <span className="media-generation-icon">▶</span>
              <span>
                <strong>视频生成</strong>
                <small>视频要求、生成方式、参考素材与生视频</small>
              </span>
              <b>{activeMediaPanel === 'video' ? '收起' : '展开'}</b>
            </button>
          </div>
        </section>

        {activeMediaPanel && (
          <div className="media-generation-panel">
            <section className="workspace-block media-requirement-block">
              <h3>{activeMediaPanel === 'image' ? '图片要求' : '视频要求'}</h3>
              {activeMediaPanel === 'image' ? (
                <RequirementGrid fields={IMAGE_REQUIREMENT_FIELDS} value={imageReq} empty="当前内容没有结构化图片要求。" />
              ) : (
                <RequirementGrid fields={VIDEO_REQUIREMENT_FIELDS} value={videoReq} empty="当前内容没有结构化视频要求。" />
              )}
            </section>

        <section className="workspace-block">
          <h3>人物角色与 LoRA</h3>
          <div className="editor-grid">
            <label>人物角色
              <select value={selectedCharacterId} onChange={(event) => setSelectedCharacterId(event.target.value)}>
                <option value="">请选择角色</option>
                {(data.characters || []).filter((character) => character.status !== 'archived').map((character) => {
                  const characterLora = getLoraInfo(character, item);
                  return (
                    <option key={character.id} value={character.id}>
                      {character.display_name || character.name || character.id} · {displayText(characterLora.name || characterLora.model, '未绑定 LoRA')}
                    </option>
                  );
                })}
              </select>
            </label>
            <Info label="来源账号" value={item.sourceAccount || referenceAccount?.account_name} />
          </div>
          <div className="character-lora-panel">
            <div className="character-preview">
              {selectedCharacter?.avatar || selectedCharacter?.avatar_url ? <img src={selectedCharacter.avatar || selectedCharacter.avatar_url} alt="" /> : <span>角色预览</span>}
            </div>
            <div className="content-card-meta">
              <Info label="角色" value={selectedCharacter?.display_name || selectedCharacter?.name} />
              <Info label="LoRA 模型" value={lora.name || lora.model || lora.filename} />
              <Info label="LoRA 版本" value={lora.version} />
              <Info label="LoRA 权重" value={lora.weight || lora.strength} />
              {activeMediaPanel === 'image' ? (
                <Info label="可用于图片" value={booleanText(lora.image_enabled ?? lora.image)} />
              ) : (
                <>
                  <Info label="可用于视频" value={booleanText(lora.video_enabled ?? lora.video)} />
                  <Info label="视频生成方式" value={displayText(videoModeLabel(videoMode))} />
                </>
              )}
              <Info label="素材库参考" value={selectedAssets.map((asset) => asset.name)} />
            </div>
          </div>
          {!hasLora(lora) && (
            <div className="warning-card">
              这个角色还没有配置 LoRA。需要先在角色库绑定 LoRA 模型、版本和权重，才能做角色一致性图片/视频生成。
              <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>前往角色库配置</button>
            </div>
          )}
        </section>

        {activeMediaPanel === 'video' && (
          <section className="workspace-block">
          <h3>视频生成方式</h3>
          <label className="full-editor">生成方式
            <select value={videoMode} onChange={(event) => setVideoMode(event.target.value)}>
              {VIDEO_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <ModeInputs mode={videoMode} selectedAssets={selectedAssets} videoReq={videoReq} />
          </section>
        )}

        <section className="workspace-block">
          <h3>素材来源</h3>
          <div className="studio-controls-grid">
            <label>来源账号（可选）
              <input value={referenceSource} onChange={(event) => setReferenceSource(event.target.value)} placeholder="例如 @maisiewzil" />
            </label>
          </div>
          <div className="asset-source-grid">
            <div>
              <h4>从素材库选择</h4>
              <div className="asset-selector-grid">
                {referenceAssets.slice(0, 24).map((asset) => (
                  <button
                    key={asset.id}
                    className={`asset-select-card ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`}
                    type="button"
                    onClick={() => toggleAsset(asset.id)}
                  >
                    <AssetPreview asset={asset} />
                    <strong>{asset.name}</strong>
                    <small>{asset.type} · {asset.source || '素材库'} · {formatDate(asset.createdAt)}</small>
                    <small>权限：{displayText(asset.rightsStatus, '未确认')} · 使用：{asset.usedByContentId ? '已被引用' : '未占用'}</small>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <h4>上传本地文件</h4>
              <label className="upload-dropzone">
                <input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={(event) => setSelectedFiles(Array.from(event.target.files || []))}
                />
                <span>拖拽或选择图片 / 视频</span>
                <small>选择后会显示上传队列；真实上传通过执行网关进入素材库。</small>
              </label>
              <div className="upload-list">
                {selectedFiles.map((file) => (
                  <div key={`${file.name}-${file.size}`} className="upload-row">
                    <span>{file.name}</span>
                    <small>{Math.round(file.size / 1024)} KB · 待上传</small>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h4>粘贴 X 贴文链接导入</h4>
              <input value={xUrl} onChange={(event) => setXUrl(event.target.value)} placeholder="https://x.com/用户名/status/推文ID" />
              <div className="x-import-preview">
                {parsedX ? (
                  <>
                    <Info label="原始链接" value={xUrl} />
                    <Info label="来源账号" value={`@${parsedX.username}`} />
                    <Info label="推文 ID" value={parsedX.statusId} />
                    <Info label="预览" value="导入后显示正文与图片/视频预览" />
                  </>
                ) : (
                  <p>请输入 X / Twitter status 链接。Token 和 secret 只在服务端使用，不会返回前端。</p>
                )}
              </div>
              <label className="consent-row">
                <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />
                我确认有权将该素材作为本次生成参考
              </label>
              <label className="consent-row">
                <input type="checkbox" checked={forceRemote} onChange={(event) => setForceRemote(event.target.checked)} />
                实际提交到 AutoDL（可能产生费用）；不勾选只创建安全预演任务
              </label>
            </div>
          </div>
        </section>

        <section className="workspace-block">
          <h3>{activeMediaPanel === 'image' ? '生成图片' : '生成视频'}</h3>
          <div className="button-row">
            <ExecutionButton
              action="upload_reference_asset"
              actionName="上传到素材库"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, campaign_id: item.campaignId, character_id: selectedCharacter?.id, files: selectedFiles.map(fileToPayload), rights_asserted: rightsConfirmed, reference_source: referenceSource }}
              reason={!selectedFiles.length ? '请先选择本地图片或视频' : !rightsConfirmed ? '请先确认素材使用权限' : undefined}
            >
              上传到素材库
            </ExecutionButton>
            <ExecutionButton
              action="import_x_reference"
              actionName="从 X 链接导入"
              className="ghost-button"
              resourceType="content_package"
              resourceId={item.id}
              payload={{ content_package_id: item.id, campaign_id: item.campaignId, character_id: selectedCharacter?.id, url: xUrl, rights_asserted: rightsConfirmed, reference_source: referenceSource }}
              reason={!parsedX ? '请填写有效的 X 贴文链接' : !rightsConfirmed ? '请先确认素材使用权限' : undefined}
            >
              从 X 链接导入
            </ExecutionButton>
            {activeMediaPanel === 'image' ? (
              <ExecutionButton
                action="generate_character_image"
                actionName="使用角色 LoRA 生成图片"
                resourceType="content_package"
                resourceId={item.id}
                payload={generationPayload}
                reason={missingGenerationReason}
              >
                使用角色 LoRA 生成图片
              </ExecutionButton>
            ) : (
              <ExecutionButton
                action="generate_character_video"
                actionName="使用角色 LoRA 生成视频"
                resourceType="content_package"
                resourceId={item.id}
                payload={generationPayload}
                reason={missingGenerationReason}
              >
                使用角色 LoRA 生成视频
              </ExecutionButton>
            )}
          </div>
        </section>
          </div>
        )}

        <section className="workspace-block">
          <h3>生成结果回传</h3>
          <GenerationResults
            item={item}
            assets={linkedAssets}
            runs={runs}
            selectedId={selectedGeneratedId}
            onSelect={setSelectedGeneratedId}
          />
        </section>

        <section className="workspace-block approval-block">
          <h3>终审与发布队列</h3>
          <div className="editor-grid final-review-editor">
            <label>最终贴文正文
              <textarea rows="5" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
            </label>
            <label>最终 CTA
              <input value={draft.cta} onChange={(event) => setDraft({ ...draft, cta: event.target.value })} />
            </label>
            <label>发布时间
              <input type="datetime-local" value={draft.scheduledAt} onChange={(event) => setDraft({ ...draft, scheduledAt: event.target.value })} />
            </label>
          </div>
          <div className="review-checklist">
            <Check label="正文已确认" ok={Boolean(draft.body.trim())} />
            <Check label="CTA 已确认" ok={Boolean(draft.cta.trim())} />
            <Check label="标签已确认" ok={Boolean(draft.tags.trim())} />
            <Check label="角色 / LoRA 已确认" ok={Boolean(selectedCharacter && hasLora(lora))} />
            <Check label="素材已确认" ok={Boolean(selectedAssets.length || linkedAssets.length)} />
            <Check label="素材权限已确认" ok={rightsConfirmed || linkedAssets.some((asset) => asset.rightsStatus)} />
          </div>
          <ExecutionButton
            action="finalize_content_package"
            actionName="审核通过并创建发布任务"
            resourceType="content_package"
            resourceId={item.id}
            payload={{
              content_package_id: item.id,
              selected_asset_id: selectedGeneratedId || null,
              selected_asset_ids: selectedAssetIds,
              final_body: draft.body,
              final_cta: draft.cta,
              final_tags: normalizeList(draft.tags),
              scheduled_at: draft.scheduledAt ? new Date(draft.scheduledAt).toISOString() : null,
              platform_account_id: item.accountId,
            }}
            reason={finalReviewReason}
          >
            审核通过并进入发布队列
          </ExecutionButton>
          {publishTask && <p className="muted-line">已关联发布任务：{publishTask.id} · {displayText(publishTask.status)}</p>}
        </section>
    </div>
  );
}

function RequirementGrid({ fields, value, empty }) {
  const entries = fields
    .map(([key, label]) => [label, value?.[key] ?? value?.[toCamel(key)]])
    .filter(([, nextValue]) => nextValue !== undefined && nextValue !== null && nextValue !== '');

  if (!entries.length && value?.text) entries.push(['说明', value.text]);
  if (!entries.length) return <div className="empty-card-inline">{empty}</div>;

  return (
    <div className="requirement-grid">
      {entries.map(([label, nextValue]) => (
        <Info key={label} label={label} value={nextValue} />
      ))}
    </div>
  );
}

function ModeInputs({ mode, selectedAssets, videoReq }) {
  if (mode === 'text_to_video') return <div className="empty-card-inline">文生视频会直接使用当前内容策略、视频脚本和角色 LoRA。</div>;
  if (mode === 'image_to_video') return <ModeNotice title="图生视频" text="必须选择一张参考图片。系统会结合当前分镜和镜头运动生成视频。" selectedAssets={selectedAssets} />;
  if (mode === 'first_frame') return <ModeNotice title="首帧生视频" text="必须选择首帧图片。尾帧和运动由视频要求自动补充。" selectedAssets={selectedAssets} />;
  if (mode === 'first_last_frame') return <ModeNotice title="首尾帧生视频" text="需要首帧和尾帧参考，适合控制人物起止动作。" selectedAssets={selectedAssets} />;
  if (mode === 'reference_video') return <ModeNotice title="参考视频生成" text="必须选择参考视频，用于动作、镜头和节奏迁移。" selectedAssets={selectedAssets} />;
  if (mode === 'multi_shot') {
    return (
      <div className="shot-list">
        {(normalizeList(videoReq.shots) || []).slice(0, 8).map((shot, index) => (
          <div key={`${displayText(shot)}-${index}`} className="shot-card">
            <strong>镜头 {index + 1}</strong>
            <p>{displayText(shot)}</p>
          </div>
        ))}
        {!normalizeList(videoReq.shots).length && <div className="empty-card-inline">当前内容没有分镜列表，生成前建议先让 Agent 补充分镜。</div>}
      </div>
    );
  }
  return <div className="empty-card-inline">角色 LoRA 视频会使用已绑定 LoRA 的角色，并结合当前视频要求生成。</div>;
}

function ModeNotice({ title, text, selectedAssets }) {
  return (
    <div className="mode-notice">
      <strong>{title}</strong>
      <p>{text}</p>
      <small>已选参考素材：{selectedAssets.length ? selectedAssets.map((asset) => asset.name).join('、') : '暂无'}</small>
    </div>
  );
}

function GenerationResults({ item, assets, runs, selectedId, onSelect }) {
  const generatedAssets = assets.filter((asset) => {
    const metadata = safeJson(asset.raw?.metadata);
    return metadata.role === 'generated' || (asset.source && asset.source !== 'upload');
  });
  const selectedAsset = generatedAssets.find((asset) => String(asset.id) === String(selectedId));

  return (
    <div className="generation-result-layout">
      <div>
        <h4>Workflow 任务</h4>
        {runs.length ? runs.map((run) => (
          <article key={run.id} className="run-card">
            <div className="row-between">
              <strong>{run.tool_id || run.workflow_id || 'workflow_run'}</strong>
              <StatusBadge status={run.status} />
            </div>
            <Info label="run_id" value={run.id} />
            <Info label="成本" value={run.cost} />
            <Info label="开始" value={formatDate(run.created_at)} />
            <Info label="完成" value={formatDate(run.completed_at)} />
            <Info label="错误" value={run.error_message} />
            <div className="button-row">
              <ExecutionButton action="poll_asset_status" actionName="回传生成内容" className="ghost-button" resourceType="workflow_run" resourceId={run.id} payload={{ run_id: run.id, content_package_id: item.id }}>回传生成内容</ExecutionButton>
              <ExecutionButton action="regenerate_asset" actionName="重新生成" className="ghost-button" resourceType="workflow_run" resourceId={run.id} payload={{ run_id: run.id, content_package_id: item.id }}>重新生成</ExecutionButton>
            </div>
          </article>
        )) : <div className="empty-card-inline">暂无生成任务。提交图片或视频生成后，run_id、进度、错误和回传结果会显示在这里。</div>}
      </div>
      <div>
        <h4>已回传素材</h4>
        {generatedAssets.length ? (
          <>
            <div className="result-review-toolbar">
              <label>生成结果
                <select value={selectedId} onChange={(event) => onSelect(event.target.value)}>
                  <option value="">请选择生成结果</option>
                  {generatedAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.type} · {asset.status}{asset.raw?.approved_for_publishing ? ' · 已确认可用' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="button-row">
                <ExecutionButton action="poll_asset_status" actionName="回传生成内容" className="ghost-button" resourceType="asset" resourceId={selectedAsset?.id} payload={{ asset_id: selectedAsset?.id, content_package_id: item.id }} reason={!selectedAsset ? '请先选择生成结果' : undefined}>回传生成内容</ExecutionButton>
                <ExecutionButton action="review_generated_asset" actionName="确认这个内容能用" resourceType="asset" resourceId={selectedAsset?.id} payload={{ asset_id: selectedAsset?.id, content_package_id: item.id, approved: true }} reason={!selectedAsset ? '请先选择生成结果' : undefined}>确认这个内容能用</ExecutionButton>
                <ExecutionButton action="regenerate_asset" actionName="重新生成" className="ghost-button" resourceType="asset" resourceId={selectedAsset?.id} payload={{ asset_id: selectedAsset?.id, content_package_id: item.id }} reason={!selectedAsset ? '请先选择生成结果' : undefined}>重新生成</ExecutionButton>
              </div>
            </div>
            <div className="asset-selector-grid">
            {generatedAssets.map((asset) => (
              <article key={asset.id} className="asset-result-card">
                <AssetPreview asset={asset} />
                <strong>{asset.name}</strong>
                <small>{asset.type} · {asset.status} · {formatDate(asset.createdAt)}</small>
                <div className="button-row">
                  <ExecutionButton action="review_generated_asset" actionName="确认可用" className="ghost-button" resourceType="asset" resourceId={asset.id} payload={{ asset_id: asset.id, content_package_id: item.id, approved: true }}>确认可用</ExecutionButton>
                  <ExecutionButton action="review_generated_asset" actionName="驳回" className="ghost-button" resourceType="asset" resourceId={asset.id} payload={{ asset_id: asset.id, content_package_id: item.id, approved: false }}>驳回</ExecutionButton>
                </div>
              </article>
            ))}
            </div>
          </>
        ) : <div className="empty-card-inline">暂无生成结果。成功后会同时保存到素材库，并回到这张内容卡。</div>}
      </div>
    </div>
  );
}

function AssetPreview({ asset, compact = false }) {
  if (asset.thumbnail || asset.url) {
    if (String(asset.type).toLowerCase().includes('video')) {
      return <video className={compact ? 'compact-asset-preview' : ''} src={asset.url} poster={asset.thumbnail} controls={!compact} muted />;
    }
    return <img className={compact ? 'compact-asset-preview' : ''} src={asset.thumbnail || asset.url} alt="" />;
  }
  return <div className={`asset-placeholder ${compact ? 'compact-asset-preview' : ''}`}>{displayText(asset.type, 'asset')}</div>;
}

function Info({ label, value }) {
  return (
    <section>
      <span>{label}</span>
      <strong>{displayText(value)}</strong>
    </section>
  );
}

function Check({ label, ok }) {
  return <span className={ok ? 'check-ok' : 'check-missing'}>{ok ? '✓' : '•'} {label}</span>;
}

function assetsForContent(item, assets) {
  const referenceIds = new Set([item.assetId, item.finalAssetId, ...item.referenceAssetIds].filter(Boolean).map(String));
  return assets.filter((asset) => (
    String(asset.contentId || '') === String(item.id)
    || String(asset.campaignId || '') === String(item.campaignId)
    || referenceIds.has(String(asset.id))
  ));
}

function runsForContent(item, runs) {
  return (runs || []).filter((run) => {
    const input = run.input_data || {};
    return String(input.content_package_id || input.content_id || run.content_package_id || '') === String(item.id);
  });
}

function getLoraInfo(character, item) {
  const source = item?.loraInfo || character?.lora_info || character?.lora || {};
  if (typeof source === 'string') {
    const parsed = safeJson(source);
    return Object.keys(parsed).length ? parsed : { name: source };
  }
  return source || {};
}

function safeJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function hasLora(lora) {
  return Boolean(lora?.name || lora?.model || lora?.filename || lora?.id);
}

function normalizeRequirement(value) {
  if (!value) return {};
  if (typeof value === 'string') return { text: value };
  if (Array.isArray(value)) return { text: value.map((item) => displayText(item)).join('；') };
  if (typeof value === 'object') return value;
  return { text: String(value) };
}

function truncate(value, length) {
  const text = displayText(value, '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function booleanText(value) {
  if (value === undefined || value === null || value === '') return '未配置';
  return value ? '支持' : '不支持';
}

function toLocalDateTimeValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function videoModeLabel(value) {
  return VIDEO_MODES.find(([mode]) => mode === value)?.[1] || value;
}

function parseXUrl(value) {
  const match = String(value || '').trim().match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/i);
  if (!match) return null;
  return { username: match[1], statusId: match[2] };
}

function fileToPayload(file) {
  return {
    filename: file.name,
    content_type: file.type,
    file_size_bytes: file.size,
  };
}

function toCamel(value) {
  return value.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}
