import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCharacterReadiness } from '../src/utils/character-generation-readiness.js';

const emma = {
  id: 'emma',
  name: 'Emma',
  appearance: 'warm lifestyle character',
  prompt_templates: { image_gen: 'emma_s1 portrait' },
  lora_info: {
    name: 'Emma S1 SDXL LoRA',
    version: '0.1',
    base_model: 'SDXL 1.0 Base',
    trigger_word: 'emma_s1',
    recommended_weight: 0.8,
    weight_range: [0.7, 0.9],
    status: 'validated',
    autodl_path: '/models/emma.safetensors',
  },
  recommended_workflows: [{ workflow_id: 'emma_s1_sdxl_t2i_v01', status: 'validated' }],
};

test('Emma 在 LoRA、工作流、测试与验证图齐备时可生成', () => {
  const result = evaluateCharacterReadiness(emma, {
    workflows: [{ id: 'workflow', name: 'emma_s1_sdxl_t2i_v01', status: 'active' }],
    runs: [{ id: 'run', character_id: 'emma', status: 'success', asset_ids: ['asset'] }],
    assets: [{ id: 'asset', thumbnail: 'image.png', approvedForPublishing: true }],
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.lora.trigger_word, 'emma_s1');
  assert.equal(result.lora.recommended_weight, 0.8);
  assert.deepEqual(result.lora.weight_range, [0.7, 0.9]);
});

test('Nina Voss 没有 LoRA 时明确显示 LoRA 不可用', () => {
  const result = evaluateCharacterReadiness({
    id: 'nina',
    name: 'Nina Voss',
    avatar: 'nina.png',
    appearance: 'photorealistic',
    prompt: 'Nina lifestyle creator',
    lora_info: {},
  });
  assert.equal(result.state, 'lora_unavailable');
  assert.match(result.blocking, /LoRA/);
});

test('有 LoRA 但无启用工作流时显示工作流不可用', () => {
  const result = evaluateCharacterReadiness(emma, {
    workflows: [{ name: 'emma_s1_sdxl_t2i_v01', status: 'disabled' }],
  });
  assert.equal(result.state, 'workflow_unavailable');
});

