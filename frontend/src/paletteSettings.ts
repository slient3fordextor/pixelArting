export const DEFAULT_SWATCHES = ['#24343E', '#596379', '#218F83', '#6DC7A8', '#F3C8A5', '#C67C73', '#C85F74', '#D09B68', '#EAB96A', '#F8E4A5', '#FFFFFF', '#000000'];
export const MAX_SWATCHES = 256;
export const MAX_RECENT_COLORS = 12;
export const RECENT_COLORS_KEY = 'pixelart-recent-colors-v1';
export const drawingPaletteKey = (projectId: string) => `pixelart-drawing-palette-v1:${projectId}`;

export function normalizeColors(value: unknown, limit = MAX_SWATCHES): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((color): color is string => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)).map(color => color.toUpperCase()))].slice(0, limit);
}

export function readColors(key: string): string[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Array.isArray(value) ? normalizeColors(value) : null;
  } catch { return null; }
}
