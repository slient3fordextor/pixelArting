export type ShapeTool = 'line' | 'rectangle' | 'ellipse';
export type ShapeMode = 'stroke' | 'fill';
type Point = [number, number];

export function isShapeTool(tool: string): tool is ShapeTool {
  return tool === 'line' || tool === 'rectangle' || tool === 'ellipse';
}

export function shapeEndpoints(tool: ShapeTool, start: Point, end: Point, shift: boolean, alt: boolean): [Point, Point] {
  let dx = end[0] - start[0];
  let dy = end[1] - start[1];
  if (shift) {
    if (tool === 'line') {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const length = Math.hypot(dx, dy);
      dx = Math.round(Math.cos(angle) * length);
      dy = Math.round(Math.sin(angle) * length);
    } else {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * side;
      dy = (dy < 0 ? -1 : 1) * side;
    }
  }
  return [alt ? [start[0] - dx, start[1] - dy] : start, [start[0] + dx, start[1] + dy]];
}

// Rectangle and ellipse strokes stay within their bounding box. Pixel centers
// determine ellipse coverage, so narrow and single-pixel shapes remain usable.
export function drawBoxShape(context: CanvasRenderingContext2D, tool: 'rectangle' | 'ellipse', from: Point, to: Point, stroke: number, mode: ShapeMode, inside: (x: number, y: number) => boolean) {
  const left = Math.min(from[0], to[0]);
  const top = Math.min(from[1], to[1]);
  const width = Math.abs(to[0] - from[0]) + 1;
  const height = Math.abs(to[1] - from[1]) + 1;
  const rx = width / 2;
  const ry = height / 2;
  const innerRx = rx - stroke;
  const innerRy = ry - stroke;
  for (let y = Math.max(0, top); y < Math.min(context.canvas.height, top + height); y++) {
    for (let x = Math.max(0, left); x < Math.min(context.canvas.width, left + width); x++) {
      if (!inside(x, y)) continue;
      if (tool === 'rectangle') {
        if (mode === 'fill' || x < left + stroke || x >= left + width - stroke || y < top + stroke || y >= top + height - stroke) context.fillRect(x, y, 1, 1);
      } else {
        const dx = x + 0.5 - left - rx;
        const dy = y + 0.5 - top - ry;
        const outer = (dx / rx) ** 2 + (dy / ry) ** 2 <= 1;
        const inner = innerRx > 0 && innerRy > 0 && (dx / innerRx) ** 2 + (dy / innerRy) ** 2 < 1;
        if (outer && (mode === 'fill' || !inner)) context.fillRect(x, y, 1, 1);
      }
    }
  }
}
