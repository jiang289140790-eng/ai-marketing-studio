import { useEffect, useMemo, useState } from 'react';
import { contextResultToPrompt, generateContextAI } from '../services/context-ai-service';

const MODES = [
  ['rewrite_copy', '优化当前文案'],
  ['generate_hook', '生成 Hook'],
  ['generate_image_prompt', '生成图片提示词'],
  ['generate_video_script', '生成视频脚本'],
  ['generate_lora_prompt', '补全角色 / LoRA'],
  ['generate_strategy', '生成内容策略'],
  ['viral_analysis_prompt', '爆款分析 Prompt 模板'],
  ['x_copy_prompt', 'X 文案 Prompt 模板'],
  ['image_prompt_template', '图片 Prompt 模板'],
  ['video_script_prompt', '视频脚本 Prompt 模板'],
  ['lora_character_prompt', 'LoRA 角色 Prompt 模板'],
  ['account_persona_prompt', '账号画像 Prompt 模板'],
];

const MODE_LABELS = Object.fromEntries(MODES);

export function ContextAIBox({
  open,
  mode = 'rewrite_copy',
  context = {},
  onApply,
  onClose,
  onSavePrompt,
}) {
  const [selectedMode, setSelectedMode] = useState(mode);
  const [model, setModel] = useState('qwen-plus');
  const [instruction, setInstruction] = useState('');
  const [state, setState] = useState({ status: 'idle', data: null, error: '' });
  const result = state.data?.result;
  const contextSummary = useMemo(() => ({
    title: context.content_title || context.current_copy?.title || '未命名内容',
    platform: context.platform || '未指定',
    character: context.character?.display_name || context.character?.name || '未选择',
    lora: context.lora?.name || context.lora?.model || context.lora?.filename || context.lora || '未选择',
  }), [context]);

  useEffect(() => {
    if (!open) return;
    setSelectedMode(mode);
    setState({ status: 'idle', data: null, error: '' });
  }, [mode, open]);

  if (!open) return null;

  async function handleGenerate() {
    setState({ status: 'generating', data: null, error: '' });
    try {
      const data = await generateContextAI({
        mode: selectedMode,
        context,
        userInstruction: instruction,
        model,
      });
      setState({ status: 'success', data, error: '' });
    } catch (error) {
      setState({ status: 'failed', data: null, error: friendlyError(error) });
    }
  }

  async function handleCopy() {
    if (!result) return;
    await globalThis.navigator?.clipboard?.writeText(JSON.stringify(result, null, 2));
  }

  return (
    <div className="context-ai-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <section className="context-ai-box" role="dialog" aria-modal="true" aria-label="Context AI">
        <header className="context-ai-header">
          <div>
            <p className="eyebrow">QWEN CONTEXT AI</p>
            <h2>{MODE_LABELS[selectedMode] || 'Context AI'}</h2>
            <p>模型会读取当前内容、策略、账号、角色、LoRA 与参考素材；点击“应用”前不会覆盖原内容。</p>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>关闭</button>
        </header>

        <div className="context-ai-summary">
          <span><small>内容</small>{contextSummary.title}</span>
          <span><small>平台</small>{contextSummary.platform}</span>
          <span><small>角色</small>{contextSummary.character}</span>
          <span><small>LoRA</small>{String(contextSummary.lora)}</span>
        </div>

        {(!context.character || !context.lora) && (
          <div className="notice">当前未完整选择角色或 LoRA，系统仍可生成通用提示词，但人物一致性会较弱。</div>
        )}

        <div className="context-ai-controls">
          <label>
            生成类型
            <select value={selectedMode} onChange={(event) => setSelectedMode(event.target.value)}>
              {MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            模型
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="qwen-plus">Qwen Plus（默认）</option>
              <option value="qwen-max">Qwen Max</option>
              <option value="qwen3.6-plus">Qwen 3.6 Plus</option>
              <option value="deepseek-chat">DeepSeek Chat（保留）</option>
            </select>
          </label>
          <label className="wide-field">
            补充要求
            <textarea
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="例如：更口语化，适合 X，避免夸张承诺，输出 9:16 视频脚本。"
            />
          </label>
        </div>

        <div className="button-row">
          <button className="primary-button" type="button" onClick={handleGenerate} disabled={state.status === 'generating'}>
            {state.status === 'generating' ? '生成中…' : result ? '重新生成' : '开始生成'}
          </button>
          {result && <button className="ghost-button" type="button" onClick={handleCopy}>复制结果</button>}
          {result && onApply && <button className="ghost-button" type="button" onClick={() => onApply(result, { mode: selectedMode, model })}>应用到当前内容</button>}
          {result && onSavePrompt && (
            <button className="ghost-button" type="button" onClick={() => onSavePrompt(contextResultToPrompt(result, {
              title: `${MODE_LABELS[selectedMode]} · ${contextSummary.title}`,
              platform: context.platform || null,
              character: context.character?.id || null,
            }))}>
              保存到 Prompt 库
            </button>
          )}
        </div>

        {state.error && <div className="notice error">{state.error}</div>}
        {result && (
          <div className="context-ai-result">
            <div className="section-head"><h3>生成结果</h3><span className="tag">{state.data.provider} · {state.data.model}</span></div>
            <ResultFields value={result} />
          </div>
        )}
      </section>
    </div>
  );
}

function ResultFields({ value }) {
  return (
    <div className="context-ai-result-grid">
      {Object.entries(value || {}).map(([key, item]) => (
        <div className={typeof item === 'string' && item.length > 100 ? 'wide' : ''} key={key}>
          <small>{key}</small>
          {typeof item === 'object'
            ? <pre>{JSON.stringify(item, null, 2)}</pre>
            : <p>{String(item ?? '')}</p>}
        </div>
      ))}
    </div>
  );
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const lower = message.toLowerCase();
  if (lower.includes('dashscope_api_key') || lower.includes('provider_auth')) return '千问密钥尚未在 Supabase Edge Function Secrets 中配置，或密钥无效。';
  if (lower.includes('quota') || lower.includes('balance') || lower.includes('billing')) return '千问额度不足或计费状态异常，请检查阿里百炼控制台。';
  if (lower.includes('model')) return '当前千问模型不可用，请改用 qwen-plus，或检查模型授权。';
  if (lower.includes('timeout')) return '千问响应超时，请稍后重试或缩短生成要求。';
  return message || '生成失败，请稍后重试。';
}
