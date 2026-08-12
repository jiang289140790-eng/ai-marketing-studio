import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  generateFromBrief,
  reviseContent,
  saveContentDraft,
  resolveIntent,
  generateQuickContentV2,
  saveContentDraftV2,
  loadDraftById,
} from '../../services/content-creation-service';
import { createP22ResearchAssistClient } from '../../services/p22-research-assist';
import { isSupabaseConfigured } from '../../services/supabase-client';
import { CreationIntentSummary } from './CreationIntentSummary';

const MAX_INPUT_LENGTH = 500;
const MAX_REVISE_LENGTH = 500;
const MAX_REVISE_ROUNDS = 5;
const MAX_REFERENCE_TEXT_LENGTH = 2000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MiB per spec
const MAX_IMAGE_DIMENSION = 4096;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// MIME file signature (magic bytes) for strict validation
const IMAGE_SIGNATURES = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF
};

/**
 * Read the first N bytes of a File and verify against known MIME signatures.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
async function validateFileSignature(file) {
  const signatures = IMAGE_SIGNATURES[file.type];
  if (!signatures) return { ok: false, reason: `不支持的图片格式：${file.type}` };
  const maxLen = Math.max(...signatures.map((s) => s.length));
  const buffer = new Uint8Array(await file.slice(0, maxLen).arrayBuffer());
  const match = signatures.some((sig) =>
    sig.every((byte, i) => buffer[i] === byte)
  );
  if (!match) return { ok: false, reason: '文件签名与声明的 MIME 类型不匹配。' };
  return { ok: true };
}

/**
 * Attempt to decode a Data URL as an Image to verify it's a valid, decodable image.
 * Returns { ok: true, width, height } or { ok: false, reason: string }.
 */
function decodeImageFromDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new globalThis.Image();
    const timer = globalThis.setTimeout(() => {
      img.src = '';
      resolve({ ok: false, reason: '图片解码超时。' });
    }, 8000);
    img.onload = () => {
      globalThis.clearTimeout(timer);
      resolve({ ok: true, width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      globalThis.clearTimeout(timer);
      resolve({ ok: false, reason: '图片无法解码，文件可能已损坏。' });
    };
    img.src = dataUrl;
  });
}

/**
 * Convert a File to a bounded Data URL. Validates MIME, size, signature, and decodability.
 * Returns { ok: true, dataUrl, width, height } or { ok: false, reason: string }.
 */
