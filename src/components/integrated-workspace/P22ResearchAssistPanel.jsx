import { useEffect, useMemo, useState } from 'react';
import { createP22ResearchAssistClient, isP22Duplicate } from '../../services/p22-research-assist.js';

export function P22ResearchAssistPanel({ project, busy, onSaveEvidence }) {
  const client = useMemo(() => createP22ResearchAssistClient(), []);
  const [status, setStatus] = useState(null);
  const [topic, setTopic] = useState(project.topic || '');
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState([]);
  const [analyses, setAnalyses] = useState([]);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setTopic(project.topic || '');
    setItems([]);
    setSelected([]);
    setAnalyses([]);
    setMessage('');
    setError('');
  }, [project.id, project.topic]);

  useEffect(() => {
    let mounted = true;
    client.status().then((next) => { if (mounted) setStatus(next); }).catch((cause) => { if (mounted) setError(cause.message); });
    return () => { mounted = false; };
  }, [client]);

  const analysisById = useMemo(() => new Map(analyses.map((row) => [row.source_id, row])), [analyses]);
  const canCollect = status?.role && ['operator', 'admin'].includes(status.role) && status.capabilities?.apify_configured;
  const canAnalyze = selected.length > 0 && selected.length <= 2 && status?.capabilities?.qwen_configured;
  const act = async (callback) => {
    setWorking(true); setError(''); setMessage('');
    try { await callback(); } catch (cause) { setError(String(cause?.message || cause)); }
    finally { setWorking(false); }
  };
  const collect = () => act(async () => {
    const response = await client.collect(topic.trim(), 5);
    setItems(response.items || []); setSelected([]); setAnalyses([]);
    setMessage(`已找到 ${response.items?.length || 0} 条公开来源；尚未保存。Apify 本次预留 ¥${response.cost?.reserved_cny ?? 0}。`);
  });
  const analyze = () => act(async () => {
    const chosen = items.filter((item) => selected.includes(item.id));
    const response = await client.analyze(chosen);
    setAnalyses(response.analyses || []);
    setMessage(`已完成 ${response.analyses?.length || 0} 条辅助分析；Qwen 结果仅作预览，保存后仍使用已验收的确定性分析链。`);
  });
  const toggle = (id) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 2 ? [...current, id] : current);
  const save = async (item) => act(async () => {
    if (isP22Duplicate(project, item)) throw new Error('该 URL 或内容哈希已存在，未重复保存。');
    const ok = await onSaveEvidence(item);
    if (ok) setMessage('来源已通过现有 P20 命令边界保存。需要进入知识链时，请运行卡片上的确定性分析。');
  });

  return (
    <div className="p22-assist" aria-label="智能找资料">
      <div className="p22-assist-head">
        <div><span className="p22-kicker">P22 · 有预算上限</span><h4>智能找资料</h4></div>
        <span className="p22-budget">Apify/Qwen 每日各 ≤ ¥10</span>
      </div>
      <p className="p19-panel-note">最多采集 5 条、分析 2 条；先预览，明确保存后才进入当前项目，不自动生成 Brief 或发布。</p>
      {!status && !error && <p className="p19-meta-line">正在检查 staging 能力…</p>}
      {status && (
        <div className="p22-capabilities">
          <span className={status.capabilities.apify_configured ? 'ready' : 'missing'}>Apify：{status.capabilities.apify_configured ? '已配置' : '尚未配置'}</span>
          <span className={status.capabilities.qwen_configured ? 'ready' : 'missing'}>Qwen：{status.capabilities.qwen_configured ? '已配置' : '尚未配置'}</span>
          <span>权限：{status.role}</span>
          {status.budget && <span>今日剩余：Apify ¥{status.budget.apify.remaining_cny} · Qwen ¥{status.budget.qwen.remaining_cny}</span>}
        </div>
      )}
      {status && !['operator', 'admin'].includes(status.role) && <p className="p22-missing-note">当前账号为只读角色；智能采集和分析需要 operator。</p>}
      <div className="p22-query-row">
        <input value={topic} maxLength={240} onChange={(event) => setTopic(event.target.value)} placeholder="输入研究主题" aria-label="研究主题" />
        <button className="p19-btn p19-btn-primary" type="button" disabled={busy || working || !canCollect || !topic.trim()} onClick={collect}>查找公开来源</button>
      </div>
      {status && !status.capabilities.apify_configured && <p className="p22-missing-note">真实采集暂不可用：staging 尚未配置 APIFY_TOKEN。</p>}
      {error && <p className="p19-error-text" role="alert">{error}</p>}
      {message && <p className="p22-message" role="status">{message}</p>}
      {items.length > 0 && (
        <div className="p22-results">
          <div className="p22-result-toolbar"><b>来源预览（未保存）</b><button className="p19-btn p19-btn-ghost" type="button" disabled={working || !canAnalyze} onClick={analyze}>分析已选（{selected.length}/2）</button></div>
          {!status?.capabilities?.qwen_configured && <p className="p22-missing-note">Qwen 尚未配置；仍可审核并保存公开来源。</p>}
          {items.map((item) => {
            const duplicate = isP22Duplicate(project, item); const analysis = analysisById.get(item.id);
            return <article className="p22-source-card" key={item.id}>
              <label className="p22-select"><input type="checkbox" checked={selected.includes(item.id)} disabled={working || (!selected.includes(item.id) && selected.length >= 2)} onChange={() => toggle(item.id)} />选择分析</label>
              <strong>{item.label}</strong><a href={item.source_url} target="_blank" rel="noreferrer">查看原始来源</a>
              <p>{item.content_text.slice(0, 360)}</p>
              <small>内容 SHA-256：{item.content_sha256.slice(0, 16)}… · Run：{String(item.provenance?.run_id || '未提供').slice(0, 48)}</small>
              {analysis && <div className="p22-analysis-preview"><b>Qwen 辅助分析（仅预览）</b><p>{analysis.summary}</p><small>信号：{analysis.signals.join('；') || '无'} · 风险：{analysis.risks.join('；') || '无'}</small></div>}
              <button className="p19-btn p19-btn-primary" type="button" disabled={busy || working || duplicate} onClick={() => save(item)}>{duplicate ? '已存在' : '保存此来源'}</button>
            </article>;
          })}
        </div>
      )}
    </div>
  );
}
