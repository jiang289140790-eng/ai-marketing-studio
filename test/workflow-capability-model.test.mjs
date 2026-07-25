import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkflowCapability,
  deriveModelAssets,
} from '../src/utils/workflow-capability-model.js';

const workflow = {
  id: 'wf-emma',
  name: 'emma_s1_sdxl_t2i_v01',
  mode: 'image',
  status: 'active',
  model: 'sdxl',
  checkpoint: 'SDXL/sd_xl_base_1.0.safetensors',
  loras: [{ name: 'emma.safetensors' }],
  default_params: { prompt_template_id: 'prompt-emma' },
  input_schema: { required: ['prompt', 'lora_name'] },
};

test('builds real workflow capability without duplicating role LoRA assets', () => {
  const capability = buildWorkflowCapability(workflow, {
    characters: [{
      id: 'emma',
      display_name: 'Emma',
      recommended_workflows: [{ id: 'wf-emma', provider: 'autodl' }],
    }],
    prompts: [{ id: 'prompt-emma', title: 'Emma 图片模板' }],
    runs: [{
      workflow_id: 'wf-emma',
      status: 'success',
      created_at: '2026-07-25T10:00:00Z',
      completed_at: '2026-07-25T10:00:10Z',
      cost: 0,
    }],
  });

  assert.equal(capability.provider, 'autodl');
  assert.equal(capability.supportsLora, true);
  assert.equal(capability.availabilityStatus, 'validated');
  assert.equal(capability.boundCharacters[0].display_name, 'Emma');
  assert.equal(capability.boundPrompts[0].title, 'Emma 图片模板');
  assert.equal(capability.averageDurationMs, 10000);
});

test('derives only generic model dependencies, not workflow LoRA entries', () => {
  const models = deriveModelAssets([workflow]);
  assert.equal(models.length, 1);
  assert.match(models[0].name, /sd_xl_base/);
  assert.equal(models.some((item) => item.name.includes('emma')), false);
});

