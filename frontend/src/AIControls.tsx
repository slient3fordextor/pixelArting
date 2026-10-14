import { useEffect, useRef, useState } from 'react';
import { Check, CircleStop, CopyPlus, Download, LoaderCircle, RefreshCw, Settings2, Sparkles, Trash2, X } from 'lucide-react';
import { api } from './api';
import type { Asset } from './types';

type AiMode = 'agent_draw' | 'image_model';
type AiStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
const STATUS_NAMES: Record<AiStatus, string> = { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
type AiConfig = {
  baseUrl: string;
  textModel: string;
  imageModel: string;
  imageSize: string;
  maxOutputTokens?: number;
  tokenLimitParameter?: 'max_tokens' | 'max_completion_tokens';
  sendImageBackground?: boolean;
  requestTimeoutSeconds: number;
  hasApiKey: boolean;
};
type AiProfile = AiConfig & { id: string; name: string };
type AiProfilesResponse = { profiles: AiProfile[]; activeId: string };
type Candidate = {
  id: string;
  summary?: string;
  commands?: { tool: string; args: Record<string, unknown> }[];
  mimeType?: string;
  b64Json?: string;
  url?: string;
  image?: string;
};
type Generation = {
  id: string;
  projectId?: string;
  mode: AiMode;
  status: AiStatus;
  request?: { prompt?: string; model?: string; variations?: number };
  result?: { kind?: string; provider?: string; model?: string; candidates?: Candidate[] };
  error?: string;
  created?: string;
  updated?: string;
};

type Props = {
  projectId: string;
  disabled?: boolean;
  suspended?: boolean;
  beforeImport?: () => Promise<boolean>;
  onBusyChange?: (busy: boolean) => void;
  onImported?: (asset: Asset) => void | Promise<void>;
};

function responseImage(candidate: Candidate) {
  if (candidate.image) return candidate.image;
  if (candidate.b64Json) return `data:${candidate.mimeType || 'image/png'};base64,${candidate.b64Json}`;
  return candidate.url || '';
}

export function AIControls({ projectId, disabled = false, suspended = false, beforeImport, onBusyChange, onImported }: Props) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileApiAvailable, setProfileApiAvailable] = useState<boolean | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [textModel, setTextModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [imageSize, setImageSize] = useState('1024x1024');
  const [maxOutputTokens, setMaxOutputTokens] = useState(8192);
  const [tokenLimitParameter, setTokenLimitParameter] = useState<'max_tokens' | 'max_completion_tokens'>('max_tokens');
  const [sendImageBackground, setSendImageBackground] = useState(false);
  const [mode, setMode] = useState<AiMode>('agent_draw');
  const [prompt, setPrompt] = useState('');
  const [width, setWidth] = useState(64);
  const [height, setHeight] = useState(64);
  const [variations, setVariations] = useState(4);
  const [paletteLimit, setPaletteLimit] = useState(16);
  const [transparentBackground, setTransparentBackground] = useState(true);
  const [task, setTask] = useState<Generation | null>(null);
  const [history, setHistory] = useState<Generation[]>([]);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const localBusy = useRef(false);
  const pendingHistoryUpdates = useRef<Set<string> | null>(null);

  const candidates = task?.result?.candidates || [];
  const selectedModel = mode === 'agent_draw' ? textModel : imageModel;
  const activeProfile = profiles.find(item => item.id === activeProfileId);
  const configChanged = !config || Boolean(baseUrl !== config.baseUrl || textModel !== config.textModel || imageModel !== config.imageModel
    || imageSize !== (config.imageSize || '1024x1024') || maxOutputTokens !== (config.maxOutputTokens || 8192)
    || tokenLimitParameter !== (config.tokenLimitParameter || 'max_tokens') || sendImageBackground !== Boolean(config.sendImageBackground) || apiKey);
  const profileNameChanged = Boolean(profileApiAvailable && activeProfile && profileName.trim() !== activeProfile.name);
  const settingsChanged = configChanged || profileNameChanged;
  const taskActive = Boolean(task && ['queued', 'running'].includes(task.status));
  const validNumber = (value: number, maximum: number) => Number.isInteger(value) && value >= 1 && value <= maximum;
  const canGenerate = Boolean(projectId && config?.hasApiKey && prompt.trim() && selectedModel.trim() && !working && !taskActive && !configChanged
    && validNumber(width, 512) && validNumber(height, 512) && validNumber(variations, 8) && validNumber(paletteLimit, 256));

  function applyProfileFields(next: AiConfig, name = '') {
    setConfig(next); setBaseUrl(next.baseUrl); setTextModel(next.textModel); setImageModel(next.imageModel); setImageSize(next.imageSize || '1024x1024');
    setMaxOutputTokens(next.maxOutputTokens || 8192); setTokenLimitParameter(next.tokenLimitParameter || 'max_tokens'); setSendImageBackground(Boolean(next.sendImageBackground));
    setProfileName(name);
    if (!next.hasApiKey || !next.textModel || !next.imageModel) setSettingsOpen(true);
  }

  useEffect(() => {
    if (!open || config) return;
    let cancelled = false;
    api<AiProfilesResponse>('/ai/profiles').then(result => {
      if (cancelled) return;
      const nextProfiles = Array.isArray(result.profiles) ? result.profiles : [];
      const active = nextProfiles.find(item => item.id === result.activeId) || nextProfiles[0];
      if (!active) throw new Error('AI 模型档案为空');
      setProfileApiAvailable(true); setProfiles(nextProfiles); setActiveProfileId(active.id); applyProfileFields(active, active.name);
    }).catch(() => api<AiConfig>('/ai/config').then(next => {
      if (cancelled) return;
      setProfileApiAvailable(false); setProfiles([]); setActiveProfileId(''); applyProfileFields(next);
    }).catch(error => { if (!cancelled) setNotice({ text: error instanceof Error ? error.message : '无法读取 AI 设置', error: true }); }));
    return () => { cancelled = true; };
  }, [open, config]);

  useEffect(() => {
    setTask(null); setHistory([]); setNotice(null);
  }, [projectId]);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    const updatedIds = new Set<string>();
    pendingHistoryUpdates.current = updatedIds;
    api<Generation[]>(`/ai/generations?projectId=${encodeURIComponent(projectId)}&limit=20`).then(list => {
      if (cancelled) return;
      // Requests started earlier must not overwrite tasks updated while they were pending.
      setHistory(current => {
        const latest = current.filter(item => updatedIds.has(item.id));
        const latestIds = new Set(latest.map(item => item.id));
        const incoming = Array.from(new Map(list.map(item => [item.id, item])).values()).filter(item => !latestIds.has(item.id));
        const receivedIds = new Set([...latest, ...incoming].map(item => item.id));
        return [...latest, ...incoming, ...current.filter(item => !receivedIds.has(item.id))];
      });
      setTask(current => current && updatedIds.has(current.id) ? current : list.find(item => item.id === current?.id) || current || list[0] || null);
      if (pendingHistoryUpdates.current === updatedIds) pendingHistoryUpdates.current = null;
    }).catch(error => { if (!cancelled) setNotice({ text: error instanceof Error ? error.message : '无法读取生成记录', error: true }); });
    return () => {
      cancelled = true;
      if (pendingHistoryUpdates.current === updatedIds) pendingHistoryUpdates.current = null;
    };
  }, [open, projectId]);

  useEffect(() => {
    if (!task?.id || !taskActive) return;
    let cancelled = false;
    let timer: number;
    const id = task.id;
    async function poll() {
      try {
        const next = await api<Generation>(`/ai/generations/${id}`);
        if (cancelled) return;
        updateTask(next);
        setNotice(next.status === 'succeeded' ? { text: '候选已生成，请选择要导入的结果' } : null);
        if (['queued', 'running'].includes(next.status)) timer = window.setTimeout(poll, 750);
      } catch (error) {
        if (cancelled) return;
        setNotice({ text: error instanceof Error ? error.message : '无法读取生成状态', error: true });
        timer = window.setTimeout(poll, 2000);
      }
    }
    timer = window.setTimeout(poll, 750);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [task?.id, taskActive]);

  function updateTask(next: Generation) {
    pendingHistoryUpdates.current?.add(next.id);
    setTask(next); setHistory(list => [next, ...list.filter(item => item.id !== next.id)]);
  }

  useEffect(() => {
    if (localBusy.current === working) return;
    localBusy.current = working;
    onBusyChange?.(working);
  }, [working, onBusyChange]);

  useEffect(() => () => { if (localBusy.current) onBusyChange?.(false); }, [onBusyChange]);

  useEffect(() => {
    if (!open || suspended) return;
    const previous = document.activeElement;
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { if (previous instanceof HTMLElement && document.contains(previous)) previous.focus({ preventScroll: true }); };
  }, [open, suspended]);

  function close() {
    if (working) return;
    setApiKey(''); setOpen(false);
  }

  function connectionPayload(includeKey = true) {
    const body: Record<string, unknown> = {
      baseUrl: baseUrl.trim(), textModel: textModel.trim(), imageModel: imageModel.trim(), imageSize: imageSize.trim(),
      maxOutputTokens, tokenLimitParameter, sendImageBackground,
    };
    if (includeKey && apiKey) body.apiKey = apiKey;
    return body;
  }

  async function activateProfile(id: string) {
    if (working || !profileApiAvailable || id === activeProfileId) return;
    if (settingsChanged && !window.confirm('当前模型档案有未保存修改，仍要切换吗？')) return;
    const previous = activeProfileId;
    setWorking(true); setNotice(null);
    try {
      const result = await api<{ activeId: string; profile: AiProfile }>(`/ai/profiles/${encodeURIComponent(id)}/activate`, {}, 'POST');
      setActiveProfileId(result.activeId); setProfiles(list => list.map(item => item.id === result.profile.id ? result.profile : item));
      applyProfileFields(result.profile, result.profile.name); setApiKey(''); setNotice({ text: `已切换到 ${result.profile.name}` });
    } catch (error) {
      setActiveProfileId(previous);
      setNotice({ text: error instanceof Error ? error.message : '模型档案切换失败', error: true });
    } finally { setWorking(false); }
  }

  async function createProfile() {
    if (working || !profileApiAvailable || configChanged) return;
    const requestedName = profileName.trim();
    const name = requestedName && requestedName !== activeProfile?.name ? requestedName : `模型档案 ${profiles.length + 1}`;
    setWorking(true); setNotice(null);
    try {
      const next = await api<AiProfile>('/ai/profiles', { name, ...connectionPayload() }, 'POST');
      setProfiles(list => [...list, next]); setApiKey('');
      const active = profiles.find(item => item.id === activeProfileId);
      setProfileName(active?.name || '');
      setNotice({ text: `已创建 ${next.name}，可从档案列表切换` });
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : '模型档案创建失败', error: true }); }
    finally { setWorking(false); }
  }

  async function deleteProfile(profile: AiProfile) {
    if (working || !profileApiAvailable || profile.id === activeProfileId || profiles.length <= 1) return;
    if (!window.confirm(`确定删除模型档案“${profile.name}”吗？`)) return;
    setWorking(true); setNotice(null);
    try {
      await api<unknown>(`/ai/profiles/${encodeURIComponent(profile.id)}`, {}, 'DELETE');
      setProfiles(list => list.filter(item => item.id !== profile.id));
      setNotice({ text: `已删除 ${profile.name}` });
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : '模型档案删除失败', error: true }); }
    finally { setWorking(false); }
  }

  async function saveConfig() {
    setWorking(true); setNotice(null);
    try {
      const body = connectionPayload();
      const next = profileApiAvailable && activeProfileId
        ? await api<AiProfile>(`/ai/profiles/${encodeURIComponent(activeProfileId)}`, { name: profileName.trim() || '未命名模型档案', ...body }, 'PUT')
        : await api<AiConfig>('/ai/config', body, 'PUT');
      if (profileApiAvailable && activeProfileId) {
        const profile = next as AiProfile;
        setProfiles(list => list.map(item => item.id === profile.id ? profile : item));
        applyProfileFields(profile, profile.name);
      } else applyProfileFields(next as AiConfig);
      setApiKey('');
      setSettingsOpen(false);
      setNotice({ text: 'AI 设置已保存' });
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : 'AI 设置保存失败', error: true }); }
    finally { setWorking(false); }
  }

  async function generate() {
    if (!canGenerate) return;
    setWorking(true); setNotice(null); setTask(null);
    try {
      const next = await api<Generation>('/ai/generations', {
        projectId, mode, prompt: prompt.trim(), width, height, variations, paletteLimit, transparentBackground,
        model: selectedModel.trim(),
      });
      updateTask(next);
      if (next.status === 'succeeded') setNotice({ text: '候选已生成，请选择要导入的结果' });
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : '生成请求失败', error: true }); }
    finally { setWorking(false); }
  }

  async function clearApiKey() {
    if (working || !config?.hasApiKey) return;
    setWorking(true); setNotice(null);
    try {
      const next = profileApiAvailable && activeProfileId
        ? await api<AiProfile>(`/ai/profiles/${encodeURIComponent(activeProfileId)}`, { clearApiKey: true }, 'PUT')
        : await api<AiConfig>('/ai/config', { clearApiKey: true }, 'PUT');
      if (profileApiAvailable && activeProfileId) {
        const profile = next as AiProfile;
        setProfiles(list => list.map(item => item.id === profile.id ? profile : item));
        applyProfileFields(profile, profile.name);
      } else applyProfileFields(next as AiConfig);
      setApiKey('');
      setNotice({ text: '已删除保存的 API Key' });
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : 'API Key 删除失败', error: true }); }
    finally { setWorking(false); }
  }

  async function cancel() {
    if (!task || !['queued', 'running'].includes(task.status)) return;
    setWorking(true);
    try { updateTask(await api<Generation>(`/ai/generations/${task.id}/cancel`, {}, 'POST')); setNotice({ text: '生成任务已取消' }); }
    catch (error) { setNotice({ text: error instanceof Error ? error.message : '取消失败', error: true }); }
    finally { setWorking(false); }
  }

  async function retryTask() {
    if (!task || working || taskActive) return;
    setWorking(true); setNotice(null);
    try { updateTask(await api<Generation>(`/ai/generations/${task.id}/retry`, {}, 'POST')); }
    catch (error) { setNotice({ text: error instanceof Error ? error.message : '重试失败', error: true }); }
    finally { setWorking(false); }
  }

  async function selectCandidate(candidate: Candidate) {
    if (!task || working) return;
    setWorking(true); setNotice(null);
    try {
      if (beforeImport && !await beforeImport()) return;
      const result = await api<{ asset?: Asset; status?: string }>(`/ai/generations/${task.id}/select`, { projectId, candidateId: candidate.id }, 'POST');
      if (result.asset) await onImported?.(result.asset);
      setNotice({ text: result.asset ? '候选已导入为新素材' : '候选已提交，等待项目处理' });
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : '候选导入失败', error: true }); }
    finally { setWorking(false); }
  }

  async function downloadSource(candidate: Candidate) {
    if (!task || working) return;
    setWorking(true); setNotice(null);
    try {
      const response = await fetch(`/api/ai/generations/${task.id}/candidates/${candidate.id}/source`);
      if (!response.ok) throw new Error((await response.json()).detail || '原图下载失败');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'ai-source.png'; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : '原图下载失败', error: true }); }
    finally { setWorking(false); }
  }

  const statusText = task ? STATUS_NAMES[task.status] : '';

  return <>
    <button className="icon-button" type="button" title="AI 生成" aria-label="AI 生成" disabled={disabled || !projectId} onClick={() => setOpen(true)}><Sparkles size={17} /></button>
    {open ? <div className="modal-backdrop" inert={suspended} style={suspended ? { visibility: 'hidden' } : undefined} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialogRef} className={`modal ai-modal ${candidates.length ? 'has-candidates' : ''}`} role="dialog" aria-modal="true" aria-labelledby="ai-generation-title" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')).filter(item => item.offsetParent !== null);
          const edge = event.shiftKey ? items[0] : items.at(-1);
          if (event.target === edge) { event.preventDefault(); (event.shiftKey ? items.at(-1) : items[0])?.focus(); }
        }
      }}>
        <div className="modal-heading"><h2 id="ai-generation-title">AI 素材生成</h2><button className="icon-button" type="button" aria-label="关闭 AI 生成" disabled={working} onClick={close}><X size={17} /></button></div>
        <div className="ai-layout"><div className="ai-inputs">
        {history.length ? <label className="field-label">生成记录<select aria-label="AI 生成记录" value={task?.id || ''} disabled={working} onChange={event => { setTask(history.find(item => item.id === event.target.value) || null); setNotice(null); }}>{history.map(item => <option key={item.id} value={item.id}>{item.created ? new Date(item.created).toLocaleString('zh-CN') : item.id.slice(0, 8)} · {item.mode === 'agent_draw' ? '像素工具' : '图像模型'} · {STATUS_NAMES[item.status]}</option>)}</select></label> : null}
        <fieldset className="ai-fields" disabled={working || taskActive}>
        <div className="ai-mode" role="group" aria-label="生成模式"><button type="button" aria-pressed={mode === 'agent_draw'} disabled={working || taskActive} className={mode === 'agent_draw' ? 'active' : ''} onClick={() => setMode('agent_draw')}>像素工具绘制</button><button type="button" aria-pressed={mode === 'image_model'} disabled={working || taskActive} className={mode === 'image_model' ? 'active' : ''} onClick={() => setMode('image_model')}>图像模型生成</button></div>
        <label className="field-label">描述<textarea aria-label="AI 生成描述" rows={3} value={prompt} placeholder="例如：64×64，透明背景，蓝色斗篷的像素法师" onChange={event => setPrompt(event.target.value)} /></label>
        <div className="property-grid"><label>宽<input aria-label="AI 生成宽度" type="number" min={1} max={512} value={width} onChange={event => setWidth(Number(event.target.value))} /></label><label>高<input aria-label="AI 生成高度" type="number" min={1} max={512} value={height} onChange={event => setHeight(Number(event.target.value))} /></label><label>候选数量<input aria-label="AI 候选数量" type="number" min={1} max={8} value={variations} onChange={event => setVariations(Number(event.target.value))} /></label><label>颜色上限<input aria-label="AI 颜色上限" type="number" min={1} max={256} value={paletteLimit} onChange={event => setPaletteLimit(Number(event.target.value))} /></label></div>
        <label className="checkbox-row"><input type="checkbox" checked={transparentBackground} onChange={event => setTransparentBackground(event.target.checked)} />透明背景</label>
        <details className="ai-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
          <summary><Settings2 size={15} />连接设置<small>{config?.hasApiKey ? '密钥已配置' : '密钥未配置'}</small></summary>
          <div className="ai-settings-fields">
            {profileApiAvailable ? <div className="ai-profiles">
              <label className="field-label">模型档案<select aria-label="AI 模型档案" value={activeProfileId} disabled={working || taskActive} onChange={event => void activateProfile(event.target.value)}>
                {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.hasApiKey ? ' · 已配置' : ' · 未配置'}</option>)}
              </select></label>
              <div className="profile-name-tools"><label className="field-label">档案名称<input aria-label="AI 档案名称" value={profileName} disabled={working || taskActive} onChange={event => setProfileName(event.target.value)} /></label><button className="icon-button" type="button" title="新建模型档案" aria-label="新建模型档案" disabled={working || taskActive || configChanged} onClick={() => void createProfile()}><CopyPlus size={16} /></button></div>
              {profiles.some(item => item.id !== activeProfileId) ? <div className="profile-delete-tools" aria-label="可删除的模型档案">{profiles.filter(item => item.id !== activeProfileId).map(profile => <button className="icon-button" key={profile.id} type="button" title={`删除模型档案 ${profile.name}`} aria-label={`删除模型档案 ${profile.name}`} disabled={working || taskActive} onClick={() => void deleteProfile(profile)}><Trash2 size={15} /></button>)}</div> : null}
            </div> : null}
            <label className="field-label">OpenAI-compatible Base URL<input aria-label="AI Base URL" type="url" value={baseUrl} placeholder="https://api.openai.com/v1" onChange={event => setBaseUrl(event.target.value)} /></label>
            <label className="field-label">API Key<div className="inline-tools"><input aria-label="AI API Key" type="password" autoComplete="off" value={apiKey} placeholder={config?.hasApiKey ? '已配置，留空则保持不变' : '输入你的 API Key'} onChange={event => setApiKey(event.target.value)} /><button className="icon-button" type="button" title="删除已保存 API Key" aria-label="删除已保存 API Key" disabled={working || !config?.hasApiKey} onClick={() => void clearApiKey()}><Trash2 size={17} /></button></div></label>
            <div className="property-grid">
              <label>文本模型<input aria-label="AI 文本模型" value={textModel} onChange={event => setTextModel(event.target.value)} /></label>
              <label>图像模型<input aria-label="AI 图像模型" value={imageModel} onChange={event => setImageModel(event.target.value)} /></label>
            </div>
            <label className="field-label">图像服务生成尺寸<input aria-label="AI 服务图像尺寸" value={imageSize} placeholder="1024x1024" onChange={event => setImageSize(event.target.value)} /></label>
            <details className="ai-advanced"><summary>高级设置</summary><div className="property-grid"><label>输出 token 上限<input aria-label="AI 输出 token 上限" type="number" min={256} max={32768} value={maxOutputTokens} onChange={event => setMaxOutputTokens(Number(event.target.value))} /></label><label>Token 限额参数<select aria-label="AI Token 限额参数" value={tokenLimitParameter} onChange={event => setTokenLimitParameter(event.target.value as typeof tokenLimitParameter)}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label></div><label className="checkbox-row"><input type="checkbox" checked={sendImageBackground} onChange={event => setSendImageBackground(event.target.checked)} />发送图像 background 参数</label></details>
            <button className="button secondary" type="button" disabled={working || taskActive || !settingsChanged} onClick={() => void saveConfig()}><Settings2 size={15} />保存连接设置</button>
          </div>
        </details>
        </fieldset><p className="ai-cost">将向所选服务发送描述。生成费用由服务商收取。</p>
        <div className="ai-actions"><button className="button primary" type="button" disabled={!canGenerate} onClick={() => void generate()}>{working ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{task && ['failed', 'cancelled'].includes(task.status) ? '重新生成' : '开始生成'}</button>{taskActive ? <button className="button secondary" type="button" disabled={working} onClick={() => void cancel()}><CircleStop size={16} />取消</button> : null}{task && ['failed', 'cancelled'].includes(task.status) ? <button className="button secondary" type="button" disabled={working || !config?.hasApiKey} onClick={() => void retryTask()}><RefreshCw size={16} />重试原任务</button> : null}</div>
        </div>{task ? <div className="ai-task" aria-label="AI 生成状态">
          <div><strong>{statusText}</strong>{task.result?.model ? <small>{task.result.model}</small> : null}</div>
          {task.error ? <p className="ai-error">{task.error}</p> : null}
          {candidates.length ? <div className="ai-candidates">{candidates.map(candidate => <article className="ai-candidate" key={candidate.id}>
            {responseImage(candidate) ? <img src={responseImage(candidate)} alt={candidate.summary || 'AI 候选'} /> : <div className="ai-command-preview"><strong>绘画命令</strong><span>{candidate.commands?.length || 0} 条</span><pre>{JSON.stringify(candidate.commands?.slice(0, 6) || [], null, 2)}</pre></div>}
            <p>{candidate.summary || (candidate.commands ? `${candidate.commands.length} 条像素工具命令` : '候选素材')}</p>
            <div className="ai-candidate-actions"><button className="button secondary" type="button" disabled={working} onClick={() => void selectCandidate(candidate)}><Check size={15} />选择并导入</button>{task.mode === 'image_model' ? <button className="icon-button" type="button" title="下载原始 PNG" aria-label="下载原始 PNG" disabled={working} onClick={() => void downloadSource(candidate)}><Download size={16} /></button> : null}</div>
          </article>)}</div> : task.status === 'succeeded' ? <p className="ai-empty">任务已完成，但没有可展示的候选。</p> : null}
        </div> : null}</div>
        {notice ? <p role={notice.error ? 'alert' : 'status'} className={`ai-notice ${notice.error ? 'error' : ''}`}>{notice.text}</p> : null}
      </section>
    </div> : null}
  </>;
}
