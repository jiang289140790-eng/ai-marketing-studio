import { useState } from 'react';
import { accountCategories, contentTypes, platforms } from '../data/navigation';
import { createMarketingDraft, generateImage, generateText, generateVideo } from '../services/ai-service';
import { createContentItem } from '../services/content-service';
import { isSupabaseConfigured } from '../services/supabase-client';

export function AIStudio({ userId }) {
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState(null);
  const [form, setForm] = useState({
    topic: '',
    audience: '',
    goal: '提升互动与转化',
    platform: 'X',
    contentType: 'text',
    accountCategory: 'brand',
    tone: '专业、清晰、有行动号召',
    keyPoints: '',
  });

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function callReservedAdapter(adapter) {
    try {
      await adapter();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function handleCreateDraft() {
    const nextDraft = createMarketingDraft(form);
    setDraft(nextDraft);
    setMessage('已生成本地营销草稿。确认后可保存到内容库。');
  }

  async function handleSaveDraft() {
    if (!draft || !userId || !isSupabaseConfigured) return;

    try {
      await createContentItem(userId, draft);
      setMessage('已保存到内容库。');
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">AI Studio</p>
          <h2>AI生成</h2>
          <p>先做 UI 和服务接口占位，后续可接 GPT、Claude、Qwen、ComfyUI 和 n8n。</p>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}

      <div className="form-card">
        <div className="form-grid">
          <label>
            主题
            <input value={form.topic} onChange={(event) => update('topic', event.target.value)} placeholder="例如：AI 自动化内容生产" />
          </label>
          <label>
            目标受众
            <input value={form.audience} onChange={(event) => update('audience', event.target.value)} placeholder="例如：独立创作者、小型电商品牌" />
          </label>
          <label>
            营销目标
            <input value={form.goal} onChange={(event) => update('goal', event.target.value)} />
          </label>
          <label>
            平台
            <select value={form.platform} onChange={(event) => update('platform', event.target.value)}>
              {platforms.map((platform) => (
                <option key={platform} value={platform}>
                  {platform}
                </option>
              ))}
            </select>
          </label>
          <label>
            内容类型
            <select value={form.contentType} onChange={(event) => update('contentType', event.target.value)}>
              {contentTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            账号分类
            <select value={form.accountCategory} onChange={(event) => update('accountCategory', event.target.value)}>
              {accountCategories.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            语气
            <input value={form.tone} onChange={(event) => update('tone', event.target.value)} />
          </label>
          <label className="wide-field">
            关键要点
            <textarea value={form.keyPoints} onChange={(event) => update('keyPoints', event.target.value)} placeholder="每行一个要点" />
          </label>
        </div>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={handleCreateDraft}>
            生成营销草稿
          </button>
          <button className="ghost-button" type="button" onClick={handleSaveDraft} disabled={!draft || !userId || !isSupabaseConfigured}>
            保存到内容库
          </button>
        </div>
      </div>

      {draft && (
        <article className="detail-panel">
          <p className="eyebrow">Generated Draft</p>
          <h3>{draft.title}</h3>
          <p className="draft-preview">{draft.content_text}</p>
        </article>
      )}

      <div className="studio-grid">
        <article className="generator-card">
          <span>Text</span>
          <h3>文本生成</h3>
          <textarea placeholder="输入主题、产品、受众和平台要求" />
          <button type="button" className="primary-button" onClick={() => callReservedAdapter(generateText)}>
            预留 generateText()
          </button>
        </article>
        <article className="generator-card">
          <span>Image</span>
          <h3>图片生成</h3>
          <textarea placeholder="描述画面、风格、比例和品牌要求" />
          <button type="button" className="primary-button" onClick={() => callReservedAdapter(generateImage)}>
            预留 generateImage()
          </button>
        </article>
        <article className="generator-card">
          <span>Video</span>
          <h3>视频生成</h3>
          <textarea placeholder="输入短视频脚本、镜头、时长和平台" />
          <button type="button" className="primary-button" onClick={() => callReservedAdapter(generateVideo)}>
            预留 generateVideo()
          </button>
        </article>
      </div>
    </section>
  );
}
