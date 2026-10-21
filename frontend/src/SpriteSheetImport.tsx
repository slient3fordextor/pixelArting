import { useEffect, useRef, useState } from 'react';
import { CheckCheck, ImagePlus, LoaderCircle, ScanLine, Upload } from 'lucide-react';
import type { Asset, Direction } from './types';
import './SpriteSheetImport.css';

type Layout = { cellWidth: number; cellHeight: number; marginX: number; marginY: number; spacingX: number; spacingY: number; rows: number; columns: number; offsetX: number; offsetY: number; cropMode: 'strict' | 'clip' };
type Mapping = { frameIndex: number; action: 'idle' | 'walk'; direction: Direction; durationMs: number };
type ImportFrame = { frameIndex: number; frameId: string; row: number; column: number; rect: { x: number; y: number; width: number; height: number }; image: string };
export type SpriteSheetPreview = { source: { width: number; height: number; checksum: string; originalRef: string }; layout: Layout; frames: ImportFrame[] };
export type SpriteSheetImportProps = {
  projectId: string;
  busy?: boolean;
  onImport: (asset: Asset) => Promise<void> | void;
  beforeImport?: () => Promise<boolean> | boolean;
  onBusyChange?: (busy: boolean) => void;
};

const initialLayout: Layout = { cellWidth: 64, cellHeight: 64, marginX: 0, marginY: 0, spacingX: 0, spacingY: 0, rows: 0, columns: 0, offsetX: 0, offsetY: 0, cropMode: 'strict' };
const layoutFields: { key: keyof Layout; label: string; min: number; max: number }[] = [
  { key: 'cellWidth', label: '单帧宽度', min: 1, max: 512 },
  { key: 'cellHeight', label: '单帧高度', min: 1, max: 512 },
  { key: 'marginX', label: '左右边距', min: 0, max: 1024 },
  { key: 'marginY', label: '上下边距', min: 0, max: 1024 },
  { key: 'spacingX', label: '水平间距', min: 0, max: 2048 },
  { key: 'spacingY', label: '垂直间距', min: 0, max: 2048 },
  { key: 'rows', label: '行数（0 自动）', min: 0, max: 64 },
  { key: 'columns', label: '列数（0 自动）', min: 0, max: 64 },
  { key: 'offsetX', label: '起始偏移 X', min: 0, max: 2048 },
  { key: 'offsetY', label: '起始偏移 Y', min: 0, max: 2048 },
];
const directions: [Direction, string][] = [['down', '下'], ['left', '左'], ['right', '右'], ['up', '上']];

function MappingOptions() {
  return <><option value="">未指定</option>{(['idle', 'walk'] as const).flatMap(action => directions.map(([direction, label]) => <option key={`${action}:${direction}`} value={`${action}:${direction}`}>{action} · {label}</option>))}</>;
}

async function submitMultipart<T>(path: string, data: FormData): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: data });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const detail = result?.detail;
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((item: { msg: string }) => item.msg).join('；') : `请求失败 (${response.status})`);
  }
  return response.json();
}

