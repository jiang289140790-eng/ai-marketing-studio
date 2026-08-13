import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  P21_VIEW_MODES,
  deriveP21GuidedState,
  normalizeP21ViewMode,
  panelIdForP21Step,
} from '../src/services/p21-guided-workspace.js';

const ROOT = join(import.meta.dirname, '..');
const STEP_IDS = ['project', 'evidence', 'analysis', 'card', 'brief', 'review', 'handoff', 'lineage'];

function workflowThrough(lastDone) {
  const boundary = STEP_IDS.indexOf(lastDone);
  return {
    steps: STEP_IDS.map((id, index) => ({
      id,
      label: id,
      done: id === 'lineage' || index <= boundary,
      blocking: id === 'lineage' || index <= boundary ? [] : [`complete ${STEP_IDS[index - 1]}`],
    })),
  };
}

test('P21 defaults to guided mode and only accepts the explicit full mode', () => {
  assert.equal(normalizeP21ViewMode(undefined), P21_VIEW_MODES.GUIDED);
  assert.equal(normalizeP21ViewMode('unexpected'), P21_VIEW_MODES.GUIDED);
  assert.equal(normalizeP21ViewMode(P21_VIEW_MODES.FULL), P21_VIEW_MODES.FULL);
  assert.equal(panelIdForP21Step('review'), 'brief');
  assert.equal(panelIdForP21Step('unknown'), 'project');
});

test('P21 recommends the first incomplete deterministic workflow step', () => {
  const project = { status: 'active' };
  const cases = [
    ['project', 'evidence'],
    ['evidence', 'analysis'],
    ['analysis', 'card'],
    ['card', 'brief'],
    ['brief', 'review'],
    ['review', 'handoff'],
    ['handoff', 'lineage'],
  ];

  for (const [lastDone, expected] of cases) {
    const state = deriveP21GuidedState({ workflow: workflowThrough(lastDone), project });
    assert.equal(state.recommended_step_id, expected, `${lastDone} should lead to ${expected}`);
    assert.equal(state.active_step_id, expected);
    assert.equal(state.active_panel_id, panelIdForP21Step(expected));
  }
});

test('P21 preserves the recommendation while allowing an explicit panel inspection', () => {
  const state = deriveP21GuidedState({
    workflow: workflowThrough('evidence'),
    project: { status: 'active' },
    requestedStep: 'project',
  });
  assert.equal(state.recommended_step_id, 'analysis');
  assert.equal(state.active_step_id, 'project');
  assert.equal(state.active_panel_id, 'project');
});

test('P21 fails safely to project setup and sends archived projects to lineage', () => {
  const empty = deriveP21GuidedState({ workflow: null, project: null });
  assert.equal(empty.recommended_step_id, 'project');
  assert.equal(empty.active_step_id, 'project');
  assert.equal(empty.active_panel_id, 'project');
  assert.equal(empty.complete, false);
  assert.equal(empty.archived, false);

  const archived = deriveP21GuidedState({
    workflow: workflowThrough('review'),
    project: { status: 'archived' },
  });
  assert.equal(archived.recommended_step_id, 'lineage');
  assert.equal(archived.active_panel_id, 'lineage');
  assert.equal(archived.archived, true);
});

test('P21 guidance is preserved as a lightweight next-step hint bound to P36 destinations', async () => {
  const page = await readFile(join(ROOT, 'src/pages/ResearchWorkspacePage.jsx'), 'utf8');
  const destinations = await readFile(join(ROOT, 'src/components/integrated-workspace/P36ResearchDestinations.jsx'), 'utf8');
  // P21 引导逻辑保留：推荐步骤 → 目的地映射，作为目的地导航区的轻量提示；
  // 七步长链与引导/完整视图切换由四目的地导航取代。
  assert.match(page, /deriveP21GuidedState\(\{ workflow, project \}\)/);
  assert.match(page, /recommendedDestination=\{recommendedDestination\}/);
  assert.match(page, /recommendedLabel=\{guidedState\.label\}/);
  assert.match(destinations, /建议下一步：\{recommendedLabel\}/);
  assert.match(destinations, /if \(stepId === 'analysis' \|\| stepId === 'card'\) return P36_DESTINATIONS\.ANALYZE/);
  assert.match(destinations, /if \(stepId === 'brief' \|\| stepId === 'review' \|\| stepId === 'handoff' \|\| stepId === 'lineage'\) return P36_DESTINATIONS\.OUTPUTS/);
  assert.match(destinations, /role: 'tablist'/);
  assert.match(destinations, /data-destination-tab=\{meta\.id\}/);
});

test('P21 helper remains local-only and cannot activate execution capabilities', async () => {
  const source = await readFile(join(ROOT, 'src/services/p21-guided-workspace.js'), 'utf8');
  for (const forbidden of [
    'fetch(',
    'supabase',
    'service_role',
    'model_invocation',
    'provider_selection',
    'workflow_selection',
    'publish_executed: true',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden capability marker: ${forbidden}`);
  }
});
