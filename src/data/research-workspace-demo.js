// 研究工作台 V1：确定性本地示例数据（只读预览）
// 全部内容为固定的本地示例，不依赖时钟、随机数、环境变量或任何外部服务。
// 不代表任何采集、分析、模型生成或发布动作已真实执行。

const EXECUTION_FLAGS = Object.freeze({
  generation_executed: false,
  routing_executed: false,
  network_executed: false,
  publish_executed: false,
});

export const RESEARCH_DEMO_VERSION = 'ams-research-workspace-demo-v1';

export const RESEARCH_DEMO_META = Object.freeze({
  version: RESEARCH_DEMO_VERSION,
  previewLabel: '本地预览',
  previewNote:
    '本页全部内容为确定性的本地示例数据。示例不代表任何采集、分析、生成或发布动作已真实执行；本页也不发起任何远程请求。',
  schemaLabel: '主题与目标 → 证据 → 多模态分析 → 知识卡 → 可审核 Brief',
  interactionNote: '本页交互全部在内存中进行，不写入或修改任何数据。',
});

export const RESEARCH_DEMO_TOPIC = Object.freeze({
  id: 'demo-topic-01',
  title: '宠物用品账号 7 月爆款内容拆解（本地示例）',
  objective:
    '为下一条宠物用品内容产出可追溯的选题依据：收集公开样本证据，完成多模态结构分析，沉淀带引用的知识卡，并输出一份等待人工审核的 Brief。',
  status: 'local_preview',
  statusLabel: '本地预览',
  boundaryNote: '未创建任何外部研究任务；本示例不连接采集器、分析服务或模型。',
});

export const RESEARCH_DEMO_EVIDENCE = Object.freeze([
  Object.freeze({
    id: 'evidence-01',
    name: '竞品账号 @petmate_hq',
    platform: 'X',
    category: '竞品',
    captureStatus: 'collected_local_preview',
    captureStatusLabel: '已采集（本地示例）',
    capturedAt: '2026-07-24 09:30（示例时间）',
    provenance:
      '本地示例：标题、正文与互动数据为固定占位内容，未连接任何采集任务或抓取工具。',
    displayOnlyUrl: 'x.com/petmate_hq/status/example01（仅展示，不请求）',
    snippet: '“猫咪第一次看到自动猫砂盆的反应”——3 秒震惊镜头开场，全程无旁白，只保留环境音。',
    engagement: 'Views 128.0万 · Likes 9.6万 · Comments 3140（示例数值）',
    analysisIds: Object.freeze(['analysis-01']),
    knowledgeIds: Object.freeze(['knowledge-01', 'knowledge-02']),
  }),
  Object.freeze({
    id: 'evidence-02',
    name: '灵感账号 @dailycatclub',
    platform: 'Instagram',
    category: '灵感',
    captureStatus: 'collected_local_preview',
    captureStatusLabel: '已采集（本地示例）',
    capturedAt: '2026-07-25 14:00（示例时间）',
    provenance:
      '本地示例：轮播图结构与文案为固定占位内容，未执行视觉分析或下载。',
    displayOnlyUrl: 'instagram.com/dailycatclub/example02（仅展示，不请求）',
    snippet: '轮播“新手养猫 12 条避坑清单”：封面悬念标题 + 每页一条清单 + 末页引导关注。',
    engagement: 'Views 41.0万 · Likes 3.2万 · Comments 480（示例数值）',
    analysisIds: Object.freeze(['analysis-02']),
    knowledgeIds: Object.freeze(['knowledge-01']),
  }),
  Object.freeze({
    id: 'evidence-03',
    name: '账号 @petmate_hq 7 月贴文（批量候选）',
    platform: 'X',
    category: '竞品',
    captureStatus: 'not_collected',
    captureStatusLabel: '未采集',
    capturedAt: null,
    provenance: '示例状态：该批次候选来源尚未采集；当前不发起任何抓取请求。',
    displayOnlyUrl: null,
    snippet: '候选列表已登记，采集与字段提取均未执行。',
    engagement: '无互动数据（未采集）',
    analysisIds: Object.freeze([]),
    knowledgeIds: Object.freeze([]),
  }),
]);