export function SpriteSheetImport({ projectId, busy = false, onImport, beforeImport, onBusyChange }: SpriteSheetImportProps) {
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [name, setName] = useState('');
  const [sheet, setSheet] = useState(false);
  const [layout, setLayout] = useState<Layout>(initialLayout);
  const [preview, setPreview] = useState<SpriteSheetPreview | null>(null);
  const [mapping, setMapping] = useState<Record<number, Mapping>>({});
  const [mappingMode, setMappingMode] = useState<'row' | 'frame'>('row');
  const [durationMs, setDurationMs] = useState(200);
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [savedAsset, setSavedAsset] = useState<Asset | null>(null);
  const requestSequence = useRef(0);
  const locked = busy || working;
  const mappedCount = Object.keys(mapping).length;
  const invalidDuration = Object.values(mapping).some(item => !Number.isInteger(item.durationMs) || item.durationMs < 1 || item.durationMs > 60000);

  useEffect(() => {
    if (!file) { setSourceUrl(''); return; }
    const url = URL.createObjectURL(file);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    requestSequence.current++;
    setPreview(null);
    setMapping({});
    setConfirmed(false);
    setSavedAsset(null);
    setError('');
  }, [projectId]);

  function invalidatePreview() {
    requestSequence.current++;
    setPreview(null);
    setMapping({});
    setConfirmed(false);
    setSavedAsset(null);
    setError('');
  }

  function selectFile(value: File | undefined) {
    if (!value) return;
    invalidatePreview();
    if (value.size > 8 * 1024 * 1024) {
      setFile(null);
      setError('PNG 文件不能超过 8 MB');
      return;
    }
    if (!/\.png$/i.test(value.name) && value.type !== 'image/png') {
      setFile(null);
      setError('仅支持静态 PNG 文件');
      return;
    }
    setFile(value);
    setName(value.name.replace(/\.png$/i, '').slice(0, 100) || '素材');
  }

  function requestData() {
    const data = new FormData();
    if (file) data.set('file', file);
    if (sheet) Object.entries(layout).forEach(([key, value]) => data.set(key, String(value)));
    return data;
  }

  async function run(task: () => Promise<void>) {
    if (locked) return;
    setWorking(true);
    setError('');
    onBusyChange?.(true);
    try { await task(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败，请重试'); }
    finally { setWorking(false); onBusyChange?.(false); }
  }

  async function showPreview() {
    if (!file || !projectId) return;
    const sequence = ++requestSequence.current;
    await run(async () => {
      const next = await submitMultipart<SpriteSheetPreview>(`/api/projects/${projectId}/imports/preview`, requestData());
      if (sequence !== requestSequence.current) return;
      setPreview(next);
      setMapping({});
      setConfirmed(false);
      setSavedAsset(null);
    });
  }

  function setFrameMappings(indices: number[], value: string) {
    setMapping(current => {
      const next = { ...current };
      for (const frameIndex of indices) {
        if (!value) delete next[frameIndex];
        else {
          const [action, direction] = value.split(':') as ['idle' | 'walk', Direction];
          next[frameIndex] = { frameIndex, action, direction, durationMs: current[frameIndex]?.durationMs ?? durationMs };
        }
      }
      return next;
    });
    setConfirmed(false);
    setSavedAsset(null);
  }

  function setFrameDuration(frameIndex: number, value: number) {
    setMapping(current => current[frameIndex] ? { ...current, [frameIndex]: { ...current[frameIndex], durationMs: value } } : current);
    setConfirmed(false);
    setSavedAsset(null);
  }

  async function confirmImport() {
    if (!file || !preview || !projectId) return;
    await run(async () => {
      if (beforeImport && !await beforeImport()) return;
      if (savedAsset) { await onImport(savedAsset); return; }
      const data = requestData();
      data.set('name', name.trim());
      data.set('mapping', JSON.stringify(Object.values(mapping).sort((left, right) => left.frameIndex - right.frameIndex)));
      data.set('mappingConfirmed', String(confirmed));
      const next = await submitMultipart<Asset>(`/api/projects/${projectId}/assets`, data);
      setSavedAsset(next);
      await onImport(next);
    });
  }

  return <div className="sprite-sheet-import" aria-busy={working}>
    <label className="upload-zone sheet-file-zone">
      <ImagePlus size={26} />
      <span>{file?.name || '选择 PNG 文件'}</span>
      {file ? <small>{Math.ceil(file.size / 1024)} KB</small> : null}
      <input aria-label="PNG 文件" type="file" accept="image/png,.png" disabled={locked} onChange={event => { selectFile(event.target.files?.[0]); event.target.value = ''; }} />
    </label>
    <label className="field-label">素材名称<input aria-label="导入素材名称" value={name} maxLength={100} disabled={locked} onChange={event => { setName(event.target.value); setSavedAsset(null); }} /></label>
    <fieldset className="sheet-segmented"><legend>导入模式</legend><label><input type="radio" name="sheet-import-kind" checked={!sheet} disabled={locked} onChange={() => { setSheet(false); invalidatePreview(); }} />单图</label><label><input type="radio" name="sheet-import-kind" checked={sheet} disabled={locked} onChange={() => { setSheet(true); invalidatePreview(); }} />Sprite Sheet</label></fieldset>
    {sheet ? <div className="sheet-layout-grid">{layoutFields.map(field => <label key={field.key}>{field.label}<input aria-label={field.label} type="number" min={field.min} max={field.max} step={1} value={layout[field.key]} disabled={locked} onChange={event => { setLayout(current => ({ ...current, [field.key]: Number(event.target.value) })); invalidatePreview(); }} /></label>)}</div> : null}
    {sheet ? <label className="field-label">裁剪规则<select aria-label="Sprite Sheet 裁剪规则" value={layout.cropMode} disabled={locked} onChange={event => { setLayout(current => ({ ...current, cropMode: event.target.value as Layout['cropMode'] })); invalidatePreview(); }}><option value="strict">严格覆盖整张图片</option><option value="clip">允许尾部裁剪</option></select></label> : null}
    <button className="button secondary full" type="button" disabled={!file || !projectId || locked} onClick={() => void showPreview()}>{working ? <LoaderCircle size={16} className="sheet-spinner" /> : <ScanLine size={16} />}预览切分</button>
    {error ? <div className="sheet-import-error" role="alert">{error}</div> : null}
    {preview ? <section className="sheet-preview" aria-label="切分预览">
      <div className="sheet-preview-heading"><strong>{preview.frames.length} 帧 · {preview.layout.rows} 行 × {preview.layout.columns} 列</strong><small>{preview.source.width} × {preview.source.height}</small></div>
      <div className="sheet-source-image" style={{ aspectRatio: `${preview.source.width} / ${preview.source.height}`, maxWidth: `${preview.source.width / preview.source.height * 220}px` }}>
        <img src={sourceUrl} alt="原始 PNG 切分预览" />
        {preview.frames.map(frame => <span key={frame.frameId} className="sheet-cut-region" aria-hidden="true" title={`帧 ${frame.frameIndex + 1}`} style={{ left: `${frame.rect.x / preview.source.width * 100}%`, top: `${frame.rect.y / preview.source.height * 100}%`, width: `${frame.rect.width / preview.source.width * 100}%`, height: `${frame.rect.height / preview.source.height * 100}%` }} />)}
      </div>
      <div className="sheet-mapping-heading"><strong>动作与方向</strong><span>{mappedCount} / {preview.frames.length} 帧已映射</span></div>
      <fieldset className="sheet-segmented"><legend>映射范围</legend><label><input type="radio" name="sheet-mapping-kind" checked={mappingMode === 'row'} disabled={locked} onChange={() => setMappingMode('row')} />按行</label><label><input type="radio" name="sheet-mapping-kind" checked={mappingMode === 'frame'} disabled={locked} onChange={() => setMappingMode('frame')} />逐帧</label></fieldset>
      <label className="sheet-duration-label">统一帧时长（ms）<input aria-label="统一帧时长" type="number" min={1} max={60000} step={1} value={durationMs} disabled={locked} onChange={event => {
        const value = Number(event.target.value);
        setDurationMs(value);
        setMapping(current => Object.fromEntries(Object.entries(current).map(([key, item]) => [key, { ...item, durationMs: value }])));
        setConfirmed(false);
        setSavedAsset(null);
      }} /></label>
      {mappingMode === 'row' ? <div className="sheet-row-mappings">{Array.from({ length: preview.layout.rows }, (_, row) => {
        const indices = preview.frames.filter(frame => frame.row === row).map(frame => frame.frameIndex);
        const values = indices.map(index => mapping[index] ? `${mapping[index].action}:${mapping[index].direction}` : '');
        const value = values.every(item => item === values[0]) ? values[0] : 'mixed';
        return <label key={row}><span>第 {row + 1} 行</span><select aria-label={`第 ${row + 1} 行动作方向`} value={value} disabled={locked} onChange={event => setFrameMappings(indices, event.target.value)}><MappingOptions />{value === 'mixed' ? <option value="mixed" disabled>逐帧混合映射</option> : null}</select></label>;
      })}</div> : null}
      <div className={`sheet-frame-grid ${mappingMode === 'frame' ? 'sheet-per-frame' : ''}`}>{preview.frames.map(frame => <figure className="sheet-frame" key={frame.frameId}>
        <img src={frame.image} alt={`切分帧 ${frame.frameIndex + 1}`} />
        <figcaption>帧 {frame.frameIndex + 1}</figcaption>
        {mappingMode === 'frame' ? <><select aria-label={`帧 ${frame.frameIndex + 1} 动作方向`} value={mapping[frame.frameIndex] ? `${mapping[frame.frameIndex].action}:${mapping[frame.frameIndex].direction}` : ''} disabled={locked} onChange={event => setFrameMappings([frame.frameIndex], event.target.value)}><MappingOptions /></select><label>ms<input aria-label={`帧 ${frame.frameIndex + 1} 时长`} type="number" min={1} max={60000} value={mapping[frame.frameIndex]?.durationMs ?? durationMs} disabled={locked || !mapping[frame.frameIndex]} onChange={event => setFrameDuration(frame.frameIndex, Number(event.target.value))} /></label></> : null}
      </figure>)}</div>
      {invalidDuration ? <div className="sheet-import-error" role="alert">帧时长必须是 1 到 60000 ms 之间的整数</div> : null}
      {mappedCount ? <label className="checkbox-row"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} />确认动作与方向映射</label> : null}
    </section> : null}
    {savedAsset ? <div className="sheet-import-saved" role="status"><CheckCheck size={16} />已导入 {savedAsset.name}</div> : null}
    <button className="button primary full" type="button" disabled={!file || !preview || !name.trim() || !projectId || locked || (mappedCount > 0 && (!confirmed || invalidDuration))} onClick={() => void confirmImport()}><Upload size={16} />{savedAsset ? '打开导入素材' : '确认导入'}</button>
  </div>;
}
