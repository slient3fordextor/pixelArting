import { Plus, Trash2 } from 'lucide-react';
import type { Frame } from './types';

type Props = { frame: Frame; locked: boolean; onChange: (rects: Frame['collisionRects']) => void };

export function FrameMetadataEditor({ frame, locked, onChange }: Props) {
  function patch(index: number, field: keyof Frame['collisionRects'][number], value: number) {
    if (!Number.isInteger(value)) return;
    const rects = structuredClone(frame.collisionRects);
    const rect = rects[index];
    const limit = field === 'x' || field === 'width' ? frame.width : frame.height;
    rect[field] = Math.max(field === 'width' || field === 'height' ? 1 : 0, Math.min(limit - (field === 'x' || field === 'y' ? 1 : 0), value));
    rect.width = Math.min(rect.width, frame.width - rect.x);
    rect.height = Math.min(rect.height, frame.height - rect.y);
    onChange(rects);
  }
  return <div className="collision-editor">
    <div className="section-label"><span>碰撞框 <small>{frame.collisionRects.length}</small></span><button className="icon-button" title="添加碰撞框" aria-label="添加碰撞框" disabled={locked || frame.collisionRects.length >= 32} onClick={() => onChange([...frame.collisionRects, { x: 0, y: 0, width: Math.min(16, frame.width), height: Math.min(16, frame.height) }])}><Plus size={17} /></button></div>
    {frame.collisionRects.map((rect, index) => <div className="collision-row" key={index}>
      <div className="section-label"><span>框 {index + 1}</span><button className="icon-button" title={`删除碰撞框 ${index + 1}`} aria-label={`删除碰撞框 ${index + 1}`} disabled={locked} onClick={() => onChange(frame.collisionRects.filter((_, i) => i !== index))}><Trash2 size={15} /></button></div>
      <div className="property-grid">{(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>{({ x: 'X', y: 'Y', width: '宽', height: '高' })[field]}<input aria-label={`碰撞框 ${index + 1} ${field}`} type="number" step={1} min={field === 'width' || field === 'height' ? 1 : 0} max={field === 'x' ? frame.width - 1 : field === 'y' ? frame.height - 1 : field === 'width' ? frame.width - rect.x : frame.height - rect.y} value={rect[field]} disabled={locked} onChange={event => patch(index, field, event.target.valueAsNumber)} /></label>)}</div>
    </div>)}
  </div>;
}
