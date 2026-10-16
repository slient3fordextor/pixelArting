import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowLeft, ArrowRight, Plus, SlidersHorizontal, Square, Trash2, X } from 'lucide-react';
import { DEFAULT_SWATCHES, MAX_RECENT_COLORS, MAX_SWATCHES, RECENT_COLORS_KEY, drawingPaletteKey, normalizeColors, readColors } from './paletteSettings';
import { hexToRgb, hsbToRgb, rgbToHex, rgbToHsb } from './colorPicker';

type PickedColor = { color: string; opacity?: number };

export function DrawingPalette({ projectId, colorRef, colorOpacityRef, palette, pickedColor, onOpacityChange }: { projectId: string; colorRef: RefObject<string>; colorOpacityRef: RefObject<number>; palette: string[]; pickedColor?: PickedColor | null; onOpacityChange: (value: number) => void }) {
  const [color, setColor] = useState(colorRef.current.toUpperCase());
  const [customSwatches, setCustomSwatches] = useState(() => readColors(drawingPaletteKey(projectId)));
  const [recent, setRecent] = useState(() => (readColors(RECENT_COLORS_KEY) ?? []).slice(0, MAX_RECENT_COLORS));
  const [managing, setManaging] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [opacity, setOpacity] = useState(() => Math.max(0, Math.min(100, colorOpacityRef.current)));
  const [background, setBackground] = useState(() => {
    try { return localStorage.getItem('pixelart-background-color-v1')?.toUpperCase() || '#FFFFFF'; } catch { return '#FFFFFF'; }
  });
  const [storageError, setStorageError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const managerToggleRef = useRef<HTMLButtonElement>(null);
  const updateFrame = useRef<number | null>(null);
  const draggedColor = useRef<string | null>(null);
  const foregroundRef = useRef(colorRef.current.toUpperCase());
  const preserveForeground = useRef(false);
  const lastPickedColor = useRef(pickedColor);
  const projectSwatches = normalizeColors(palette);
  const swatches = customSwatches ?? (projectSwatches.length ? projectSwatches : DEFAULT_SWATCHES);
  const selectedIndex = swatches.indexOf(color);
  const [red, green, blue] = hexToRgb(color);
  const hsb = rgbToHsb(red, green, blue);

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
    foregroundRef.current = pickedColor.color.toUpperCase();
    if (pickedColor.opacity !== undefined) {
      const nextOpacity = Math.max(0, Math.min(100, Math.round(pickedColor.opacity)));
      colorOpacityRef.current = nextOpacity;
      setOpacity(nextOpacity);
      onOpacityChange(nextOpacity);
    }
    if (inputRef.current) inputRef.current.value = pickedColor.color;
    setColor(pickedColor.color.toUpperCase());
    remember(pickedColor.color);
  }, [pickedColor, colorRef, colorOpacityRef, onOpacityChange, remember]);

  useEffect(() => {
    try { localStorage.setItem('pixelart-background-color-v1', background); } catch { /* Storage may be unavailable. */ }
  }, [background]);

  function updateOpacity(value: number) {
    const next = Math.max(0, Math.min(100, Math.round(value)));
    colorOpacityRef.current = next;
    setOpacity(next);
    onOpacityChange(next);
  }

  function pick(next: string) {
    // Brush events need the latest color even before the next display frame.
    colorRef.current = next;
    if (!preserveForeground.current) foregroundRef.current = next.toUpperCase();
    preserveForeground.current = false;
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

  function chooseBackground() {
    preserveForeground.current = true;
    choose(background);
    updateOpacity(100);
  }

  function swapColors() {
    const foreground = colorRef.current.toUpperCase();
    const next = foregroundRef.current;
    setBackground(foreground);
    choose(next);
  }

  function updateRgb(channel: 'red' | 'green' | 'blue', value: number) {
    const rgb: [number, number, number] = [red, green, blue];
    rgb[channel === 'red' ? 0 : channel === 'green' ? 1 : 2] = Math.max(0, Math.min(255, Math.round(value)));
    choose(rgbToHex(rgb[0], rgb[1], rgb[2]));
  }

  function updateHsb(key: 'hue' | 'saturation' | 'brightness', value: number) {
    choose(rgbToHex(...hsbToRgb({ ...hsb, [key]: value })));
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
      <div className="palette-color-tools">
        <div className="color-stack" aria-label="前景色和背景色">
          <label className="color-swatch foreground-swatch" title={`前景色 ${color}`} style={{ backgroundColor: color }}>
            <input ref={inputRef} type="color" aria-label="绘图颜色" defaultValue={colorRef.current} onInput={event => pick(event.currentTarget.value)} onBlur={event => remember(event.currentTarget.value)} />
            <span>前景</span>
          </label>
          <button className="color-swatch background-swatch" type="button" aria-label="使用背景色" title={`背景色 ${background}`} style={{ backgroundColor: background }} onClick={chooseBackground}><span>背景</span></button>
          <label className="background-picker" title="设置背景色">
            <input type="color" aria-label="背景色" value={background} onChange={event => setBackground(event.currentTarget.value.toUpperCase())} />
          </label>
        </div>
        <button className="icon-button palette-action" type="button" aria-label="交换前景色和背景色" title="交换前景色和背景色" onClick={swapColors}><ArrowLeft size={13} /><ArrowRight size={13} /></button>
      <button className="transparent-color" type="button" aria-label="使用透明色" title="透明色" onClick={() => updateOpacity(0)}><span><Square size={14} /><X size={10} /></span></button>
        <button className={`icon-button palette-action color-adjust-button ${advancedOpen ? 'active' : ''}`} type="button" aria-label="调整颜色" title="调整颜色（HSB / RGB）" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(value => !value)}><SlidersHorizontal size={14} /><span>调整颜色</span></button>
        <label className="compact-opacity"><span>不透明度</span><input aria-label="颜色不透明度" type="range" min="0" max="100" step="1" value={opacity} onChange={event => updateOpacity(Number(event.target.value))} /><output>{opacity}%</output></label>
      </div>
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
    {advancedOpen && <div className="advanced-color-panel" role="group" aria-label="调整颜色">
      <div className="advanced-color-heading"><strong>调整颜色</strong><span>HSB / RGB</span></div>
      <div className="advanced-color-preview" style={{ backgroundColor: color }}><span>{color}</span></div>
      <div className="advanced-color-fields" aria-label="HSB 色彩模式">
        <span className="advanced-color-section-label">HSB：色相、饱和度、明度</span>
        <label><span>色相</span><input aria-label="色相" type="range" min="0" max="360" value={hsb.hue} onChange={event => updateHsb('hue', Number(event.target.value))} /><output>{hsb.hue}°</output></label>
        <label><span>饱和度</span><input aria-label="饱和度" type="range" min="0" max="100" value={hsb.saturation} onChange={event => updateHsb('saturation', Number(event.target.value))} /><output>{hsb.saturation}%</output></label>
        <label><span>明度</span><input aria-label="明度" type="range" min="0" max="100" value={hsb.brightness} onChange={event => updateHsb('brightness', Number(event.target.value))} /><output>{hsb.brightness}%</output></label>
      </div>
      <div className="rgb-fields" aria-label="RGB 数值">
        <span className="advanced-color-section-label">RGB：红、绿、蓝通道</span>
        <label><span>R</span><input aria-label="红色通道" type="number" min="0" max="255" value={red} onChange={event => updateRgb('red', Number(event.target.value))} /></label>
        <label><span>G</span><input aria-label="绿色通道" type="number" min="0" max="255" value={green} onChange={event => updateRgb('green', Number(event.target.value))} /></label>
        <label><span>B</span><input aria-label="蓝色通道" type="number" min="0" max="255" value={blue} onChange={event => updateRgb('blue', Number(event.target.value))} /></label>
      </div>
    </div>}
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
