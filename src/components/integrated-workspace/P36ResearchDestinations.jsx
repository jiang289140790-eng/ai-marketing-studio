// P36 研究工作台渐进式交互重设计：四个目的地（采集 / 分析 / 创作 / 产物）。
//
// 信息架构：
// - 采集：一个显著智能输入 + 一个主按钮 → 紧凑来源卡 → 显式保存；已保存来源
//   作为右栏资料库；热门主题搜索与手工录入作为可展开的次级工具。
// - 分析：必须选择一个已保存来源；媒体预览与完整分析结果同屏（宽屏左右分栏），
//   未保存结果的主操作是「保存分析结果」；「追加新版分析」等位于版本/历史菜单。
// - 创作：必须选择一个已保存分析；相似帖子草稿编辑器为主画布，显式保存；
//   绝不自动审核/交接/路由/发布，绝不静默改绑新分析。
// - 产物：知识卡 / 相似草稿 / Brief / 交接包 / 世系 的紧凑资料库；选择条目打开
//   详情；知识卡详情完整渲染已保存的视频/媒体分析与溯源。
//
// 隔离契约：本组件由页面以 key={project.id} 挂载；切换项目时整棵子树重挂载，
// 采集输入/结果、选中来源/分析、分析预览、草稿与保存标记全部重置，绝不跨项目
// 泄漏。预览与草稿在渲染时再次按证据/分析版本与指纹校验，过时即失效。
//
// 本组件不发起任何网络请求：所有网络副作用（采集/分析/生成相似帖）经由
// 页面持有的 P22 客户端与回调上抛，失败/费用/身份绑定错误由页面统一 fail closed。

import { useCallback, useEffect, useState } from 'react';
import {
  getAllAnalysisVersionsForEvidence,
  getLatestAnalysisForEvidence,
} from '../../services/p19-workspace-service.js';
import { assessMediaAnalyzability, findP22Evidence, p22ItemFromEvidence } from '../../services/p22-research-assist.js';
import { P19AnalysisList, P19CardList, P19EvidenceList } from './P19WorkbenchPanels.jsx';
import { P32ComparisonView, P32EvidenceLibrary, P32HotTopicSearchPanel } from './P19WorkbenchPanels.jsx';
import { P19BriefSection, P19HandoffSection, P19LineageSection } from './P19WorkbenchPanels.jsx';
import { P22CollectPanel } from './P22ResearchAssistPanel.jsx';

// eslint-disable-next-line react-refresh/only-export-components
export const P36_DESTINATIONS = Object.freeze({
  COLLECT: 'collect',
  ANALYZE: 'analyze',
  CREATE: 'create',
  OUTPUTS: 'outputs',
});

const DESTINATION_META = Object.freeze([
  { id: P36_DESTINATIONS.COLLECT, label: '采集', hint: '找到并保存来源' },
  { id: P36_DESTINATIONS.ANALYZE, label: '分析', hint: '查看完整分析结果并保存' },
  { id: P36_DESTINATIONS.CREATE, label: '创作', hint: '从已保存分析生成相似帖子' },
  { id: P36_DESTINATIONS.OUTPUTS, label: '产物', hint: '知识卡、草稿、Brief、交接与世系' },
]);

/** 建议步骤 → 目的地（P21 引导逻辑保留，仅改变呈现层）。 */
// eslint-disable-next-line react-refresh/only-export-components
export function destinationForRecommendedStep(stepId) {
  if (stepId === 'analysis' || stepId === 'card') return P36_DESTINATIONS.ANALYZE;
  if (stepId === 'brief' || stepId === 'review' || stepId === 'handoff' || stepId === 'lineage') return P36_DESTINATIONS.OUTPUTS;
  return P36_DESTINATIONS.COLLECT;
}

function formatShortTime(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return '';
  return text.slice(0, 16).replace('T', ' ');
}

function boundedText(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function engagementLine(engagement) {
  if (!engagement || typeof engagement !== 'object') return null;
  const labels = [['likes', '点赞'], ['retweets', '转发'], ['replies', '评论'], ['quotes', '引用'], ['views', '浏览'], ['bookmarks', '收藏'], ['reddit_score', 'Score'], ['reddit_comments', '评论']];
  const parts = labels.filter(([key]) => Number.isInteger(engagement[key])).map(([key, label]) => `${label} ${engagement[key]}`);
  return parts.length ? parts.join(' · ') : null;
}

function ListBlock({ title, values }) {
  const list = Array.isArray(values) ? values.filter((value) => String(value ?? '').trim() !== '') : [];
  if (list.length === 0) return null;
  return (
    <div className="p36-findings-block">
      <b>{title}</b>
      <ul>{list.map((value, index) => <li key={`${title}-${index}`}>{String(value)}</li>)}</ul>
    </div>
  );
}

function TextBlock({ title, value }) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return (
    <div className="p36-findings-block">
      <b>{title}</b>
      <p>{text}</p>
    </div>
  );
}

// ---- 媒体预览 ---------------------------------------------------------------

function MediaNode({ asset }) {
  const isVideo = asset.kind === 'video' || String(asset.mime_type || '').startsWith('video/');
  const common = { 'data-media-order': asset.order, 'aria-label': `媒体 ${asset.order + 1}` };
  return isVideo
    ? <video src={asset.media_url} controls preload="metadata" {...common} />
    : <img src={asset.media_url} alt={`媒体 ${asset.order + 1}`} loading="lazy" {...common} />;
}

/**
 * 来源媒体预览：真实媒体资产（视频播放器/图片）单独展示；帖子正文文本包
 * （text/plain）明确标记为「帖子文本证据」，绝不把文本包伪称为视频元数据。
 * P38：媒体绑定未通过严格安全验证（旧 URL 哈希/t.co/非白名单/类型失配/
 * 缺内容字节）时显示有界提示，绝不显示不可解释的灰色死按钮。
 */
function P36MediaPreview({ evidence }) {
  const assets = Array.isArray(evidence.media_assets) ? evidence.media_assets : [];
  const mediaMeta = evidence.media_metadata;
  const isTextPackage = Boolean(mediaMeta && typeof mediaMeta.mime_type === 'string' && mediaMeta.mime_type.startsWith('text/plain'));
  const mediaGate = assessMediaAnalyzability(evidence);
  return (
    <div className="p36-media-preview" aria-label="来源媒体预览">
      <div className="p36-section-head">
        <h4>来源媒体</h4>
        <span className="p19-panel-note">{assets.length} 项 · 按顺序绑定</span>
      </div>
      {assets.length > 0 && (
        <>
          <div className="p36-media-grid" data-media-count={assets.length}>
            {assets.map((asset) => <MediaNode key={asset.id} asset={asset} />)}
          </div>
          {!mediaGate.analyzable && (
            <p className="p38-media-unverified" role="status">
              ⚠ 媒体绑定尚未完成安全验证（旧合同）：无法确认真实画面/声音内容，未通过验证前不会调用 Qwen。
            </p>
          )}
        </>
      )}
      {assets.length === 0 && !mediaMeta && (
        <p className="p19-empty-note">该来源没有媒体资产（纯文本来源）。</p>
      )}
      {isTextPackage && (
        <div className="p38-text-package" aria-label="帖子文本证据">
          <b>帖子文本证据</b>
          <span title={mediaMeta.sha256}>
            {boundedText(mediaMeta.filename, 40)} · {mediaMeta.mime_type} · {mediaMeta.byte_size} 字节 · SHA-256 {String(mediaMeta.sha256 || '').slice(0, 12)}…
          </span>
        </div>
      )}
      {mediaMeta && !isTextPackage && (
        <p className="p19-meta-line" title={mediaMeta.sha256}>
          媒体元数据：{boundedText(mediaMeta.filename, 40)} · {mediaMeta.mime_type} · {mediaMeta.byte_size} 字节 · SHA-256 {String(mediaMeta.sha256 || '').slice(0, 12)}…
        </p>
      )}
      <p className="p19-meta-line">
        来源：{boundedText(evidence.source_url, 64)}
      </p>
    </div>
  );
}

// ---- 分析结果（多模态模型）----------------------------------------------------

