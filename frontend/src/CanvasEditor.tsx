import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent, RefObject } from 'react';
import { loadImage } from './api';
import { stepZoom } from './canvasView';
import { drawBoxShape, isShapeTool, shapeEndpoints } from './drawingShapes';
import type { ShapeMode } from './drawingShapes';
import { defaultFillSettings, fillPixels } from './drawingFill';
import { brushStampSpacing, sampleBrushStroke } from './drawingBrush';
import type { BrushStroke } from './drawingBrush';
import type { FillSettings } from './drawingFill';
import type { Frame, Layer, Finding, ColorSampleSource, FrameMetadata } from './types';
import { resizeSelectionPixels, transformSelectionPixels } from './selectionPixels';
import type { SelectionTransform } from './selectionPixels';

export type DrawingTool =
  | 'pencil'
  | 'eraser'
  | 'eyedropper'
  | 'fill'
  | 'line'
  | 'rectangle'
  | 'ellipse'
  | 'select'
  | 'lasso'
  | 'color-select'
  | 'magic-wand'
  | 'pan'
  | 'move-layer';
export type BrushShape = 'square' | 'circle';
type Point = [number, number];
export type Rect = { x: number; y: number; width: number; height: number };
export type CanvasEditorHandle = {
  copySelection: () => void;
  copyMergedSelection: () => void;
  cutSelection: () => void;
  pasteSelection: () => void;
  pasteSystemImage: () => Promise<boolean>;
  deleteSelection: () => void;
  clearSelection: () => void;
  transformSelection: (transform: SelectionTransform) => void;
  resizeSelection: (width: number, height: number) => void;
  positionSelection: (x: number, y: number) => void;
  hasSelection: () => boolean;
  hasClipboard: () => boolean;
  finishStroke: () => void;
  resetView: () => void;
  panBy: (distanceX: number, distanceY: number, pointer?: [number, number]) => void;
};
type Props = {
  frame: Frame;
  layers: Layer[];
  activeLayer: string;
  tool: DrawingTool;
  colorRef: RefObject<string>;
  colorOpacityRef?: RefObject<number>;
  brushSize?: number;
  brushOpacity?: number;
  brushPressure?: boolean;
  brushSpacing?: number;
  brushShape?: BrushShape;
  shapeStrokeSize?: number;
  shapeMode?: ShapeMode;
  fillSettings?: FillSettings;
  eyedropperSample?: ColorSampleSource;
  zoom: number;
  grid: boolean;
  gridColor?: string;
  gridOpacity?: number;
  gridSize?: number;
  backgroundStyle?: 'checker' | 'solid';
  backgroundColor?: string;
  checkerSize?: number;
  guides?: boolean;
  onionFrames?: Frame[];
  onionOpacity?: number;
  onionColor?: string;
  readonly?: boolean;
  label?: string;
  finding?: Finding | null;
  difference?: Rect | null;
  onChange?: (image: string, layerOverflow?: Record<string, string>) => void;
  layerOverflow?: Record<string, string>;
  layerOverflows?: Record<string, Record<string, string>>;
  onPickColor?: (color: string, opacity?: number) => void;
  onZoomChange?: (zoom: number) => void;
  onSelectionChange?: (selection: Rect | null) => void;
  onClipboardChange?: (available: boolean) => void;
  onStrokeStateChange?: (drawing: boolean) => void;
  onFrameMetadataChange?: (metadata: FrameMetadata) => void;
};

