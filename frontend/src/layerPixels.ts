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
    const coordinates = [...new Set(layers.flatMap(layer => Object.keys(frame.layerOverflow?.[layer.id] || {})))];
    const overflow: Record<string, string> = {};
    if (coordinates.length) {
      // Pack sparse coordinates into a small temporary raster so Canvas applies
      // exactly the same opacity and blend modes as the in-canvas pixels.
      const output = document.createElement('canvas');
      output.width = Math.min(512, coordinates.length);
      output.height = Math.ceil(coordinates.length / output.width);
      const outputContext = output.getContext('2d')!;
      const input = document.createElement('canvas');
      input.width = output.width;
      input.height = output.height;
      const inputContext = input.getContext('2d')!;
      for (const layer of layers) {
        const pixels = inputContext.createImageData(input.width, input.height);
        coordinates.forEach((key, index) => {
          const color = frame.layerOverflow?.[layer.id]?.[key];
          if (color) for (let channel = 0; channel < 4; channel++) pixels.data[index * 4 + channel] = Number.parseInt(color.slice(1 + channel * 2, 3 + channel * 2), 16);
        });
        inputContext.putImageData(pixels, 0, 0);
        outputContext.globalAlpha = layer.opacity / 255;
        outputContext.globalCompositeOperation = layer.blendMode && layer.blendMode !== 'normal' ? layer.blendMode : 'source-over';
        outputContext.drawImage(input, 0, 0);
      }
      const pixels = outputContext.getImageData(0, 0, output.width, output.height).data;
      coordinates.forEach((key, index) => {
        if (pixels[index * 4 + 3]) overflow[key] = `#${Array.from(pixels.slice(index * 4, index * 4 + 4), value => value.toString(16).padStart(2, '0')).join('')}`;
      });
    }
    for (const layer of layers) delete frame.pixels[layer.id];
    if (frame.layerOverflow) for (const layer of layers) delete frame.layerOverflow[layer.id];
    if (coordinates.length) {
      frame.layerOverflow ||= {};
      frame.layerOverflow[survivor.id] = overflow;
    }
    frame.pixels[survivor.id] = buffer.toDataURL('image/png');
  }
  const topId = layers.at(-1)!.id;
  next.layers = source.layers.flatMap(layer => layer.id === topId ? [{ ...survivor, opacity: 255, blendMode: 'normal' as const }] : merging.has(layer.id) ? [] : [structuredClone(layer)]);
  return { document: next, layerId: survivor.id };
}
