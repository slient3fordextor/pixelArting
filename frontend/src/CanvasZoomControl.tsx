import { useState } from 'react';
import { MAX_ZOOM, MIN_ZOOM } from './canvasView';

type Props = { zoom: number; disabled: boolean; onChange: (zoom: number) => void };

export function CanvasZoomControl({ zoom, disabled, onChange }: Props) {
  const [value, setValue] = useState<string | null>(null);
  const percent = Math.round(zoom * 1000) / 10;

  function commit() {
    if (value !== null && value.trim() !== '') {
      const next = Number(value);
      if (Number.isFinite(next)) onChange(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next * 10) / 1000)));
    }
    setValue(null);
  }

  return <span className="zoom-label">
    {value === null ? <button type="button" disabled={disabled} aria-label="自定义画布缩放" title="点击输入缩放比例 · Ctrl + 滚轮缩放 · Shift + 滚轮左右移动" onClick={() => setValue(String(percent))}>{percent}%</button> :
      <label className="zoom-input"><input autoFocus type="text" inputMode="decimal" aria-label="画布缩放百分比" title="5%～1200% · Enter 确认 · Esc 取消" value={value} disabled={disabled} onFocus={event => event.currentTarget.select()} onChange={event => setValue(event.target.value)} onBlur={commit} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); setValue(null); }
      }} /><span>%</span></label>}
  </span>;
}