function clamp(value: number, max: number) {
  return Math.max(0, Math.min(max - 1, value));
}
function colorToRgba(color: string, opacity = 100): [number, number, number, number] {
  const value = color.replace('#', '').trim();
  const normalized =
    value.length === 3
      ? value
          .split('')
          .map((part) => part + part)
          .join('')
      : value;
  const number = Number.parseInt(normalized || '000000', 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255, Math.round(Math.max(0, Math.min(100, opacity)) * 2.55)];
}
function rgbaToHex(data: Uint8ClampedArray, offset: number) {
  return `#${[data[offset], data[offset + 1], data[offset + 2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
function normalizeRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start[0], end[0]),
    y: Math.min(start[1], end[1]),
    width: Math.abs(end[0] - start[0]) + 1,
    height: Math.abs(end[1] - start[1]) + 1,
  };
}

function cropImageData(source: ImageData, width: number, height: number) {
  if (width === source.width && height === source.height) return source;
  const result = new ImageData(width, height);
  for (let row = 0; row < height; row++) {
    result.data.set(source.data.slice(row * source.width * 4, row * source.width * 4 + width * 4), row * width * 4);
  }
  return result;
}

function contentBounds(image: ImageData): Rect | null {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function contentBoundsWithOverflow(image: ImageData, overflow: Record<string, string>): Rect | null {
  const bounds = contentBounds(image);
  let result = bounds ? { ...bounds } : null;
  for (const key of Object.keys(overflow)) {
    const [x, y] = key.split(',').map(Number);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    result = result
      ? { x: Math.min(result.x, x), y: Math.min(result.y, y), width: Math.max(result.x + result.width - 1, x) - Math.min(result.x, x) + 1, height: Math.max(result.y + result.height - 1, y) - Math.min(result.y, y) + 1 }
      : { x, y, width: 1, height: 1 };
  }
  return result;
}

function storedToRgba(value: string): [number, number, number, number] | null {
  const normalized = value.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{8}$/.test(normalized)) return null;
  return [0, 2, 4, 6].map(index => Number.parseInt(normalized.slice(index, index + 2), 16)) as [number, number, number, number];
}

export const CanvasEditor = forwardRef<CanvasEditorHandle, Props>(function CanvasEditor(props, ref) {
  const {
    frame,
    layers,
    activeLayer,
    tool,
    colorRef,
    colorOpacityRef,
    brushSize = 1,
    brushOpacity = 100,
    brushPressure = false,
    brushSpacing = 100,
    brushShape = 'square',
    shapeStrokeSize = 1,
    shapeMode = 'stroke',
    fillSettings = defaultFillSettings,
    eyedropperSample = 'merged',
    zoom,
    grid,
    gridColor = '#6E7473',
    gridOpacity = 20,
    gridSize = 1,
    backgroundStyle = 'checker',
    backgroundColor = '#FFFFFF',
    checkerSize = 16,
    guides = true,
    onionFrames,
    onionOpacity = 25,
    onionColor = '#218F83',
    readonly,
    finding,
    difference,
    onChange,
    onPickColor,
    onZoomChange,
    onSelectionChange,
    onClipboardChange,
    onStrokeStateChange,
    onFrameMetadataChange,
    layerOverflow = {},
    layerOverflows = {},
    label = '像素编辑画布',
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onionRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const sourceFiles = useRef<Map<string, string>>(new Map());
  const decodedImages = useRef<Map<string, HTMLImageElement>>(new Map());
  const drawing = useRef(false);
  const panDrawing = useRef(false);
  const previous = useRef<Point | null>(null);
  const brushStroke = useRef<BrushStroke | null>(null);
  const start = useRef<Point | null>(null);
  const snapshot = useRef<ImageData | null>(null);
  const shapePointer = useRef<Point | null>(null);
  const moveBuffer = useRef<HTMLCanvasElement | null>(null);
  const moveBounds = useRef<Rect | null>(null);
  const moveStart = useRef<Point | null>(null);
  const moveDelta = useRef<Point>([0, 0]);
  const moveSnapshot = useRef<ImageData | null>(null);
  const moveOverflow = useRef<Record<string, string>>({});
  const [movePreview, setMovePreview] = useState<Record<string, string> | null>(null);
  const changed = useRef(false);
  const ready = useRef(false);
  const drawRef = useRef<() => void>(() => {});
  const [cursor, setCursor] = useState<Point | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Rect | null>(null);
  const selectionRef = useRef<Rect | null>(null);
  const selectionMaskRef = useRef<Uint8Array | null>(null);
  const lassoPath = useRef<Point[]>([]);
  const guideDrag = useRef<'origin' | 'baseline' | null>(null);

  useEffect(() => {
    if (!guideDrag.current) return;
    const move = (event: globalThis.PointerEvent) => {
      const board = canvasRef.current?.getBoundingClientRect();
      if (!board || !onFrameMetadataChange) return;
      const x = Math.max(0, Math.min(frame.width - 1, Math.round((event.clientX - board.left) / zoom)));
      const y = Math.max(0, Math.min(frame.height - 1, Math.round((event.clientY - board.top) / zoom)));
      const metadata: FrameMetadata = { origin: frame.origin ? { ...frame.origin } : { x, y }, baselineY: frame.baselineY, collisionRects: frame.collisionRects };
      if (guideDrag.current === 'origin') metadata.origin = { x, y }; else metadata.baselineY = y;
      onFrameMetadataChange(metadata);
    };
    const end = () => { guideDrag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
  }, [frame, zoom, onFrameMetadataChange]);
  const selectionClipboard = useRef<ImageData | null>(null);
  const selectionSnapshot = useRef<ImageData | null>(null);
  const selectionMoveBuffer = useRef<ImageData | null>(null);
  const selectionMoveStart = useRef<Point | null>(null);
  const selectionMoveOrigin = useRef<Rect | null>(null);
  const selectionMoving = useRef(false);
  const [pan, setPan] = useState<Point>([0, 0]);
  const panStart = useRef<{ pointer: Point; offset: Point } | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const spaceHeld = useRef(false);
  const [panning, setPanning] = useState(false);
  const hovered = useRef(false);
  const capturedPointer = useRef<number | null>(null);
  const zoomAnchor = useRef<{ pixel: Point; pointer: Point } | null>(null);
  const wheelZoom = useRef(zoom);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  wheelZoom.current = zoom;

  wheelHandler.current = event => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    if (!event.ctrlKey || !onZoomChange || !event.deltaY) return;
    event.preventDefault();
    if (drawing.current || panDrawing.current) return;
    const next = stepZoom(wheelZoom.current, event.deltaY < 0 ? 1 : -1);
    if (next === wheelZoom.current) return;
    wheelZoom.current = next;
    const rect = canvasRef.current!.getBoundingClientRect();
    zoomAnchor.current = {
      pixel: [(event.clientX - rect.left) / zoom, (event.clientY - rect.top) / zoom],
      pointer: [event.clientX, event.clientY],
    };
    onZoomChange(next);
  };
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wheel = (event: WheelEvent) => wheelHandler.current(event);
    // React wheel listeners are passive; canvas zoom must prevent page scrolling.
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, []);

  function panBy(distanceX: number, distanceY: number, pointer?: Point) {
    if (drawing.current || panDrawing.current) return;
    setPan(previous => [previous[0] - distanceX / zoom, previous[1] - distanceY / zoom]);
    if (!pointer) { setCursor(null); return; }
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = (pointer[0] - rect.left + distanceX) / zoom;
    const y = (pointer[1] - rect.top + distanceY) / zoom;
    setCursor(x >= 0 && x < frame.width && y >= 0 && y < frame.height ? [Math.floor(x), Math.floor(y)] : null);
  }
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    if (!anchor) return;
    zoomAnchor.current = null;
    const rect = canvasRef.current!.getBoundingClientRect();
    setPan(previous => [
      previous[0] + (anchor.pointer[0] - rect.left - anchor.pixel[0] * zoom) / zoom,
      previous[1] + (anchor.pointer[1] - rect.top - anchor.pixel[1] * zoom) / zoom,
    ]);
  }, [zoom]);
  useEffect(() => {
    const clearNavigation = () => {
      spaceHeld.current = false;
      setSpacePressed(false);
      panDrawing.current = false;
      panStart.current = null;
      setPanning(false);
      const pointer = capturedPointer.current;
      const canvas = canvasRef.current;
      if (!drawing.current && pointer !== null && canvas?.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
      if (!drawing.current) capturedPointer.current = null;
      setCursor(null);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      spaceHeld.current = true;
      setSpacePressed(true);
      if (hovered.current) event.preventDefault();
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceHeld.current = false;
      setSpacePressed(false);
    };
    const visibility = () => { if (document.hidden) clearNavigation(); };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', clearNavigation);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', clearNavigation);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  function updateSelection(next: Rect | null, mask: Uint8Array | null = null) {
    selectionRef.current = next;
    selectionMaskRef.current = mask;
    setSelection(next);
    onSelectionChange?.(next);
  }

  function selectionContext() {
    const layer = layers.find(item => item.id === activeLayer);
    if (readonly || !ready.current || drawing.current || !layer || layer.locked || layer.pixelsLocked || !layer.visible) return null;
    return sourceRef.current.get(activeLayer)?.getContext('2d') ?? null;
  }

  function copySelection(merged = false) {
    const region = selectionRef.current;
    const context = (merged ? canvasRef.current : sourceRef.current.get(activeLayer))?.getContext('2d');
    if (!ready.current || drawing.current || !region || !context) return;
    selectionClipboard.current = context.getImageData(region.x, region.y, region.width, region.height);
    onClipboardChange?.(true);
  }

  function cutSelection() {
    const region = selectionRef.current;
    const context = selectionContext();
    if (!region || !context) return;
    selectionClipboard.current = context.getImageData(region.x, region.y, region.width, region.height);
    onClipboardChange?.(true);
    context.clearRect(region.x, region.y, region.width, region.height);
    drawRef.current();
    emitChange();
  }

  function deleteSelection() {
    const region = selectionRef.current;
    const context = selectionContext();
    if (!region || !context) return;
    context.clearRect(region.x, region.y, region.width, region.height);
    drawRef.current();
    emitChange();
  }

  function pasteSelection() {
    const clipboard = selectionClipboard.current;
    const context = selectionContext();
    if (!clipboard || !context) return;
    const current = selectionRef.current;
    const x = current?.x ?? 0;
    const y = current?.y ?? 0;
    const width = Math.min(clipboard.width, frame.width - x);
    const height = Math.min(clipboard.height, frame.height - y);
    if (width <= 0 || height <= 0) return;
    const cropped = cropImageData(clipboard, width, height);
    context.putImageData(cropped, x, y);
    updateSelection({ x, y, width, height });
    drawRef.current();
    emitChange();
  }

  async function pasteSystemImage() {
    if (!navigator.clipboard?.read) return false;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(value => value === 'image/png' || value === 'image/jpeg' || value === 'image/webp');
        if (!type) continue;
        const url = URL.createObjectURL(await item.getType(type));
        try {
          const image = await loadImage(url);
          const buffer = document.createElement('canvas');
          buffer.width = Math.min(frame.width, image.width);
          buffer.height = Math.min(frame.height, image.height);
          buffer.getContext('2d')!.drawImage(image, 0, 0, buffer.width, buffer.height);
          selectionClipboard.current = buffer.getContext('2d')!.getImageData(0, 0, buffer.width, buffer.height);
          onClipboardChange?.(true);
          pasteSelection();
          return true;
        } finally { URL.revokeObjectURL(url); }
      }
    } catch { return false; }
    return false;
  }

  function moveSelectionBy(dx: number, dy: number) {
    const region = selectionRef.current;
    const context = selectionContext();
    if (!region || !context) return;
    const nextX = Math.max(0, Math.min(frame.width - region.width, region.x + dx));
    const nextY = Math.max(0, Math.min(frame.height - region.height, region.y + dy));
    if (nextX === region.x && nextY === region.y) return;
    const image = context.getImageData(region.x, region.y, region.width, region.height);
    context.clearRect(region.x, region.y, region.width, region.height);
    context.putImageData(image, nextX, nextY);
    updateSelection({ ...region, x: nextX, y: nextY });
    drawRef.current();
    emitChange();
  }

  function replaceSelection(image: ImageData, x?: number, y?: number) {
    const region = selectionRef.current;
    const context = selectionContext();
    if (!region || !context || image.width > frame.width || image.height > frame.height) return;
    const next = {
      x: Math.max(0, Math.min(frame.width - image.width, x ?? Math.floor(region.x + (region.width - image.width) / 2))),
      y: Math.max(0, Math.min(frame.height - image.height, y ?? Math.floor(region.y + (region.height - image.height) / 2))),
      width: image.width,
      height: image.height,
    };
    const before = context.getImageData(0, 0, frame.width, frame.height);
    context.clearRect(region.x, region.y, region.width, region.height);
    context.putImageData(image, next.x, next.y);
    updateSelection(next);
    const after = context.getImageData(0, 0, frame.width, frame.height);
    if (before.data.every((value, index) => value === after.data[index])) return;
    drawRef.current();
    emitChange();
  }

  function transformSelection(transform: SelectionTransform) {
    const region = selectionRef.current;
    const context = selectionContext();
    if (!region || !context) return;
    replaceSelection(transformSelectionPixels(context.getImageData(region.x, region.y, region.width, region.height), transform));
  }

  function resizeSelection(width: number, height: number) {
    const region = selectionRef.current;
    const context = selectionContext();
    if (!region || !context || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > frame.width || height > frame.height) return;
    if (width === region.width && height === region.height) return;
    replaceSelection(resizeSelectionPixels(context.getImageData(region.x, region.y, region.width, region.height), width, height));
  }

  function positionSelection(x: number, y: number) {
    const region = selectionRef.current;
    if (!region || !Number.isInteger(x) || !Number.isInteger(y)) return;
    moveSelectionBy(x - region.x, y - region.y);
  }

  useImperativeHandle(ref, () => ({
    copySelection: () => copySelection(),
    copyMergedSelection: () => copySelection(true),
    cutSelection,
    pasteSelection,
    pasteSystemImage,
    deleteSelection,
    clearSelection: () => updateSelection(null),
    transformSelection,
    resizeSelection,
    positionSelection,
    hasSelection: () => selectionRef.current !== null,
    hasClipboard: () => selectionClipboard.current !== null,
    finishStroke: () => finish(),
    resetView: () => {
      if (drawing.current || panDrawing.current) return;
      setPan([0, 0]);
      setCursor(null);
    },
    panBy,
  }), [frame, layers, activeLayer, readonly, zoom]);

  drawRef.current = () => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, frame.width, frame.height);
    context.imageSmoothingEnabled = false;
    for (const layer of layers) {
      const image = sourceRef.current.get(layer.id);
      if (image && layer.visible) {
        context.globalAlpha = layer.opacity / 255;
        context.globalCompositeOperation = (layer.blendMode && layer.blendMode !== 'normal' ? layer.blendMode : 'source-over') as GlobalCompositeOperation;
        context.drawImage(image, 0, 0);
      }
    }
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
  };
  useEffect(() => {
    let cancelled = false;
    const entries = Object.entries(frame.pixels);
    const currentBuffer = (id: string, source: string) => {
      const buffer = sourceRef.current.get(id);
      return sourceFiles.current.get(id) === source && buffer?.width === frame.width && buffer.height === frame.height ? buffer : null;
    };
    if (entries.length === sourceRef.current.size && entries.every(([id, source]) => currentBuffer(id, source))) {
      ready.current = true;
      setLoading(false);
      drawRef.current();
      return;
    }
    ready.current = false;
    setLoading(true);
    drawing.current = false;
    previous.current = null;
    brushStroke.current = null;
    Promise.all(
      entries.map(async ([id, source]) => {
        const existing = currentBuffer(id, source);
        if (existing) return [id, existing] as const;
        const image = decodedImages.current.get(source) ?? await loadImage(source);
        if (decodedImages.current.size >= 32) decodedImages.current.clear();
        decodedImages.current.set(source, image);
        const buffer = document.createElement('canvas');
        buffer.width = frame.width;
        buffer.height = frame.height;
        const context = buffer.getContext('2d')!;
        context.imageSmoothingEnabled = false;
        context.drawImage(image, 0, 0);
        return [id, buffer] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) {
          sourceRef.current = new Map(entries);
          sourceFiles.current = new Map(Object.entries(frame.pixels));
          ready.current = true;
          setLoading(false);
          drawRef.current();
        }
      })
      .catch(() => {
        ready.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [frame]);
  useEffect(() => {
    updateSelection(null);
    setPan([0, 0]);
  }, [frame.id, frame.width, frame.height]);
  useEffect(() => {
    onClipboardChange?.(selectionClipboard.current !== null);
  }, [onClipboardChange]);
  useEffect(() => {
    drawRef.current();
  }, [layers]);
  useEffect(() => {
    const context = onionRef.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, frame.width, frame.height);
    let cancelled = false;
    Promise.all((onionFrames ?? []).map(async ghost => {
      const buffer = document.createElement('canvas');
      buffer.width = ghost.width;
      buffer.height = ghost.height;
      const ctx = buffer.getContext('2d')!;
      const images = await Promise.all(layers.filter(layer => layer.visible).map(async layer => ({ layer, image: await loadImage(ghost.pixels[layer.id]) })));
      for (const { layer, image } of images) { ctx.globalAlpha = layer.opacity / 255; ctx.drawImage(image, 0, 0); }
      return buffer;
    })).then(buffers => {
      if (cancelled) return;
      context.globalAlpha = Math.max(.05, Math.min(1, onionOpacity / 100));
      const color = onionColor.replace('#', '');
      context.globalCompositeOperation = 'source-over';
      for (const buffer of buffers) {
        context.drawImage(buffer, 0, 0);
        if (color.length === 6) {
          context.globalCompositeOperation = 'multiply';
          context.fillStyle = onionColor;
          context.fillRect(0, 0, frame.width, frame.height);
          context.globalCompositeOperation = 'source-over';
        }
      }
      context.globalAlpha = 1;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [frame.width, frame.height, onionFrames, layers]);
  function position(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      clamp(Math.floor(((event.clientX - rect.left) * frame.width) / rect.width), frame.width),
      clamp(Math.floor(((event.clientY - rect.top) * frame.height) / rect.height), frame.height),
    ];
  }
  function inside(x: number, y: number) {
    if (selectionMaskRef.current) return selectionMaskRef.current[y * frame.width + x] === 1;
    return (
      !selection ||
      (x >= selection.x &&
        y >= selection.y &&
        x < selection.x + selection.width &&
        y < selection.y + selection.height)
    );
  }

  function maskBounds(mask: Uint8Array) {
    let left = frame.width, top = frame.height, right = -1, bottom = -1;
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) if (mask[y * frame.width + x]) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  }
  function pointInPolygon(x: number, y: number, polygon: Point[]) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1) + xi) inside = !inside;
    }
    return inside;
  }
  function selectLasso() {
    const polygon = lassoPath.current;
    if (polygon.length < 3) { updateSelection(null); return; }
    const mask = new Uint8Array(frame.width * frame.height);
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) if (pointInPolygon(x + .5, y + .5, polygon)) mask[y * frame.width + x] = 1;
    updateSelection(maskBounds(mask), mask);
  }
  function selectByColor(point: Point, contiguous: boolean) {
    const source = sourceRef.current.get(activeLayer)?.getContext('2d');
    if (!source) return;
    const data = source.getImageData(0, 0, frame.width, frame.height).data;
    const origin = (point[1] * frame.width + point[0]) * 4;
    const target = [data[origin], data[origin + 1], data[origin + 2], data[origin + 3]];
    const mask = new Uint8Array(frame.width * frame.height);
    const matches = (x: number, y: number) => { const i = (y * frame.width + x) * 4; return Math.max(Math.abs(data[i] - target[0]), Math.abs(data[i + 1] - target[1]), Math.abs(data[i + 2] - target[2]), Math.abs(data[i + 3] - target[3])) <= 12; };
    if (contiguous) {
      const queue: Point[] = [point]; mask[point[1] * frame.width + point[0]] = 1;
      for (let index = 0; index < queue.length; index++) { const [x, y] = queue[index]; for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as Point[]) if (nx >= 0 && ny >= 0 && nx < frame.width && ny < frame.height && !mask[ny * frame.width + nx] && matches(nx, ny)) { mask[ny * frame.width + nx] = 1; queue.push([nx, ny]); } }
    } else for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) if (matches(x, y)) mask[y * frame.width + x] = 1;
    updateSelection(maskBounds(mask), mask);
  }
  function setPixel(context: CanvasRenderingContext2D, x: number, y: number, erase = false, size = 1, shape: BrushShape = 'square') {
    const normalizedSize = Math.max(1, Math.min(16, Math.round(size)));
    const offset = Math.floor((normalizedSize - 1) / 2);
    const left = x - offset;
    const top = y - offset;
    for (let brushY = top; brushY < top + normalizedSize; brushY++) {
      for (let brushX = left; brushX < left + normalizedSize; brushX++) {
        if (shape === 'circle') {
          const radius = Math.max(0.5, (normalizedSize - 1) / 2 + 0.25);
          const center = (normalizedSize - 1) / 2;
          const distanceX = brushX - left - center;
          const distanceY = brushY - top - center;
          if (distanceX * distanceX + distanceY * distanceY > radius * radius) continue;
        }
        if (brushX < 0 || brushY < 0 || brushX >= frame.width || brushY >= frame.height || !inside(brushX, brushY)) continue;
        if (erase) context.clearRect(brushX, brushY, 1, 1);
        else context.fillRect(brushX, brushY, 1, 1);
      }
    }
  }
  function line(context: CanvasRenderingContext2D, from: Point, to: Point, erase = false, size = 1, shape: BrushShape = 'square') {
    const dx = Math.abs(to[0] - from[0]);
    const sx = from[0] < to[0] ? 1 : -1;
    const dy = -Math.abs(to[1] - from[1]);
    const sy = from[1] < to[1] ? 1 : -1;
    let error = dx + dy;
    let x = from[0];
    let y = from[1];
    while (true) {
      setPixel(context, x, y, erase, size, shape);
      if (x === to[0] && y === to[1]) break;
      const twice = 2 * error;
      if (twice >= dy) {
        error += dy;
        x += sx;
      }
      if (twice <= dx) {
        error += dx;
        y += sy;
      }
    }
  }
  function previewShape(point: Point, shift: boolean, alt: boolean) {
    if (!isShapeTool(tool) || !start.current || !snapshot.current) return;
    const context = sourceRef.current.get(activeLayer)?.getContext('2d');
    if (!context) return;
    shapePointer.current = point;
    context.globalAlpha = 1;
    context.putImageData(snapshot.current, 0, 0);
    context.fillStyle = colorRef.current;
    context.globalAlpha = Math.max(0, Math.min(1, (colorOpacityRef?.current ?? 100) / 100));
    context.globalCompositeOperation = (colorOpacityRef?.current ?? 100) === 0 ? 'destination-out' : 'source-over';
    const [from, to] = shapeEndpoints(tool, start.current, point, shift, alt);
    const stroke = Math.max(1, Math.min(16, Math.round(shapeStrokeSize)));
    if (tool === 'line') line(context, from, to, false, stroke);
    else drawBoxShape(context, tool, from, to, stroke, shapeMode, inside);
    context.globalCompositeOperation = 'source-over';
    changed.current = true;
    drawRef.current();
  }
  function samplingContext(source: ColorSampleSource) {
    return (source === 'merged' ? canvasRef.current : sourceRef.current.get(activeLayer))?.getContext('2d');
  }
  function fillAt(point: Point, context: CanvasRenderingContext2D) {
    const image = context.getImageData(0, 0, frame.width, frame.height);
    const sampleContext = samplingContext(fillSettings.sample);
    if (!sampleContext) return false;
    const reference = sampleContext.getImageData(0, 0, frame.width, frame.height);
    const replacement = colorToRgba(colorRef.current, colorOpacityRef?.current ?? 100);
    if (!fillPixels(image, reference, point, replacement, fillSettings, inside)) return false;
    context.putImageData(image, 0, 0);
    return true;
  }
  function emitChange(nextOverflow: Record<string, string> = layerOverflow) {
    const image = sourceRef.current.get(activeLayer);
    if (image) {
      const source = image.toDataURL('image/png');
      sourceFiles.current.set(activeLayer, source);
      onChange?.(source, nextOverflow);
    }
  }

  function commitLayerMove(dx: number, dy: number) {
    const source = moveSnapshot.current;
    const context = sourceRef.current.get(activeLayer)?.getContext('2d');
    if (!source || !context) return undefined;
    const output = new ImageData(frame.width, frame.height);
    const overflow: Record<string, string> = {};
    const put = (x: number, y: number, rgba: [number, number, number, number]) => {
      if (rgba[3] === 0) return;
      if (x >= 0 && y >= 0 && x < frame.width && y < frame.height) {
        const offset = (y * frame.width + x) * 4;
        output.data.set(rgba, offset);
      } else overflow[`${x},${y}`] = `#${rgba.map(value => value.toString(16).padStart(2, '0')).join('')}`;
    };
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const offset = (y * source.width + x) * 4;
      put(x + dx, y + dy, [source.data[offset], source.data[offset + 1], source.data[offset + 2], source.data[offset + 3]]);
    }
    for (const [key, value] of Object.entries(moveOverflow.current)) {
      const [x, y] = key.split(',').map(Number);
      const rgba = storedToRgba(value);
      if (rgba && Number.isInteger(x) && Number.isInteger(y)) put(x + dx, y + dy, rgba);
    }
    context.putImageData(output, 0, 0);
    drawRef.current();
    return overflow;
  }
  function paint(event: PointerEvent<HTMLCanvasElement>) {
    const point = position(event);
    setCursor(point);
    if (panDrawing.current && panStart.current) {
      setPan([
        panStart.current.offset[0] + (event.clientX - panStart.current.pointer[0]) / zoom,
        panStart.current.offset[1] + (event.clientY - panStart.current.pointer[1]) / zoom,
      ]);
      return;
    }
    if (!drawing.current || !start.current) return;
    const context = sourceRef.current.get(activeLayer)?.getContext('2d');
    if (!context) return;
    context.imageSmoothingEnabled = false;
    if (tool === 'lasso') {
      lassoPath.current.push(point);
      selectLasso();
      drawRef.current();
      return;
    }
    if ((tool === 'select' || tool === 'color-select' || tool === 'magic-wand') && selectionMoving.current) {
      const buffer = selectionMoveBuffer.current;
      const origin = selectionMoveOrigin.current;
      const pointer = selectionMoveStart.current;
      const base = selectionSnapshot.current;
      if (buffer && origin && pointer && base) {
        context.putImageData(base, 0, 0);
        const dx = Math.max(-origin.x, Math.min(frame.width - origin.x - origin.width, Math.round((event.clientX - pointer[0]) / zoom)));
        const dy = Math.max(-origin.y, Math.min(frame.height - origin.y - origin.height, Math.round((event.clientY - pointer[1]) / zoom)));
        context.clearRect(origin.x, origin.y, origin.width, origin.height);
        context.putImageData(buffer, origin.x + dx, origin.y + dy);
        updateSelection({ ...origin, x: origin.x + dx, y: origin.y + dy });
        changed.current = dx !== 0 || dy !== 0;
      }
      drawRef.current();
      return;
    }
    if (tool === 'select') {
      updateSelection(normalizeRect(start.current, point));
      return;
    }
    if (tool === 'move-layer') {
      const buffer = moveBuffer.current;
      const bounds = moveBounds.current;
      const pointer = moveStart.current;
      if (buffer && bounds && pointer) {
        const dx = Math.round((event.clientX - pointer[0]) / zoom);
        const dy = Math.round((event.clientY - pointer[1]) / zoom);
        moveDelta.current = [dx, dy];
        setMovePreview(commitLayerMove(dx, dy) ?? null);
        changed.current = dx !== 0 || dy !== 0;
      }
    } else if (tool === 'pencil' || tool === 'eraser') {
      // Pointer movement within a pixel and pointer-up must not stamp it again.
      if (previous.current?.[0] === point[0] && previous.current[1] === point[1]) return;
      context.fillStyle = colorRef.current;
      const transparent = (colorOpacityRef?.current ?? 100) === 0;
      const pressure = brushPressure && event.pointerType === 'pen' ? Math.max(0.05, Math.min(1, event.pressure || 0.5)) : 1;
      context.globalAlpha = tool === 'eraser' || transparent ? 1 : Math.max(0, Math.min(1, (brushOpacity / 100) * ((colorOpacityRef?.current ?? 100) / 100) * pressure));
      context.globalCompositeOperation = transparent ? 'destination-out' : 'source-over';
      if (tool === 'eraser') {
        line(context, previous.current ?? point, point, true, brushSize, brushShape);
      } else {
        brushStroke.current = sampleBrushStroke(brushStroke.current, point, brushStampSpacing(brushSize, brushSpacing),
          (x, y) => setPixel(context, x, y, transparent, brushSize, brushShape));
      }
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      previous.current = point;
      changed.current = true;
    } else if (isShapeTool(tool)) {
      previewShape(point, event.shiftKey, event.altKey);
      return;
    }
    drawRef.current();
  }
  function finish(cancelled = false) {
    onStrokeStateChange?.(false);
    if (panDrawing.current) {
      panDrawing.current = false;
      panStart.current = null;
      setPanning(false);
      return;
    }
    if (!drawing.current) return;
    drawing.current = false;
    if (cancelled && snapshot.current) {
      const context = sourceRef.current.get(activeLayer)?.getContext('2d');
      if (context) { context.putImageData(snapshot.current, 0, 0); drawRef.current(); }
      changed.current = false;
    }
    if (cancelled && moveBuffer.current) {
      const context = sourceRef.current.get(activeLayer)?.getContext('2d');
      if (context) {
        context.clearRect(0, 0, frame.width, frame.height);
        context.drawImage(moveBuffer.current, 0, 0);
        drawRef.current();
      }
      changed.current = false;
    }
    if (cancelled && selectionMoving.current && selectionSnapshot.current) {
      const context = sourceRef.current.get(activeLayer)?.getContext('2d');
      if (context) {
        context.putImageData(selectionSnapshot.current, 0, 0);
        drawRef.current();
      }
      if (selectionMoveOrigin.current) updateSelection(selectionMoveOrigin.current);
      changed.current = false;
    }
    previous.current = null;
    brushStroke.current = null;
    shapePointer.current = null;
    snapshot.current = null;
    let nextOverflow: Record<string, string> | undefined;
    if (!cancelled && tool === 'move-layer' && changed.current) nextOverflow = commitLayerMove(moveDelta.current[0], moveDelta.current[1]);
    moveBuffer.current = null;
    moveBounds.current = null;
    moveStart.current = null;
    moveSnapshot.current = null;
    moveOverflow.current = {};
    setMovePreview(null);
    selectionMoving.current = false;
    selectionSnapshot.current = null;
    selectionMoveBuffer.current = null;
    selectionMoveStart.current = null;
    selectionMoveOrigin.current = null;
    start.current = null;
    if (changed.current) emitChange(nextOverflow);
    changed.current = false;
  }
  useEffect(() => {
    const cancelMove = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (drawing.current && shapePointer.current && (event.key === 'Shift' || event.key === 'Alt')) {
        previewShape(shapePointer.current, event.shiftKey, event.altKey);
      }
      if (event.type === 'keydown' && event.key === 'Escape' && drawing.current && (moveBuffer.current || selectionMoving.current || snapshot.current)) {
        event.preventDefault();
        finish(true);
      }
      if (event.type === 'keydown' && event.key === 'Escape' && !drawing.current && selectionRef.current) {
        event.preventDefault();
        updateSelection(null);
      }
      if (event.type === 'keydown' && !drawing.current && (tool === 'select' || tool === 'lasso' || tool === 'color-select' || tool === 'magic-wand') && selectionRef.current && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const delta: Point = event.key === 'ArrowLeft' ? [-1, 0] : event.key === 'ArrowRight' ? [1, 0] : event.key === 'ArrowUp' ? [0, -1] : [0, 1];
        moveSelectionBy(delta[0], delta[1]);
      }
    };
    window.addEventListener('keydown', cancelMove);
    window.addEventListener('keyup', cancelMove);
    return () => {
      window.removeEventListener('keydown', cancelMove);
      window.removeEventListener('keyup', cancelMove);
    };
  }, [frame, activeLayer, tool, readonly, shapeStrokeSize, shapeMode]);
  const selected = layers.find((layer) => layer.id === activeLayer);
  const region = finding?.frameId === frame.id ? finding.region : null;
  const gridLineColor = (() => {
    const value = gridColor.replace('#', '').trim();
    const number = Number.parseInt(value.length === 3 ? value.split('').map(part => part + part).join('') : value, 16);
    const alpha = Math.max(0.05, Math.min(1, gridOpacity / 100));
    return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
  })();
  const cursorClass =
    panning || spacePressed || tool === 'pan'
      ? `pan-cursor${panning ? ' is-panning' : ''}`
      : ['select', 'lasso', 'color-select', 'magic-wand'].includes(tool)
        ? 'select-cursor'
        : tool === 'eyedropper'
          ? 'eyedropper-cursor'
          : tool === 'fill'
            ? 'fill-cursor'
            : tool === 'move-layer'
              ? 'move-layer-cursor'
              : !readonly && (tool === 'pencil' || tool === 'eraser')
                ? 'brush-tool-cursor'
                : '';
  return (
    <div className="canvas-wrap">
      <div
        className="pixel-board"
        style={{
          width: frame.width * zoom,
          height: frame.height * zoom,
          transform: `translate(${pan[0] * zoom}px, ${pan[1] * zoom}px)`,
          backgroundColor: backgroundStyle === 'solid' ? backgroundColor : '#FFFFFF',
          backgroundImage: backgroundStyle === 'checker' ? `conic-gradient(#E5E8EB 25%, transparent 0 50%, #E5E8EB 0 75%, transparent 0)` : 'none',
          backgroundSize: backgroundStyle === 'checker' ? `${checkerSize}px ${checkerSize}px` : 'auto',
        }}
      >
        <div className="overflow-pixels" aria-hidden="true">{layers.flatMap(layer => {
          if (!layer.visible || !layer.opacity) return [];
          const pixels = layer.id === activeLayer && movePreview !== null ? movePreview : layerOverflows[layer.id] || {};
          return Object.entries(pixels).map(([key, value]) => {
            const rgba = storedToRgba(value);
            if (!rgba || rgba[3] === 0) return null;
            const [x, y] = key.split(',').map(Number);
            if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
            return <span key={`${layer.id}:${key}`} className="overflow-pixel" style={{ left: x * zoom, top: y * zoom, width: zoom, height: zoom, mixBlendMode: layer.blendMode || 'normal', backgroundColor: `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${(rgba[3] / 255) * (layer.opacity / 255)})` }} />;
          });
        })}</div>
        <canvas ref={onionRef} width={frame.width} height={frame.height} className="onion-overlay" aria-label="洋葱皮预览画布" />
        <canvas
          ref={canvasRef}
          width={frame.width}
          height={frame.height}
          aria-label={label}
          aria-busy={loading}
          className={cursorClass}
          onPointerDown={(event) => {
            if (drawing.current || panDrawing.current) return;
            if (event.button === 1 || (event.button === 0 && (tool === 'pan' || spaceHeld.current))) {
              event.preventDefault();
              capturedPointer.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              panDrawing.current = true;
              panStart.current = { pointer: [event.clientX, event.clientY], offset: pan };
              setPanning(true);
              setCursor(null);
              return;
            }
            if (readonly || !ready.current || event.button !== 0) return;
            const point = position(event);
            setCursor(point);
            capturedPointer.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            if (tool === 'eyedropper') {
              const data = samplingContext(eyedropperSample)?.getImageData(point[0], point[1], 1, 1).data;
              if (data && data[3] > 0) onPickColor?.(rgbaToHex(data, 0), Math.round(data[3] / 2.55));
              return;
            }
            if (tool === 'color-select' || tool === 'magic-wand') {
              selectByColor(point, tool === 'magic-wand');
              return;
            }
            if (tool === 'lasso') {
              onStrokeStateChange?.(true);
              drawing.current = true;
              start.current = point;
              lassoPath.current = [point];
              updateSelection(normalizeRect(point, point));
              return;
            }
            if (tool === 'select') {
              onStrokeStateChange?.(true);
              const current = selectionRef.current;
              if (current && point[0] >= current.x && point[0] < current.x + current.width && point[1] >= current.y && point[1] < current.y + current.height && selected && !selected.locked && !selected.pixelsLocked && selected.visible) {
                const context = sourceRef.current.get(activeLayer)?.getContext('2d');
                if (context) {
                  drawing.current = true;
                  start.current = point;
                  previous.current = null;
                  changed.current = false;
                  selectionMoving.current = true;
                  selectionMoveOrigin.current = current;
                  selectionMoveStart.current = [event.clientX, event.clientY];
                  selectionMoveBuffer.current = context.getImageData(current.x, current.y, current.width, current.height);
                  selectionSnapshot.current = context.getImageData(0, 0, frame.width, frame.height);
                }
              } else {
                drawing.current = true;
                start.current = point;
                previous.current = null;
                changed.current = false;
                updateSelection(normalizeRect(point, point));
              }
              paint(event);
              return;
            }
            if (!selected || selected.locked || selected.pixelsLocked || !selected.visible) return;
            const context = sourceRef.current.get(activeLayer)?.getContext('2d');
            if (!context) return;
            if (tool === 'fill') {
              context.imageSmoothingEnabled = false;
              context.globalAlpha = Math.max(0, Math.min(1, (colorOpacityRef?.current ?? 100) / 100));
              context.fillStyle = colorRef.current;
              if (fillAt(point, context)) {
                drawRef.current();
                emitChange();
              }
              return;
            }
            drawing.current = true;
            onStrokeStateChange?.(true);
            start.current = point;
            previous.current = null;
            brushStroke.current = null;
            changed.current = false;
            if (tool === 'move-layer') {
              const pixels = context.getImageData(0, 0, frame.width, frame.height);
              moveSnapshot.current = pixels;
              moveOverflow.current = structuredClone(layerOverflow);
              moveBounds.current = contentBoundsWithOverflow(pixels, moveOverflow.current);
              moveStart.current = [event.clientX, event.clientY];
              moveDelta.current = [0, 0];
              const buffer = document.createElement('canvas');
              buffer.width = frame.width;
              buffer.height = frame.height;
              buffer
                .getContext('2d')!
                .putImageData(pixels, 0, 0);
              moveBuffer.current = buffer;
            } else if (tool === 'line' || tool === 'rectangle' || tool === 'ellipse')
              snapshot.current = context.getImageData(0, 0, frame.width, frame.height);
            paint(event);
          }}
          onPointerMove={paint}
          onPointerUp={event => {
            if (event.pointerId !== capturedPointer.current || event.button === 2) return;
            paint(event);
            if (tool === 'lasso') selectLasso();
            finish();
            capturedPointer.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            const bounds = event.currentTarget.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) setCursor(null);
          }}
          onPointerCancel={() => { finish(true); capturedPointer.current = null; }}
          onLostPointerCapture={() => { finish(true); capturedPointer.current = null; }}
          onPointerEnter={() => { hovered.current = true; }}
          onPointerLeave={() => { hovered.current = false; setCursor(null); }}
          onAuxClick={event => { if (event.button === 1) event.preventDefault(); }}
        />
        {grid && zoom >= 5 ? (
          <div className="pixel-grid" style={{ backgroundSize: `${zoom * gridSize}px ${zoom * gridSize}px`, backgroundImage: `linear-gradient(to right, ${gridLineColor} 1px, transparent 1px), linear-gradient(to bottom, ${gridLineColor} 1px, transparent 1px)` }} />
        ) : null}
        {selection ? (
          <div
            className="selection-region"
            style={{
              left: selection.x * zoom,
              top: selection.y * zoom,
              width: selection.width * zoom,
              height: selection.height * zoom,
            }}
          />
        ) : null}
        {guides && frame.origin ? (
          <>
            <div className="origin-guide-x" style={{ left: frame.origin.x * zoom }} />
            <div className="origin-guide-y" style={{ top: frame.origin.y * zoom }} />
            <span
              className="origin-marker"
              aria-label="帧原点标记"
              title={`原点 ${frame.origin.x}, ${frame.origin.y}`}
              style={{ left: frame.origin.x * zoom, top: frame.origin.y * zoom }}
              onPointerDown={event => { event.preventDefault(); event.stopPropagation(); guideDrag.current = 'origin'; }}
            />
          </>
        ) : null}
        {guides && frame.baselineY !== null ? (
          <div className="baseline-guide" style={{ top: frame.baselineY * zoom }}>
            <span onPointerDown={event => { event.preventDefault(); event.stopPropagation(); guideDrag.current = 'baseline'; }}>基线 {frame.baselineY}</span>
          </div>
        ) : null}
        {guides ? frame.collisionRects.map((rect, index) => <div key={index} className="collision-region" aria-label={`碰撞框 ${index + 1}`} style={{ left: rect.x * zoom, top: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom }} />) : null}
        {region ? (
          <div
            className="finding-region"
            style={{
              left: region.x * zoom,
              top: region.y * zoom,
              width: region.width * zoom,
              height: region.height * zoom,
            }}
          />
        ) : null}
        {difference && difference.width > 0 && difference.height > 0 && difference.x < frame.width && difference.y < frame.height ? <div className="difference-region" aria-label="修复像素变化范围" style={{ left: difference.x * zoom, top: difference.y * zoom, width: Math.min(difference.width, frame.width - difference.x) * zoom, height: Math.min(difference.height, frame.height - difference.y) * zoom }} /> : null}
        {cursor && !readonly && !spacePressed && !panning && (tool === 'pencil' || tool === 'eraser') && ready.current ? (() => {
          const size = Math.max(1, Math.min(16, Math.round(brushSize)));
          const offset = Math.floor((size - 1) / 2);
          return (
            <div
              className={`brush-cursor ${brushShape === 'circle' ? 'circle' : 'square'} ${tool === 'eraser' ? 'eraser' : ''}`}
              aria-label="画笔范围预览"
              style={{ left: (cursor[0] - offset) * zoom, top: (cursor[1] - offset) * zoom, width: size * zoom, height: size * zoom }}
            />
          );
        })() : null}
      </div>
      <span className="coordinates">
        {cursor ? `${cursor[0]}, ${cursor[1]}` : `${frame.width} × ${frame.height}`}
      </span>
    </div>
  );
});
