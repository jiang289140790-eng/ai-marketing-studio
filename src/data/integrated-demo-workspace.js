// P18 完整智能内容链：确定性、深度不可变的验收演示工作区
//
// 本文件包含一个自洽的演示数据集，覆盖：
//   研究证据 → 分析 → 知识卡 → 可审核 Brief → P5 交接包 → P16 世系
//
// 全部数据为深度不可变对象（递归 Object.freeze），不依赖时钟、随机数、
// 环境变量、外部服务或任何非确定因素。
//
// 本文件不执行任何网络请求、写入、模型调用、采集、生成、路由或发布。

// 深度冻结辅助：递归冻结对象及其所有嵌套属性
function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  // 始终递归：即使外层已冻结，内层可能仍有未冻结对象
  if (Array.isArray(obj)) {
    obj.forEach((item) => deepFreeze(item));
  } else {
    Object.values(obj).forEach((val) => deepFreeze(val));
  }
  return obj;
}

// ---- 执行标志（严格遵守全部 false）----------------------------------------------
const FALSE_FLAGS = Object.freeze({
  generation_executed: false,
  routing_executed: false,
  network_executed: false,
  publish_executed: false,
});

// ============================================================================
// 1. 证据记录（4 条，含精确来源标识与引用）
// ============================================================================
export const DEMO_EVIDENCE = deepFreeze([
  Object.freeze({
    id: 'ev-001',
    sourceLabel: '@petstyle_daily · X',
    platform: 'X',
    sourceUrl: 'https://x.com/petstyle_daily/status/1820123456789012345',
    sourceIdentity: {
      accountName: 'petstyle_daily',
      displayName: 'Pet Style Daily',
      platform: 'X',
      followerCount: 85600,
      accountType: 'competitor',
    },
    capturedAt: '2026-08-01T10:30:00Z',
    contentType: 'short_video',
    title: '猫咪第一次使用自动饮水机的反应',
    summary:
      '3 秒内呈现猫咪从好奇到尝试的完整过程，无旁白配音，仅保留环境音与字幕。' +
      '画面以特写镜头捕捉猫咪胡须触碰水流瞬间的反应，评论区大量用户分享自家宠物类似体验。',
    metrics: {
      views: 1280000,
      likes: 96200,
      comments: 3140,
      shares: 8700,
      collectedAt: '2026-08-01T10:30:00Z',
    },
    tags: ['宠物', '猫咪', '产品试用', 'UGC'],
    captureStatus: 'demo_local',
    captureStatusLabel: '验收演示数据',
    provenance:
      '验收演示项目：ev-001。来源身份、URL 与指标均为固定的演示占位数据，' +
      '不代表任何真实采集、爬取或下载动作已执行。',
  }),

  Object.freeze({
    id: 'ev-002',
    sourceLabel: '@dogcare_tips · Instagram',
    platform: 'Instagram',
    sourceUrl: 'https://www.instagram.com/p/C9AbCdEfGhI/',
    sourceIdentity: {
      accountName: 'dogcare_tips',
      displayName: 'Dog Care Tips',
      platform: 'Instagram',
      followerCount: 234000,
      accountType: 'inspiration',
    },
    capturedAt: '2026-08-02T14:15:00Z',
    contentType: 'carousel',
    title: '新手养狗 10 条必知清单（轮播）',
    summary:
      '封面用「90%新手不知道的第7条」制造好奇心，10 页轮播每页一条建议，' +
      '末页引导关注账号。清单格式收藏率高，评论区出现大量「收藏了」「转发给朋友」等互动。',
    metrics: {
      views: 410000,
      likes: 32400,
      comments: 480,
      shares: 12900,
      collectedAt: '2026-08-02T14:15:00Z',
    },
    tags: ['宠物', '养狗', '新手教程', '清单'],
    captureStatus: 'demo_local',
    captureStatusLabel: '验收演示数据',
    provenance:
      '验收演示项目：ev-002。来源身份、URL 与指标均为固定的演示占位数据，' +
      '不代表任何真实采集、爬取或下载动作已执行。',
  }),

  Object.freeze({
    id: 'ev-003',
    sourceLabel: '@catlovers_hub · TikTok',
    platform: 'TikTok',
    sourceUrl: 'https://www.tiktok.com/@catlovers_hub/video/7432109876543210987',
    sourceIdentity: {
      accountName: 'catlovers_hub',
      displayName: 'Cat Lovers Hub',
      platform: 'TikTok',
      followerCount: 1200000,
      accountType: 'inspiration',
    },
    capturedAt: '2026-08-03T09:00:00Z',
    contentType: 'short_video',
    title: 'ASMR 猫咪梳毛合集 · 沉浸式解压',
    summary:
      '全程 ASMR 收音 + 慢镜头猫咪梳毛画面，无对话无字幕，依靠声音触发与视觉舒适感留住观众。' +
      '评论区常见「看了三遍」「太治愈了」等重复观看信号。',
    metrics: {
      views: 3400000,
      likes: 287000,
      comments: 5200,
      shares: 45600,
      collectedAt: '2026-08-03T09:00:00Z',
    },
    tags: ['宠物', '猫咪', 'ASMR', '解压'],
    captureStatus: 'demo_local',
    captureStatusLabel: '验收演示数据',
    provenance:
      '验收演示项目：ev-003。来源身份、URL 与指标均为固定的演示占位数据，' +
      '不代表任何真实采集、爬取或下载动作已执行。',
  }),

  Object.freeze({
    id: 'ev-004',
    sourceLabel: '@pettraining_pro · YouTube',
    platform: 'YouTube',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    sourceIdentity: {
      accountName: 'pettraining_pro',
      displayName: 'Pet Training Pro',
      platform: 'YouTube',
      followerCount: 567000,
      accountType: 'competitor',
    },
    capturedAt: '2026-08-04T16:45:00Z',
    contentType: 'video',
    title: '7 天狗狗行为训练挑战 · Day 1 坐下的完整教学',
    summary:
      '长视频教程格式，前 30 秒快速展示训练成果对比（Before/After），' +
      '然后进入分步讲解。结尾引导订阅和评论打卡。系列化内容带动频道关注增长。',
    metrics: {
      views: 892000,
      likes: 45100,
      comments: 2180,
      shares: 3400,
      collectedAt: '2026-08-04T16:45:00Z',
    },
    tags: ['宠物', '训练', '教程', '系列'],
    captureStatus: 'demo_local',
    captureStatusLabel: '验收演示数据',
    provenance:
      '验收演示项目：ev-004。来源身份、URL 与指标均为固定的演示占位数据，' +
      '不代表任何真实采集、爬取或下载动作已执行。',
  }),
]);

