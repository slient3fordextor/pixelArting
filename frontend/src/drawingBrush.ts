type Point = [number, number];

export type BrushStroke = {
  previous: Point;
  lastStamp: Point;
  distanceToNext: number;
};

export function brushStampSpacing(size: number, percent: number) {
  return Math.max(1, size * Math.max(10, Math.min(200, percent)) / 100);
}

/** Sample the entire pointer path, carrying unused distance across events. */
export function sampleBrushStroke(
  stroke: BrushStroke | null,
  point: Point,
  spacing: number,
  stamp: (x: number, y: number) => void,
): BrushStroke {
  if (!stroke) {
    stamp(point[0], point[1]);
    return { previous: point, lastStamp: point, distanceToNext: spacing };
  }
  const dx = point[0] - stroke.previous[0];
  const dy = point[1] - stroke.previous[1];
  const length = Math.hypot(dx, dy);
  if (!length) return stroke;
  let distance = stroke.distanceToNext;
  let lastStamp = stroke.lastStamp;
  for (; distance <= length + 1e-9; distance += spacing) {
    const x = Math.round(stroke.previous[0] + dx * distance / length);
    const y = Math.round(stroke.previous[1] + dy * distance / length);
    if (x !== lastStamp[0] || y !== lastStamp[1]) {
      stamp(x, y);
      lastStamp = [x, y];
    }
  }
  return { previous: point, lastStamp, distanceToNext: distance - length };
}
