import { loadImage } from './api';
import type { Document } from './types';

export async function mergeLayerPixels(source: Document, ids: string[]) {
  const merging = new Set(ids);
  const layers = source.layers.filter(layer => merging.has(layer.id));
  if (layers.length < 2 || layers.some(layer => layer.locked || !layer.visible)) throw new Error('只能合并可见且未锁定的图层');
  const survivor = layers[0];
  const next = structuredClone(source);
  // Decode one frame at a time to bound memory for long animations.
  for (const frame of next.frames) {
    const buffer = document.createElement('canvas');
    buffer.width = frame.width;
    buffer.height = frame.height;
    const context = buffer.getContext('2d')!;
    const images = await Promise.all(layers.map(layer => loadImage(frame.pixels[layer.id])));
    for (let index = 0; index < layers.length; index++) {
      context.globalAlpha = layers[index].opacity / 255;
      context.globalCompositeOperation = (layers[index].blendMode && layers[index].blendMode !== 'normal' ? layers[index].blendMode : 'source-over') as GlobalCompositeOperation;
      context.drawImage(images[index], 0, 0);
    }
    context.globalCompositeOperation = 'source-over';
    for (const layer of layers) delete frame.pixels[layer.id];
    frame.pixels[survivor.id] = buffer.toDataURL('image/png');
  }
  const topId = layers.at(-1)!.id;
  next.layers = source.layers.flatMap(layer => layer.id === topId ? [{ ...survivor, opacity: 255, blendMode: 'normal' as const }] : merging.has(layer.id) ? [] : [structuredClone(layer)]);
  return { document: next, layerId: survivor.id };
}