/**
 * 完整分析结果视图：概览、内容结构、逐媒体/视频发现、受众与情绪、传播驱动与
 * 可复用方法、改写建议、信号与风险；精确 ID/指纹/模型/执行标志收进
 * 「来源与技术信息」可展开区，默认视图保持可读状态。
 */
export function P36AnalysisResultView({ analysis, evidence }) {
  const ext = analysis.model_analysis;
  const result = (ext && ext.result) || analysis.result || {};
  const mediaRows = Array.isArray(result.media_analysis) ? result.media_analysis : [];
  return (
    <div className="p36-analysis-detail" aria-label="完整分析结果">
      <div className="p36-section-head">
        <h4>{result.hook || '内容结构与传播分析'}</h4>
        <span className="p19-panel-note">
          {ext ? `多模态模型分析 · 第 ${analysis.version} 版` : `确定性本地分析 · 第 ${analysis.version} 版`}
        </span>
      </div>
      <TextBlock title="表达与内容" value={result.text_expression} />
      <TextBlock title="文案结构" value={result.copy_pattern} />
      {(result.target_audience || result.audience_need_emotion) && (
        <div className="p36-findings-grid">
          <TextBlock title="目标受众" value={result.target_audience} />
          <TextBlock title="需求与情绪" value={result.audience_need_emotion} />
        </div>
      )}
      {mediaRows.length > 0 && (
        <div className="p36-findings-block">
          <b>逐媒体 / 视频发现</b>
          <ul className="p36-media-findings">
            {mediaRows.map((row, index) => {
              const asset = (Array.isArray(evidence.media_assets) ? evidence.media_assets : []).find((item) => item.id === row.media_id);
              return (
                <li key={row.media_id || index} data-media-id={row.media_id}>
                  <b>媒体 {index + 1}{asset ? ` · ${asset.kind}${asset.dimensions ? ` · ${asset.dimensions.width}×${asset.dimensions.height}` : ''}` : ''}：</b>
                  <p>{[row.visual_content, row.composition, row.people, row.scene, row.emotion].filter(Boolean).join('；')}</p>
                  {row.visual_selling_points && <small>视觉卖点：{row.visual_selling_points}</small>}
                  {row.style_pattern && <small>风格：{row.style_pattern}</small>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="p36-findings-grid">
        <ListBlock title="传播驱动" values={result.virality_drivers} />
        <ListBlock title="可复用方法" values={result.reusable_methods} />
      </div>
      <ListBlock title="改写建议" values={result.rewrite_suggestions} />
      <div className="p36-findings-grid">
        <ListBlock title="信号" values={result.signals} />
        <ListBlock title="风险" values={result.risks} />
      </div>
      <details className="p19-details">
        <summary>来源与技术信息（ID / 指纹 / 模型 / 执行标志）</summary>
        <pre className="p19-pre">{JSON.stringify({
          分析ID: analysis.id,
          分析版本: analysis.version,
          分析指纹: analysis.fingerprint,
          证据ID: evidence.id,
          证据版本: evidence.version,
          证据指纹: evidence.fingerprint,
          模型: ext ? ext.model : 'deterministic_local',
          模型Schema: ext ? ext.schema_version : null,
          来源ID: ext ? ext.source_id : null,
          绑定媒体: ext ? ext.media_ids : [],
          执行时间: ext ? ext.executed_at : analysis.provenance?.executed_at,
          规则条数: Array.isArray(analysis.rule_ids) ? analysis.rule_ids.length : 0,
          生成方式: analysis.provenance?.generated_by,
          用量: ext ? { total_tokens: ext.usage?.total_tokens } : null,
        }, null, 2)}</pre>
      </details>
    </div>
  );
}

// ---- 分析目的地 ---------------------------------------------------------------

/**
 * 分析目的地：左栏来源选择器 + 主画布（媒体预览 + 完整结果 + 主操作）。
 * 状态机：未分析 → 主按钮「分析此来源」；有未保存预览 → 主按钮「保存分析结果」；
 * 已保存多模态 → 主按钮「去创作」；已保存确定性 → 主按钮「生成知识卡 / 查看知识卡」。
 * 「追加新版分析」「运行确定性分析」等一律为次级操作或版本菜单项。
 */
export function P36AnalyzeDestination({
  project,
  busy,
  canUseAi,
  onlineMode,
  selectedEvidenceId,
  onSelectEvidence,
  previews,
  onStartAnalysis,
  onRehydrateMedia,
  onSaveAnalysis,
  onDiscardPreview,
  onRunDeterministic,
  onMakeCard,
  onViewCard,
  onGoCreate,
  onGoCollect,
  workingKey,
  message,
  error,
  comparedEvidenceIds,
  onComparedSelectionChange,
  synthesisOutcome,
  onSynthesize,
}) {
  const evidenceList = project.evidence || [];
  const selected = evidenceList.find((item) => item.id === selectedEvidenceId) || null;
  const latest = selected ? getLatestAnalysisForEvidence(project, selected.id) : null;
  const preview = selected ? previews[selected.id] : null;
  const previewFresh = Boolean(preview && preview.evidenceVersion === selected.version && preview.evidenceFingerprint === selected.fingerprint);
  const hasModel = Boolean(latest && latest.model_analysis);
  const evidenceFresh = Boolean(latest && latest.evidence_fingerprint === selected.fingerprint && latest.evidence_version === selected.version);
  const cardsForLatest = latest ? (project.knowledge_cards || []).filter((card) => (
    card.analysis_id === latest.id
    && card.analysis_fingerprint === latest.fingerprint
    && card.analysis_version === latest.version
  )) : [];
  const cardForLatest = cardsForLatest.length === 1 ? cardsForLatest[0] : null;
  const cardBindingAmbiguous = cardsForLatest.length > 1;
  const sourceHasMedia = Array.isArray(selected?.media_assets) && selected.media_assets.length > 0;
  const allVersions = selected ? getAllAnalysisVersionsForEvidence(project, selected.id) : [];
  const isCollected = Boolean(selected && selected.provenance && selected.provenance.source_id);
  // P38 严格媒体可分析性：旧合同媒体（URL 哈希/t.co/非白名单/类型失配/缺内容
  // 字节）必须先「重新采集媒体并分析」原位恢复，恢复前任何入口不得调用 Qwen。
  const mediaGate = selected ? assessMediaAnalyzability(selected) : null;
  const needsRehydration = Boolean(mediaGate && !mediaGate.analyzable && isCollected);

  if (!selected) {
    return (
      <div className="p36-empty-state p36-destination-empty" role="status">
        <p className="p19-eyebrow">分析</p>
        <h3>还没有已保存的来源</h3>
        <p>先在「采集」中粘贴链接或输入主题并保存来源，然后回到这里查看完整分析结果。</p>
        <button className="p19-btn p19-btn-primary" type="button" onClick={onGoCollect}>去采集来源</button>
      </div>
    );
  }

  const sourceMeta = selected.source_metadata || {};
  const author = sourceMeta.author || {};
  const latestStale = Boolean(latest && !evidenceFresh);
  const primaryAction = (() => {
    if (preview && previewFresh) {
      return (
        <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled={busy || Boolean(workingKey)} onClick={() => onSaveAnalysis(selected.id, preview)}>
          {workingKey === `save-analysis:${selected.id}` ? '保存中…' : '保存分析结果'}
        </button>
      );
    }
    if (needsRehydration) {
      // P38 唯一可操作入口：旧合同媒体不得直接调用 Qwen，必须先原位恢复。
      return (
        <button
          className="p19-btn p19-btn-primary p36-cta-primary p38-rehydrate-cta"
          type="button"
          disabled={busy || Boolean(workingKey) || !canUseAi || !onlineMode}
          onClick={() => onRehydrateMedia(selected.id)}
          title={onlineMode
            ? (canUseAi ? '重新采集同一 X 帖子、验证真实媒体内容并原位升级该证据，再运行 Qwen 多模态分析（结果预览，确认后才会保存）' : '当前账号无分析权限')
            : '重新采集媒体需要登录在线工作区'}
        >
          {workingKey === `rehydrate:${selected.id}` ? '恢复并分析中…' : '重新采集媒体并分析'}
        </button>
      );
    }
    if (!latest || latestStale) {
      if (!isCollected) {
        // 手工录入的来源没有可绑定的来源身份，不调用模型：确定性本地分析即主操作。
        return (
          <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled={busy || Boolean(workingKey)} onClick={() => onRunDeterministic(selected.id)} title="手工录入的来源不调用模型：由确定性本地规则生成分析（deterministic_local）">
            {workingKey === `analyze:${selected.id}` ? '分析中…' : '运行确定性分析'}
          </button>
        );
      }
      return (
        <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled={busy || Boolean(workingKey) || !canUseAi} onClick={() => onStartAnalysis(selected.id)} title={canUseAi ? '运行多模态模型分析（结果预览，确认后才会保存）' : '当前账号无分析权限'}>
          {workingKey === `analyze:${selected.id}` ? '分析中…' : '分析此来源'}
        </button>
      );
    }
    if (hasModel) {
      return (
        <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled={busy} onClick={() => onGoCreate(latest.id)} title="使用这份已保存分析生成相似帖子草稿">
          去创作
        </button>
      );
    }
    if (cardBindingAmbiguous) {
      return <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled>知识卡绑定异常</button>;
    }
    if (cardForLatest) {
      return (
        <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled={busy} onClick={() => onViewCard(cardForLatest.id)} title="打开这份分析精确绑定的知识卡详情；不会再次写入">
          查看知识卡
        </button>
      );
    }
    if (isCollected && sourceHasMedia && canUseAi) {
      return (
        <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled={busy || Boolean(workingKey)} onClick={() => onStartAnalysis(selected.id)} title="使用 Qwen 多模态模型理解媒体内容；结果预览后由你确认保存">
          用 Qwen 分析此来源
        </button>
      );
    }
    return (
      <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled={busy} onClick={() => onMakeCard(latest.id)} title="把这份确定性基础检测转为知识卡">
        生成知识卡
      </button>
    );
  })();

  // 未保存预览按来源版本/指纹校验后，构造与已保存分析同形的 model_analysis 包装。
  const previewAnalysis = (preview && previewFresh)
    ? {
      id: latest?.id || selected.id,
      version: latest ? latest.version + 1 : 1,
      fingerprint: '',
      rule_ids: [],
      provenance: latest?.provenance || { generated_by: 'model_preview' },
      model_analysis: {
        source_id: preview.result.source_id,
        model: preview.result.model || 'qwen-plus',
        schema_version: 'p32_multimodal_model_v2',
        media_ids: (Array.isArray(preview.result.media_analysis) ? preview.result.media_analysis : []).map((row) => row && row.media_id),
        executed_at: preview.result.executed_at || '',
        result: preview.result,
      },
    }
    : null;

  return (
    <div className="p36-destination p36-analyze" data-destination="analyze">
      <aside className="p36-rail" aria-label="已保存来源">
        <div className="p36-rail-head">
          <h3>来源</h3>
          <span className="p19-panel-note">{evidenceList.length} 条已保存</span>
        </div>
        <ul className="p36-rail-list">
          {evidenceList.map((record) => {
            const rowLatest = getLatestAnalysisForEvidence(project, record.id);
            const rowFresh = Boolean(rowLatest && rowLatest.evidence_fingerprint === record.fingerprint && rowLatest.evidence_version === record.version);
            const rowGate = assessMediaAnalyzability(record);
            const rowNeedsRehydration = Boolean(!rowGate.analyzable && record.provenance?.source_id);
            const status = rowNeedsRehydration
              ? '媒体待恢复'
              : rowLatest ? (rowLatest.model_analysis ? (rowFresh ? '已分析' : '分析已过时') : rowFresh ? '确定性分析' : '分析已过时') : '尚未分析';
            return (
              <li key={record.id}>
                <button
                  type="button"
                  className={`p36-rail-item ${record.id === selected.id ? 'selected' : ''}`}
                  onClick={() => onSelectEvidence(record.id)}
                  aria-pressed={record.id === selected.id}
                  title={record.source_url}
                >
                  <strong>{boundedText(record.label, 30)}</strong>
                  <small>{status}{rowLatest ? ` · v${rowLatest.version}` : ''}{Array.isArray(record.media_assets) && record.media_assets.length > 0 ? ` · 媒体 ${record.media_assets.length}` : ''}</small>
                </button>
              </li>
            );
          })}
        </ul>
        {evidenceList.length === 0 && (
          <p className="p19-empty-note">暂无来源。先到「采集」保存来源。</p>
        )}
      </aside>
      <div className="p36-canvas">
        <div className="p36-source-summary" aria-label="选中来源">
          <div className="p36-section-head">
            <div>
              <h3>{boundedText(selected.label, 60)}</h3>
              <p className="p19-meta-line">
                {author.name || author.handle || '未知作者'}
                {author.handle ? ` @${author.handle}` : ''}
                {sourceMeta.published_at ? ` · ${formatShortTime(sourceMeta.published_at)}` : ''}
                {sourceMeta.community ? ` · r/${boundedText(sourceMeta.community, 24)}` : ''}
              </p>
            </div>
            <span className="p19-meta-line">
              {selected.provenance?.manual === false ? 'P22 采集来源' : '手工录入'}
              {engagementLine(sourceMeta.engagement) ? ` · ${engagementLine(sourceMeta.engagement)}` : ''}
            </span>
          </div>
          <p className="p19-meta-line">{boundedText(selected.content_text, 300)}</p>
        </div>
        <div className="p36-split">
          <P36MediaPreview evidence={selected} />
          <div className="p36-result-col">
            {previewAnalysis && (
              <>
                <P36AnalysisResultView analysis={previewAnalysis} evidence={selected} />
                <div className="p36-result-actions">
                  <span className="p22-preview-state">预览 · 未保存</span>
                  <button className="p19-btn p19-btn-ghost" type="button" disabled={busy || Boolean(workingKey)} onClick={() => onDiscardPreview(selected.id)}>放弃本次结果</button>
                </div>
              </>
            )}
            {!preview && needsRehydration && (
              <div className="p38-media-notice" data-testid="p38-media-notice" role="status">
                <b>视频媒体尚未完成安全验证</b>
                <span>
                  该来源的媒体绑定来自旧合同：基础检测没有理解视频画面/声音，也未验证真实媒体内容。
                  点击下方「重新采集媒体并分析」：重新采集同一 X 帖子、验证真实视频/图片内容、原位升级该 Evidence，再运行 Qwen 多模态分析（结果预览，确认后才会保存）。
                </span>
              </div>
            )}
            {!preview && latest && (
              <>
                <div className={`p36-analysis-quality ${hasModel ? 'model' : 'basic'}`} data-testid="p36-analysis-quality" role="status">
                  <strong>{hasModel ? 'Qwen 多模态分析' : '基础检测（未理解视频画面/声音）'}</strong>
                  <span>
                    {hasModel
                      ? `已保存模型结果；覆盖文本与 ${latest.model_analysis?.result?.media_analysis?.length || 0} 项逐媒体分析，并保留模型、来源和执行身份。`
                      : '仅检查来源 URL、文字表面特征和媒体元数据；不包含镜头、人物动作、字幕、声音、叙事或情绪理解，不能作为全面的视频分析。'}
                  </span>
                  {!hasModel && isCollected && sourceHasMedia && canUseAi && !needsRehydration && (
                    <button className="p19-btn p19-btn-ghost" type="button" disabled={busy || Boolean(workingKey)} onClick={() => onStartAnalysis(selected.id)}>
                      用 Qwen 分析视频/图片
                    </button>
                  )}
                </div>
                {hasModel ? (
                  <P36AnalysisResultView analysis={latest} evidence={selected} />
                ) : (
                  <div className="p36-analysis-detail" aria-label="确定性本地分析结果">
                    <div className="p36-section-head">
                      <h4>确定性本地分析（未调用任何模型）</h4>
                      <span className="p19-panel-note">deterministic_local · 第 {latest.version} 版</span>
                    </div>
                    <p className="p19-provenance-line">规则 {latest.rule_ids.length} 条 · {latest.provenance.generated_by}</p>
                    <ul className="p19-rule-list">
                      {(latest.result.rules || []).map((rule) => (
                        <li key={rule.rule_id}><b>{rule.label}：</b><span>{String(rule.output?.note || rule.output?.trust_status || rule.output?.keywords?.join('、') || JSON.stringify(rule.output) || '—')}</span></li>
                      ))}
                    </ul>
                    <details className="p19-details">
                      <summary>来源与技术信息（ID / 指纹 / 规则 / 执行标志）</summary>
                      <pre className="p19-pre">{JSON.stringify({
                        分析ID: latest.id, 分析版本: latest.version, 分析指纹: latest.fingerprint,
                        证据ID: selected.id, 证据版本: selected.version, 证据指纹: selected.fingerprint,
                        规则: latest.rule_ids, 生成方式: latest.provenance?.generated_by,
                      }, null, 2)}</pre>
                    </details>
                  </div>
                )}
                {latestStale && <p className="p19-blocking-note">⚠ 分析已过时：来源内容已变化。请重新分析后再使用。</p>}
              </>
            )}
            {!preview && !latest && (
              <div className="p36-empty-state" role="status">
                <p className="p19-eyebrow">尚未分析</p>
                <h3>{isCollected ? '查看完整分析结果' : '手工来源可用确定性分析'}</h3>
                <p>
                  {isCollected
                    ? '点击下方「分析此来源」运行多模态模型分析；结果先预览，由你确认后才会保存为新版本。'
                    : '手工录入的来源不调用模型：点击下方「运行确定性分析」由本地规则生成分析。'}
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="p36-result-actions">
          {primaryAction}
          <button className="p19-btn p19-btn-ghost" type="button" disabled={busy || Boolean(workingKey)} onClick={() => onRunDeterministic(selected.id)} title="运行确定性本地分析（deterministic_local，不调用模型）">
            运行确定性分析
          </button>
          {!preview && latest && !cardBindingAmbiguous && (
            <button
              className="p19-btn p19-btn-ghost p36-card-action"
              type="button"
              disabled={busy}
              onClick={() => (cardForLatest ? onViewCard(cardForLatest.id) : onMakeCard(latest.id))}
            >
              {cardForLatest ? '查看知识卡' : '生成知识卡'}
            </button>
          )}
          <details className="p36-version-menu">
            <summary>版本与历史</summary>
            <div className="p36-version-menu-items">
              <button
                className="p19-btn p19-btn-ghost"
                type="button"
                disabled={busy || Boolean(workingKey) || !canUseAi || needsRehydration}
                onClick={() => onStartAnalysis(selected.id)}
                title={needsRehydration ? '媒体尚未完成安全验证：请先点击「重新采集媒体并分析」恢复媒体' : '追加新版分析（保留旧版本，不覆写）'}
              >
                追加新版分析
              </button>
              {allVersions.length > 1 && (
                <div className="p36-version-history" aria-label="分析版本历史">
                  <b>共 {allVersions.length} 个版本（旧版只读保留，追加不覆写）</b>
                  <ul>
                    {allVersions.map((row) => (
                      <li key={row.id}>
                        v{row.version} · {row.model_analysis ? boundedText(row.model_analysis.model, 30) : '确定性分析'}
                        {' · '}{formatShortTime(row.model_analysis?.executed_at || row.provenance?.executed_at)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
          {message && <p className="p22-message" role="status">{message}</p>}
          {error && <p className="p19-error-text" role="alert">{error}</p>}
        </div>
        <details className="p36-advanced">
          <summary>高级工具：全部分析记录 · 多帖比较与综合 Brief</summary>
          <P19AnalysisList project={project} onMakeCard={onMakeCard} busy={busy} />
          <P32ComparisonView
            project={project}
            selectedIds={comparedEvidenceIds}
            onSelectionChange={onComparedSelectionChange}
            onSynthesize={onSynthesize}
            busy={busy}
            outcome={synthesisOutcome}
          />
        </details>
      </div>
    </div>
  );
}

// ---- 创作目的地 ---------------------------------------------------------------

/**
 * 创作目的地：左栏已保存分析选择器 + 主画布相似帖子草稿编辑器。
 * 必须显式选择一份已保存分析；生成/编辑/保存每步独立确认，绝不自动审核、
 * 自动交接、路由、发布或静默改绑更新版本。
 */
export function P36CreateDestination({
  project,
  busy,
  canUseAi,
  selectedAnalysisId,
  onSelectAnalysis,
  drafts,
  savedDraftIds,
  workingKey,
  message,
  error,
  onGenerateDraft,
  onUpdateDraft,
  onSaveDraft,
  onGoAnalyze,
}) {
  const evidenceById = new Map((project.evidence || []).map((item) => [item.id, item]));
  const modelAnalyses = (project.analyses || [])
    .filter((row) => row.model_analysis)
    .sort((a, b) => String(b.model_analysis.executed_at || '').localeCompare(String(a.model_analysis.executed_at || '')));
  const deterministicAnalyses = (project.analyses || []).filter((row) => !row.model_analysis);
  const selected = (project.analyses || []).find((row) => row.id === selectedAnalysisId && row.model_analysis) || null;
  const selectedEvidence = selected ? evidenceById.get(selected.evidence_id) || null : null;
  const draft = selected ? drafts[selected.id] : null;
  const draftFresh = Boolean(draft && selectedEvidence
    && draft.analysis_id === selected.id
    && draft.analysis_version === selected.version
    && draft.analysis_fingerprint === selected.fingerprint
    && draft.evidence_id === selectedEvidence.id
    && draft.evidence_version === selectedEvidence.version
    && draft.evidence_fingerprint === selectedEvidence.fingerprint);
  const savedId = selected ? savedDraftIds[selected.id] : null;

  if (modelAnalyses.length === 0) {
    return (
      <div className="p36-empty-state p36-destination-empty" role="status">
        <p className="p19-eyebrow">创作</p>
        <h3>还没有已保存的多模态分析</h3>
        <p>先在「分析」中对已保存来源运行分析并保存结果，然后回到这里生成相似帖子草稿。</p>
        <button className="p19-btn p19-btn-primary" type="button" onClick={onGoAnalyze}>去分析</button>
      </div>
    );
  }

  return (
    <div className="p36-destination p36-create" data-destination="create">
      <aside className="p36-rail" aria-label="已保存分析">
        <div className="p36-rail-head">
          <h3>已保存分析</h3>
          <span className="p19-panel-note">{modelAnalyses.length} 份可用</span>
        </div>
        <ul className="p36-rail-list">
          {modelAnalyses.map((row) => {
            const evidence = evidenceById.get(row.evidence_id);
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className={`p36-rail-item ${row.id === selected?.id ? 'selected' : ''}`}
                  onClick={() => onSelectAnalysis(row.id)}
                  aria-pressed={row.id === selected?.id}
                >
                  <strong>{boundedText(evidence ? evidence.label : '（来源已移除）', 30)}</strong>
                  <small>{boundedText(row.model_analysis.model, 24)} · v{row.version} · {formatShortTime(row.model_analysis.executed_at)}</small>
                </button>
              </li>
            );
          })}
        </ul>
        {deterministicAnalyses.length > 0 && (
          <p className="p19-meta-line">
            另有 {deterministicAnalyses.length} 份确定性本地分析（不调用模型，不能生成相似帖子草稿，可在「分析」中查看）。
          </p>
        )}
      </aside>
      <div className="p36-canvas">
        <div className="p36-draft-editor" aria-label="相似帖子草稿">
          <div className="p36-section-head">
            <div>
              <p className="p22-kicker">相似帖子草稿</p>
              <h3>基于已保存分析生成，可编辑后保存</h3>
            </div>
            {savedId && <span className="p22-saved-state">已保存到内容库{savedId !== 'saved' ? ` · ${String(savedId).slice(0, 10)}` : ''}</span>}
          </div>
          {selectedEvidence && (
            <p className="p19-meta-line">
              绑定来源：{boundedText(selectedEvidence.label, 40)} · 分析第 {selected.version} 版 · {boundedText(selected.model_analysis.model, 30)}
              {' · '}绑定指纹：{String(selected.fingerprint).slice(0, 12)}…
            </p>
          )}
          {!draft && (
            <div className="p36-empty-state" role="status">
              <p className="p19-empty-note">
                从这份已保存分析生成相似帖子草稿；生成后可以修改标题、正文、行动引导、标签与媒体创意，再显式保存。
                不会自动审核、自动交接、路由或发布。
              </p>
              <div className="p19-form-actions">
                <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled={busy || Boolean(workingKey) || !canUseAi} onClick={() => onGenerateDraft(selected)}>
                  {workingKey === `draft:${selected.id}` ? '生成中…' : '根据分析生成相似帖子'}
                </button>
              </div>
            </div>
          )}
          {draft && (
            <>
              {!draftFresh && (
                <p className="p19-blocking-note">⚠ 草稿绑定的来源或分析版本已变化，已停止保存；请重新生成。</p>
              )}
              <label className="p19-field"><span>标题</span><input type="text" value={draft.title || ''} maxLength={200} onChange={(event) => onUpdateDraft(selected.id, 'title', event.target.value)} disabled={Boolean(savedId)} /></label>
              <label className="p19-field"><span>正文</span><textarea rows={6} value={draft.main_copy || ''} maxLength={5000} onChange={(event) => onUpdateDraft(selected.id, 'main_copy', event.target.value)} disabled={Boolean(savedId)} /></label>
              <div className="p36-findings-grid">
                <label className="p19-field"><span>行动引导</span><input type="text" value={draft.cta || ''} maxLength={300} onChange={(event) => onUpdateDraft(selected.id, 'cta', event.target.value)} disabled={Boolean(savedId)} /></label>
                <label className="p19-field"><span>标签（空格分隔）</span><input type="text" value={(draft.hashtags || []).join(' ')} maxLength={500} onChange={(event) => onUpdateDraft(selected.id, 'hashtags', event.target.value.split(/\s+/).filter(Boolean).slice(0, 10))} disabled={Boolean(savedId)} /></label>
              </div>
              <label className="p19-field"><span>媒体创意</span><textarea rows={3} value={draft.media_idea || ''} maxLength={1000} onChange={(event) => onUpdateDraft(selected.id, 'media_idea', event.target.value)} disabled={Boolean(savedId)} /></label>
              <div className="p19-form-actions">
                <button className="p19-btn p19-btn-primary p36-cta-primary" type="button" disabled={busy || Boolean(workingKey) || !draftFresh || Boolean(savedId)} onClick={() => onSaveDraft(selected, draft)} title={savedId ? '草稿已保存' : '保存为内容库草稿（不审核、不路由、不发布）'}>
                  {workingKey === `save-draft:${selected.id}` ? '保存中…' : savedId ? '草稿已保存' : '保存相似帖子草稿'}
                </button>
                <button className="p19-btn p19-btn-ghost" type="button" disabled={busy || Boolean(workingKey) || !canUseAi} onClick={() => onGenerateDraft(selected)} title="重新生成会覆盖当前未保存的修改">
                  重新生成
                </button>
              </div>
              <small className="p19-meta-line">只保存为草稿；不会自动审核、路由或发布。绑定关系在保存时再次校验，失配即拒绝。</small>
            </>
          )}
          {message && <p className="p22-message" role="status">{message}</p>}
          {error && <p className="p19-error-text" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// ---- 产物目的地 ---------------------------------------------------------------

/**
 * 知识卡详情：完整渲染已保存的视频/媒体分析 —— 媒体时间线与视觉证据、视觉影响、
 * 语义层、情绪基调、受众响应机制、可复用特征、风险标签、证据链接、生成指导、
 * 不确定性与来源/模型/媒体 ID 溯源。不只是钩子 + 四个短标签。
 */
export function P36KnowledgeCardDetail({ card, evidence }) {
  const source = card.source_observations || {};
  const media = source.media || {};
  const creative = card.creative_analysis || {};
  const guidance = card.generation_guidance || {};
  const readiness = card.generation_readiness || {};
  const provenance = card.analysis_provenance || null;
  return (
    <div className="p36-card-detail" aria-label="知识卡详情">
      <div className="p36-section-head">
        <div>
          <h3>{boundedText(creative.hook || source.post_text, 80)}</h3>
          <p className="p19-meta-line">信任 {card.trust_status} · 校验 {card.validation_status} · 第 {card.version} 版</p>
        </div>
        {provenance && <span className="p32-badge p32-badge-v2" title={provenance.model}>多模态 · {boundedText(provenance.model, 30)}</span>}
      </div>
      <div className="p36-findings-block">
        <b>媒体时间线 / 视觉证据（{Array.isArray(media.timeline) ? media.timeline.length : 0} 段）</b>
        <ul className="p36-card-timeline">
          {(media.timeline || []).map((segment, index) => (
            <li key={`${segment.stage}-${index}`} data-stage={segment.stage}>
              <b>{segment.stage}{segment.time_range ? ` · ${segment.time_range}` : ''}：</b>
              <p>{segment.visual_evidence}</p>
              {segment.audio_evidence && <small>音轨：{segment.audio_evidence}</small>}
            </li>
          ))}
        </ul>
        <p className="p19-meta-line">
          媒体：{media.duration_seconds} 秒 · 分辨率 {media.resolution} · 音轨 {media.audio_track_present ? '有' : '无'}
          {provenance ? ` · 绑定媒体 ${provenance.media_ids.length} 项` : ''}
        </p>
      </div>
      <TextBlock title="视觉影响" value={creative.visual_impact} />
      <div className="p36-findings-grid">
        <ListBlock title="语义层" values={creative.semantic_layers} />
        <ListBlock title="受众响应机制" values={creative.audience_response_mechanisms} />
      </div>
      <TextBlock title="情绪基调" value={creative.seductive_tone} />
      <TextBlock title="叙事弧" value={creative.narrative_arc} />
      <ListBlock title="可复用特征" values={creative.replicable_features} />
      <ListBlock title="风险标签" values={Object.entries(creative.risk_labels || {}).filter(([, value]) => typeof value === 'string').map(([key, value]) => `${key}: ${value}`)} />
      <TextBlock title="文案手法" value={creative.copy_device} />
      <div className="p36-findings-block">
        <b>证据链接（{Array.isArray(card.evidence_links) ? card.evidence_links.length : 0} 条）</b>
        <ul className="p36-card-links">
          {(card.evidence_links || []).map((link, index) => (
            <li key={index}>
              {link.claim}{link.evidence_type ? ` · ${link.evidence_type}` : ''}{link.source_ref ? ` · ${String(link.source_ref).slice(0, 16)}…` : ''}{Number.isFinite(link.confidence) ? ` · 置信 ${link.confidence}` : ''}
            </li>
          ))}
        </ul>
      </div>
      <div className="p36-findings-block">
        <b>生成指导</b>
        <ul className="p36-card-links">
          {guidance.reusable_pattern && <li>可复用模式：{guidance.reusable_pattern}</li>}
          <li>必须保留：{(guidance.must_preserve || []).join('；') || '—'}</li>
          <li>不得虚构：{(guidance.must_not_invent || []).join('；') || '—'}</li>
          <li>提示要素：{(guidance.prompt_ingredients || []).join('；') || '—'}</li>
          <li>变体空间：{(guidance.variation_space || []).join('；') || '—'}</li>
        </ul>
      </div>
      <p className="p19-provenance-line">
        生成就绪：{readiness.usable ? `可用（${readiness.score} 分）` : '不可用'}
        {Array.isArray(readiness.reasons) && readiness.reasons.length > 0 ? ` · ${readiness.reasons.join('；')}` : ''}
      </p>
      <ListBlock title="不确定性" values={source.uncertainties} />
      <details className="p19-details">
        <summary>来源与技术信息（ID / 模型 / 媒体 / 指纹）</summary>
        <pre className="p19-pre">{JSON.stringify({
          知识卡ID: card.id,
          知识卡版本: card.version,
          知识卡指纹: card.fingerprint,
          项目ID: card.project_id,
          分析ID: card.analysis_id,
          分析版本: card.analysis_version,
          分析指纹: card.analysis_fingerprint,
          模型与执行: provenance ? {
            method: provenance.method, provider: provenance.provider, model: provenance.model,
            executed_at: provenance.executed_at, media_ids: provenance.media_ids,
          } : null,
          证据ID: evidence ? evidence.id : null,
          创建时间: card.created_at,
          更新时间: card.updated_at,
        }, null, 2)}</pre>
      </details>
    </div>
  );
}

/**
 * 产物目的地：知识卡 / 相似草稿 / Brief / 交接包 / 世系 的紧凑资料库。
 * 选择条目在主画布打开详情；知识卡详情完整渲染媒体分析与溯源。
 */
export function P36OutputsDestination({
  project,
  workflow,
  busy,
  onlineMode,
  selectedSection,
  onSelectSection,
  selectedCardId,
  onSelectCard,
  savedDrafts,
  onAssembleBrief,
  onDecide,
  onDeriveHandoff,
  onDownload,
  activeRow,
  graph,
  projects,
  onGoCreate,
}) {
  const cards = project.knowledge_cards || [];
  const evidenceById = new Map((project.evidence || []).map((item) => [item.id, item]));
  const selectedCard = cards.find((card) => card.id === selectedCardId) || null;
  const projectDrafts = savedDrafts.filter((draft) => draft.projectId === project.id);
  const sections = [
    { id: 'cards', label: `知识卡${cards.length ? `（${cards.length}）` : ''}` },
    { id: 'drafts', label: `相似草稿${projectDrafts.length ? `（${projectDrafts.length}）` : ''}` },
    { id: 'brief', label: 'Brief' },
    { id: 'handoff', label: '交接包' },
    { id: 'lineage', label: '世系' },
  ];
  return (
    <div className="p36-destination p36-outputs" data-destination="outputs">
      <aside className="p36-rail" aria-label="产物资料库">
        <div className="p36-rail-head">
          <h3>产物</h3>
          <span className="p19-panel-note">选择条目查看详情</span>
        </div>
        <ul className="p36-rail-list p36-rail-sections">
          {sections.map((section) => (
            <li key={section.id}>
              <button
                type="button"
                className={`p36-rail-item ${selectedSection === section.id ? 'selected' : ''}`}
                onClick={() => onSelectSection(section.id)}
                aria-pressed={selectedSection === section.id}
              >
                <strong>{section.label}</strong>
              </button>
            </li>
          ))}
        </ul>
        {cards.length === 0 && projectDrafts.length === 0 && !project.brief && !project.handoff && (
          <p className="p19-empty-note">还没有产物。先完成 采集 → 分析 → 创作，或从「分析」生成知识卡。</p>
        )}
      </aside>
      <div className="p36-canvas">
        {selectedSection === 'cards' && (
          <>
            {cards.length === 0 && (
              <div className="p36-empty-state p36-destination-empty" role="status">
                <p className="p19-eyebrow">知识卡</p>
                <h3>还没有知识卡</h3>
                <p>在「分析」中对已保存来源点击「生成知识卡」，知识卡会完整保留媒体分析与溯源。</p>
                <button className="p19-btn p19-btn-primary" type="button" onClick={() => onSelectSection('brief')}>查看 Brief 区</button>
              </div>
            )}
            {cards.length > 0 && !selectedCard && (
              <P19CardList
                project={project}
                workflow={workflow}
                onSelectCard={onSelectCard}
              />
            )}
            {selectedCard && (
              <>
                <div className="p19-form-actions">
                  <button className="p19-btn p19-btn-ghost" type="button" onClick={() => onSelectCard(null)}>← 返回知识卡列表</button>
                </div>
                <P36KnowledgeCardDetail card={selectedCard} evidence={evidenceById.get(selectedCard.analysis_id ? (project.analyses || []).find((row) => row.id === selectedCard.analysis_id)?.evidence_id : null) || null} />
              </>
            )}
          </>
        )}
        {selectedSection === 'drafts' && (
          <>
            {projectDrafts.length === 0 && (
              <div className="p36-empty-state p36-destination-empty" role="status">
                <p className="p19-eyebrow">相似草稿</p>
                <h3>本会话还没有保存的相似帖子草稿</h3>
                <p>在「创作」中选择一份已保存分析，生成并保存草稿后会出现在这里；草稿也保存在内容库。</p>
                <button className="p19-btn p19-btn-primary" type="button" onClick={onGoCreate}>去创作</button>
              </div>
            )}
            {projectDrafts.length > 0 && (
              <ul className="p36-draft-list">
                {projectDrafts.map((draft) => (
                  <li className="p36-draft-item" key={`${draft.analysisId}:${draft.savedAt}`}>
                    <strong>{boundedText(draft.title || '（未命名草稿）', 60)}</strong>
                    <p className="p19-meta-line">
                      来源：{boundedText(draft.evidenceLabel, 40)} · 分析第 {draft.analysisVersion} 版
                      {' · '}已保存到内容库{draft.savedId && draft.savedId !== 'saved' ? `（${String(draft.savedId).slice(0, 10)}）` : ''}
                      {' · '}{formatShortTime(draft.savedAt)}
                    </p>
                    <p className="p19-provenance-line">仅保存为草稿；未审核、未路由、未发布。</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {selectedSection === 'brief' && (
          <P19BriefSection project={project} workflow={workflow} onAssemble={onAssembleBrief} onDecide={onDecide} busy={busy} onlineMode={onlineMode} />
        )}
        {selectedSection === 'handoff' && (
          <P19HandoffSection project={project} workflow={workflow} onDerive={onDeriveHandoff} onDownload={onDownload} busy={busy} />
        )}
        {selectedSection === 'lineage' && (
          <P19LineageSection row={activeRow} graph={graph} projects={projects} />
        )}
      </div>
    </div>
  );
}

// ---- 目的地容器 ---------------------------------------------------------------

/**
 * 四个目的地的总容器：持有采集输入/结果、选中来源/分析、分析预览、草稿与
 * 保存标记等全部瞬态状态。页面以 key={project.id} 挂载本组件，切换项目即
 * 整棵重挂载（隔离契约）；版本递增不重挂载，预览/草稿在渲染时按绑定校验。
 */
export function P36Destinations({
  project,
  workflow,
  onlineMode,
  busy,
  assistClient,
  onSaveEvidence,
  onSaveAnalysisPreview,
  onReanalyze,
  onRehydrateAndAnalyze,
  onRunDeterministic,
  onMakeCard,
  onSaveDraft,
  hotSearchState,
  onHotSearchStateChange,
  onImportHotSearch,
  importError,
  comparedEvidenceIds,
  onComparedSelectionChange,
  synthesisOutcome,
  onSynthesize,
  onAddEvidence,
  onUpdateEvidence,
  onRemoveEvidence,
  onAssembleBrief,
  onDecide,
  onDeriveHandoff,
  onDownload,
  activeRow,
  graph,
  projects,
  savedDrafts,
  recommendedDestination,
  recommendedLabel,
}) {
  const [destination, setDestination] = useState(P36_DESTINATIONS.COLLECT);

  // 采集瞬态状态
  const [collectTopic, setCollectTopic] = useState('');
  const [collectItems, setCollectItems] = useState([]);
  const [collectMessage, setCollectMessage] = useState('');
  const [collectError, setCollectError] = useState('');

  // 分析瞬态状态
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(null);
  const [analysisPreviews, setAnalysisPreviews] = useState({});
  const [analyzeMessage, setAnalyzeMessage] = useState('');
  const [analyzeError, setAnalyzeError] = useState('');

  // 创作瞬态状态
  const [selectedAnalysisId, setSelectedAnalysisId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [savedDraftIds, setSavedDraftIds] = useState({});
  const [createMessage, setCreateMessage] = useState('');
  const [createError, setCreateError] = useState('');

  // 产物瞬态状态
  const [outputSection, setOutputSection] = useState('cards');
  const [selectedCardId, setSelectedCardId] = useState(null);

  const [workingKey, setWorkingKey] = useState('');
  const [canUseAi, setCanUseAi] = useState(false);

  useEffect(() => {
    let mounted = true;
    assistClient.status().then((next) => {
      if (mounted && next?.role && ['operator', 'admin'].includes(next.role)) setCanUseAi(true);
    }).catch(() => { /* 能力探测失败只影响模型类按钮可用性，页面其余功能不受影响 */ });
    return () => { mounted = false; };
  }, [assistClient]);

  // 已保存来源也作为来源卡显示（与采集结果同列表并标注已保存），刷新后仍可见：
  // 未保存的采集结果保留，已保存证据按项目快照派生为卡（绝不跨项目复用）。
  useEffect(() => {
    setCollectItems((previous) => {
      const previousItems = Array.isArray(previous) ? previous : [];
      const unsaved = previousItems.filter((item) => !findP22Evidence(project, item));
      const saved = (project.evidence || []).map(p22ItemFromEvidence).filter(Boolean);
      return [...unsaved, ...saved];
    });
  }, [project]);

  // 默认选中：有分析的最新来源优先，其次第一条来源。
  useEffect(() => {
    const list = project.evidence || [];
    if (list.length === 0) return;
    if (list.some((row) => row.id === selectedEvidenceId)) return;
    const withAnalysis = list.find((row) => getLatestAnalysisForEvidence(project, row.id));
    setSelectedEvidenceId((withAnalysis || list[0]).id);
  }, [project, selectedEvidenceId]);

  useEffect(() => {
    const rows = (project.analyses || []).filter((row) => row.model_analysis);
    if (rows.length === 0) { setSelectedAnalysisId(null); return; }
    if (rows.some((row) => row.id === selectedAnalysisId)) return;
    setSelectedAnalysisId(rows[0].id);
  }, [project, selectedAnalysisId]);

  const selectDestination = useCallback((next) => {
    setDestination(next);
  }, []);

  const handleDestinationKeyDown = useCallback((event) => {
    const order = DESTINATION_META.map((meta) => meta.id);
    const current = order.indexOf(destination);
    let nextIndex = current;
    if (event.key === 'ArrowRight') nextIndex = (current + 1) % order.length;
    else if (event.key === 'ArrowLeft') nextIndex = (current - 1 + order.length) % order.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = order.length - 1;
    else return;
    event.preventDefault();
    const next = order[nextIndex];
    selectDestination(next);
    globalThis.document?.querySelector(`[data-destination-tab="${next}"]`)?.focus();
  }, [destination, selectDestination]);

  // ---- 采集动作 ----
  const runCollect = useCallback(async (topic, isUrl) => {
    setCollectError('');
    setCollectMessage('');
    setCollectItems([]);
    if (!topic) {
      setCollectError('请输入链接或主题。');
      return;
    }
    setWorkingKey('collect');
    try {
      const response = isUrl ? await assistClient.collectUrl(topic) : await assistClient.collect(topic, 5);
      const items = Array.isArray(response.items) ? response.items : [];
      setCollectItems(items);
      setCollectMessage(`已找到 ${items.length} 条公开来源，尚未保存。Apify 本次费用记录 ¥${response.cost?.recorded_cny ?? 0}。`);
    } catch (cause) {
      setCollectError(String(cause?.message || cause));
    } finally {
      setWorkingKey('');
    }
  }, [assistClient]);

  const saveEvidence = useCallback(async (item) => {
    setWorkingKey(`save:${item.id}`);
    setCollectError('');
    setCollectMessage('');
    try {
      const ok = await onSaveEvidence(item);
      if (ok) {
        setCollectMessage('来源证据已保存。下一步可分析帖子/视频；分析结果由你确认后才会保存。');
        // 不直接用搜索结果 id 作为选中来源：已保存证据身份由项目快照权威派生
        // （证据 id 可能与搜索项 id 不同），默认选中由 effect 按项目重新计算。
      }
    } catch (cause) {
      setCollectError(String(cause?.message || cause));
    } finally {
      setWorkingKey('');
    }
  }, [onSaveEvidence]);

  const goToAnalyze = useCallback((evidenceId) => {
    setSelectedEvidenceId(evidenceId);
    setDestination(P36_DESTINATIONS.ANALYZE);
  }, []);

  // ---- 分析动作 ----
  const startAnalysis = useCallback(async (evidenceId) => {
    const evidence = (project.evidence || []).find((item) => item.id === evidenceId);
    if (!evidence) return;
    // P38 失败关闭：旧合同媒体（URL 哈希/t.co/非白名单/类型失配/缺内容字节）
    // 不得直接调用 Qwen —— 必须先「重新采集媒体并分析」原位恢复。
    const mediaGate = assessMediaAnalyzability(evidence);
    if (!mediaGate.analyzable) {
      setAnalyzeError(`该来源的媒体尚未完成安全验证（${String(mediaGate.issues[0] || '旧媒体绑定').slice(0, 120)}）：请先点击「重新采集媒体并分析」恢复媒体后再分析。`);
      return;
    }
    setWorkingKey(`analyze:${evidenceId}`);
    setAnalyzeError('');
    setAnalyzeMessage('');
    try {
      const response = await assistClient.analyzePersisted(project.id, evidenceId);
      const result = (response.analyses || []).find((row) => row.source_id === evidence.provenance?.source_id);
      if (!result) throw new Error('分析结果未准确绑定当前来源，已停止。');
      setAnalysisPreviews((previous) => ({
        ...previous,
        [evidenceId]: {
          result,
          usage: response.usage || {},
          evidenceVersion: evidence.version,
          evidenceFingerprint: evidence.fingerprint,
        },
      }));
      setAnalyzeMessage('分析完成。请先查看完整结果，确认后再保存。');
    } catch (cause) {
      setAnalyzeError(String(cause?.message || cause));
    } finally {
      setWorkingKey('');
    }
  }, [assistClient, project]);

  /**
   * P38 一键「重新采集媒体并分析」：委托页面执行原位恢复链（collect_url →
   * 唯一身份绑定 → 一次 evidence.update → 权威在线读取 → analyze_persisted），
   * 成功后把 Qwen 结果作为预览绑定到权威升级后的证据版本/指纹。
   * 页面侧任何失败都会抛回有界结构化错误（P38_*），此处仅展示并保持原状态。
   */
  const rehydrateMedia = useCallback(async (evidenceId) => {
    const evidence = (project.evidence || []).find((item) => item.id === evidenceId);
    if (!evidence) return;
    const mediaGate = assessMediaAnalyzability(evidence);
    if (mediaGate.analyzable) {
      setAnalyzeError('该证据的媒体已通过安全验证，无需重新采集。');
      return;
    }
    setWorkingKey(`rehydrate:${evidenceId}`);
    setAnalyzeError('');
    setAnalyzeMessage('');
    try {
      const result = await onRehydrateAndAnalyze(evidenceId);
      if (!result || !result.evidence) return;
      const upgraded = result.evidence;
      // 恢复后的预览必须绑定权威升级后的版本/指纹；旧版本预览绝不混入。
      if (upgraded.id !== evidenceId || upgraded.version !== evidence.version + 1) {
        throw new Error('原位升级未返回同一证据的新版本，已停止。');
      }
      setAnalysisPreviews((previous) => ({
        ...previous,
        [evidenceId]: {
          result: result.modelResult,
          usage: result.usage || {},
          evidenceVersion: upgraded.version,
          evidenceFingerprint: upgraded.fingerprint,
        },
      }));
      setAnalyzeMessage('媒体已重新采集并通过安全验证，同一证据已原位升级；Qwen 分析完成，请查看完整结果，确认后再保存。');
    } catch (cause) {
      setAnalyzeError(String(cause?.message || cause));
    } finally {
      setWorkingKey('');
    }
  }, [onRehydrateAndAnalyze, project]);

  const saveAnalysis = useCallback(async (evidenceId, preview) => {
    setWorkingKey(`save-analysis:${evidenceId}`);
    setAnalyzeError('');
    setAnalyzeMessage('');
    try {
      const saved = await onSaveAnalysisPreview(evidenceId, preview.result, preview.usage);
      if (!saved) throw new Error('分析保存后未返回准确版本。');
      setAnalysisPreviews((previous) => {
        const next = { ...previous };
        delete next[evidenceId];
        return next;
      });
      setAnalyzeMessage(`分析结果已保存为第 ${saved.version} 版；原来源与旧版本保持不变。`);
    } catch (cause) {
      setAnalyzeError(String(cause?.message || cause));
    } finally {
      setWorkingKey('');
    }
  }, [onSaveAnalysisPreview]);

  const discardPreview = useCallback((evidenceId) => {
    setAnalysisPreviews((previous) => {
      const next = { ...previous };
      delete next[evidenceId];
      return next;
    });
    setAnalyzeMessage('');
    setAnalyzeError('');
  }, []);

  const goToCreate = useCallback((analysisId) => {
    setSelectedAnalysisId(analysisId);
    setDestination(P36_DESTINATIONS.CREATE);
  }, []);

  const viewKnowledgeCard = useCallback((cardId) => {
    const matches = (project.knowledge_cards || []).filter((card) => card.id === cardId);
    if (matches.length !== 1) {
      setAnalyzeError('知识卡身份缺失或不唯一，已拒绝打开。');
      return;
    }
    setSelectedCardId(cardId);
    setOutputSection('cards');
    setDestination(P36_DESTINATIONS.OUTPUTS);
  }, [project.knowledge_cards]);

  // ---- 创作动作 ----
  const generateDraft = useCallback(async (analysis) => {
    const evidence = (project.evidence || []).find((item) => item.id === analysis.evidence_id);
    if (!evidence) return;
    setWorkingKey(`draft:${analysis.id}`);
    setCreateError('');
    setCreateMessage('');
    try {
      const response = await assistClient.generateSimilar(project.id, evidence.id, analysis.id);
      setDrafts((previous) => ({
        ...previous,
        [analysis.id]: { ...response.draft, model: response.draft?.model || 'qwen-plus', usage: response.usage || {} },
      }));
      setSavedDraftIds((previous) => {
        const next = { ...previous };
        delete next[analysis.id];
        return next;
      });
      setCreateMessage('相似帖子草稿已生成。你可以修改后保存。');
    } catch (cause) {
      setCreateError(String(cause?.message || cause));
    } finally {
      setWorkingKey('');
    }
  }, [assistClient, project]);

  const updateDraft = useCallback((analysisId, field, value) => {
    setDrafts((previous) => ({ ...previous, [analysisId]: { ...previous[analysisId], [field]: value } }));
  }, []);

  const saveDraft = useCallback(async (analysis, draft) => {
    const evidence = (project.evidence || []).find((item) => item.id === analysis.evidence_id);
    if (!evidence) {
      setCreateError('草稿绑定的来源已不存在，请重新生成。');
      return;
    }
    if (draft.evidence_id !== evidence.id || draft.evidence_version !== evidence.version || draft.evidence_fingerprint !== evidence.fingerprint) {
      setCreateError('草稿绑定的来源版本已变化，请重新生成。');
      return;
    }
    const boundAnalysis = (project.analyses || []).find((row) => row.id === draft.analysis_id
      && row.evidence_id === evidence.id && row.version === draft.analysis_version && row.fingerprint === draft.analysis_fingerprint);
    if (!boundAnalysis) {
      setCreateError('草稿绑定的分析版本不存在或已失配，请重新生成。');
      return;
    }
    setWorkingKey(`save-draft:${analysis.id}`);
    setCreateError('');
    setCreateMessage('');
    try {
      const saved = await onSaveDraft(draft, evidence, boundAnalysis);
      setSavedDraftIds((previous) => ({ ...previous, [analysis.id]: saved?.id || 'saved' }));
      setCreateMessage('相似帖子草稿已保存到内容库；未审核、未路由、未发布。');
    } catch (cause) {
      setCreateError(String(cause?.message || cause));
    } finally {
      setWorkingKey('');
    }
  }, [onSaveDraft, project]);

  const tablistProps = {
    role: 'tablist',
    'aria-label': '工作台目的地',
    onKeyDown: handleDestinationKeyDown,
  };

  return (
    <div className="p36-destinations" data-active-destination={destination}>
      <nav {...tablistProps} className="p36-tabs">
        {DESTINATION_META.map((meta) => (
          <button
            type="button"
            role="tab"
            data-destination-tab={meta.id}
            aria-selected={destination === meta.id}
            className={`p36-tab ${destination === meta.id ? 'active' : ''}`}
            key={meta.id}
            onClick={() => selectDestination(meta.id)}
          >
            <b>{meta.label}</b>
            <small>{meta.hint}</small>
          </button>
        ))}
        {recommendedDestination && recommendedDestination !== destination && (
          <span className="p36-next-hint">
            建议下一步：{recommendedLabel}
            <button className="p19-btn p19-btn-ghost" type="button" onClick={() => selectDestination(recommendedDestination)}>前往</button>
          </span>
        )}
      </nav>

      {destination === P36_DESTINATIONS.COLLECT && (
        <div className="p36-destination p36-collect-destination" data-destination="collect">
          <div className="p36-canvas p36-collect-canvas">
            <P22CollectPanel
              project={project}
              busy={busy}
              onSaveEvidence={saveEvidence}
              onGoAnalyze={goToAnalyze}
              topic={collectTopic}
              onTopicChange={setCollectTopic}
              items={collectItems}
              message={collectMessage}
              error={collectError}
              workingKey={workingKey}
              onCollect={runCollect}
            />
            <details className="p36-advanced">
              <summary>更多采集方式：热门主题搜索 · 手工录入证据</summary>
              <P32HotTopicSearchPanel
                key={project.id}
                project={project}
                busy={busy}
                client={assistClient}
                searchState={hotSearchState}
                onSearchStateChange={onHotSearchStateChange}
                onImport={onImportHotSearch}
                importError={importError}
              />
              <P19EvidenceList
                project={project}
                onAdd={onAddEvidence}
                onUpdate={onUpdateEvidence}
                onRemove={onRemoveEvidence}
                onAnalyze={onRunDeterministic}
                busy={busy}
              />
            </details>
          </div>
          <aside className="p36-drawer" aria-label="已保存来源">
            <P32EvidenceLibrary
              project={project}
              workflow={workflow}
              onReanalyze={onReanalyze}
              onMakeCard={onMakeCard}
              busy={busy}
            />
          </aside>
        </div>
      )}

      {destination === P36_DESTINATIONS.ANALYZE && (
        <P36AnalyzeDestination
          project={project}
          busy={busy}
          canUseAi={canUseAi}
          onlineMode={onlineMode}
          selectedEvidenceId={selectedEvidenceId}
          onSelectEvidence={setSelectedEvidenceId}
          previews={analysisPreviews}
          onStartAnalysis={startAnalysis}
          onRehydrateMedia={rehydrateMedia}
          onSaveAnalysis={saveAnalysis}
          onDiscardPreview={discardPreview}
          onRunDeterministic={onRunDeterministic}
          onMakeCard={onMakeCard}
          onViewCard={viewKnowledgeCard}
          onGoCreate={goToCreate}
          onGoCollect={() => setDestination(P36_DESTINATIONS.COLLECT)}
          workingKey={workingKey}
          message={analyzeMessage}
          error={analyzeError}
          comparedEvidenceIds={comparedEvidenceIds}
          onComparedSelectionChange={onComparedSelectionChange}
          synthesisOutcome={synthesisOutcome}
          onSynthesize={onSynthesize}
        />
      )}

      {destination === P36_DESTINATIONS.CREATE && (
        <P36CreateDestination
          project={project}
          busy={busy}
          canUseAi={canUseAi}
          selectedAnalysisId={selectedAnalysisId}
          onSelectAnalysis={setSelectedAnalysisId}
          drafts={drafts}
          savedDraftIds={savedDraftIds}
          workingKey={workingKey}
          message={createMessage}
          error={createError}
          onGenerateDraft={generateDraft}
          onUpdateDraft={updateDraft}
          onSaveDraft={saveDraft}
          onGoAnalyze={() => setDestination(P36_DESTINATIONS.ANALYZE)}
        />
      )}

      {destination === P36_DESTINATIONS.OUTPUTS && (
        <P36OutputsDestination
          project={project}
          workflow={workflow}
          busy={busy}
          onlineMode={onlineMode}
          selectedSection={outputSection}
          onSelectSection={setOutputSection}
          selectedCardId={selectedCardId}
          onSelectCard={setSelectedCardId}
          savedDrafts={savedDrafts}
          onAssembleBrief={onAssembleBrief}
          onDecide={onDecide}
          onDeriveHandoff={onDeriveHandoff}
          onDownload={onDownload}
          activeRow={activeRow}
          graph={graph}
          projects={projects}
          onGoCreate={goToCreate}
        />
      )}
    </div>
  );
}
