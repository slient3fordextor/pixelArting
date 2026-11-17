export type SelectionTransform = 'flip-horizontal' | 'flip-vertical' | 'rotate-clockwise' | 'rotate-counterclockwise';

// Map whole pixels so palette entries and alpha survive every transform exactly.
export function transformSelectionPixels(source: ImageData, transform: SelectionTransform) {
  const rotating = transform === 'rotate-clockwise' || transform === 'rotate-counterclockwise';
  const result = new ImageData(rotating ? source.height : source.width, rotating ? source.width : source.height);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const nextX = transform === 'flip-horizontal' ? source.width - x - 1
        : transform === 'rotate-clockwise' ? source.height - y - 1
        : transform === 'rotate-counterclockwise' ? y : x;
      const nextY = transform === 'flip-vertical' ? source.height - y - 1
        : transform === 'rotate-clockwise' ? x
        : transform === 'rotate-counterclockwise' ? source.width - x - 1 : y;
      const from = (y * source.width + x) * 4;
      result.data.set(source.data.subarray(from, from + 4), (nextY * result.width + nextX) * 4);
    }
  }
  return result;
}

export function resizeSelectionPixels(source: ImageData, width: number, height: number) {
  const result = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (Math.floor(y * source.height / height) * source.width + Math.floor(x * source.width / width)) * 4;
      result.data.set(source.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return result;
}

// A selection carries its coverage independently of alpha: a selected transparent
// pixel still replaces its destination, while holes in a mask leave it untouched.
export type SelectionPixels = { image: ImageData; mask: Uint8Array | null };

export function mapSelectionPixels(source: SelectionPixels, map: (image: ImageData) => ImageData): SelectionPixels {
  const image = map(source.image);
  if (!source.mask) return { image, mask: null };
  const coverage = new ImageData(source.image.width, source.image.height);
  source.mask.forEach((selected, index) => { coverage.data[index * 4 + 3] = selected ? 255 : 0; });
  const mapped = map(coverage);
  return { image, mask: Uint8Array.from({ length: image.width * image.height }, (_, index) => mapped.data[index * 4 + 3] ? 1 : 0) };
}