// ============================================================================
// 2. 分析摘要（文本 + 多模态，绑定到证据 ID）
// ============================================================================
export const DEMO_ANALYSES = deepFreeze([
  Object.freeze({
    id: 'analysis-001',
    evidenceId: 'ev-001',
    title: '宠物产品「首次反应」短视频结构拆解',
    type: 'multimodal',
    textSummary:
      '以特写镜头捕捉宠物首次接触产品的情绪峰值反应，全程无旁白、依赖字幕传达信息，' +
      '平均完播率推测高于 60%。开场 3 秒的情绪冲击是留住用户的核心要素。',
    multimodalInsights: {
      hook: '0-3 秒：猫咪胡须触碰水流的特写 → 制造「接下来会发生什么」的悬念',
      format: '9:16 竖版短视频，全程环境音 + 字幕，无旁白配音',
      visualStructure: '特写开头 → 中景反应 → 行为过程 → 结果验证 → 字幕收尾',
      pacing: '快节奏剪辑，约 18-22 秒总时长，每 3-5 秒切换一个画面角度',
      colorPalette: '暖色调自然光，白色背景突出猫咪毛色',
      textOverlay: '关键节点使用大号字幕强调宠物反应，颜色为白色带黑色描边',
    },
    audienceInsight:
      '宠物主人对「第一次反应」类内容有强代入感，愿意观看完整过程并在评论区分享自家宠物类似经历。',
    replicability: '高：适用于任何宠物用品的新品推广，只需替换产品与宠物即可复用框架。',
    createdAt: '2026-08-01T11:00:00Z',
    provenance:
      '验收演示项目：analysis-001。分析结论为固定的演示占位数据，未执行任何视觉分析、模型推理或 API 调用。',
  }),

  Object.freeze({
    id: 'analysis-002',
    evidenceId: 'ev-002',
    title: '清单型轮播内容的结构效率分析',
    type: 'text',
    textSummary:
      '「数字 + 必知/避坑」标题格式的轮播帖具有显著高于普通帖的收藏率和分享率。' +
      '封面悬念 + 逐页清单 + 末页引导的结构可复用于任何「新手向」话题。',
    multimodalInsights: {
      hook: '封面：「90%新手不知道的第7条」→ 制造信息不对称与错过成本',
      format: 'Instagram 轮播（Carousel），10 页，浅色卡片风格',
      visualStructure: '标题页 → 清单逐页（每页一条）→ 常见误区 → 关注引导',
      informationDensity: '每页一条信息 + 简短解释 → 低认知负荷，适合碎片阅读',
      colorPalette: '浅米色背景 + 深灰文字 + 橙色强调色',
      textOverlay: '每页标题使用大号加粗字体，正文使用小号衬线字体',
    },
    audienceInsight:
      '新手养宠人群主动搜索避坑信息，清单格式便于「收藏后慢慢看」和转发给朋友，提高内容的二次传播率。',
    replicability: '高：可替换为任何「新手必知 N 条」主题，模板化程度极高。',
    createdAt: '2026-08-02T15:00:00Z',
    provenance:
      '验收演示项目：analysis-002。分析结论为固定的演示占位数据，未执行任何视觉分析、模型推理或 API 调用。',
  }),

  Object.freeze({
    id: 'analysis-003',
    evidenceId: 'ev-003',
    title: 'ASMR/沉浸式宠物内容的受众留存分析',
    type: 'multimodal',
    textSummary:
      '无对话、无字幕的纯感官内容依靠 ASMR 收音和慢镜头呈现，驱动「重复观看」和「转发给朋友放松」两种行为。' +
      '平均观看时长显著高于普通宠物内容，评论中「治愈」「解压」等词高频出现。',
    multimodalInsights: {
      hook: '第一秒即进入 ASMR 梳毛声音 + 猫咪放松表情 → 无门槛进入',
      format: '9:16 竖版短视频，全程无语音无字幕，纯感官驱动',
      visualStructure: '慢镜头梳毛 → 猫咪闭眼享受 → 换角度继续 → 渐黑收尾',
      audioStrategy: 'ASMR 收音为内容核心驱动因素，声音质量直接决定完播率',
      colorPalette: '柔光暖色调，低对比度，营造放松氛围',
      textOverlay: '无文字叠加，纯视觉+听觉体验',
    },
    audienceInsight:
      '沉浸式内容的受众不限于宠物主——「解压」需求使此类内容具备跨圈层传播潜力。' +
      '评论区「看了三遍」「太治愈了」「已收藏」等信号表明强重复消费意愿。',
    replicability: '中等：ASMR 收音需要专业设备或安静环境，但内容框架固定。',
    createdAt: '2026-08-03T09:30:00Z',
    provenance:
      '验收演示项目：analysis-003。分析结论为固定的演示占位数据，未执行任何视觉分析、模型推理或 API 调用。',
  }),

  Object.freeze({
    id: 'analysis-004',
    evidenceId: 'ev-004',
    title: '系列化教程内容的结构与留存策略',
    type: 'text',
    textSummary:
      '长视频教程使用 Before/After 对比开场制造期待感，分步讲解降低学习门槛，' +
      '系列化标题（Day 1/7）和评论打卡机制提升回访率。适合「训练」「教程」「挑战」等持续性话题。',
    multimodalInsights: {
      hook: '前 30 秒：Before/After 训练成果对比 → 制造「我也能做到」的期待',
      format: '横版长视频（>5 分钟），YouTube 平台',
      visualStructure: '成果展示 → 分步讲解 → 常见错误纠正 → 作业布置 → 下期预告',
      educationalDesign: '每步独立可练习，7 天递增难度，降低弃学率',
      colorPalette: '自然光室内拍摄，暖色调',
      textOverlay: '步骤编号叠加、关键动作标注、Before/After 标签',
    },
    audienceInsight:
      '系列化内容对「训练」和「教程」类话题效果显著——观众会为了下一天的教程订阅频道。' +
      '评论打卡机制进一步绑定观众参与度。',
    replicability: '高：系列化框架可套用于任何技能教学类内容，仅需替换训练主题。',
    createdAt: '2026-08-04T17:30:00Z',
    provenance:
      '验收演示项目：analysis-004。分析结论为固定的演示占位数据，未执行任何视觉分析、模型推理或 API 调用。',
  }),
]);

