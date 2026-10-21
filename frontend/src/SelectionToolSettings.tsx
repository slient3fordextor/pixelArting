import { useState } from 'react';
import { FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw } from 'lucide-react';
import type { Rect } from './CanvasEditor';
import type { SelectionTransform } from './selectionPixels';

type Props = {
  selection: Rect | null;
  canvasWidth: number;
  canvasHeight: number;
  disabled: boolean;
  onTransform: (transform: SelectionTransform) => void;
  onResize: (width: number, height: number) => void;
  onMove: (x: number, y: number) => void;
};

export function SelectionToolSettings({ selection, canvasWidth, canvasHeight, disabled, onTransform, onResize, onMove }: Props) {
  const [width, setWidth] = useState(String(selection?.width ?? 1));
  const [height, setHeight] = useState(String(selection?.height ?? 1));
  const [x, setX] = useState(String(selection?.x ?? 0));
  const [y, setY] = useState(String(selection?.y ?? 0));
  const integerIn = (value: string, min: number, max: number) => value.trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
  const inactive = disabled || !selection;
  const rotationDisabled = inactive || selection.width > canvasHeight || selection.height > canvasWidth;
  return <div className="tool-settings-panel selection-settings" role="group" aria-label="选区变换设置">
    <strong>选区变换</strong>
    {([
      ['flip-horizontal', '水平翻转选区', FlipHorizontal2],
      ['flip-vertical', '垂直翻转选区', FlipVertical2],
      ['rotate-counterclockwise', '逆时针旋转选区', RotateCcw],
      ['rotate-clockwise', '顺时针旋转选区', RotateCw],
    ] as const).map(([transform, label, Icon]) => <button key={transform} type="button" className="icon-button" aria-label={label} title={label + (transform.startsWith('rotate') ? ' 90°（保持完整像素）' : '')} disabled={transform.startsWith('rotate') ? rotationDisabled : inactive} onClick={() => onTransform(transform)}><Icon size={16} /></button>)}
    <form onSubmit={event => { event.preventDefault(); if (!inactive && integerIn(width, 1, canvasWidth) && integerIn(height, 1, canvasHeight)) onResize(Number(width), Number(height)); }}>
      <label>宽<input aria-label="选区缩放宽度" type="number" min="1" max={canvasWidth} value={width} disabled={inactive} onChange={event => setWidth(event.target.value)} /></label>
      <label>高<input aria-label="选区缩放高度" type="number" min="1" max={canvasHeight} value={height} disabled={inactive} onChange={event => setHeight(event.target.value)} /></label>
      <button type="submit" className="button secondary" disabled={inactive || !integerIn(width, 1, canvasWidth) || !integerIn(height, 1, canvasHeight)}>缩放选区</button>
    </form>
    <form onSubmit={event => { event.preventDefault(); if (!inactive && integerIn(x, 0, canvasWidth - selection.width) && integerIn(y, 0, canvasHeight - selection.height)) onMove(Number(x), Number(y)); }}>
      <label>X<input aria-label="选区位置 X" type="number" min="0" max={canvasWidth - (selection?.width ?? 1)} value={x} disabled={inactive} onChange={event => setX(event.target.value)} /></label>
      <label>Y<input aria-label="选区位置 Y" type="number" min="0" max={canvasHeight - (selection?.height ?? 1)} value={y} disabled={inactive} onChange={event => setY(event.target.value)} /></label>
      <button type="submit" className="button secondary" disabled={inactive || !integerIn(x, 0, canvasWidth - selection.width) || !integerIn(y, 0, canvasHeight - selection.height)}>定位选区</button>
      <button type="button" className="button secondary" disabled={inactive} onClick={() => { if (selection) onMove(Math.floor((canvasWidth - selection.width) / 2), Math.floor((canvasHeight - selection.height) / 2)); }}>居中选区</button>
    </form>
    <span className="tool-settings-hint">最近邻缩放 · 替换目标区域 · 超出画布的旋转不可用</span>
  </div>;
}
