export type Hsb = { hue: number; saturation: number; brightness: number };

export function hexToRgb(value: string): [number, number, number] {
  const normalized = value.replace('#', '').trim();
  const full = normalized.length === 3 ? normalized.split('').map(part => part + part).join('') : normalized;
  const number = Number.parseInt(full || '000000', 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

export function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function rgbToHsb(red: number, green: number, blue: number): Hsb {
  const r = red / 255, g = green / 255, b = blue / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return { hue: Math.round((hue + 360) % 360), saturation: Math.round(max ? delta / max * 100 : 0), brightness: Math.round(max * 100) };
}

export function hsbToRgb({ hue, saturation, brightness }: Hsb): [number, number, number] {
  const h = ((hue % 360) + 360) % 360, s = Math.max(0, Math.min(100, saturation)) / 100, v = Math.max(0, Math.min(100, brightness)) / 100;
  const chroma = v * s, x = chroma * (1 - Math.abs((h / 60) % 2 - 1)), match = v - chroma;
  const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [Math.round((r + match) * 255), Math.round((g + match) * 255), Math.round((b + match) * 255)];
}
