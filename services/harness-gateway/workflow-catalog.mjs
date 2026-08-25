// Fixed deterministic workflow catalog for the Harness orchestrator (v1).
//
// Every user-facing Harness ability maps to exactly one bounded workflow in
// this registry. A workflow declares its exact scalar slots, ordered step
// graph (dependencies), allowed P19/P22 operations, required approval scopes,
// fan-out bounds, reuse rules and terminal artifacts. The planner may only
// select one workflow id and fill validated scalar slots; the deterministic
// executor is the only code that turns a confirmed plan into tool calls.
//
// The registry is immutable server code: nothing here is derived from model
// output, and no workflow can reference an operation that is not in
// TOOL_DEFINITIONS (asserted by assertWorkflowIntegrity and by tests).
//
// Slots are bounded scalars only — never arrays, payload objects, SQL, URLs
// outside the P22 X/Reddit post contracts, provider selection, deletions,
// Auth/schema/security changes, production or social publishing.
import { TOOL_DEFINITIONS } from './tool-contract.mjs';

export const WORKFLOW_SCHEMA_VERSION = 'ams_harness_workflow_v1';
export const WORKFLOW_CATALOG_VERSION = 'ams_harness_workflow_catalog_v1';

export const APPROVAL_SCOPES = Object.freeze(['paid_external_calls', 'online_writes', 'handoff_creation']);
export const MAX_FAN_OUT = 10;
export const MAX_WORKFLOW_STEPS = 12;
export const MAX_SLOT_STRING = 1000;
export const MAX_SLOT_KEYWORD = 240;
export const MAX_SLOT_IDENTITY = 200;

// Exact post-identity patterns. The planner extracts these bounded scalars
// from the intent; the executor reuses the same exact identity strings.
export const EVIDENCE_ID_PATTERN = /^ev-[0-9a-f]{24}$/;
export const ANALYSIS_ID_PATTERN = /^an-[0-9a-f]{24}$/;
export const BRIEF_ID_PATTERN = /^brief-[0-9a-f]{24}$/;
// 知识卡身份遵循 P19 权威契约：kc-<24 位小写十六进制>（旧 card- 前缀不是合法别名）。
export const CARD_ID_PATTERN = /^kc-[0-9a-f]{24}$/;
export const G1_JOB_ID_PATTERN = /^g1j-[0-9a-f]{24}$/;
export const G1_ARTIFACT_ID_PATTERN = /^g1x-[0-9a-f]{24}$/;
// 引用素材（assets.id）是 UUID；G1 边界要求该素材为当前用户已批准的图片。
export const REFERENCE_ASSET_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const stringSlot = (overrides = {}) => ({
  type: 'string',
  required: false,
  min: 1,
  max: MAX_SLOT_STRING,
  ...overrides,
});
const keywordSlot = (overrides = {}) => stringSlot({ max: MAX_SLOT_KEYWORD, required: true, ...overrides });
const integerSlot = (overrides = {}) => ({ type: 'integer', required: false, min: 0, max: MAX_FAN_OUT, ...overrides });
const booleanSlot = (overrides = {}) => ({ type: 'boolean', required: false, default: false, ...overrides });
const enumSlot = (values, overrides = {}) => ({ type: 'enum', values, required: false, ...overrides });
const identitySlot = (pattern, overrides = {}) => ({ type: 'identity', pattern, required: false, max: MAX_SLOT_IDENTITY, ...overrides });

// Step kind: read_state performs the state reader's bounded project read
// (workspace.project.read through the exact tool contract); tool steps are
// expanded by the deterministic executor into exactly one validated
// ams_harness_tool_v1 call per item.
const readStateStep = (overrides = {}) => ({
  step: 'read_state',
  label: '读取当前项目状态',
  kind: 'read_state',
  operation: 'workspace.project.read',
  depends_on: [],
  approval: [],
  cost: false,
  write: false,
  fan_out: null,
  reuse: null,
  terminal_artifact: null,
  note: '读取当前项目的 Evidence、分析、知识卡与 Brief 状态，用于精确复用与修订守卫。',
  ...overrides,
});