async function fileToImageDataUrl(file) {
  if (!file) return { ok: false, reason: '未选择文件。' };
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return { ok: false, reason: `不支持的图片格式：${file.type || '未知'}。仅支持 JPEG、PNG、WebP。` };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MiB。` };
  }

  // Verify file signature
  const sigCheck = await validateFileSignature(file);
  if (!sigCheck.ok) return sigCheck;

  // Read full file into Data URL
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const dataUrl = `data:${file.type};base64,${globalThis.btoa(binary)}`;

  // Verify the Data URL decodes as a valid image
  const decodeCheck = await decodeImageFromDataUrl(dataUrl);
  if (!decodeCheck.ok) return decodeCheck;
  if (decodeCheck.width > MAX_IMAGE_DIMENSION || decodeCheck.height > MAX_IMAGE_DIMENSION) {
    return {
      ok: false,
      reason: `图片宽高均不能超过 ${MAX_IMAGE_DIMENSION}px。`,
    };
  }

  return { ok: true, dataUrl, width: decodeCheck.width, height: decodeCheck.height };
}

/**
 * P31 v2 参考驱动内容创建面板。
 *
 * Props:
 * - mode: 'quick' | 'brief'
 * - brief: object | null (仅 brief 模式)
 * - userId: string
 * - onNavigate: function
 * - onDraftCountChange: function(number)
 * - onPrepareImage: function({ draftId, title, visualPlan, aspectRatio }) - 制作图片回调
 */
export function ContentCreationModePanel({ mode, brief, userId, onNavigate: _onNavigate, onDraftCountChange, onPrepareImage }) {
  // 输入状态
  const [inputText, setInputText] = useState('');
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);

  // P31 v2 参考输入
  const [referenceUrl, setReferenceUrl] = useState('');
  const [referenceText, setReferenceText] = useState('');
  const [referenceImage, setReferenceImage] = useState(null); // File 对象
  const [referenceImageMeta, setReferenceImageMeta] = useState(null); // 元数据
  const [referenceImageDataUrl, setReferenceImageDataUrl] = useState(null); // 有界 Data URL（仅内存，不持久化）
  const [showReferenceInputs, setShowReferenceInputs] = useState(false);
  const [collectingUrl, setCollectingUrl] = useState(false);
  const [collectedUrlData, setCollectedUrlData] = useState(null);
  const [collectUrlError, setCollectUrlError] = useState('');

  // P31 v2 意图与生成阶段
  const [phase, setPhase] = useState('input'); // input → intent → generate → result
  const [intent, setIntent] = useState(null);
  const [intentSummary, setIntentSummary] = useState('');
  const [resolvingIntent, setResolvingIntent] = useState(false);

  // 生成结果（v2）
  const [result, setResult] = useState(null); // { data, meta, summary }
  const [editableTitle, setEditableTitle] = useState('');
  const [editableCopy, setEditableCopy] = useState('');
  const [editableVisual, setEditableVisual] = useState('');
  const [showCandidates, setShowCandidates] = useState(false);
  const [showFullDetails, setShowFullDetails] = useState(false);

  // 修改状态（v1 兼容）
  const [reviseFeedback, setReviseFeedback] = useState('');
  const [reviseHistory, setReviseHistory] = useState([]);

  // 保存
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState(null);
  const [savedDraft, setSavedDraft] = useState(null); // 完整草稿对象
  const [loadingDraft, setLoadingDraft] = useState(false);

  const inputRef = useRef(null);

  // Brief 模式：显示 brief 摘要
  const briefSummaryDisplay = useMemo(() => {
    if (mode !== 'brief' || !brief) return null;
    let status = '';
    if (brief.status === 'approved') status = '已批准';
    else if (brief.status === 'pending') status = '待审批';
    else if (brief.status === 'returned') status = '已退回';
    else if (brief.status === 'stale') status = '已过期';
    else status = brief.status || '未知';
    return {
      id: brief.id,
      name: brief.name || brief.title || '未命名简报',
      status,
      statusApproved: brief.status === 'approved',
      summary: brief.summary || brief.description || '暂无摘要',
      version: brief.version || null,
      fingerprint: brief.fingerprint || null,
      schemaVersion: brief.schema_version || null,
      knowledgeCitationIds: Array.isArray(brief.knowledge_citation_ids) ? brief.knowledge_citation_ids : [],
      evidenceProvenance: brief.evidence_provenance && typeof brief.evidence_provenance === 'object'
        ? brief.evidence_provenance
        : {},
    };
  }, [mode, brief]);

  // 自动聚焦输入框
  useEffect(() => {
    if (mode === 'quick' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [mode]);

  // 重置状态当模式/phase 切换时
  useEffect(() => {
    setInputText('');
    setError('');
    setResult(null);
    setShowCandidates(false);
    setShowFullDetails(false);
    setReviseFeedback('');
    setReviseHistory([]);
    setSaving(false);
    setSavedId(null);
    setSavedDraft(null);
    setGenerating(false);

    // P31 v2 重置
    setReferenceUrl('');
    setReferenceText('');
    setReferenceImage(null);
    setReferenceImageMeta(null);
    setReferenceImageDataUrl(null);
    setShowReferenceInputs(false);
    setCollectingUrl(false);
    setCollectedUrlData(null);
    setCollectUrlError('');
    setPhase('input');
    setIntent(null);
    setIntentSummary('');
    setResolvingIntent(false);
  }, [mode, brief?.id]);

  // ---- 参考图片处理（完整验证链：MIME、大小、签名、解码）----
  const handleImageSelect = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError('');
    const result = await fileToImageDataUrl(file);
    if (!result.ok) {
      setError(result.reason);
      // 重置文件 input 以便用户重新选择
      event.target.value = '';
      return;
    }

    setReferenceImage(file);
    setReferenceImageDataUrl(result.dataUrl);
    setReferenceImageMeta({
      mime_type: file.type,
      byte_size: file.size,
      name: file.name,
      width: result.width,
      height: result.height,
    });
    setError('');
  }, []);

  // ---- P22 URL 采集 ----
  const handleCollectUrl = useCallback(async () => {
    const trimmed = referenceUrl.trim();
    if (!trimmed) {
      setCollectUrlError('请先输入 X 链接。');
      return;
    }

    // 验证 URL 模式
    const match = trimmed.match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i);
    if (!match) {
      setCollectUrlError('请输入有效的 X/Twitter status HTTPS 链接。');
      return;
    }

    setCollectUrlError('');
    setCollectingUrl(true);
    try {
      const client = createP22ResearchAssistClient();
      const response = await client.collectUrl(trimmed);
      setCollectedUrlData({
        url: trimmed,
        content_text: response?.data?.content_text || response?.content_text || '',
        content_sha256: response?.data?.content_sha256 || response?.content_sha256 || '',
        collected_at: response?.data?.collected_at || new Date().toISOString(),
        source_id: response?.data?.source_id || response?.data?.id || '',
      });
    } catch (err) {
      setCollectUrlError(err?.message || 'X 链接采集失败，请检查链接或稍后重试。');
      setCollectedUrlData(null);
    } finally {
      setCollectingUrl(false);
    }
  }, [referenceUrl]);

  // ---- resolveIntent ----
  const handleResolveIntent = useCallback(async () => {
    const trimmed = inputText.trim();
    if (!trimmed) {
      setError('请输入你想要生成的内容需求。');
      return;
    }
    if (trimmed.length > MAX_INPUT_LENGTH) {
      setError(`输入不能超过 ${MAX_INPUT_LENGTH} 个字符。`);
      return;
    }
    if (!isSupabaseConfigured) {
      setError('数据服务未配置，无法生成内容。');
      return;
    }
    if (!userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setResolvingIntent(true);
    setPhase('intent');
    try {
      const options = {};
      if (referenceUrl && collectedUrlData) {
        options.referenceUrl = referenceUrl;
        options.referenceUrlData = collectedUrlData;
      }
      if (referenceText.trim()) {
        options.referenceText = referenceText.trim();
      }
      if (referenceImage && referenceImageDataUrl) {
        options.image_data_url = referenceImageDataUrl;
      }

      const response = await resolveIntent(trimmed, options);
      setIntent(response.data.intent);
      setIntentSummary(response.data.summary || '');
    } catch (err) {
      setError(err?.message || '意图解析失败，请稍后重试。');
      setPhase('input');
    } finally {
      setResolvingIntent(false);
    }
  }, [inputText, userId, referenceUrl, referenceText, referenceImage, referenceImageDataUrl, collectedUrlData]);

  // ---- v2 生成 ----
  const handleV2Generate = useCallback(async () => {
    if (!intent) {
      setError('请先解析意图。');
      return;
    }
    if (!isSupabaseConfigured || !userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setGenerating(true);
    setPhase('generate');
    try {
      const options = {};
      if (referenceText.trim()) options.referenceText = referenceText.trim();
      if (collectedUrlData) options.referenceUrlData = collectedUrlData;
      if (referenceImage && referenceImageDataUrl) options.image_data_url = referenceImageDataUrl;

      const response = await generateQuickContentV2(inputText.trim(), intent, options);
      setResult({ data: response.data, meta: response.meta, summary: response.data?.summary || '' });
      setEditableTitle(response.data?.title || '');
      setEditableCopy(response.data?.main_copy || '');
      setEditableVisual(response.data?.visual_description || '');
      setPhase('result');
    } catch (err) {
      setError(err?.message || '内容生成失败，请稍后重试。');
      setPhase('intent'); // 回到意图编辑
    } finally {
      setGenerating(false);
    }
  }, [inputText, intent, userId, referenceText, referenceImage, referenceImageDataUrl, collectedUrlData]);

  // ---- v1 Brief 生成 ----
  const handleBriefGenerate = useCallback(async () => {
    if (!briefSummaryDisplay) {
      setError('无法读取简报信息。');
      return;
    }
    if (!briefSummaryDisplay.statusApproved) {
      setError(`简报状态为「${briefSummaryDisplay.status}」，只有已批准的简报才能生成内容。`);
      return;
    }
    if (!isSupabaseConfigured) {
      setError('数据服务未配置，无法生成内容。');
      return;
    }
    if (!userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setGenerating(true);
    try {
      const response = await generateFromBrief(brief);
      setResult({ data: response.data, meta: response.meta, summary: response.data?.summary || '' });
      setShowCandidates(false);
      setShowFullDetails(false);
    } catch (err) {
      setError(err?.message || '从 Brief 生成失败，请稍后重试。');
      setResult(null);
    } finally {
      setGenerating(false);
    }
  }, [brief, briefSummaryDisplay, userId]);

  // ---- v1 继续修改 ----
  const handleRevise = useCallback(async () => {
    const trimmed = reviseFeedback.trim();
    if (!trimmed) {
      setError('请输入修改意见。');
      return;
    }
    if (trimmed.length > MAX_REVISE_LENGTH) {
      setError(`修改意见不能超过 ${MAX_REVISE_LENGTH} 个字符。`);
      return;
    }
    if (reviseHistory.length >= MAX_REVISE_ROUNDS) {
      setError(`最多支持 ${MAX_REVISE_ROUNDS} 轮修改。`);
      return;
    }
    if (!result?.data) {
      setError('没有可修改的内容。');
      return;
    }
    if (!isSupabaseConfigured || !userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setGenerating(true);
    try {
      const response = await reviseContent(trimmed, result.data);
      const newHistory = [...reviseHistory, { feedback: trimmed, result: result.data }];
      setReviseHistory(newHistory);
      setResult({ data: response.data, meta: response.meta, summary: response.data?.summary || '' });
      setReviseFeedback('');
      setShowCandidates(false);
      setShowFullDetails(false);
    } catch (err) {
      setError(err?.message || '修改失败，请稍后重试。');
    } finally {
      setGenerating(false);
    }
  }, [reviseFeedback, reviseHistory, result, userId]);

  // ---- v2 保存 ----
  const handleV2Save = useCallback(async () => {
    if (!result?.data) {
      setError('没有可保存的内容。');
      return;
    }
    if (savedId) {
      setError('已经保存过了。');
      return;
    }
    if (!userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setSaving(true);
    try {
      // 构建带编辑后内容的 result
      const resultData = {
        ...result.data,
        title: editableTitle || result.data.title,
        main_copy: editableCopy || result.data.main_copy,
        visual_description: editableVisual || result.data.visual_description,
      };

      // 计算参考文本哈希（如果有）
      let referenceTextHash = null;
      if (referenceText.trim()) {
        const encoder = new globalThis.TextEncoder();
        const data = encoder.encode(referenceText.trim());
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        referenceTextHash = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      }

      // 计算图片哈希（如果有）
      let imageMetaWithHash = null;
      if (referenceImage && referenceImageMeta) {
        const buffer = await referenceImage.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const sha256 = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        imageMetaWithHash = {
          ...referenceImageMeta,
          sha256,
        };
      }

      const context = {
        originalInput: inputText || '',
        summary: result.summary || intentSummary || '',
        usage: result.meta?.total_tokens ? { total_tokens: result.meta.total_tokens } : {},
        provider: result.meta?.provider || 'dashscope/qwen',
        model: result.meta?.model || 'qwen-plus',
        source: 'quick_generate_v2',
        referenceUrl: referenceUrl || null,
        referenceUrlData: collectedUrlData,
        referenceTextHash,
        imageMetadata: imageMetaWithHash,
      };

      const saved = await saveContentDraftV2(userId, resultData, intent, context);
      setSavedId(saved.id);
      if (onDraftCountChange) onDraftCountChange(1);
    } catch (err) {
      setError(err?.message || '保存失败。');
    } finally {
      setSaving(false);
    }
  }, [result, savedId, userId, inputText, intent, intentSummary, referenceUrl, referenceText, referenceImage, referenceImageMeta, collectedUrlData, editableTitle, editableCopy, editableVisual, onDraftCountChange]);

  // ---- v1 保存 ----
  const handleSave = useCallback(async () => {
    if (!result?.data) {
      setError('没有可保存的内容。');
      return;
    }
    if (savedId) {
      setError('已经保存过了。');
      return;
    }
    if (!userId) {
      setError('请先登录。');
      return;
    }

    setError('');
    setSaving(true);
    try {
      const context = {
        originalInput: inputText || '',
        summary: result.summary || '',
        usage: result.meta?.total_tokens ? { total_tokens: result.meta.total_tokens } : {},
        provider: result.meta?.provider || 'dashscope/qwen',
        model: result.meta?.model || 'qwen-plus',
        source: mode === 'brief' ? 'generate_from_brief' : 'quick_generate',
        briefReferences: mode === 'brief' && brief ? {
          source_view: brief.source_type || 'ke_content_briefs_v1',
          brief_id: brief.id,
          brief_version: brief.version,
          brief_fingerprint: brief.fingerprint,
          brief_schema_version: brief.schema_version,
          brief_status: brief.status,
        } : null,
        knowledgeReferences: mode === 'brief' && brief
          ? [...(brief.knowledge_citation_ids || [])]
          : null,
        evidenceReferences: mode === 'brief' && brief
          ? JSON.parse(JSON.stringify(brief.evidence_provenance || {}))
          : null,
      };
      const saved = await saveContentDraft(userId, result.data, context);
      setSavedId(saved.id);
      if (onDraftCountChange) onDraftCountChange(1);
    } catch (err) {
      setError(err?.message || '保存失败。');
    } finally {
      setSaving(false);
    }
  }, [result, savedId, userId, inputText, mode, brief, onDraftCountChange]);

  // ---- 查看草稿 ----
  const handleViewDraft = useCallback(async () => {
    if (!savedId) return;
    setLoadingDraft(true);
    try {
      const response = await loadDraftById(savedId);
      setSavedDraft(response.draft);
    } catch (err) {
      setError(err?.message || '加载草稿失败。');
    } finally {
      setLoadingDraft(false);
    }
  }, [savedId]);

  // ---- 制作图片 ----
  const handlePrepareImage = useCallback(() => {
    if (!savedId || !result?.data) return;
    const data = result.data;
    if (onPrepareImage) {
      onPrepareImage({
        draftId: savedId,
        title: editableTitle || data.title || '',
        visualPlan: editableVisual || data.visual_description || '',
        aspectRatio: data.aspect_ratio || intent?.aspect_ratio || '1:1',
      });
    }
  }, [savedId, result, editableTitle, editableVisual, intent, onPrepareImage]);

  // ---- 重新开始 v2 流程 ----
  const handleV2Reset = useCallback(() => {
    setResult(null);
    setReviseHistory([]);
    setSavedId(null);
    setSavedDraft(null);
    setPhase('intent');
  }, []);

  // 键盘提交
  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (mode === 'quick') {
        if (phase === 'input') handleResolveIntent();
        else if (phase === 'intent') handleV2Generate();
      } else if (mode === 'brief') {
        handleBriefGenerate();
      }
    }
  }, [mode, phase, handleResolveIntent, handleV2Generate, handleBriefGenerate]);

  // ===== 快速生成面板（P31 v2 升级）=====
  if (mode === 'quick') {
    return (
      <div className="creation-mode-panel quick-generate-panel" role="region" aria-label="快速生成一条内容">
        {/* Phase: input — 输入需求 + 参考 */}
        {(phase === 'input' || phase === 'intent') && !result && (
          <div className="quick-input-section">
            <div className="quick-input-header">
              <h3>描述你的内容需求</h3>
              <p>输入一句话描述，添加可选的参考链接、文本或截图，AI 将理解意图并生成平台适配内容。</p>
            </div>

            {/* 参考输入（折叠） */}
            <details
              className="collapse-panel reference-inputs-panel"
              open={showReferenceInputs}
              onToggle={(e) => setShowReferenceInputs(e.currentTarget.open)}
            >
              <summary>
                参考素材（可选）— X 链接、参考文本、截图
                {(referenceUrl || referenceText || referenceImage) && (
                  <span className="reference-indicator"> · 已添加</span>
                )}
              </summary>

              <div className="reference-inputs-body">
                {/* X URL */}
                <div className="reference-field">
                  <label>
                    <span>X/Twitter 参考链接</span>
                    <small>粘贴一条公开 X 状态链接，点击"采集"获取内容。</small>
                  </label>
                  <div className="reference-url-row">
                    <input
                      className="reference-url-input"
                      value={referenceUrl}
                      onChange={(e) => {
                        setReferenceUrl(e.target.value);
                        setCollectedUrlData(null);
                        setCollectUrlError('');
                      }}
                      placeholder="https://x.com/用户名/status/推文ID"
                      maxLength={500}
                      disabled={generating || collectingUrl}
                      aria-label="X 参考链接"
                    />
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={handleCollectUrl}
                      disabled={collectingUrl || !referenceUrl.trim() || generating}
                    >
                      {collectingUrl ? '采集中...' : '采集'}
                    </button>
                  </div>
                  {collectUrlError && (
                    <div className="notice error" role="alert">{collectUrlError}</div>
                  )}
                  {collectedUrlData && !collectUrlError && (
                    <div className="notice success" role="status">
                      已采集链接内容（{collectedUrlData.content_text?.length || 0} 字符）
                    </div>
                  )}
                </div>

                {/* 参考文本 */}
                <div className="reference-field">
                  <label>
                    <span>参考文本</span>
                    <small>粘贴你想参考的文案或内容片段。</small>
                  </label>
                  <textarea
                    className="reference-text-input"
                    value={referenceText}
                    onChange={(e) => setReferenceText(e.target.value)}
                    placeholder="粘贴参考文本..."
                    rows={4}
                    maxLength={MAX_REFERENCE_TEXT_LENGTH}
                    disabled={generating || resolvingIntent}
                  />
                  <small className="reference-char-count">
                    {referenceText.length}/{MAX_REFERENCE_TEXT_LENGTH}
                  </small>
                </div>

                {/* 截图上传 */}
                <div className="reference-field">
                  <label>
                    <span>参考截图</span>
                    <small>上传 JPEG/PNG/WebP 截图（≤4 MiB），不会保存到草稿。</small>
                  </label>
                  <label className="upload-dropzone reference-image-dropzone">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleImageSelect}
                      disabled={generating || resolvingIntent}
                    />
                    <span>{referenceImage ? referenceImage.name : '选择图片文件'}</span>
                    <small>
                      {referenceImage
                        ? `${Math.round(referenceImage.size / 1024)} KB · ${referenceImage.type}`
                        : '仅用于本次生成，不持久化'}
                    </small>
                  </label>
                  {referenceImage && (
                    <button
                      className="text-action"
                      type="button"
                      onClick={() => { setReferenceImage(null); setReferenceImageMeta(null); setReferenceImageDataUrl(null); }}
                      disabled={generating || resolvingIntent}
                    >
                      移除图片
                    </button>
                  )}
                </div>
              </div>
            </details>

            {/* 主输入 */}
            <div className="quick-input-group">
              <textarea
                ref={inputRef}
                className="quick-input-textarea"
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  setError('');
                }}
                onKeyDown={handleKeyDown}
                placeholder="例如：为独立创业者写一篇关于AI提效的 X 贴文，要专业但不生硬"
                rows={3}
                maxLength={MAX_INPUT_LENGTH}
                disabled={generating || resolvingIntent}
                aria-label="一句话内容需求"
              />
              <div className="quick-input-footer">
                <small>{inputText.length}/{MAX_INPUT_LENGTH}</small>
                <button
                  className="primary-button generate-button"
                  type="button"
                  onClick={handleResolveIntent}
                  disabled={resolvingIntent || generating || !inputText.trim()}
                  aria-busy={resolvingIntent}
                >
                  {resolvingIntent ? '解析意图中...' : '智能生成'}
                </button>
              </div>
            </div>

            {/* 意图解析 loading */}
            {resolvingIntent && (
              <div className="intent-resolving-indicator" aria-live="polite">
                <p>正在分析你的内容需求...</p>
              </div>
            )}

            {/* 意图摘要 */}
            {phase === 'intent' && intent && !resolvingIntent && (
              <div className="intent-result-section">
                <CreationIntentSummary
                  intent={intent}
                  summary={intentSummary}
                  loading={false}
                  onIntentChange={(updates) => {
                    setIntent((prev) => ({ ...prev, ...updates }));
                  }}
                />

                <div className="intent-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={handleV2Generate}
                    disabled={generating}
                    aria-busy={generating}
                  >
                    {generating ? '生成中...' : `生成${intent?.platform === 'x' ? ' X' : ''}${intent?.content_format === 'image_caption' ? '图文' : intent?.content_format === 'long_post' ? '长文' : ''}内容`}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => { setIntent(null); setPhase('input'); setResolvingIntent(false); }}
                    disabled={generating}
                  >
                    重新输入
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
          </div>
        )}

        {/* Phase: result — 生成结果 + 编辑 + 保存 */}
        {phase === 'result' && result && (
          <div className="generation-result-section">
            {/* 意图摘要（只读 chip） */}
            {intent && (
              <div className="intent-result-section">
                <CreationIntentSummary
                  intent={intent}
                  summary={intentSummary}
                  loading={false}
                />
              </div>
            )}

            {/* 可编辑主版本 */}
            <div className="main-version-card v2">
              <div className="version-header">
                <span className="version-badge primary">v2 主版本</span>
                <button
                  className="text-action"
                  type="button"
                  onClick={handleV2Reset}
                  disabled={generating || saving}
                >
                  重新生成
                </button>
              </div>

              {/* 标题编辑 */}
              <div className="v2-edit-field">
                <label>
                  <span className="edit-label">标题</span>
                  <input
                    className="v2-edit-input title"
                    value={editableTitle}
                    onChange={(e) => setEditableTitle(e.target.value)}
                    maxLength={200}
                    disabled={saving}
                    aria-label="编辑标题"
                  />
                </label>
              </div>

              {/* 正文编辑 */}
              <div className="v2-edit-field">
                <label>
                  <span className="edit-label">正文</span>
                  <textarea
                    className="v2-edit-textarea"
                    value={editableCopy}
                    onChange={(e) => setEditableCopy(e.target.value)}
                    rows={8}
                    maxLength={3000}
                    disabled={saving}
                    aria-label="编辑正文"
                  />
                </label>
                <small className="char-count">{editableCopy.length}/3000</small>
              </div>

              {/* 视觉方案编辑 */}
              <div className="v2-edit-field">
                <label>
                  <span className="edit-label">视觉方案</span>
                  <textarea
                    className="v2-edit-textarea visual"
                    value={editableVisual}
                    onChange={(e) => setEditableVisual(e.target.value)}
                    rows={3}
                    maxLength={600}
                    disabled={saving}
                    aria-label="编辑视觉方案"
                  />
                </label>
                <small className="char-count">{editableVisual.length}/600</small>
              </div>

              {/* 非编辑字段展示 */}
              <div className="v2-meta-row">
                {result.data?.cta && (
                  <span className="main-cta">{result.data.cta}</span>
                )}
                {(result.data?.hashtags || []).length > 0 && (
                  <div className="main-hashtags">
                    {result.data.hashtags.map((tag) => (
                      <span className="hashtag-chip" key={tag}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 候选版本（折叠） */}
            {(result.data?.candidates || []).length > 0 && (
              <details
                className="collapse-panel candidates-panel"
                open={showCandidates}
                onToggle={(e) => setShowCandidates(e.currentTarget.open)}
              >
                <summary>候选版本（{result.data.candidates.length}）</summary>
                <div className="candidates-list">
                  {result.data.candidates.map((candidate, index) => (
                    <div className="candidate-card" key={index}>
                      <span className="version-badge">候选 {index + 1}</span>
                      {candidate.title && <strong>{candidate.title}</strong>}
                      <p>{candidate.copy}</p>
                      {candidate.cta && <small>CTA: {candidate.cta}</small>}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* 完整详情（折叠） */}
            <details
              className="collapse-panel full-details-panel"
              open={showFullDetails}
              onToggle={(e) => setShowFullDetails(e.currentTarget.open)}
            >
              <summary>意图详情、参考来源与生成元数据</summary>
              <div className="full-details-grid">
                <div className="detail-item"><span className="detail-label">平台</span><strong>{result.data?.platform}</strong></div>
                <div className="detail-item"><span className="detail-label">格式</span><strong>{result.data?.content_format}</strong></div>
                <div className="detail-item"><span className="detail-label">语言</span><strong>{result.data?.language_mode || intent?.language_mode}</strong></div>
                <div className="detail-item"><span className="detail-label">长度</span><strong>{result.data?.length_profile || intent?.length_profile}</strong></div>
                <div className="detail-item"><span className="detail-label">语气</span><strong>{result.data?.tone || intent?.tone}</strong></div>
                <div className="detail-item"><span className="detail-label">CTA策略</span><strong>{intent?.cta_policy}</strong></div>
                <div className="detail-item"><span className="detail-label">标签策略</span><strong>{intent?.hashtag_policy}</strong></div>
                <div className="detail-item"><span className="detail-label">置信度</span><strong>{intent?.confidence}</strong></div>
                <div className="detail-item"><span className="detail-label">画幅</span><strong>{result.data?.aspect_ratio || '1:1'}</strong></div>
                <div className="detail-item detail-full"><span className="detail-label">视觉描述</span><strong>{editableVisual || result.data?.visual_description}</strong></div>
              </div>
              <div className="detail-meta-row">
                <small>Provider: {result.meta?.provider} · Model: {result.meta?.model} · Tokens: {result.meta?.total_tokens} · Multimodal: {result.meta?.multimodal ? 'yes' : 'no'}</small>
              </div>
            </details>

            {/* 保存 */}
            {!savedId ? (
              <div className="result-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleV2Save}
                  disabled={saving || generating}
                >
                  {saving ? '保存中...' : '确认保存'}
                </button>
              </div>
            ) : (
              <div className="save-success-section">
                <div className="notice success" role="status">
                  内容已保存为草稿（ID: {savedId}）。
                </div>

                {/* 草稿详情 */}
                {savedDraft && (
                  <div className="saved-draft-preview">
                    <h4>已保存草稿详情</h4>
                    <div className="full-details-grid">
                      <div className="detail-item"><span className="detail-label">ID</span><strong>{savedDraft.id}</strong></div>
                      <div className="detail-item"><span className="detail-label">标题</span><strong>{savedDraft.title}</strong></div>
                      <div className="detail-item"><span className="detail-label">平台</span><strong>{savedDraft.platform}</strong></div>
                      <div className="detail-item"><span className="detail-label">类型</span><strong>{savedDraft.content_type}</strong></div>
                      <div className="detail-item"><span className="detail-label">状态</span><strong>{savedDraft.status}</strong></div>
                    </div>
                    {savedDraft.generation_brief?.reference_provenance && (
                      <div className="detail-meta-row">
                        <small>参考来源已记录（URL/文本/图片哈希，不含原始图片数据）</small>
                      </div>
                    )}
                  </div>
                )}

                {/* 下一步操作 */}
                <div className="next-steps v2">
                  <div className="next-steps-grid">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleViewDraft}
                      disabled={loadingDraft}
                    >
                      {loadingDraft ? '加载中...' : '查看草稿'}
                    </button>
                    <button
                      className="primary-button prepare-image-button"
                      type="button"
                      onClick={handlePrepareImage}
                    >
                      制作图片
                    </button>
                  </div>
                  <p className="form-hint">
                    查看草稿将加载本次保存的完整记录。制作图片将携带草稿 ID、标题、视觉方案和画幅进入图片生成准备页面。
                  </p>
                </div>
              </div>
            )}

            {error && (
              <div className="notice error" role="alert">{error}</div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ===== Brief 生成面板（v1 兼容）=====
  if (mode === 'brief') {
    if (!brief) {
      return (
        <div className="creation-mode-panel brief-generate-panel" role="region" aria-label="从 Brief 生成">
          <div className="empty-card-inline">请先在运营工作台中选择一个已批准的 Brief。</div>
        </div>
      );
    }

    const isApproved = briefSummaryDisplay?.statusApproved;
    const canGenerate = isApproved && userId && isSupabaseConfigured;

    return (
      <div className="creation-mode-panel brief-generate-panel" role="region" aria-label="从 Brief 生成">
        <div className="brief-selection-display">
          <div className="brief-header">
            <h3>从 Brief 生成内容</h3>
            <span className={`status-badge ${isApproved ? 'approved' : 'draft'}`}>
              {briefSummaryDisplay.status}
            </span>
          </div>

          <div className="brief-summary-card">
            <div className="brief-summary-row">
              <span className="detail-label">简报名称</span>
              <strong>{briefSummaryDisplay.name}</strong>
            </div>
            <div className="brief-summary-row">
              <span className="detail-label">版本</span>
              <strong>{briefSummaryDisplay.version || '未指定'}</strong>
            </div>
          </div>

          <details className="collapse-panel brief-advanced-panel">
            <summary>知识引用、证据来源与高级设置</summary>
            <div className="brief-advanced-content">
              <p className="brief-summary-text">{briefSummaryDisplay.summary}</p>
              {brief.target_audience && (
                <div className="detail-item"><span className="detail-label">目标受众</span><strong>{brief.target_audience}</strong></div>
              )}
              {brief.platforms && (
                <div className="detail-item"><span className="detail-label">发布渠道</span><strong>{Array.isArray(brief.platforms) ? brief.platforms.join(', ') : String(brief.platforms)}</strong></div>
              )}
              {brief.constraints && (
                <div className="detail-item"><span className="detail-label">约束条件</span><strong>{brief.constraints}</strong></div>
              )}
            </div>
          </details>

          {!result && (
            <div className="brief-generate-action">
              <button
                className="primary-button"
                type="button"
                onClick={handleBriefGenerate}
                disabled={generating || !canGenerate}
              >
                {generating ? '生成中...' : !canGenerate ? (isApproved ? '请先登录' : '简报未批准——无法生成') : '基于此 Brief 生成内容'}
              </button>
              {!isApproved && (
                <p className="form-hint">
                  {brief.status === 'pending' ? '简报尚在审批中，请等待审批完成后生成。'
                    : brief.status === 'returned' ? '简报已被退回，需要修改后重新提交。'
                    : brief.status === 'stale' ? '简报已过期，需要更新后重新提交。'
                    : `简报状态为「${brief.status || '未知'}」，只有已批准（approved）的简报才能生成内容。`}
                </p>
              )}
              {error && (
                <div className="notice error" role="alert">{error}</div>
              )}
            </div>
          )}

          {result && (
            <div className="generation-result-section">
              <div className="result-summary-bar">
                <span className="result-summary-text">{result.summary}</span>
              </div>

              <div className="main-version-card">
                <div className="version-header">
                  <span className="version-badge primary">主版本</span>
                </div>
                <div className="main-copy-display">
                  <h4 className="main-hook">{result.data?.hook}</h4>
                  <p className="main-body">{result.data?.main_copy}</p>
                  <div className="main-meta">
                    <span className="main-cta">{result.data?.cta}</span>
                    <div className="main-hashtags">
                      {(result.data?.hashtags || []).map((tag) => (
                        <span className="hashtag-chip" key={tag}>{tag}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <details
                className="collapse-panel full-details-panel"
                open={showFullDetails}
                onToggle={(e) => setShowFullDetails(e.currentTarget.open)}
              >
                <summary>完整账号/平台/风格、知识与证据</summary>
                <div className="full-details-grid">
                  <div className="detail-item"><span className="detail-label">平台</span><strong>{result.data?.platform}</strong></div>
                  <div className="detail-item"><span className="detail-label">受众</span><strong>{result.data?.audience}</strong></div>
                  <div className="detail-item"><span className="detail-label">语气/风格</span><strong>{result.data?.tone}</strong></div>
                  <div className="detail-item"><span className="detail-label">内容目标</span><strong>{result.data?.content_goal}</strong></div>
                  <div className="detail-item"><span className="detail-label">视觉类型</span><strong>{result.data?.visual_type}</strong></div>
                  <div className="detail-item"><span className="detail-label">画幅</span><strong>{result.data?.aspect_ratio}</strong></div>
                  <div className="detail-item detail-full"><span className="detail-label">视觉描述</span><strong>{result.data?.visual_description}</strong></div>
                </div>
              </details>

              {(result.data?.candidates || []).length > 0 && (
                <details
                  className="collapse-panel candidates-panel"
                  open={showCandidates}
                  onToggle={(e) => setShowCandidates(e.currentTarget.open)}
                >
                  <summary>候选版本（{result.data.candidates.length}）</summary>
                  <div className="candidates-list">
                    {result.data.candidates.map((candidate, index) => (
                      <div className="candidate-card" key={index}>
                        <span className="version-badge">候选 {index + 1}</span>
                        <strong>{candidate.hook}</strong>
                        <p>{candidate.copy}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {!savedId && (
                <div className="revise-section">
                  <label className="revise-label">
                    <span>继续修改（可选）</span>
                    <div className="revise-input-row">
                      <input
                        className="revise-input"
                        value={reviseFeedback}
                        onChange={(event) => { setReviseFeedback(event.target.value); setError(''); }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            handleRevise();
                          }
                        }}
                        placeholder="例如：更简洁，突出核心收益"
                        maxLength={MAX_REVISE_LENGTH}
                        disabled={generating || saving}
                        aria-label="修改意见"
                      />
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={handleRevise}
                        disabled={generating || saving || !reviseFeedback.trim() || reviseHistory.length >= MAX_REVISE_ROUNDS}
                      >
                        {generating ? '修改中...' : '继续修改'}
                      </button>
                    </div>
                  </label>
                </div>
              )}

              {!savedId ? (
                <div className="result-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={handleSave}
                    disabled={saving || generating}
                  >
                    {saving ? '保存中...' : '确认保存'}
                  </button>
                </div>
              ) : (
                <div className="save-success-section">
                  <div className="notice success" role="status">内容已保存为草稿（ID: {savedId}）。</div>
                </div>
              )}

              {error && (
                <div className="notice error" role="alert">{error}</div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