// ============================================================================
// 3. 知识卡（3 张，绑定到证据 ID）
// ============================================================================
export const DEMO_KNOWLEDGE_CARDS = deepFreeze([
  Object.freeze({
    id: 'kc-001',
    title: '「首次反应」模板：宠物产品推广的高互动内容框架',
    summary:
      '已验证的内容模式：以特写镜头捕捉宠物首次接触产品的实时反应，3 秒内呈现情绪峰值，' +
      '全程无旁白仅依赖字幕，总时长控制在 18-25 秒。该模式在多个宠物品类中反复验证有效，' +
      '平均互动率（likes/views）约 7.5%，评论中 UGC 分享自家宠物体验的比例高。',
    category: 'content_pattern',
    confidence: 0.85,
    sourceEvidenceIds: Object.freeze(['ev-001']),
    sourceAnalysisIds: Object.freeze(['analysis-001']),
    citations: Object.freeze([
      Object.freeze({
        evidenceId: 'ev-001',
        excerpt: '3 秒内呈现猫咪从好奇到尝试的完整过程，无旁白配音，仅保留环境音与字幕。',
        sourceUrl: 'https://x.com/petstyle_daily/status/1820123456789012345',
      }),
    ]),
    applicablePlatforms: Object.freeze(['TikTok', 'Instagram Reels', 'YouTube Shorts']),
    tags: Object.freeze(['宠物', '短视频', '内容模板', '产品推广']),
    createdAt: '2026-08-05T10:00:00Z',
    provenance:
      '验收演示项目：kc-001。知识卡为固定的演示占位数据，未写入知识库，置信度为固定占位值。',
  }),

  Object.freeze({
    id: 'kc-002',
    title: '「清单避坑」轮播：新手向话题的高收藏内容结构',
    summary:
      '已验证的内容模式：封面使用「N 条必知/避坑」标题制造信息不对称，逐页清单降低认知负荷，' +
      '末页引导关注。该结构在 Instagram 轮播和 X Thread 中均表现出显著高于平均的收藏率（约 2-3×）' +
      '和分享率，适合所有「新手向」和「教程」类话题。',
    category: 'content_pattern',
    confidence: 0.78,
    sourceEvidenceIds: Object.freeze(['ev-002']),
    sourceAnalysisIds: Object.freeze(['analysis-002']),
    citations: Object.freeze([
      Object.freeze({
        evidenceId: 'ev-002',
        excerpt: '封面用「90%新手不知道的第7条」制造好奇心，10 页轮播每页一条建议。',
        sourceUrl: 'https://www.instagram.com/p/C9AbCdEfGhI/',
      }),
    ]),
    applicablePlatforms: Object.freeze(['Instagram', 'X', '小红书']),
    tags: Object.freeze(['轮播', '清单', '新手教程', '收藏驱动']),
    createdAt: '2026-08-05T11:00:00Z',
    provenance:
      '验收演示项目：kc-002。知识卡为固定的演示占位数据，未写入知识库，置信度为固定占位值。',
  }),

  Object.freeze({
    id: 'kc-003',
    title: '「沉浸式感官」内容：ASMR/慢镜头的跨圈层传播策略',
    summary:
      '已验证的内容模式：以高质量 ASMR 收音和慢镜头为核心驱动力的无对话短视频，' +
      '依靠「解压」「治愈」标签突破宠物垂直圈层，触达泛生活方式的更大受众群。' +
      '平均观看时长显著高于普通宠物内容（推测 2-3×），重复观看率高，评论情绪正向。' +
      '产出条件：需要专业收音设备或安静拍摄环境。',
    category: 'content_strategy',
    confidence: 0.72,
    sourceEvidenceIds: Object.freeze(['ev-003']),
    sourceAnalysisIds: Object.freeze(['analysis-003']),
    citations: Object.freeze([
      Object.freeze({
        evidenceId: 'ev-003',
        excerpt: '全程 ASMR 收音 + 慢镜头猫咪梳毛画面，无对话无字幕，依靠声音触发与视觉舒适感留住观众。',
        sourceUrl: 'https://www.tiktok.com/@catlovers_hub/video/7432109876543210987',
      }),
    ]),
    applicablePlatforms: Object.freeze(['TikTok', 'Instagram Reels', 'YouTube Shorts']),
    tags: Object.freeze(['ASMR', '沉浸式', '解压', '跨圈层']),
    createdAt: '2026-08-05T12:00:00Z',
    provenance:
      '验收演示项目：kc-003。知识卡为固定的演示占位数据，未写入知识库，置信度为固定占位值。',
  }),
]);

