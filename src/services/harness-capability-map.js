// Browser-safe mirror of the approved server workflow catalog. A contract test
// compares these exact ids with the server catalog to prevent UI drift.
export const HARNESS_CAPABILITY_MAP = Object.freeze([
  { id: 'read_capability', label: '查看当前项目与能力', route: 'ai', mode: 'read' },
  { id: 'collect_analyze_evidence', label: '采集并分析公开来源', route: 'research', mode: 'paid-write' },
  { id: 'inspect_private_attachments', label: '理解私有图片、视频与文档', route: 'ai', mode: 'paid-write' },
  { id: 'search_x', label: '搜索 X 热门主题', route: 'research', mode: 'paid' },
  { id: 'search_reddit', label: '搜索 Reddit 热门主题', route: 'research', mode: 'paid' },
  { id: 'search_x_reddit', label: '跨平台主题搜索', route: 'research', mode: 'paid-write' },
  { id: 'analyze_evidence', label: '分析已保存 Evidence', route: 'research', mode: 'paid-write' },
  { id: 'compare_project', label: '比较项目来源与规律', route: 'research', mode: 'read' },
  { id: 'generate_similar', label: '生成相似内容草案', route: 'research', mode: 'read' },
  { id: 'assemble_brief', label: '生成待审核 Brief', route: 'research', mode: 'write' },
  { id: 'lineage_audit', label: '审计 Evidence 到 Brief 来源链', route: 'knowledge', mode: 'read' },
  { id: 'create_handoff', label: '创建人工审核交接包', route: 'research', mode: 'write' },
  { id: 'generate_media', label: '报价并生成图片或视频', route: 'generation', mode: 'paid-write' },
  { id: 'read_generation', label: '查看生成状态与成品', route: 'generation', mode: 'read' },
]);

export const HARNESS_CAPABILITY_IDS = Object.freeze(HARNESS_CAPABILITY_MAP.map((item) => item.id));

export function capabilityModeLabel(mode) {
  if (mode === 'paid-write') return '付费 · 写入 staging · 逐项批准';
  if (mode === 'paid') return '可能付费 · 逐项批准';
  if (mode === 'write') return '写入 staging · 逐项批准';
  return '只读';
}
