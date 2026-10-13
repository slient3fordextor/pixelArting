import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

const defaultSwatches = ['#24343E', '#596379', '#218F83', '#6DC7A8', '#F3C8A5', '#C67C73', '#C85F74', '#D09B68', '#EAB96A', '#F8E4A5', '#FFFFFF', '#000000'];

export function DrawingPalette({ colorRef, palette, pickedColor }: { colorRef: RefObject<string>; palette: string[]; pickedColor?: string }) {
  const [color, setColor] = useState(colorRef.current);
  const inputRef = useRef<HTMLInputElement>(null);
  const updateFrame = useRef<number | null>(null);

  useEffect(() => () => {
    if (updateFrame.current !== null) cancelAnimationFrame(updateFrame.current);
  }, []);

  useEffect(() => {
    if (!pickedColor) return;
    colorRef.current = pickedColor;
    if (inputRef.current) inputRef.current.value = pickedColor;
    setColor(pickedColor);
  }, [pickedColor, colorRef]);

  function pick(next: string) {
    // Brush events need the latest color even before the next display frame.
    colorRef.current = next;
    if (updateFrame.current !== null) return;
    updateFrame.current = requestAnimationFrame(() => {
      updateFrame.current = null;
      setColor(colorRef.current);
    });
  }

  return <div className="palette-strip">
    <label className="color-input" title="绘图颜色"><input ref={inputRef} type="color" aria-label="绘图颜色" defaultValue={colorRef.current} onInput={event => pick(event.currentTarget.value)} /></label>
    <span className="palette-divider" />
    {(palette.length ? palette : defaultSwatches).map(swatch => <button key={swatch} type="button" aria-label={`选择颜色 ${swatch}`} title={swatch} className={`swatch ${color.toUpperCase() === swatch.toUpperCase() ? 'chosen' : ''}`} style={{ backgroundColor: swatch }} onClick={() => {
      if (inputRef.current) inputRef.current.value = swatch;
      pick(swatch);
    }} />)}
    <span className="color-hex">{color.toUpperCase()}</span>
  </div>;
}
