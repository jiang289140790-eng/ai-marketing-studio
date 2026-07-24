const DEFAULT_LORA = {
  name: '',
  model: '',
  version: '',
  filename: '',
  weight: 0.8,
  trigger_words: '',
  workflow: '',
  image_enabled: true,
  video_enabled: true,
};

export function parseLoraConfig(value) {
  if (!value) return { ...DEFAULT_LORA };
  if (typeof value === 'object') return { ...DEFAULT_LORA, ...value };

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...DEFAULT_LORA, ...parsed };
    }
  } catch {
    // Legacy records stored the LoRA name directly as plain text.
  }

  return { ...DEFAULT_LORA, name: String(value), model: String(value) };
}

export function serializeLoraConfig(value) {
  const config = parseLoraConfig(value);
  const hasReference = Boolean(config.name || config.model || config.filename);
  if (!hasReference) return null;

  return JSON.stringify({
    name: config.name?.trim() || '',
    model: config.model?.trim() || '',
    version: config.version?.trim() || '',
    filename: config.filename?.trim() || '',
    weight: normalizeWeight(config.weight),
    trigger_words: config.trigger_words?.trim() || '',
    workflow: config.workflow?.trim() || '',
    image_enabled: Boolean(config.image_enabled),
    video_enabled: Boolean(config.video_enabled),
  });
}

export function hasLoraConfig(value) {
  const config = parseLoraConfig(value);
  return Boolean(config.name || config.model || config.filename);
}

export function loraDisplayName(value) {
  const config = parseLoraConfig(value);
  return config.name || config.model || config.filename || '未绑定 LoRA';
}

function normalizeWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LORA.weight;
  return Math.min(2, Math.max(0, number));
}