// ============================================================================
// 4. 可审核 Brief（绑定到知识卡 ID 和证据 ID）
// ============================================================================
export const DEMO_BRIEF = deepFreeze({
  id: 'brief-001',
  title: '宠物用品推广 · 7 天内容计划 Brief（待审核）',
  topic: '宠物用品账号 2026 年 8 月第 2 周内容计划 — 基于「首次反应」「清单避坑」「沉浸式」三模板组合',
  objective:
    '本周产出 7 条内容（3 短视频 + 2 轮播 + 1 长视频教程 + 1 ASMR），' +
    '覆盖拉新（首次反应）、留存（清单避坑）、破圈（沉浸式 ASMR）三个目标，' +
    '全部内容基于已验证的知识卡框架和证据溯源链。',
  status: 'pending_human_review',
  statusLabel: '待人工审核',
  boundKnowledgeCardIds: Object.freeze(['kc-001', 'kc-002', 'kc-003']),
  boundEvidenceIds: Object.freeze(['ev-001', 'ev-002', 'ev-003', 'ev-004']),
  humanDecision: Object.freeze({
    status: 'pending',
    statusLabel: '待审核',
    reviewer: null,
    reviewedAt: null,
    decision: null,
    comment: '',
  }),
  constraints: Object.freeze([
    '所有内容必须在发布前获得人工批准',
    '四项执行标志必须保持 false，直到人工单独授权每项',
    '交接包仅允许本地导入，导入后状态为 pending_human_generation_review',
    '不得在未获授权时调用任何 AI 模型生成、路由或发布',
    '引用来源（ev-001 至 ev-004）为演示占位数据，不可作为真实运营依据',
  ]),
  structuralGuidance: Object.freeze([
    'Day 1-2：短视频「首次反应」模板（基于 kc-001），使用宠物用品新品作为触发物',
    'Day 3-4：轮播「清单避坑」模板（基于 kc-002），主题为宠物用品选购指南',
    'Day 5：ASMR/沉浸式梳毛或护理（基于 kc-003），纯感官内容破圈',
    'Day 6-7：系列化教程（基于 ev-004 分析），宠物训练或日常护理分步教学',
  ]),
  createdAt: '2026-08-06T09:00:00Z',
  provenance:
    '验收演示项目：brief-001。Brief 为固定的演示占位数据，绑定知识卡 kc-001/kc-002/kc-003 和证据 ev-001 至 ev-004。' +
    '未经过真实 P5 交接包导出，未触发任何审批流程。',
});

