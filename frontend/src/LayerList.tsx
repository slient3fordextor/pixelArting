import { useRef, useState } from 'react';
import { Eye, EyeOff, GripVertical, Lock, Unlock } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { Frame, Layer } from './types';

type Props = {
  layers: Layer[];
  frame: Frame;
  selectedLayer: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Partial<Layer>) => void;
  onContext: (event: MouseEvent, id: string) => void;
  onReorder: (id: string, targetId: string, above: boolean) => void;
};

export function LayerList({ layers, frame, selectedLayer, disabled, onSelect, onPatch, onContext, onReorder }: Props) {
  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; above: boolean } | null>(null);
  const endDrag = () => { dragging.current = null; setDrop(null); };
  return <div className="layer-list" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }}>
    {[...layers].reverse().map(layer => <div key={layer.id} className={`layer-row ${layer.id === selectedLayer ? 'selected' : ''} ${layer.locked ? 'is-locked' : ''} ${!layer.visible ? 'is-hidden' : ''} ${drop?.id === layer.id ? drop.above ? 'drop-above' : 'drop-below' : ''}`} onContextMenu={event => onContext(event, layer.id)} onDragOver={event => {
      if (disabled || !dragging.current || dragging.current === layer.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const bounds = event.currentTarget.getBoundingClientRect();
      const above = event.clientY < bounds.top + bounds.height / 2;
      setDrop(current => current?.id === layer.id && current.above === above ? current : { id: layer.id, above });
    }} onDrop={event => {
      event.preventDefault();
      if (!disabled && dragging.current && dragging.current !== layer.id) {
        const bounds = event.currentTarget.getBoundingClientRect();
        onReorder(dragging.current, layer.id, event.clientY < bounds.top + bounds.height / 2);
      }
      endDrag();
    }}>
      <button className="layer-drag-handle" type="button" aria-label={`拖拽排序 ${layer.name}`} title="拖拽排序；也可使用下方的上移/下移按钮" disabled={disabled || layer.locked} draggable={!disabled && !layer.locked} onDragStart={event => {
        if (disabled || layer.locked) { event.preventDefault(); return; }
        dragging.current = layer.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-pixelart-layer', layer.id);
      }} onDragEnd={endDrag}><GripVertical size={13} /></button>
      <button type="button" className="icon-button" title={layer.visible ? `隐藏 ${layer.name}` : `显示 ${layer.name}`} aria-label={layer.visible ? `隐藏 ${layer.name}` : `显示 ${layer.name}`} disabled={disabled} onClick={() => onPatch(layer.id, { visible: !layer.visible })}>{layer.visible ? <Eye size={17} /> : <EyeOff size={17} />}</button>
      <button type="button" className="layer-select" disabled={disabled} aria-pressed={layer.id === selectedLayer} onClick={() => onSelect(layer.id)}><img src={frame.pixels[layer.id]} draggable={false} alt="" /><span>{layer.name}<small className="layer-state">{layer.locked ? '已锁定' : ''}{layer.pixelsLocked ? ' · 像素锁定' : ''}{layer.opacityLocked ? ' · 透明度锁定' : ''}{layer.opacity < 255 ? ` · ${Math.round(layer.opacity / 255 * 100)}%` : ''}{!layer.visible ? ' · 已隐藏' : ''}</small></span></button>
      <button type="button" className="icon-button" title={layer.locked ? `解锁 ${layer.name}` : `锁定 ${layer.name}`} aria-label={layer.locked ? `解锁 ${layer.name}` : `锁定 ${layer.name}`} disabled={disabled} onClick={() => onPatch(layer.id, { locked: !layer.locked })}>{layer.locked ? <Lock size={17} /> : <Unlock size={17} />}</button>
    </div>)}
  </div>;
}
