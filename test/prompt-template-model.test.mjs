import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPromptVariables,
  renderPromptTemplate,
  calculatePromptSuccessRate,
} from '../src/utils/prompt-template-model.js';

test('extracts prompt variables once and provides business descriptions', () => {
  const variables = extractPromptVariables('{{character_trigger}} on {{platform}} with {{character_trigger}}');
  assert.deepEqual(variables.map((item) => item.name), ['character_trigger', 'platform']);
  assert.equal(variables[0].label, '角色触发词');
});

test('renders a prompt template with provided and default examples', () => {
  const result = renderPromptTemplate('{{character_trigger}} at {{location}}', {
    character_trigger: 'emma_s1',
  });
  assert.match(result, /emma_s1/);
  assert.match(result, /雨后霓虹街道/);
});

test('calculates success rate from real workflow statuses', () => {
  assert.equal(calculatePromptSuccessRate([{ status: 'success' }, { status: 'failed' }]), 50);
  assert.equal(calculatePromptSuccessRate([]), null);
});

