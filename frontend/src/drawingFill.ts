export type FillSettings = {
  tolerance: number;
  contiguous: boolean;
  sample: 'layer' | 'merged';
};

export const defaultFillSettings: FillSettings = { tolerance: 0, contiguous: true, sample: 'layer' };

export function normalizeFillSettings(value: Partial<FillSettings> | null): FillSettings {
  const tolerance = value?.tolerance;
  return {
    tolerance: typeof tolerance === 'number' && Number.isFinite(tolerance) ? Math.max(0, Math.min(255, Math.round(tolerance))) : 0,
    contiguous: value?.contiguous !== false,
    sample: value?.sample === 'merged' ? 'merged' : 'layer',
  };
}

// Reference pixels remain unchanged while replacement pixels are written only
// to the active layer. Connectivity uses four neighbors within the selection.
export function fillPixels(image: ImageData, reference: ImageData, point: [number, number], replacement: [number, number, number, number], settings: FillSettings, inside: (x: number, y: number) => boolean) {
  const { width, height } = image;
  if (!inside(...point)) return false;
  const sample = reference.data;
  const target = Array.from(sample.slice((point[1] * width + point[0]) * 4, (point[1] * width + point[0]) * 4 + 4));
  const tolerance = settings.tolerance;
  let changed = false;

  function matches(index: number) {
    const offset = index * 4;
    if (sample[offset + 3] === 0 && target[3] === 0) return true;
    return target.every((channel, component) => Math.abs(sample[offset + component] - channel) <= tolerance);
  }

  function replace(index: number) {
    const offset = index * 4;
    if (replacement.every((channel, component) => image.data[offset + component] === channel)) return;
    image.data.set(replacement, offset);
    changed = true;
  }

  if (!settings.contiguous) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (inside(x, y) && matches(index)) replace(index);
    }
  } else {
    const queue = new Uint32Array(width * height);
    const visited = new Uint8Array(width * height);
    let read = 0;
    let write = 0;
    function enqueue(index: number) {
      if (visited[index]) return;
      visited[index] = 1;
      queue[write++] = index;
    }
    enqueue(point[1] * width + point[0]);
    while (read < write) {
      const index = queue[read++];
      const x = index % width;
      const y = Math.floor(index / width);
      if (!inside(x, y) || !matches(index)) continue;
      replace(index);
      if (x > 0) enqueue(index - 1);
      if (x + 1 < width) enqueue(index + 1);
      if (y > 0) enqueue(index - width);
      if (y + 1 < height) enqueue(index + width);
    }
  }
  return changed;
}