export const RESEARCH_DEMO_ANALYSES = Object.freeze([
  Object.freeze({
    id: 'analysis-01',
    evidenceId: 'evidence-01',
    title: '无旁白实时反应（本地示例分析）',
    status: 'analysed_local_preview',
    statusLabel: '已分析（本地示例）',
    modelLabel: '分析来自固定示例，未调用任何模型',
    hook: '3 秒内出现“震惊 + 声音反应”，用情绪峰值留住首屏用户。',
    format: '单条竖版短视频，全程无旁白，保留环境音与字幕。',
    visualStory: '开场即高潮：画面直接进入“第一次见到自动猫砂盆”的震惊反应，不做铺垫。',
    structure: '震惊开场 → 行为过程 → 结果验证（猫盆状态）→ 字幕收尾，总时长约 20 秒。',
    audienceInsight: '宠物主对“第一次反应”类内容有强代入感，愿意看完整过程并评论自家宠物反应。',
    analysisNote: '结论为示例拆解，未执行视觉分析或模型分析。',
  }),
  Object.freeze({
    id: 'analysis-02',
    evidenceId: 'evidence-02',
    title: '清单型轮播避坑指南（本地示例分析）',
    status: 'analysed_local_preview',
    statusLabel: '已分析（本地示例）',
    modelLabel: '分析来自固定示例，未调用任何模型',
    hook: '封面用“新手必看 / 12 条避坑”制造错过成本，点开率来自明确数量承诺。',
    format: '轮播图，封面悬念 + 逐页清单 + 末页关注引导。',
    visualStory: '信息密度逐页递增：标题页 → 清单页 → 场景示例页 → 引导页，视觉上统一为浅色卡片风。',
    structure: '封面标题 → 12 条清单（每页一条）→ 常见误区 → 关注引导。',
    audienceInsight: '新手养宠人群主动搜索避坑信息，清单格式便于收藏与转发给朋友。',
    analysisNote: '结论为示例拆解，未执行视觉分析或模型分析。',
  }),
  Object.freeze({
    id: 'analysis-03',
    evidenceId: 'evidence-03',
    title: '候选批次分析',
    status: 'not_analysed',
    statusLabel: '未分析',
    modelLabel: '无',
    hook: null,
    format: null,
    visualStory: null,
    structure: null,
    audienceInsight: null,
    analysisNote: '该证据尚未采集，因此未进行任何分析。',
  }),
]);

export const RESEARCH_DEMO_KNOWLEDGE = Object.freeze([
  Object.freeze({
    id: 'knowledge-01',
    title: '“第一次反应”类内容是宠物账号的高互动模板（示例）',
    summary:
      '示例结论：宠物主对“宠物第一次接触新事物”的实时反应有强代入感，常见高互动形式为无旁白短视频 + 情绪峰值开场。',
    confidence: '示例置信度（未评估）',
    status: 'local_preview',
    statusLabel: '本地示例知识卡',
    citations: Object.freeze([
      Object.freeze({ evidenceId: 'evidence-01', quote: '3 秒震惊镜头开场，全程无旁白' }),
      Object.freeze({ evidenceId: 'evidence-02', quote: '封面悬念标题 + 逐页清单' }),
    ]),
    note: '知识卡为固定示例，未写入知识库，未计算真实置信度。',
  }),
  Object.freeze({
    id: 'knowledge-02',
    title: '清单型结构适合新手向话题（示例）',
    summary:
      '示例结论：面向新手人群时，清单型轮播通过数量承诺与收藏价值获得更高转发；可与短视频“第一次反应”模板组合使用。',
    confidence: '示例置信度（未评估）',
    status: 'local_preview',
    statusLabel: '本地示例知识卡',
    citations: Object.freeze([
      Object.freeze({ evidenceId: 'evidence-02', quote: '轮播“新手养猫 12 条避坑清单”' }),
    ]),
    note: '知识卡为固定示例，未写入知识库，未计算真实置信度。',
  }),
]);

export const RESEARCH_DEMO_BRIEF = Object.freeze({
  id: 'demo-brief-01',
  briefProvenance: '本地示例 Brief：由本页示例数据生成，未经过真实 P5 交接包导出。',
  topic: RESEARCH_DEMO_TOPIC.title,
  objective: RESEARCH_DEMO_TOPIC.objective,
  humanDecision: Object.freeze({
    status: 'pending_human_review',
    statusLabel: '待人工审核',
    note: '本 Brief 尚未获得任何人工批准或反馈。',
  }),
  structuralGuidance: Object.freeze([
    '开场 3 秒呈现“第一次反应”情绪峰值，不做长铺垫',
    '无旁白短视频保留环境音与字幕；轮播使用封面悬念 + 逐页清单',
    '收尾引导评论自家宠物反应或关注账号',
  ]),
  constraints: Object.freeze([
    '在本页之外不得宣称已完成采集、分析、生成或发布',
    '交接包仅允许本地导入，导入后状态为 pending_human_generation_review',
    '四项执行标志必须保持 false，直到人工单独授权',
    '示例数据不得被当作真实运营数据使用',
  ]),
  knowledgeCitations: Object.freeze([
    Object.freeze({ knowledgeId: 'knowledge-01', title: '“第一次反应”类内容是宠物账号的高互动模板（示例）' }),
    Object.freeze({ knowledgeId: 'knowledge-02', title: '清单型结构适合新手向话题（示例）' }),
  ]),
  evidenceProvenance:
    '引用证据：evidence-01、evidence-02（本地示例）；evidence-03 未采集，不参与本 Brief 结论。',
  manualFeedback: Object.freeze([]),
  externalProjectBoundary:
    '下一交接边界：人工审核通过后生成本地交接包，仅允许导入下游视频生成仓库（P6 本地导入，草稿状态 pending_human_generation_review）。导入与生成必须等待人工单独授权。',
  executionFlags: EXECUTION_FLAGS,
  importOnly: true,
  nextHandoffBoundary:
    '人工审核 → 本地交接包（P5）→ 下游仓库本地导入（P6）→ 本地草稿（P7）。以上步骤全部仅限本地，当前均未执行。',
});
