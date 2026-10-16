import type { FillSettings } from './drawingFill';

type Props = { settings: FillSettings; disabled: boolean; onChange: (settings: FillSettings) => void };

export function FillToolSettings({ settings, disabled, onChange }: Props) {
  return <div className="tool-settings-panel" aria-label="填充工具设置">
    <strong>填充设置</strong>
    <label className="brush-size-control"><span>容差</span><input type="range" aria-label="填充容差" min="0" max="255" step="1" value={settings.tolerance} disabled={disabled} onChange={event => onChange({ ...settings, tolerance: Number(event.target.value) })} /><output>{settings.tolerance}</output></label>
    <label className="fill-mode-control"><span>范围</span><select aria-label="填充范围" value={settings.contiguous ? 'contiguous' : 'all'} disabled={disabled} onChange={event => onChange({ ...settings, contiguous: event.target.value === 'contiguous' })}><option value="contiguous">连续区域</option><option value="all">全局同色</option></select></label>
    <label className="fill-mode-control"><span>取样</span><select aria-label="填充取样来源" value={settings.sample} disabled={disabled} onChange={event => onChange({ ...settings, sample: event.target.value as FillSettings['sample'] })}><option value="layer">当前图层</option><option value="merged">可见图层合成</option></select></label>
    <span className="tool-settings-hint">只写入当前图层，遵循选区 · 容差 0 为精确匹配</span>
  </div>;
}
