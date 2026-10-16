import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowLeft, ArrowRight, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { DEFAULT_SWATCHES, MAX_RECENT_COLORS, MAX_SWATCHES, RECENT_COLORS_KEY, drawingPaletteKey, normalizeColors, readColors } from './paletteSettings';

export function DrawingPalette({ projectId, colorRef, palette, pickedColor }: { projectId: string; colorRef: RefObject<string>; palette: string[]; pickedColor?: { color: string } | null }) {
  const [color, setColor] = useState(colorRef.current.toUpperCase());
  const [customSwatches, setCustomSwatches] = useState(() => readColors(drawingPaletteKey(projectId)));
  const [recent, setRecent] = useState(() => (readColors(RECENT_COLORS_KEY) ?? []).slice(0, MAX_RECENT_COLORS));
  const [managing, setManaging] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const managerToggleRef = useRef<HTMLButtonElement>(null);
  const updateFrame = useRef<number | null>(null);
  const draggedColor = useRef<string | null>(null);
  const lastPickedColor = useRef(pickedColor);
  const projectSwatches = normalizeColors(palette);
  const swatches = customSwatches ?? (projectSwatches.length ? projectSwatches : DEFAULT_SWATCHES);
  const selectedIndex = swatches.indexOf(color);

  const remember = useCallback((next: string) => {
    const normalized = next.toUpperCase();
    setRecent(previous => previous[0] === normalized ? previous : [normalized, ...previous.filter(item => item !== normalized)].slice(0, MAX_RECENT_COLORS));
  }, []);

  useEffect(() => {
    try {
      if (customSwatches !== null) localStorage.setItem(drawingPaletteKey(projectId), JSON.stringify(customSwatches));
      localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(recent));
      setStorageError(false);
    } catch { setStorageError(true); }
  }, [customSwatches, recent, projectId]);

  useEffect(() => {
    const input = inputRef.current;
    // Native change commits the final color; input events stay on the RAF path.
    const commit = () => { if (input) remember(input.value); };
    input?.addEventListener('change', commit);
    return () => {
      input?.removeEventListener('change', commit);
      if (updateFrame.current !== null) cancelAnimationFrame(updateFrame.current);
    };
  }, [remember]);

  useEffect(() => {
    if (!pickedColor || pickedColor === lastPickedColor.current) return;
    lastPickedColor.current = pickedColor;
    colorRef.current = pickedColor.color;
    if (inputRef.current) inputRef.current.value = pickedColor.color;
    setColor(pickedColor.color.toUpperCase());
    remember(pickedColor.color);
  }, [pickedColor, colorRef, remember]);

  function pick(next: string) {
    // Brush events need the latest color even before the next display frame.
    colorRef.current = next;
    if (updateFrame.current !== null) return;
    updateFrame.current = requestAnimationFrame(() => {
      updateFrame.current = null;
      setColor(colorRef.current.toUpperCase());
    });
  }

  function choose(next: string) {
    if (inputRef.current) inputRef.current.value = next;
    pick(next);
    remember(next);
  }

  function moveSwatch(source: string, target: string) {
    const from = swatches.indexOf(source);
    const to = swatches.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...swatches];
    next.splice(to, 0, ...next.splice(from, 1));
    setCustomSwatches(next);
  }

  return <section className="drawing-palette" aria-label="绘图调色板" onKeyDown={event => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Delete', 'Backspace', 'Escape'].includes(event.key)) {
      event.stopPropagation();
      if (event.key === 'Escape' && managing) { setManaging(false); managerToggleRef.current?.focus(); }
    }
  }}>
    <div className="palette-strip">
      <label className="color-input" title="绘图颜色"><input ref={inputRef} type="color" aria-label="绘图颜色" defaultValue={colorRef.current} onInput={event => pick(event.currentTarget.value)} onBlur={event => remember(event.currentTarget.value)} /></label>
      <span className="palette-divider" />
      <div className="palette-swatches" role="group" aria-label="绘图色板">
        {swatches.length === 0 && <span className="palette-hint">色板为空，点击 + 添加颜色</span>}
        {swatches.map(swatch => <button key={swatch} type="button" draggable aria-label={`选择颜色 ${swatch}`} aria-pressed={color === swatch} title={`${swatch} · 拖动排序`} className={`swatch ${color === swatch ? 'chosen' : ''}`} style={{ backgroundColor: swatch }} onClick={() => choose(swatch)} onDragStart={event => {
          draggedColor.current = swatch;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', swatch);
        }} onDragOver={event => {
          if (draggedColor.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
        }} onDrop={event => {
          if (!draggedColor.current) return;
          event.preventDefault();
          moveSwatch(draggedColor.current, swatch);
          draggedColor.current = null;
        }} onDragEnd={() => { draggedColor.current = null; }} />)}
      </div>
      <button className="icon-button palette-action" type="button" aria-label="添加当前颜色到色板" title={swatches.includes(color) ? '当前颜色已在色板中' : `添加当前颜色（最多 ${MAX_SWATCHES} 色）`} disabled={swatches.includes(color) || swatches.length >= MAX_SWATCHES} onClick={() => setCustomSwatches([...swatches, color])}><Plus size={15} /></button>
      <button ref={managerToggleRef} className={`icon-button palette-action ${managing ? 'active' : ''}`} type="button" aria-label="管理色板" title="管理色板" aria-expanded={managing} aria-controls="palette-manager" onClick={() => setManaging(value => !value)}><SlidersHorizontal size={15} /></button>
      <span className="color-hex">{color}</span>
    </div>
    <div className="palette-recent" role="group" aria-label="最近使用颜色">
      <span className="palette-label">最近</span>
      {recent.length ? recent.map(swatch => <button key={swatch} type="button" className="swatch" aria-label={`使用最近颜色 ${swatch}`} title={swatch} style={{ backgroundColor: swatch }} onClick={() => choose(swatch)} />) : <span className="palette-hint">选取颜色后显示在这里</span>}
    </div>
    {managing && <div id="palette-manager" className="palette-manager" role="group" aria-label="色板管理">
      <span className="palette-hint">按项目保存 · 拖动色块排序</span>
      <div className="palette-manager-actions">
        <button type="button" aria-label="当前色块前移" title="当前色块前移" disabled={selectedIndex <= 0} onClick={() => moveSwatch(color, swatches[selectedIndex - 1])}><ArrowLeft size={14} /></button>
        <button type="button" aria-label="当前色块后移" title="当前色块后移" disabled={selectedIndex < 0 || selectedIndex === swatches.length - 1} onClick={() => moveSwatch(color, swatches[selectedIndex + 1])}><ArrowRight size={14} /></button>
        <button type="button" disabled={selectedIndex < 0} onClick={() => setCustomSwatches(swatches.filter(swatch => swatch !== color))}><Trash2 size={13} />删除当前色块</button>
        <button type="button" disabled={!projectSwatches.length} onClick={() => setCustomSwatches(projectSwatches)}>载入项目色板</button>
        <button type="button" onClick={() => setCustomSwatches([...DEFAULT_SWATCHES])}>恢复默认色板</button>
      </div>
    </div>}
    {storageError && <div className="palette-hint" role="status">色板暂未保存，请检查本地存储空间。</div>}
  </section>;
}