function toolStep(step, label, operation, overrides = {}) {
  const definition = TOOL_DEFINITIONS[operation];
  if (!definition) throw new TypeError(`Catalog references an unknown operation: ${operation}`);
  return {
    step,
    label,
    kind: 'tool',
    operation,
    depends_on: [],
    approval: [...definition.approval],
    // 付费与写入标志由工具定义的批准范围派生（G1 generation.submit 同时
    // 声明 paid_external_calls 与 online_writes，因此 cost 与 write 均为 true）。
    cost: definition.approval.includes('paid_external_calls'),
    write: definition.approval.includes('online_writes'),
    fan_out: null,
    reuse: null,
    terminal_artifact: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Workflow definitions. Each `steps` array is the complete dependency graph
// for the workflow; the planner includes steps whose `gate` predicate is true
// (deterministic normalization of the validated slots), preserving order and
// dependencies.
// ---------------------------------------------------------------------------

const WORKFLOW_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'read_capability',
    title: '能力与当前项目读取',
    description: '读取当前项目状态或 Harness 可用能力，不产生费用与写入。',
    slots: Object.freeze({}),
    terminal_artifacts: Object.freeze(['project']),
    steps: Object.freeze([
      Object.freeze({
        step: 'read_project',
        label: '读取当前项目',
        kind: 'tool',
        operation: 'workspace.project.read',
        depends_on: Object.freeze([]),
        approval: Object.freeze([]),
        cost: false,
        write: false,
        fan_out: null,
        reuse: null,
        terminal_artifact: 'project',
        gate: null,
        note: '只读能力：返回当前项目的完整状态。',
      }),
    ]),
  }),

  Object.freeze({
    id: 'collect_analyze_evidence',
    title: '采集并分析公开来源',
    description: '采集一条公开 X 帖子，可选保存为证据、执行多模态分析、生成知识卡与待审核 Brief。',
    slots: Object.freeze({
      url: stringSlot({ type: 'url', required: true, max: MAX_SLOT_STRING, note: '公开 X 帖子链接（https，具体状态页）。' }),
      persist: booleanSlot({ note: '把采集结果保存为项目证据。' }),
      analyze: booleanSlot({ note: '对已保存证据执行模型分析。' }),
      card: booleanSlot({ note: '从分析生成知识卡。' }),
      brief: booleanSlot({ note: '从知识卡生成待审核 Brief。' }),
    }),
    terminal_artifacts: Object.freeze(['evidence', 'analysis', 'card', 'brief']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: 'persist' }),
      Object.freeze({
        ...toolStep('collect', '采集公开来源', 'research.collect_url', {
          depends_on: Object.freeze(['read_state']),
          reuse: Object.freeze({ kind: 'evidence', rule: 'exact_source_identity', note: '同一规范化来源身份已存在时标记 reused，不发起付费采集。' }),
          terminal_artifact: 'evidence',
          gate: null,
        }),
      }),
      Object.freeze({
        ...toolStep('save_evidence', '保存证据', 'workspace.evidence.create', {
          depends_on: Object.freeze(['read_state', 'collect']),
          reuse: Object.freeze({ kind: 'evidence', rule: 'exact_source_identity', note: '同一正文哈希的 Evidence 已存在时标记 reused，不重复写入。' }),
          terminal_artifact: 'evidence',
          gate: 'persist',
        }),
      }),
      Object.freeze({
        ...toolStep('analyze', '分析已保存证据', 'research.analyze_persisted', {
          depends_on: Object.freeze(['save_evidence']),
          reuse: Object.freeze({ kind: 'analysis', rule: 'evidence_binding_model', note: '同一证据绑定与模型契约的分析已存在时标记 reused，不发起付费分析。' }),
          terminal_artifact: 'analysis',
          gate: 'analyze',
        }),
      }),
      Object.freeze({
        ...toolStep('save_analysis', '保存分析记录', 'workspace.analysis.create', {
          depends_on: Object.freeze(['analyze']),
          reuse: Object.freeze({ kind: 'analysis', rule: 'evidence_binding_model', note: '同一证据绑定与模型契约的分析已存在时标记 reused，不重复写入。' }),
          terminal_artifact: 'analysis',
          gate: 'analyze',
        }),
      }),
      Object.freeze({
        ...toolStep('make_card', '生成知识卡', 'workspace.card.create', {
          depends_on: Object.freeze(['save_analysis']),
          reuse: Object.freeze({ kind: 'card', rule: 'analysis_lineage', note: '同一分析精确血缘的知识卡已存在时标记 reused。' }),
          terminal_artifact: 'card',
          gate: 'card',
        }),
      }),
      Object.freeze({
        ...toolStep('assemble_brief', '生成待审核 Brief', 'workspace.brief.assemble', {
          depends_on: Object.freeze(['make_card']),
          reuse: Object.freeze({ kind: 'brief', rule: 'knowledge_set_version', note: '最新版本 Brief 引用同一知识卡集合时标记 reused。' }),
          terminal_artifact: 'brief',
          gate: 'brief',
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'inspect_private_attachments',
    title: '验证并分析私有附件',
    description: '验证当前任务绑定的私有图片、视频或文档，执行有界内容提取，并可保存为 Evidence、Analysis、Knowledge Card 与待审核 Brief。',
    slots: Object.freeze({
      persist: booleanSlot({ default: true, note: '保存经过服务端验证的附件 Evidence。' }),
      analyze: booleanSlot({ default: true, note: '保存附件内容分析。' }),
      card: booleanSlot({ default: true, note: '从附件分析生成知识卡。' }),
      brief: booleanSlot({ default: false, note: '从知识卡生成待审核 Brief。' }),
    }),
    terminal_artifacts: Object.freeze(['evidence', 'analysis', 'card', 'brief']),
    steps: Object.freeze([
      Object.freeze(readStateStep()),
      Object.freeze({
        ...toolStep('inspect', '验证并理解附件', 'research.inspect_attachments', {
          depends_on: Object.freeze(['read_state']),
          terminal_artifact: 'analysis',
          gate: null,
        }),
      }),
      Object.freeze({
        ...toolStep('save_evidence', '保存附件证据', 'workspace.evidence.create', {
          depends_on: Object.freeze(['inspect']),
          terminal_artifact: 'evidence',
          gate: 'persist',
        }),
      }),
      Object.freeze({
        ...toolStep('save_analysis', '保存附件分析', 'workspace.analysis.create', {
          depends_on: Object.freeze(['save_evidence']),
          terminal_artifact: 'analysis',
          gate: 'analyze',
        }),
      }),
      Object.freeze({
        ...toolStep('make_card', '生成附件知识卡', 'workspace.card.create', {
          depends_on: Object.freeze(['save_analysis']),
          terminal_artifact: 'card',
          gate: 'card',
        }),
      }),
      Object.freeze({
        ...toolStep('assemble_brief', '生成待审核 Brief', 'workspace.brief.assemble', {
          depends_on: Object.freeze(['make_card']),
          terminal_artifact: 'brief',
          gate: 'brief',
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'search_x',
    title: '搜索 X 热门主题',
    description: '按关键词搜索 X 公开内容，可选把搜索到的前 N 条保存为证据。',
    slots: Object.freeze({
      keyword: keywordSlot({ note: '搜索关键词（非 URL）。' }),
      count: integerSlot({ min: 1, max: 10, default: 5, note: '搜索返回条数 1–10。' }),
      save_count: integerSlot({ min: 0, max: 5, default: 0, note: '保存为证据的条数 0–5。' }),
      sort: enumSlot(['latest'], { default: 'latest', note: '排序意图（当前仅 latest）。' }),
    }),
    terminal_artifacts: Object.freeze(['search_results', 'evidence']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: 'save_count' }),
      Object.freeze({
        ...toolStep('search', '搜索 X 公开内容', 'research.search_x', {
          depends_on: Object.freeze(['read_state']),
          terminal_artifact: 'search_results',
          gate: null,
        }),
      }),
      Object.freeze({
        ...toolStep('save_evidence', '保存证据', 'workspace.evidence.create', {
          depends_on: Object.freeze(['search']),
          fan_out: Object.freeze({ source: 'search_items', max: 5, limit_slot: 'save_count' }),
          reuse: Object.freeze({ kind: 'evidence', rule: 'exact_source_identity', note: '与既有证据来源身份精确一致时标记 reused。' }),
          terminal_artifact: 'evidence',
          gate: 'save_count',
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'search_reddit',
    title: '搜索 Reddit 热门主题',
    description: '按关键词搜索 Reddit 公开内容，可选把搜索到的前 N 条保存为证据。',
    slots: Object.freeze({
      keyword: keywordSlot({ note: '搜索关键词（非 URL）。' }),
      count: integerSlot({ min: 1, max: 10, default: 5, note: '搜索返回条数 1–10。' }),
      save_count: integerSlot({ min: 0, max: 5, default: 0, note: '保存为证据的条数 0–5。' }),
      sort: enumSlot(['relevance', 'hot', 'new', 'top', 'comments'], { default: 'relevance', note: 'Reddit 排序。' }),
      time_filter: enumSlot(['hour', 'day', 'week', 'month', 'year', 'all'], { default: 'all', note: 'Reddit 时间范围。' }),
      subreddit: stringSlot({ max: 32, pattern: /^[A-Za-z0-9_]{2,32}$/, note: '限定 subreddit（可选）。' }),
    }),
    terminal_artifacts: Object.freeze(['search_results', 'evidence']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: 'save_count' }),
      Object.freeze({
        ...toolStep('search', '搜索 Reddit 公开内容', 'research.search_reddit', {
          depends_on: Object.freeze(['read_state']),
          terminal_artifact: 'search_results',
          gate: null,
        }),
      }),
      Object.freeze({
        ...toolStep('save_evidence', '保存证据', 'workspace.evidence.create', {
          depends_on: Object.freeze(['search']),
          fan_out: Object.freeze({ source: 'search_items', max: 5, limit_slot: 'save_count' }),
          reuse: Object.freeze({ kind: 'evidence', rule: 'exact_source_identity', note: '与既有证据来源身份精确一致时标记 reused。' }),
          terminal_artifact: 'evidence',
          gate: 'save_count',
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'search_x_reddit',
    title: '搜索 X 与 Reddit 热门主题',
    description: '同一关键词分别搜索 X 与 Reddit，可选把搜索结果中的前 N 条保存为证据。',
    slots: Object.freeze({
      keyword: keywordSlot({ note: '搜索关键词（非 URL）。' }),
      count: integerSlot({ min: 1, max: 10, default: 5, note: '每个平台搜索返回条数 1–10。' }),
      save_count: integerSlot({ min: 0, max: 5, default: 0, note: '合并结果中保存为证据的条数 0–5（先 X 后 Reddit）。' }),
    }),
    terminal_artifacts: Object.freeze(['search_results', 'evidence']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: 'save_count' }),
      Object.freeze({
        ...toolStep('search_x', '搜索 X 公开内容', 'research.search_x', {
          depends_on: Object.freeze(['read_state']),
          terminal_artifact: 'search_results',
          gate: null,
        }),
      }),
      Object.freeze({
        ...toolStep('search_reddit', '搜索 Reddit 公开内容', 'research.search_reddit', {
          depends_on: Object.freeze(['search_x']),
          terminal_artifact: 'search_results',
          gate: null,
        }),
      }),
      Object.freeze({
        ...toolStep('save_evidence', '保存证据', 'workspace.evidence.create', {
          depends_on: Object.freeze(['search_reddit']),
          fan_out: Object.freeze({ source: 'combined_items', max: 5, limit_slot: 'save_count' }),
          reuse: Object.freeze({ kind: 'evidence', rule: 'exact_source_identity', note: '与既有证据来源身份精确一致时标记 reused。' }),
          terminal_artifact: 'evidence',
          gate: 'save_count',
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'analyze_evidence',
    title: '分析项目既有证据',
    description: '对当前项目中已有的 Evidence 逐条执行模型分析并保存分析记录（按项目内顺序，最多 count 条）。',
    slots: Object.freeze({
      count: integerSlot({ min: 1, max: 5, default: 5, note: '分析条数上限 1–5。' }),
    }),
    terminal_artifacts: Object.freeze(['analysis']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: null }),
      Object.freeze({
        ...toolStep('analyze', '分析已保存证据', 'research.analyze_persisted', {
          depends_on: Object.freeze(['read_state']),
          fan_out: Object.freeze({ source: 'evidence_items', max: 5, limit_slot: 'count' }),
          reuse: Object.freeze({ kind: 'analysis', rule: 'evidence_binding_model', note: '同一证据绑定与模型契约的分析已存在时标记 reused。' }),
          terminal_artifact: 'analysis',
          gate: null,
        }),
      }),
      Object.freeze({
        ...toolStep('save_analysis', '保存分析记录', 'workspace.analysis.create', {
          depends_on: Object.freeze(['analyze']),
          fan_out: Object.freeze({ source: 'evidence_items', max: 5, limit_slot: 'count' }),
          reuse: Object.freeze({ kind: 'analysis', rule: 'evidence_binding_model', note: '同一证据绑定与模型契约的分析已存在时标记 reused，不重复写入。' }),
          terminal_artifact: 'analysis',
          gate: null,
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'compare_project',
    title: '比较项目来源与规律',
    description: '读取当前项目，按选定指标（views 或 engagement）确定性排序既有证据并提炼可复用规律；默认只读返回，仅在明确批准在线写入时才保存本地比较分析（本地计算，零模型调用）。',
    slots: Object.freeze({
      metric: enumSlot(['views', 'engagement'], { default: 'engagement', note: '比较指标：views（展现量/浏览量/播放量/曝光量，读取 canonical views 字段）或 engagement（单一确定性互动公式）。' }),
      count: integerSlot({ min: 1, max: 10, default: 5, note: '参与比较的来源条数上限 1–10。' }),
      persist: booleanSlot({ note: '把本地确定性比较分析保存到 staging（需明确批准在线写入；默认只读）。' }),
    }),
    terminal_artifacts: Object.freeze(['comparison', 'analysis']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: null }),
      Object.freeze({
        step: 'compare',
        label: '按指标比较来源',
        kind: 'local',
        operation: null,
        depends_on: Object.freeze(['read_state']),
        approval: Object.freeze([]),
        cost: false,
        write: false,
        fan_out: null,
        reuse: null,
        terminal_artifact: 'comparison',
        gate: null,
        note: '本地确定性比较：仅使用项目既有 Evidence 的指标字段，不调用任何模型、不联网、不产生费用。',
      }),
      Object.freeze({
        ...toolStep('save_comparison', '保存比较分析', 'workspace.analysis.create', {
          depends_on: Object.freeze(['compare']),
          fan_out: Object.freeze({ source: 'compare_evidence', max: 10, limit_slot: 'count' }),
          reuse: Object.freeze({ kind: 'analysis', rule: 'evidence_binding_model', note: '同一证据绑定的本地比较分析已存在时标记 reused。' }),
          terminal_artifact: 'analysis',
          gate: 'persist',
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'generate_similar',
    title: '生成相似内容草案',
    description: '基于精确保存的 Evidence 与绑定该 Evidence 的已保存 Analysis 生成一条相似风格的公开内容草案（付费模型调用）。',
    slots: Object.freeze({
      evidence_id: identitySlot(EVIDENCE_ID_PATTERN, { required: true, note: '精确的已保存 Evidence 身份 ev-<24 位十六进制>。' }),
      analysis_id: identitySlot(ANALYSIS_ID_PATTERN, { required: true, note: '精确的、绑定该 Evidence 的已保存 Analysis 身份 an-<24 位十六进制>。' }),
    }),
    terminal_artifacts: Object.freeze(['draft']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: null }),
      Object.freeze({
        ...toolStep('generate', '生成相似内容草案', 'research.generate_similar', {
          depends_on: Object.freeze(['read_state']),
          terminal_artifact: 'draft',
          gate: null,
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'assemble_brief',
    title: '生成待审核 Brief',
    description: '从当前项目已有的分析/知识卡确定性汇总生成待审核 Brief；引用集合不变时复用最新版本。',
    slots: Object.freeze({}),
    terminal_artifacts: Object.freeze(['brief']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: null }),
      Object.freeze({
        ...toolStep('assemble_brief', '生成待审核 Brief', 'workspace.brief.assemble', {
          depends_on: Object.freeze(['read_state']),
          reuse: Object.freeze({ kind: 'brief', rule: 'knowledge_set_version', note: '最新版本 Brief 引用同一知识卡集合时标记 reused。' }),
          terminal_artifact: 'brief',
          gate: null,
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'lineage_audit',
    title: '来源血缘审计',
    description: '只读审计当前项目的 Evidence/分析/知识卡/Brief/交接包来源血缘，不产生费用与写入。',
    slots: Object.freeze({}),
    terminal_artifacts: Object.freeze(['lineage']),
    steps: Object.freeze([
      Object.freeze({
        ...toolStep('audit', '执行血缘审计', 'workspace.lineage.audit', {
          depends_on: Object.freeze([]),
          terminal_artifact: 'lineage',
          gate: null,
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'create_handoff',
    title: '生成交接包',
    description: '从当前项目最新待审核 Brief 确定性生成生成交接包（需明确请求并批准 handoff_creation）。',
    slots: Object.freeze({}),
    terminal_artifacts: Object.freeze(['handoff']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: null }),
      Object.freeze({
        ...toolStep('make_handoff', '生成交接包', 'workspace.handoff.create', {
          depends_on: Object.freeze(['read_state']),
          reuse: Object.freeze({ kind: 'handoff', rule: 'latest_handoff_brief_binding', note: '已有同一 Brief 绑定的交接包时标记 reused。' }),
          terminal_artifact: 'handoff',
          gate: null,
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'generate_media',
    title: '生成图片或视频素材',
    description: '基于当前项目已批准/待审核 Brief 生成图片或视频（Bailian 固定模型）；quote 步骤只读返回不可变报价，submit 步骤是付费生成 + staging 作业写入，必须同时获得 paid_external_calls 与 online_writes 批准；quote_only 时仅获取报价，零费用零写入。',
    slots: Object.freeze({
      brief_id: identitySlot(BRIEF_ID_PATTERN, { required: true, note: '精确的已保存 Brief 身份 brief-<24 位十六进制>（pending_review 或 approved）。' }),
      mode: enumSlot(['image', 'video_t2v', 'video_i2v'], { required: true, note: 'image：qwen-image-2.0；video_t2v：happyhorse-1.0-t2v；video_i2v：happyhorse-1.0-i2v（需要已批准引用素材）。' }),
      prompt: stringSlot({ required: true, max: 2000, min: 1, note: '生成提示词（1–2000 字符）。' }),
      negative_prompt: stringSlot({ max: 500, note: '负面提示词（可选，0–500 字符）。' }),
      aspect_ratio: enumSlot(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'], { note: '画幅（可选；image 缺省 1:1，video 缺省 16:9）。' }),
      duration_seconds: integerSlot({ min: 1, max: 10, note: '视频时长秒数（可选，仅 video；缺省 5 秒）。' }),
      resolution: enumSlot(['720p', '1080p'], { note: '视频分辨率（可选，仅 video；缺省 720p）。' }),
      reference_asset_id: identitySlot(REFERENCE_ASSET_PATTERN, { note: '已批准引用素材 UUID（video_i2v 必需；其余 mode 不可用）。' }),
      submit_generation: booleanSlot({ default: true, note: '是否提交付费生成（false = 仅获取不可变报价，零费用零写入）。' }),
    }),
    terminal_artifacts: Object.freeze(['quote', 'job']),
    steps: Object.freeze([
      Object.freeze({ ...readStateStep(), gate: null }),
      Object.freeze({
        ...toolStep('quote', '获取不可变报价', 'generation.quote', {
          depends_on: Object.freeze(['read_state']),
          terminal_artifact: 'quote',
          gate: null,
          note: '只读报价：固定模型/模式 + 有界费用区间 + 到期时间 + 请求指纹，零费用零写入。',
        }),
      }),
      Object.freeze({
        ...toolStep('submit', '批准并提交付费生成', 'generation.submit', {
          depends_on: Object.freeze(['quote']),
          terminal_artifact: 'job',
          gate: 'submit_generation',
          note: '显式批准（paid_external_calls + online_writes 双重批准）后创建幂等付费生成作业；quote 步骤的结果（quote_id/指纹/预估最大费用）作为提交绑定。',
        }),
      }),
    ]),
  }),

  Object.freeze({
    id: 'read_generation',
    title: '读取生成任务状态或产物',
    description: '只读查询生成作业状态或产物签名链接；绝不继承 submit 的任何批准，不产生费用与写入。',
    slots: Object.freeze({
      job_id: identitySlot(G1_JOB_ID_PATTERN, { required: true, note: '精确的生成作业身份 g1j-<24 位十六进制>。' }),
      artifact_id: identitySlot(G1_ARTIFACT_ID_PATTERN, { note: '精确的产物身份 g1x-<24 位十六进制>（可选；提供时同时返回产物签名链接）。' }),
    }),
    terminal_artifacts: Object.freeze(['job_status', 'artifact']),
    steps: Object.freeze([
      Object.freeze({
        ...toolStep('status', '读取生成作业状态', 'generation.status', {
          depends_on: Object.freeze([]),
          terminal_artifact: 'job_status',
          gate: null,
          note: '只读：返回作业状态/尝试/事件与产物摘要。',
        }),
      }),
      Object.freeze({
        ...toolStep('artifact', '读取生成产物', 'generation.artifact', {
          depends_on: Object.freeze(['status']),
          terminal_artifact: 'artifact',
          gate: 'artifact_id',
          note: '只读：返回短时签名下载链接与产物血缘元数据。',
        }),
      }),
    ]),
  }),
]);

export const WORKFLOW_BY_ID = Object.freeze(Object.fromEntries(
  WORKFLOW_DEFINITIONS.map((workflow) => [workflow.id, workflow]),
));

export const WORKFLOW_IDS = Object.freeze(WORKFLOW_DEFINITIONS.map((workflow) => workflow.id));

// The fixed metric slot contract for compare_project. The planner maps Chinese
// highest-metric intents to exactly one of these values; the executor's
// comparison reads only these canonical metrics (never invented numbers).
export const COMPARE_METRICS = Object.freeze(['views', 'engagement']);
export const COMPARE_METRIC_LABELS = Object.freeze({
  views: '展现量/浏览量/播放量/曝光量（views）',
  engagement: '互动（engagement）',
});

export function compareMetricLabel(metric) {
  return COMPARE_METRICS.includes(metric) ? COMPARE_METRIC_LABELS[metric] : null;
}

/**
 * Integrity proof for the fixed catalog. Every entry must reference only
 * operations in TOOL_DEFINITIONS, only known approval scopes, valid slot
 * schemas, valid dependency keys, bounded fan-out sources and sane gates.
 * Called by tests; the gateway also runs it once at startup so a template bug
 * surfaces as a bounded startup failure instead of a plan-time surprise.
 */
export function assertWorkflowIntegrity() {
  const issues = [];
  for (const workflow of WORKFLOW_DEFINITIONS) {
    if (typeof workflow.id !== 'string' || !workflow.id || !WORKFLOW_BY_ID[workflow.id]) issues.push(`${workflow.id}: missing identity`);
    const stepKeys = new Set(workflow.steps.map((step) => step.step));
    if (stepKeys.size !== workflow.steps.length) issues.push(`${workflow.id}: duplicate step keys`);
    for (const step of workflow.steps) {
      if (step.kind === 'read_state') {
        if (step.operation !== 'workspace.project.read') issues.push(`${workflow.id}.${step.step}: read_state must use project.read`);
      } else if (step.kind === 'local') {
        // A local step is pure deterministic computation over the state the
        // read_state step already loaded: no operation, no approval, no cost
        // and no write can ever be attached to it.
        if (step.operation != null) issues.push(`${workflow.id}.${step.step}: local step must not declare an operation`);
        if (step.approval.length !== 0) issues.push(`${workflow.id}.${step.step}: local step must not declare approval`);
        if (step.cost !== false || step.write !== false) issues.push(`${workflow.id}.${step.step}: local step must be free and read-only`);
        if (step.fan_out != null || step.reuse != null) issues.push(`${workflow.id}.${step.step}: local step must not fan out or reuse`);
      } else if (step.kind === 'tool') {
        const definition = TOOL_DEFINITIONS[step.operation];
        if (!definition) issues.push(`${workflow.id}.${step.step}: unknown operation ${step.operation}`);
        else {
          if (![...definition.approval].every((scope) => APPROVAL_SCOPES.includes(scope))) issues.push(`${workflow.id}.${step.step}: unknown approval scope`);
          if (![...step.approval].every((scope) => APPROVAL_SCOPES.includes(scope))) issues.push(`${workflow.id}.${step.step}: unknown declared scope`);
          // 付费/写入标志由工具定义的批准范围派生（任何端点一致适用；
          // G1 generation.submit 同时声明 paid_external_calls 与 online_writes）。
          if (step.cost !== definition.approval.includes('paid_external_calls')) {
            issues.push(`${workflow.id}.${step.step}: cost flag inconsistent with operation`);
          }
          if (step.write !== definition.approval.includes('online_writes')) {
            issues.push(`${workflow.id}.${step.step}: write flag inconsistent with operation`);
          }
        }
      } else {
        issues.push(`${workflow.id}.${step.step}: unknown step kind ${step.kind}`);
      }
      for (const dependency of step.depends_on) {
        if (!stepKeys.has(dependency) || dependency === step.step) issues.push(`${workflow.id}.${step.step}: invalid dependency ${dependency}`);
      }
      if (step.fan_out) {
        if (!Number.isInteger(step.fan_out.max) || step.fan_out.max < 1 || step.fan_out.max > MAX_FAN_OUT) {
          issues.push(`${workflow.id}.${step.step}: fan-out bound out of range`);
        }
        if (typeof step.fan_out.source !== 'string' || !step.fan_out.source) issues.push(`${workflow.id}.${step.step}: fan-out source missing`);
        if (typeof step.fan_out.limit_slot !== 'string' || !step.fan_out.limit_slot) {
          issues.push(`${workflow.id}.${step.step}: fan-out limit slot missing`);
        } else if (!Object.hasOwn(workflow.slots, step.fan_out.limit_slot) || workflow.slots[step.fan_out.limit_slot].type !== 'integer') {
          issues.push(`${workflow.id}.${step.step}: fan-out limit slot must reference a declared integer slot`);
        }
      }
      if (step.gate != null && (typeof step.gate !== 'string' || !Object.hasOwn(workflow.slots, step.gate))) {
        issues.push(`${workflow.id}.${step.step}: gate must reference a declared slot`);
      }
    }
    for (const [slotKey, slot] of Object.entries(workflow.slots)) {
      if (!['string', 'boolean', 'integer', 'enum', 'identity', 'url'].includes(slot.type)) issues.push(`${workflow.id}.${slotKey}: unknown slot type`);
      if (slot.type === 'integer' && (!Number.isInteger(slot.min) || !Number.isInteger(slot.max) || slot.min > slot.max)) issues.push(`${workflow.id}.${slotKey}: invalid integer bounds`);
      if (slot.type === 'enum' && (!Array.isArray(slot.values) || slot.values.length === 0)) issues.push(`${workflow.id}.${slotKey}: enum values missing`);
      if ((slot.type === 'identity' || slot.type === 'url' || slot.type === 'string') && (!Number.isInteger(slot.max) || slot.max < 1)) issues.push(`${workflow.id}.${slotKey}: invalid string bound`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function lookupWorkflow(workflowId) {
  return WORKFLOW_BY_ID[workflowId] || null;
}
