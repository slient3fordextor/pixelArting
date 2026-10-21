import { useEffect, useRef } from 'react';
import type { BrushShape } from './CanvasEditor';
import { hexToRgb } from './colorPicker';
import { brushStampSpacing, sampleBrushStroke } from './drawingBrush';
import type { BrushStroke } from './drawingBrush';

type Props = {
  size: number;
  opacity: number;
  shape: BrushShape;
  color: string;
  colorOpacity: number;
  spacing: number;
};

export function BrushPreview({ size, opacity, shape, color, colorOpacity, spacing }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const width = 60;
    const height = 36;
    const image = context.createImageData(width, height);
    const [red, green, blue] = hexToRgb(color);
    const alpha = Math.round(255 * opacity / 100 * colorOpacity / 100);
    const offset = Math.floor((size - 1) / 2);
    const center = (size - 1) / 2;
    const radius = Math.max(0.5, center + 0.25);
    const stamp = (x: number, y: number) => {
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
        if (shape === 'circle' && (dx - center) ** 2 + (dy - center) ** 2 > radius ** 2) continue;
        const px = x - offset + dx;
        const py = y - offset + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const index = (py * width + px) * 4;
        // One coverage sample keeps opacity readable where brush stamps overlap.
        image.data.set([red, green, blue, alpha], index);
      }
    };
    stamp(16, 18);
    let stroke: BrushStroke | null = null;
    for (let x = 35; x <= 50; x++) {
      stroke = sampleBrushStroke(stroke, [x, Math.round(18 + Math.sin((x - 35) / 15 * Math.PI * 2) * 5)], brushStampSpacing(size, spacing), stamp);
    }
    context.putImageData(image, 0, 0);
  }, [size, opacity, shape, color, colorOpacity, spacing]);

  return <figure className="brush-preview" aria-label="画笔效果预览">
    <figcaption><span>笔尖与笔触</span><span>{size} px · {opacity}%</span></figcaption>
    <div className="brush-preview-surface">
      <canvas ref={canvas} width={60} height={36} role="img" aria-label={`画笔预览：${size} 像素，${shape === 'circle' ? '圆形' : '方形'}，不透明度 ${opacity}%，间距 ${spacing}%`} />
    </div>
  </figure>;
}