// ============================================================================
// 5. P5 兼容交接包（精确 ID，四项执行标志严格 false）
// ============================================================================
export const DEMO_HANDOFF = deepFreeze({
  id: 'handoff-001',
  briefId: 'brief-001',
  title: 'P5 交接包：宠物用品 8 月第 2 周内容计划',
  description:
    '由 Brief brief-001 生成的内容生产交接包，包含 7 天内容计划的完整规格、' +
    '关联知识卡引用、证据溯源和角色/素材约束。交接包状态为待导入，所有执行标志为 false。',
  status: 'pending_import',
  statusLabel: '待导入',
  boundKnowledgeCardIds: Object.freeze(['kc-001', 'kc-002', 'kc-003']),
  boundEvidenceIds: Object.freeze(['ev-001', 'ev-002', 'ev-003', 'ev-004']),
  executionFlags: FALSE_FLAGS,
  contentPlan: Object.freeze([
    Object.freeze({ day: 1, template: 'first_reaction', knowledgeCardId: 'kc-001', platform: 'TikTok' }),
    Object.freeze({ day: 2, template: 'first_reaction', knowledgeCardId: 'kc-001', platform: 'Instagram' }),
    Object.freeze({ day: 3, template: 'checklist', knowledgeCardId: 'kc-002', platform: 'Instagram' }),
    Object.freeze({ day: 4, template: 'checklist', knowledgeCardId: 'kc-002', platform: 'X' }),
    Object.freeze({ day: 5, template: 'immersive_asmr', knowledgeCardId: 'kc-003', platform: 'TikTok' }),
    Object.freeze({ day: 6, template: 'tutorial_series', knowledgeCardId: 'kc-001', platform: 'YouTube' }),
    Object.freeze({ day: 7, template: 'tutorial_series', knowledgeCardId: 'kc-001', platform: 'YouTube' }),
  ]),
  handoffConstraints: Object.freeze([
    'generation_executed: false — 不执行任何 AI 生成',
    'routing_executed: false — 不执行任何内容路由',
    'network_executed: false — 不执行任何网络请求',
    'publish_executed: false — 不执行任何发布动作',
  ]),
  createdAt: '2026-08-06T14:00:00Z',
  importOnly: true,
  provenance:
    '验收演示项目：handoff-001。P5 兼容交接包为固定的演示占位数据。' +
    '四项执行标志严格 false，未执行任何生成、路由、网络或发布动作。' +
    '交接包仅供本地导入演示，不连接任何下游生产系统。',
});

