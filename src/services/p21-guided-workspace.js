export const P21_VIEW_MODE_KEY = 'p21_research_view_mode_v1';
export const P21_VIEW_MODES = Object.freeze({ GUIDED: 'guided', FULL: 'full' });

const ORDERED_STEP_IDS = Object.freeze([
  'project',
  'evidence',
  'analysis',
  'card',
  'brief',
  'review',
  'handoff',
  'lineage',
]);

const PANEL_BY_STEP = Object.freeze({
  project: 'project',
  evidence: 'evidence',
  analysis: 'analysis',
  card: 'card',
  brief: 'brief',
  review: 'brief',
  handoff: 'handoff',
  lineage: 'lineage',
});

export function normalizeP21ViewMode(value) {
  return value === P21_VIEW_MODES.FULL ? P21_VIEW_MODES.FULL : P21_VIEW_MODES.GUIDED;
}

export function panelIdForP21Step(stepId) {
  return PANEL_BY_STEP[stepId] || 'project';
}

export function deriveP21GuidedState({ workflow, project, requestedStep = null } = {}) {
  const steps = Array.isArray(workflow?.steps)
    ? workflow.steps.filter((step) => step && ORDERED_STEP_IDS.includes(step.id))
    : [];
  const byId = new Map(steps.map((step) => [step.id, step]));

  if (!project || steps.length === 0) {
    return {
      recommended_step_id: 'project',
      active_step_id: 'project',
      active_panel_id: 'project',
      label: '创建研究项目',
      guidance: '先创建一个研究项目，再按证据、分析、知识卡和 Brief 的顺序推进。',
      complete: false,
      archived: false,
    };
  }

  const archived = project.status === 'archived';
  const recommended = archived
    ? (byId.get('lineage') || byId.get('project'))
    : steps.find((step) => !step.done && step.id !== 'lineage')
      || byId.get('lineage')
      || steps[steps.length - 1];
  const requested = typeof requestedStep === 'string' ? byId.get(requestedStep) : null;
  const active = requested || recommended;
  const blocking = Array.isArray(active?.blocking) ? active.blocking.filter(Boolean) : [];
  const complete = !archived && steps
    .filter((step) => step.id !== 'lineage')
    .every((step) => step.done);

  return {
    recommended_step_id: recommended?.id || 'project',
    active_step_id: active?.id || 'project',
    active_panel_id: panelIdForP21Step(active?.id),
    label: archived ? '查看已归档项目' : (active?.label || '研究项目'),
    guidance: archived
      ? '项目已归档并保持只读；可查看完整链路和世系审计。'
      : complete
        ? '研究链已完成；请在完整视图中复核全部证据和交接内容。'
        : (blocking[0] || '当前步骤可以继续操作。'),
    complete,
    archived,
  };
}
