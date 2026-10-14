import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Download, Eye, GitCompareArrows, History, Pause, Play, RotateCcw, X } from 'lucide-react';
import { api } from './api';
import { CanvasEditor } from './CanvasEditor';
import { RULE_NAMES } from './types';
import type { Asset, Document, Frame, Report } from './types';

type Props = {
  asset: Asset | null;
  draft: Document | null;
  selectedLayer: string;
  frameIndex: number;
  zoom: number;
  colorRef: RefObject<string>;
  busy?: boolean;
  locked?: boolean;
  onRestore: (asset: Asset) => void;
  beforeRestore?: () => Promise<boolean>;
  onBusyChange?: (busy: boolean) => void;
};
type HistoricReport = Report & { created?: string };
type LoadedVersion = { id: string; document: Document; reports: HistoricReport[] };
const operations: Record<string, string> = { upload: '原始版本', repair: '自动修复', rename: '重命名', copy: '复制', edit: '编辑保存' };
const directions: Record<string, string> = { down: '下', left: '左', right: '右', up: '上' };

function metadata(frame: Frame | undefined) {
  if (!frame) return null;
  return { width: frame.width, height: frame.height, origin: frame.origin, baselineY: frame.baselineY, collisionRects: frame.collisionRects };
}

function originLabel(frame: Frame | undefined) {
  return frame?.origin ? `(${frame.origin.x}, ${frame.origin.y})` : '未设置';
}

function collisionLabel(frame: Frame | undefined) {
  return frame?.collisionRects.map(rect => `(${rect.x}, ${rect.y}) ${rect.width} × ${rect.height}`).join('；') || '无';
}