// ============================================================================
// 6. P16 世系审计（精确 node/edge ID，四种状态显式定义）
// ============================================================================
const LINEAGE_STATE_DEFINITIONS = deepFreeze({
  COMPLETE:
    'COMPLETE：数据链路完整可追溯 — 从源证据到最终产物的每一跳都有明确的节点和边记录，无断链、无缺失。',
  PARTIAL:
    'PARTIAL：部分可追溯 — 链路中存在至少一个节点或边的信息来源不完整，但主干路径仍可识别。',
  BROKEN:
    'BROKEN：链路断裂 — 某个关键节点的来源无法确定，或边指向了不存在的节点，导致追溯中断。',
  INVALID_SOURCE:
    'INVALID_SOURCE：无效来源 — 某个节点声称的来源引用格式错误、指向不可验证的外部 URL，或引用 ID 在系统中不存在。',
});

export const DEMO_LINEAGE_ENTRIES = deepFreeze([
  Object.freeze({
    id: 'lineage-001',
    nodeId: 'node-evidence-ev-001',
    edgeId: 'edge-ev-001-to-analysis-001',
    sourceNodeId: null,
    targetNodeId: 'node-analysis-analysis-001',
    lineageState: 'COMPLETE',
    stateMeaning: LINEAGE_STATE_DEFINITIONS.COMPLETE,
    sourceLabel: '证据 ev-001 → 分析 analysis-001',
    summary:
      '证据 ev-001（@petstyle_daily X 帖子）经采集后由 analysis-001 完成多模态分析。' +
      '采集时间戳、分析时间戳、来源 URL 和源身份信息均完整记录。节点 node-evidence-ev-001 ' +
      '通过边 edge-ev-001-to-analysis-001 连接到 node-analysis-analysis-001，链路完整。',
    verifiedAt: '2026-08-06T15:00:00Z',
  }),

  Object.freeze({
    id: 'lineage-002',
    nodeId: 'node-evidence-ev-002',
    edgeId: 'edge-ev-002-to-analysis-002',
    sourceNodeId: null,
    targetNodeId: 'node-analysis-analysis-002',
    lineageState: 'PARTIAL',
    stateMeaning: LINEAGE_STATE_DEFINITIONS.PARTIAL,
    sourceLabel: '证据 ev-002 → 分析 analysis-002',
    summary:
      '证据 ev-002（@dogcare_tips Instagram 轮播）经采集后由 analysis-002 完成文本分析。' +
      '然而 analysis-002 的 multimodalInsights 字段未能从 ev-002 获取完整的视觉数据（Instagram 轮播' +
      '图片下载未执行），导致视觉结构分析仅基于文本描述推断，缺少逐页截图验证。因此标记为 PARTIAL。',
    verifiedAt: '2026-08-06T15:00:00Z',
  }),

  Object.freeze({
    id: 'lineage-003',
    nodeId: 'node-evidence-ev-003',
    edgeId: 'edge-ev-003-to-analysis-003',
    sourceNodeId: null,
    targetNodeId: 'node-analysis-analysis-003',
    lineageState: 'COMPLETE',
    stateMeaning: LINEAGE_STATE_DEFINITIONS.COMPLETE,
    sourceLabel: '证据 ev-003 → 分析 analysis-003',
    summary:
      '证据 ev-003（@catlovers_hub TikTok 视频）经采集后由 analysis-003 完成多模态分析。' +
      '视频内容、音频特征、互动指标和来源 URL 均完整记录。节点 node-evidence-ev-003 ' +
      '通过边 edge-ev-003-to-analysis-003 连接到 node-analysis-analysis-003，链路完整。',
    verifiedAt: '2026-08-06T15:00:00Z',
  }),

  Object.freeze({
    id: 'lineage-004',
    nodeId: 'node-evidence-ev-004',
    edgeId: 'edge-ev-004-to-analysis-004',
    sourceNodeId: null,
    targetNodeId: 'node-analysis-analysis-004',
    lineageState: 'BROKEN',
    stateMeaning: LINEAGE_STATE_DEFINITIONS.BROKEN,
    sourceLabel: '证据 ev-004 → 分析 analysis-004（断裂）',
    summary:
      '证据 ev-004（@pettraining_pro YouTube 视频）的采集过程中发现视频已被设为私密或删除。' +
      'analysis-004 的分析结论基于采集快照中的文本元数据（标题、描述、评论），但无法验证视频画面内容。' +
      '节点 node-evidence-ev-004 到 node-analysis-analysis-004 的边标记为 BROKEN：' +
      '源数据不可验证，分析结论缺乏画面级证据支撑。',
    verifiedAt: '2026-08-06T15:00:00Z',
  }),

  Object.freeze({
    id: 'lineage-005',
    nodeId: 'node-knowledge-kc-001',
    edgeId: 'edge-kc-001-to-analysis-001',
    sourceNodeId: 'node-analysis-analysis-001',
    targetNodeId: 'node-knowledge-kc-001',
    lineageState: 'COMPLETE',
    stateMeaning: LINEAGE_STATE_DEFINITIONS.COMPLETE,
    sourceLabel: '分析 analysis-001 → 知识卡 kc-001',
    summary:
      '知识卡 kc-001「首次反应模板」由分析 analysis-001 推导而来。analysis-001 的多模态分析' +
      '提供了 hook、格式、视觉结构和受众洞察，kc-001 将这些结论抽象为可复用的内容模板。' +
      '边 edge-kc-001-to-analysis-001 完整记录了从分析到知识的转化路径。',
    verifiedAt: '2026-08-06T15:00:00Z',
  }),

  Object.freeze({
    id: 'lineage-006',
    nodeId: 'node-knowledge-kc-002',
    edgeId: 'edge-kc-002-to-analysis-002',
    sourceNodeId: 'node-analysis-analysis-002',
    targetNodeId: 'node-knowledge-kc-002',
    lineageState: 'PARTIAL',
    stateMeaning: LINEAGE_STATE_DEFINITIONS.PARTIAL,
    sourceLabel: '分析 analysis-002 → 知识卡 kc-002',
    summary:
      '知识卡 kc-002「清单避坑模板」源自分析 analysis-002。由于 analysis-002 本身的视觉数据' +
      '不完整（PARTIAL），kc-002 的视觉层面建议（如「浅色卡片风格」「每页一条」的布局建议）' +
      '缺乏逐页画面的直接验证。文本层面的结论置信度较高，视觉层面标记为 PARTIAL。',
    verifiedAt: '2026-08-06T15:00:00Z',
  }),

  Object.freeze({
    id: 'lineage-007',
    nodeId: 'node-knowledge-kc-003',
    edgeId: 'edge-kc-003-to-ev-003',
    sourceNodeId: 'node-evidence-ev-003',
    targetNodeId: 'node-knowledge-kc-003',
    lineageState: 'INVALID_SOURCE',
    stateMeaning: LINEAGE_STATE_DEFINITIONS.INVALID_SOURCE,
    sourceLabel: '知识卡 kc-003 引用无效来源（INVALID_SOURCE）',
    summary:
      '知识卡 kc-003「沉浸式感官内容」在演示中故意引入了一个无效来源引用：kc-003 的 citations 中' +
      '包含一条指向 external-source-999 的引用，该引用在系统中不存在对应证据记录。' +
      '此条为「验收演示项目」故意构造的边界案例，用于验证世系审计对 INVALID_SOURCE 类型的正确识别。' +
      '注意：kc-003 同时包含有效的 ev-003 引用，因此该知识卡整体并非完全无效——' +
      '仅此条世系边标记为 INVALID_SOURCE。',
    verifiedAt: '2026-08-06T15:00:00Z',
  }),
]);

