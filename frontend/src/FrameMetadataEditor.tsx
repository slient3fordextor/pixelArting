import { Copy, Plus, Trash2 } from 'lucide-react';
import type { Frame } from './types';

type Props = { frame: Frame; locked: boolean; onChange: (rects: Frame['collisionRects']) => void };

export function FrameMetadataEditor({ frame, locked, onChange }: Props) {
  function patch(index: number, field: keyof Frame['collisionRects'][number], value: number) {
    if (!Number.isInteger(value)) return;
    const rects = structuredClone(frame.collisionRects);
    const rect = rects[index];
    rect.width = Math.max(1, Math.min(frame.width, rect.width));
    rect.height = Math.max(1, Math.min(frame.height, rect.height));
    rect.x = Math.max(0, Math.min(frame.width - rect.width, rect.x));
    rect.y = Math.max(0, Math.min(frame.height - rect.height, rect.y));
    const limit = field === 'x' ? frame.width - rect.width : field === 'y' ? frame.height - rect.height : field === 'width' ? frame.width - rect.x : frame.height - rect.y;
    rect[field] = Math.max(field === 'width' || field === 'height' ? 1 : 0, Math.min(limit, value));
    onChange(rects);
  }
  function duplicate(index: number) {
    if (frame.collisionRects.length >= 32) return;
    const source = frame.collisionRects[index];
    const rect = { ...source, x: Math.min(frame.width - source.width, source.x + 1), y: Math.min(frame.height - source.height, source.y + 1) };
    onChange([...frame.collisionRects.slice(0, index + 1), rect, ...frame.collisionRects.slice(index + 1)]);
  }
  function snap(index: number) {
    const rects = structuredClone(frame.collisionRects);
    const rect = rects[index];
    const step = 2;
    rect.x = Math.max(0, Math.min(frame.width - rect.width, Math.round(rect.x / step) * step));
    rect.y = Math.max(0, Math.min(frame.height - rect.height, Math.round(rect.y / step) * step));
    onChange(rects);
  }
  function align(axis: 'left' | 'right' | 'top' | 'bottom') {
    onChange(frame.collisionRects.map(rect => ({ ...rect, ...(axis === 'left' ? { x: 0 } : axis === 'right' ? { x: frame.width - rect.width } : axis === 'top' ? { y: 0 } : { y: frame.height - rect.height }) })));
  }
  return <div className="collision-editor">
    <div className="section-label"><span>碰撞框 <small>{frame.collisionRects.length}</small></span><button className="icon-button" title="添加碰撞框" aria-label="添加碰撞框" disabled={locked || frame.collisionRects.length >= 32} onClick={() => onChange([...frame.collisionRects, { x: 0, y: 0, width: Math.min(16, frame.width), height: Math.min(16, frame.height) }])}><Plus size={17} /></button></div>
    {frame.collisionRects.length ? <div className="collision-actions"><button type="button" className="button secondary" disabled={locked} onClick={() => align('left')}>左对齐</button><button type="button" className="button secondary" disabled={locked} onClick={() => align('right')}>右对齐</button><button type="button" className="button secondary" disabled={locked} onClick={() => align('top')}>顶部对齐</button><button type="button" className="button secondary" disabled={locked} onClick={() => align('bottom')}>底部对齐</button></div> : null}
    {frame.collisionRects.map((rect, index) => <div className="collision-row" key={index}>
      <div className="section-label"><span>框 {index + 1}</span><div className="inline-tools"><button className="icon-button" title={`复制碰撞框 ${index + 1}`} aria-label={`复制碰撞框 ${index + 1}`} disabled={locked || frame.collisionRects.length >= 32} onClick={() => duplicate(index)}><Copy size={14} /></button><button type="button" className="button secondary collision-snap" disabled={locked} onClick={() => snap(index)}>吸附</button><button className="icon-button" title={`删除碰撞框 ${index + 1}`} aria-label={`删除碰撞框 ${index + 1}`} disabled={locked} onClick={() => onChange(frame.collisionRects.filter((_, i) => i !== index))}><Trash2 size={15} /></button></div></div>
      <div className="property-grid">{(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>{({ x: 'X', y: 'Y', width: '宽', height: '高' })[field]}<input aria-label={`碰撞框 ${index + 1} ${field}`} type="number" step={1} min={field === 'width' || field === 'height' ? 1 : 0} max={field === 'x' ? frame.width - rect.width : field === 'y' ? frame.height - rect.height : field === 'width' ? frame.width - rect.x : frame.height - rect.y} value={rect[field]} disabled={locked} onChange={event => patch(index, field, event.target.valueAsNumber)} /></label>)}</div>
    </div>)}
  </div>;
}
