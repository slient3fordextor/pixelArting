import type { ColorSampleSource } from './types';

type Props = { sample: ColorSampleSource; disabled: boolean; onChange: (sample: ColorSampleSource) => void };

export function EyedropperToolSettings({ sample, disabled, onChange }: Props) {
  return <div className="tool-settings-panel" aria-label="取色器设置">
    <strong>取色器设置</strong>
    <label className="fill-mode-control"><span>取样</span><select aria-label="取色器取样来源" value={sample} disabled={disabled} onChange={event => onChange(event.target.value as ColorSampleSource)}><option value="layer">当前图层</option><option value="merged">可见图层合成</option></select></label>
    <span className="tool-settings-hint">当前图层取原始颜色 · 仅取 RGB，透明区域保留当前颜色</span>
  </div>;
}
