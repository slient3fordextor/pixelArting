import { useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { api } from './api';
import { FIX_NAMES } from './types';
import type { Asset, CheckConfig, Preview, RepairAction } from './types';

type Props = {
  asset: Asset | null;
  config: CheckConfig;
  dirty?: boolean;
  busy?: boolean;
  locked?: boolean;
  onPreview: (preview: Preview) => void;
};

export function RepairControls({ asset, config, dirty = false, busy = false, locked = false, onPreview }: Props) {
  const [action, setAction] = useState('remove-halo-v1');
  const [alphaThreshold, setAlphaThreshold] = useState(128);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const latestAsset = useRef(asset);
  const latestDirty = useRef(dirty);
  latestAsset.current = asset;
  latestDirty.current = dirty;
  const disabled = busy || locked || loading;
  const validAlpha = Number.isInteger(alphaThreshold) && alphaThreshold >= 1 && alphaThreshold <= 255;
  const validOffset = [offsetX, offsetY].every(value => Number.isInteger(value) && value >= 0 && value <= 512);
  const validParameters = action === 'remove-halo-v1' ? validAlpha : action === 'pad-canvas-v1' ? validOffset : true;

  async function previewRepair() {
    if (!asset || dirty || disabled || !validParameters) return;
    setLoading(true);
    setError('');
    const parameters: RepairAction = { id: action, alphaThreshold: action === 'remove-halo-v1' ? alphaThreshold : 128, offsetX: action === 'pad-canvas-v1' ? offsetX : 0, offsetY: action === 'pad-canvas-v1' ? offsetY : 0 };
    try {
      const result = await api<Preview>(`/assets/${asset.id}/preview`, { versionId: asset.currentVersionId, config, actions: [parameters] });
      if (result.baseVersionId !== asset.currentVersionId) throw new Error('修复预览与基础版本不一致，请重新预览');
      if (latestAsset.current?.id !== asset.id || latestAsset.current.currentVersionId !== asset.currentVersionId) return;
      if (latestDirty.current) throw new Error('预览期间素材已改变，请保存后重新预览');
      onPreview(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法生成修复预览');
    } finally {
      setLoading(false);
    }
  }

  return <section className="repair-controls">
    <div className="panel-divider" />
    <div className="section-label"><span>修复动作</span><Sparkles size={15} /></div>
    <select className="full" aria-label="修复动作" value={action} disabled={disabled} onChange={event => { setAction(event.target.value); setError(''); }}>{Object.entries(FIX_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
    {action === 'remove-halo-v1' ? <label className="field-label">透明度阈值<input aria-label="透明度阈值" type="number" min={1} max={255} step={1} value={alphaThreshold} disabled={disabled} onChange={event => setAlphaThreshold(Number(event.target.value))} /></label> : null}
    {action === 'pad-canvas-v1' ? <div className="property-grid"><label>水平偏移<input aria-label="修复水平偏移" type="number" min={0} max={512} step={1} value={offsetX} disabled={disabled} onChange={event => setOffsetX(Number(event.target.value))} /></label><label>垂直偏移<input aria-label="修复垂直偏移" type="number" min={0} max={512} step={1} value={offsetY} disabled={disabled} onChange={event => setOffsetY(Number(event.target.value))} /></label></div> : null}
    <button className="button secondary full" disabled={!asset || dirty || disabled || !validParameters} onClick={previewRepair}><RefreshCw size={16} />{loading ? '生成预览中' : '预览修复'}</button>
    {error ? <p className="workflow-error" role="alert">{error}</p> : null}
  </section>;
}