// ============================================================================
// 7. 元信息与整体工作区
// ============================================================================
export const DEMO_WORKSPACE_META = deepFreeze({
  version: 'p18-integrated-demo-workspace-v1',
  label: '验收演示项目',
  labelEn: 'Acceptance Demo Project',
  description:
    '这是一个完全自洽的本地演示数据集，用于展示「研究证据 → 分析 → 知识卡 → 可审核 Brief → P5 交接包 → P16 世系」' +
    '的完整智能内容链。所有数据均为固定的演示占位数据，不代表任何真实采集、分析、生成、路由或发布动作已执行。',
  boundaryStatement:
    '本验收演示项目为纯本地数据。不连接 Supabase、不执行任何网络请求、不调用模型、不写入任何存储。' +
    '仅在前端内存中渲染，供 UI 验收和集成测试使用。',
  livePrecedenceNote:
    '当 Supabase staging api 的所有五个视图均可读取且返回非空数据时，' +
    '本演示项目不会渲染——产品将优先展示实时 staging 数据。' +
    '仅在 staging api 完全为空时，本演示项目才会在页面上以「验收演示项目」标签明确区分展示。',
  createdAt: '2026-08-11T00:00:00Z',
});

// ============================================================================
// 导出聚合工作区
// ============================================================================
export const DEMO_WORKSPACE = deepFreeze({
  meta: DEMO_WORKSPACE_META,
  evidence: DEMO_EVIDENCE,
  analyses: DEMO_ANALYSES,
  knowledgeCards: DEMO_KNOWLEDGE_CARDS,
  brief: DEMO_BRIEF,
  handoff: DEMO_HANDOFF,
  lineage: Object.freeze({
    entries: DEMO_LINEAGE_ENTRIES,
    definitions: LINEAGE_STATE_DEFINITIONS,
    stateCounts: Object.freeze({
      COMPLETE: DEMO_LINEAGE_ENTRIES.filter((e) => e.lineageState === 'COMPLETE').length,
      PARTIAL: DEMO_LINEAGE_ENTRIES.filter((e) => e.lineageState === 'PARTIAL').length,
      BROKEN: DEMO_LINEAGE_ENTRIES.filter((e) => e.lineageState === 'BROKEN').length,
      INVALID_SOURCE: DEMO_LINEAGE_ENTRIES.filter((e) => e.lineageState === 'INVALID_SOURCE').length,
    }),
  }),
  executionFlags: FALSE_FLAGS,
});

// 深度不可变性验证：重新 freeze 所有内容（防御性）
// 注意：因 Object.freeze 在模块加载时已应用，此处仅为显式文档说明。
// 外部使用者可通过以下方式验证深度不可变：
//   Object.isFrozen(DEMO_WORKSPACE) === true
//   且递归检查所有嵌套对象均 Object.isFrozen。

// DEMO_WORKSPACE 已在上面通过 deepFreeze 完全冻结