export function VersionHistory({ asset, draft, selectedLayer, frameIndex, zoom, colorRef, busy = false, locked = false, onRestore, beforeRestore, onBusyChange }: Props) {
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<'restore-check' | 'restore' | 'export' | null>(null);
  const working = operation !== null;
  const currentOperation = useRef(operation);
  currentOperation.current = operation;
  const [error, setError] = useState('');
  const [view, setView] = useState<'preview' | 'compare' | 'reports'>('preview');
  const [viewFrameIndex, setViewFrameIndex] = useState(0);
  const [animationKey, setAnimationKey] = useState('');
  const [playing, setPlaying] = useState(false);
  const [reportIndex, setReportIndex] = useState(0);
  const requestFrameIndex = useRef(frameIndex);
  const latestAsset = useRef(asset);
  const modal = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  latestAsset.current = asset;

  function closePreview() {
    setPlaying(false);
    setSelectedVersionId(null);
  }

  useEffect(() => {
    setSelectedVersionId(null);
    setLoaded(null);
    setPlaying(false);
  }, [asset?.id]);

  useEffect(() => {
    if (!asset || !selectedVersionId) return;
    let cancelled = false;
    const assetId = asset.id;
    setLoading(true);
    setLoaded(null);
    setError('');
    Promise.all([
      api<Document>(`/assets/${assetId}/versions/${selectedVersionId}`),
      api<HistoricReport[]>(`/assets/${assetId}/reports?versionId=${encodeURIComponent(selectedVersionId)}`),
    ]).then(([document, reports]) => {
      if (cancelled) return;
      if (reports.some(report => report.assetVersionId !== selectedVersionId)) throw new Error('质检报告与选中版本不一致');
      setLoaded({ id: selectedVersionId, document, reports });
      setViewFrameIndex(Math.min(requestFrameIndex.current, document.frames.length - 1));
      setAnimationKey('');
      setReportIndex(0);
      setPlaying(false);
    }).catch(failure => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : '无法载入历史版本');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [asset?.id, selectedVersionId]);

  useEffect(() => {
    if (!selectedVersionId) return;
    modal.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !currentOperation.current) { event.preventDefault(); closePreview(); }
    };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); opener.current?.focus(); };
  }, [selectedVersionId]);

  useEffect(() => {
    if (!playing || !loaded) return;
    const document = loaded.document;
    const animation = document.animations.find(item => `${item.action}_${item.direction}` === animationKey);
    const sequence = animation?.frames ?? document.frames.map(frame => ({ frameId: frame.id, durationMs: 200 }));
    let position = 0;
    let timer: ReturnType<typeof setTimeout>;
    setViewFrameIndex(document.frames.findIndex(frame => frame.id === sequence[0].frameId));
    const advance = () => {
      timer = setTimeout(() => {
        if (animation && !animation.loop && position === sequence.length - 1) { setPlaying(false); return; }
        position = (position + 1) % sequence.length;
        setViewFrameIndex(document.frames.findIndex(frame => frame.id === sequence[position].frameId));
        advance();
      }, sequence[position].durationMs);
    };
    advance();
    return () => clearTimeout(timer);
  }, [playing, loaded, animationKey]);

  function openVersion(versionId: string) {
    opener.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    requestFrameIndex.current = frameIndex;
    setPlaying(false);
    setView('preview');
    setSelectedVersionId(versionId);
  }

  async function restoreVersion(versionId: string) {
    if (!asset || busy || locked || working || versionId === asset.currentVersionId) return;
    const requestedAssetId = asset.id;
    setOperation('restore-check');
    onBusyChange?.(true);
    setError('');
    setPlaying(false);
    try {
      if (beforeRestore && !await beforeRestore()) return;
      // The parent may have saved and queued a new asset during the restore gate.
      flushSync(() => setOperation('restore'));
      if (!beforeRestore && draft && JSON.stringify(draft) !== JSON.stringify(asset.document) && !window.confirm('放弃未保存编辑并恢复历史版本？')) return;
      const current = latestAsset.current;
      if (!current || current.id !== requestedAssetId) return;
      const restored = await api<Asset>(`/assets/${requestedAssetId}/restore`, { expectedCurrentVersionId: current.currentVersionId, versionId });
      if (latestAsset.current?.id !== requestedAssetId) return;
      onRestore(restored);
      closePreview();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法恢复历史版本');
    } finally {
      setOperation(null);
      onBusyChange?.(false);
    }
  }

  async function exportVersion(target: 'png' | 'frames' | 'sheet' | 'json' | 'godot') {
    if (!asset || !loaded || working) return;
    setOperation('export');
    setError('');
    try {
      const frame = loaded.document.frames[viewFrameIndex];
      const query = new URLSearchParams({ versionId: loaded.id, target });
      if (target === 'png') query.set('frameId', frame.id);
      const response = await fetch(`/api/assets/${asset.id}/export?${query}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.detail === 'string' ? body.detail : '历史版本导出失败');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `pixelart-${loaded.id.slice(0, 7)}.${target === 'png' ? 'png' : 'zip'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '历史版本导出失败');
    } finally {
      setOperation(null);
    }
  }

  const document = loaded && loaded.id === selectedVersionId ? loaded.document : undefined;
  const frame = document?.frames[viewFrameIndex];
  const currentDocument = draft || asset?.document;
  const currentFrame = currentDocument?.frames.find(item => item.id === frame?.id);
  const historicLayer = document?.layers.some(layer => layer.id === selectedLayer) ? selectedLayer : document?.layers.at(-1)?.id || '';
  const currentLayer = currentDocument?.layers.some(layer => layer.id === selectedLayer) ? selectedLayer : currentDocument?.layers.at(-1)?.id || '';
  const selectedVersion = asset?.versions.find(version => version.id === selectedVersionId);
  const selectedNumber = asset && selectedVersion ? asset.versions.length - asset.versions.indexOf(selectedVersion) : 0;
  const selectedReport = loaded?.reports[reportIndex];
  const metadataChanged = JSON.stringify(metadata(frame)) !== JSON.stringify(metadata(currentFrame));
  const fitZoom = frame ? Math.min(Math.max(zoom, Math.ceil(128 / Math.max(frame.width, frame.height))), Math.max(1, Math.floor(320 / Math.max(frame.width, frame.height)))) : 1;

  return <div className="version-history">
    <div className="section-label"><span>保存历史</span><small>{asset?.versions.length || 0} 个版本</small></div>
    {asset?.versions.map((version, index) => <div className="version-row" key={version.id}>
      <div className="version-line"><History size={15} /><strong>{operations[version.operation] || version.operation}</strong>{version.id === asset.currentVersionId ? <span className="current-badge">当前</span> : null}</div>
      <span>{new Date(version.created).toLocaleString('zh-CN')} · {version.id.slice(0, 7)}</span>
      <div className="version-commands"><button className="button secondary" disabled={busy || working} onClick={() => openVersion(version.id)} aria-label={`预览版本 ${asset.versions.length - index}`}><Eye size={14} />预览</button><button className="button secondary" disabled={busy || locked || working || version.id === asset.currentVersionId} onClick={() => restoreVersion(version.id)}><RotateCcw size={14} />恢复版本</button></div>
    </div>)}
    {error && !selectedVersionId ? <p className="workflow-error" role="alert">{error}</p> : null}
    {selectedVersionId ? <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !working) closePreview(); }}>
      <section ref={modal} tabIndex={-1} className="modal version-preview-modal" role="dialog" aria-modal="true" aria-labelledby="history-heading" onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' && !working) { event.preventDefault(); closePreview(); }
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary')].filter(element => element.offsetParent !== null);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (window.document.activeElement === first || window.document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <div className="modal-heading"><div><h2 id="history-heading">版本 {selectedNumber}{selectedVersionId === asset?.currentVersionId ? ' · 当前' : ''}</h2><small>{selectedVersion?.created ? new Date(selectedVersion.created).toLocaleString('zh-CN') : ''} · {selectedVersionId.slice(0, 7)}</small></div><button className="icon-button" aria-label="关闭版本预览" title="关闭版本预览" disabled={working} onClick={closePreview}><X size={17} /></button></div>
        <div className="history-tabs" role="tablist" aria-label="历史版本视图"><button role="tab" aria-selected={view === 'preview'} onClick={() => setView('preview')}><Eye size={14} />预览</button><button role="tab" aria-selected={view === 'compare'} onClick={() => setView('compare')}><GitCompareArrows size={14} />与当前对比</button><button role="tab" aria-selected={view === 'reports'} onClick={() => { setPlaying(false); setView('reports'); }}><History size={14} />质检记录</button></div>
        {loading ? <p className="empty-text" role="status">载入历史版本中</p> : null}
        {error ? <p className="workflow-error" role="alert">{error}</p> : null}
        {document && frame && loaded ? <>
          {view !== 'reports' ? <>
            <div className="history-frame-controls"><button className={`icon-button ${playing ? 'active' : ''}`} aria-label={playing ? '暂停历史动画' : '播放历史动画'} title={playing ? '暂停历史动画' : '播放历史动画'} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={17} /> : <Play size={17} />}</button><select aria-label="历史动画" value={animationKey} onChange={event => { setPlaying(false); setAnimationKey(event.target.value); const animation = document.animations.find(item => `${item.action}_${item.direction}` === event.target.value); if (animation) setViewFrameIndex(document.frames.findIndex(item => item.id === animation.frames[0].frameId)); }}><option value="">全部帧</option>{document.animations.map(animation => <option key={`${animation.action}_${animation.direction}`} value={`${animation.action}_${animation.direction}`}>{animation.action} · {directions[animation.direction]}</option>)}</select><label>帧<select aria-label="历史帧" value={viewFrameIndex} onChange={event => { setPlaying(false); setViewFrameIndex(Number(event.target.value)); }}>{document.frames.map((item, index) => <option key={item.id} value={index}>{index + 1} / {document.frames.length}</option>)}</select></label><span>{frame.width} × {frame.height} · {document.layers.length} 图层</span></div>
            <div className={`history-canvases ${view === 'compare' ? 'compare' : ''}`}><div className="history-canvas-pane"><span className="stage-label">历史版本 · {selectedVersionId.slice(0, 7)}</span><div className="history-canvas-scroll"><CanvasEditor frame={frame} layers={document.layers} activeLayer={historicLayer} tool="pencil" colorRef={colorRef} zoom={fitZoom} grid={false} guides readonly label="历史版本画布" /></div></div>{view === 'compare' && currentDocument ? <div className="history-canvas-pane"><span className="stage-label">当前工作稿 · {asset?.currentVersionId.slice(0, 7)}</span>{currentFrame ? <div className="history-canvas-scroll"><CanvasEditor frame={currentFrame} layers={currentDocument.layers} activeLayer={currentLayer} tool="pencil" colorRef={colorRef} zoom={fitZoom} grid={false} guides readonly label="当前工作稿对比画布" /></div> : <p className="empty-text">当前工作稿不存在此帧</p>}</div> : null}</div>
            {view === 'compare' ? <div className="history-comparison"><span>历史 {document.frames.length} 帧 / {document.layers.length} 图层 / {document.animations.length} 个动画</span><span>当前 {currentDocument?.frames.length || 0} 帧 / {currentDocument?.layers.length || 0} 图层 / {currentDocument?.animations.length || 0} 个动画</span><span>{metadataChanged ? '帧元数据有变化' : '帧元数据一致'}</span><table className="metadata-comparison"><thead><tr><th>帧属性</th><th>历史</th><th>当前</th></tr></thead><tbody><tr><td>原点</td><td>{originLabel(frame)}</td><td>{currentFrame ? originLabel(currentFrame) : '无对应帧'}</td></tr><tr><td>基线 Y</td><td>{frame.baselineY ?? '未设置'}</td><td>{currentFrame ? currentFrame.baselineY ?? '未设置' : '无对应帧'}</td></tr><tr><td>碰撞框</td><td>{collisionLabel(frame)}</td><td>{currentFrame ? collisionLabel(currentFrame) : '无对应帧'}</td></tr></tbody></table></div> : null}
          </> : <div className="history-report-panel">
            {loaded.reports.length ? <><label className="field-label">质检报告<select aria-label="历史质检报告" value={reportIndex} onChange={event => setReportIndex(Number(event.target.value))}>{loaded.reports.map((report, index) => <option key={report.id || index} value={index}>{report.created ? new Date(report.created).toLocaleString('zh-CN') : `报告 ${index + 1}`} · {report.findings.length} 个问题</option>)}</select></label>{selectedReport ? <><div className="report-summary">版本 {selectedReport.assetVersionId?.slice(0, 7)} · {selectedReport.colorCount} 色 · {selectedReport.frameCount} 帧 · {selectedReport.findings.length} 个问题</div><div className="history-report-rules">{selectedReport.rules.map(rule => <div key={rule.ruleId}><span>{RULE_NAMES[rule.ruleId] || rule.ruleId}</span><span>{({ passed: '通过', findings: '问题', skipped: '跳过', disabled: '关闭', failed: '失败' } as Record<string, string>)[rule.status] || rule.status}</span>{rule.reason ? <small>{rule.reason}</small> : null}</div>)}</div>{selectedReport.findings.map(finding => <div className="finding-item" key={finding.id}><strong>{RULE_NAMES[finding.ruleId] || finding.ruleId}</strong><p>{finding.message}</p></div>)}</> : null}</> : <p className="empty-text">此版本暂无质检报告</p>}
          </div>}
          <div className="history-preview-actions"><details className="export-menu"><summary className="button secondary"><Download size={16} />导出此版本</summary><div className="dropdown">{(['png', 'frames', 'sheet', 'json', 'godot'] as const).map(target => <button key={target} disabled={working || (target === 'godot' && !document.animations.length)} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void exportVersion(target); }}>{target === 'png' ? '历史当前帧 PNG' : target === 'frames' ? '历史帧序列 PNG ZIP' : target === 'sheet' ? '历史 Sprite Sheet PNG ZIP' : target === 'json' ? '历史分层 PNG + JSON 包' : '历史 Godot SpriteFrames 包'}</button>)}</div></details><button className="button primary" disabled={busy || locked || working || loaded.id === asset?.currentVersionId} onClick={() => restoreVersion(loaded.id)}><RotateCcw size={15} />恢复此版本</button></div>
        </> : null}
      </section>
    </div> : null}
  </div>;
}
