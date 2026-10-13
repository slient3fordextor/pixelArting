import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PointerEvent, RefObject } from 'react';
import { loadImage } from './api';
import type { Frame, Layer, Finding } from './types';

export type DrawingTool =
  | 'pencil'
  | 'eraser'
  | 'eyedropper'
  | 'fill'
  | 'line'
  | 'rectangle'
  | 'ellipse'
  | 'select'
  | 'pan'
  | 'move-layer';
type Point = [number, number];
export type Rect = { x: number; y: number; width: number; height: number };
export type CanvasEditorHandle = {
  copySelection: () => void;
  cutSelection: () => void;
  pasteSelection: () => void;
  deleteSelection: () => void;
  clearSelection: () => void;
  hasSelection: () => boolean;
  hasClipboard: () => boolean;
};
type Props = {
  frame: Frame;
  layers: Layer[];
  activeLayer: string;
  tool: DrawingTool;
  colorRef: RefObject<string>;
  zoom: number;
  grid: boolean;
  guides?: boolean;
  readonly?: boolean;
  label?: string;
  finding?: Finding | null;
  onChange?: (image: string) => void;
  onPickColor?: (color: string) => void;
  onSelectionChange?: (selection: Rect | null) => void;
  onClipboardChange?: (available: boolean) => void;
};

function clamp(value: number, max: number) {
  return Math.max(0, Math.min(max - 1, value));
}
function colorToRgba(color: string): [number, number, number, number] {
  const value = color.replace('#', '').trim();
  const normalized =
    value.length === 3
      ? value
          .split('')
          .map((part) => part + part)
          .join('')
      : value;
  const number = Number.parseInt(normalized || '000000', 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255, 255];
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

export const CanvasEditor = forwardRef<CanvasEditorHandle, Props>(function CanvasEditor(props, ref) {
  const {
    frame,
    layers,
    activeLayer,
    tool,
    colorRef,
    zoom,
    grid,
    guides = true,
    readonly,
    finding,
    onChange,
    onPickColor,
    onSelectionChange,
    onClipboardChange,
    label = '像素编辑画布',
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const sourceFiles = useRef<Map<string, string>>(new Map());
  const decodedImages = useRef<Map<string, HTMLImageElement>>(new Map());
  const drawing = useRef(false);
  const panDrawing = useRef(false);
  const previous = useRef<Point | null>(null);
  const start = useRef<Point | null>(null);
  const snapshot = useRef<ImageData | null>(null);
  const moveBuffer = useRef<HTMLCanvasElement | null>(null);
  const moveBounds = useRef<Rect | null>(null);
  const moveStart = useRef<Point | null>(null);
  const changed = useRef(false);
  const ready = useRef(false);
  const drawRef = useRef<() => void>(() => {});
  const [cursor, setCursor] = useState<Point | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Rect | null>(null);
  const selectionRef = useRef<Rect | null>(null);
  const selectionClipboard = useRef<ImageData | null>(null);
  const selectionSnapshot = useRef<ImageData | null>(null);
  const selectionMoveBuffer = useRef<ImageData | null>(null);
  const selectionMoveStart = useRef<Point | null>(null);
  const selectionMoveOrigin = useRef<Rect | null>(null);
  const selectionMoving = useRef(false);
  const [pan, setPan] = useState<Point>([0, 0]);
  const panStart = useRef<{ pointer: Point; offset: Point } | null>(null);

  function updateSelection(next: Rect | null) {
    selectionRef.current = next;
    setSelection(next);
    onSelectionChange?.(next);
  }

  function selectionContext() {
    const layer = layers.find(item => item.id === activeLayer);
    if (readonly || !layer || layer.locked || !layer.visible) return null;
    return sourceRef.current.get(activeLayer)?.getContext('2d') ?? null;
  }

  function copySelection() {
    const region = selectionRef.current;
    const context = canvasRef.current?.getContext('2d');
    if (!region || !context) return;
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

  useImperativeHandle(ref, () => ({
    copySelection,
    cutSelection,
    pasteSelection,
    deleteSelection,
    clearSelection: () => updateSelection(null),
    hasSelection: () => selectionRef.current !== null,
    hasClipboard: () => selectionClipboard.current !== null,
  }), [frame, layers, activeLayer, readonly]);

  drawRef.current = () => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, frame.width, frame.height);
    context.imageSmoothingEnabled = false;
    for (const layer of layers) {
      const image = sourceRef.current.get(layer.id);
      if (image && layer.visible) {
        context.globalAlpha = layer.opacity / 255;
        context.drawImage(image, 0, 0);
      }
    }
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
  function position(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      clamp(Math.floor(((event.clientX - rect.left) * frame.width) / rect.width), frame.width),
      clamp(Math.floor(((event.clientY - rect.top) * frame.height) / rect.height), frame.height),
    ];
  }
  function inside(x: number, y: number) {
    return (
      !selection ||
      (x >= selection.x &&
        y >= selection.y &&
        x < selection.x + selection.width &&
        y < selection.y + selection.height)
    );
  }
  function setPixel(context: CanvasRenderingContext2D, x: number, y: number, erase = false) {
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height || !inside(x, y)) return;
    if (erase) context.clearRect(x, y, 1, 1);
    else {
      context.clearRect(x, y, 1, 1);
      context.fillRect(x, y, 1, 1);
    }
  }
  function line(context: CanvasRenderingContext2D, from: Point, to: Point, erase = false) {
    const dx = Math.abs(to[0] - from[0]);
    const sx = from[0] < to[0] ? 1 : -1;
    const dy = -Math.abs(to[1] - from[1]);
    const sy = from[1] < to[1] ? 1 : -1;
    let error = dx + dy;
    let x = from[0];
    let y = from[1];
    while (true) {
      setPixel(context, x, y, erase);
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
  function shape(context: CanvasRenderingContext2D, from: Point, to: Point) {
    context.fillStyle = colorRef.current;
    if (tool === 'line') line(context, from, to);
    if (tool === 'rectangle') {
      const box = normalizeRect(from, to);
      line(context, [box.x, box.y], [box.x + box.width - 1, box.y]);
      line(context, [box.x, box.y], [box.x, box.y + box.height - 1]);
      line(context, [box.x + box.width - 1, box.y], [box.x + box.width - 1, box.y + box.height - 1]);
      line(context, [box.x, box.y + box.height - 1], [box.x + box.width - 1, box.y + box.height - 1]);
    }
    if (tool === 'ellipse') {
      const box = normalizeRect(from, to);
      const centerX = box.x + (box.width - 1) / 2;
      const centerY = box.y + (box.height - 1) / 2;
      const radiusX = Math.max((box.width - 1) / 2, 0.5);
      const radiusY = Math.max((box.height - 1) / 2, 0.5);
      for (let step = 0; step < 720; step++) {
        const angle = (step * Math.PI) / 360;
        setPixel(
          context,
          Math.round(centerX + radiusX * Math.cos(angle)),
          Math.round(centerY + radiusY * Math.sin(angle)),
        );
      }
    }
  }
  function fillAt(point: Point, context: CanvasRenderingContext2D) {
    const image = context.getImageData(0, 0, frame.width, frame.height);
    const targetOffset = (point[1] * frame.width + point[0]) * 4;
    const target = Array.from(image.data.slice(targetOffset, targetOffset + 4));
    const replacement = colorToRgba(colorRef.current);
    if (target.every((value, index) => value === replacement[index])) return false;
    const stack: Point[] = [point];
    const visited = new Uint8Array(frame.width * frame.height);
    while (stack.length) {
      const [x, y] = stack.pop()!;
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height || !inside(x, y)) continue;
      const index = y * frame.width + x;
      if (visited[index]) continue;
      visited[index] = 1;
      const offset = index * 4;
      if (!target.every((value, channel) => image.data[offset + channel] === value)) continue;
      image.data.set(replacement, offset);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    context.putImageData(image, 0, 0);
    return true;
  }
  function emitChange() {
    const image = sourceRef.current.get(activeLayer);
    if (image) {
      const source = image.toDataURL('image/png');
      sourceFiles.current.set(activeLayer, source);
      onChange?.(source);
    }
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
    if (tool === 'select' && selectionMoving.current) {
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
        const dx = Math.max(-bounds.x, Math.min(frame.width - bounds.x - bounds.width, Math.round((event.clientX - pointer[0]) / zoom)));
        const dy = Math.max(-bounds.y, Math.min(frame.height - bounds.y - bounds.height, Math.round((event.clientY - pointer[1]) / zoom)));
        context.clearRect(0, 0, frame.width, frame.height);
        context.drawImage(buffer, dx, dy);
        changed.current = dx !== 0 || dy !== 0;
      }
    } else if (tool === 'pencil' || tool === 'eraser') {
      context.fillStyle = colorRef.current;
      line(context, previous.current ?? point, point, tool === 'eraser');
      previous.current = point;
      changed.current = true;
    } else if (tool === 'line' || tool === 'rectangle' || tool === 'ellipse') {
      if (snapshot.current) context.putImageData(snapshot.current, 0, 0);
      shape(context, start.current, point);
      changed.current = true;
    }
    drawRef.current();
  }
  function finish(cancelled = false) {
    if (panDrawing.current) {
      panDrawing.current = false;
      panStart.current = null;
      return;
    }
    if (!drawing.current) return;
    drawing.current = false;
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
    snapshot.current = null;
    moveBuffer.current = null;
    moveBounds.current = null;
    moveStart.current = null;
    selectionMoving.current = false;
    selectionSnapshot.current = null;
    selectionMoveBuffer.current = null;
    selectionMoveStart.current = null;
    selectionMoveOrigin.current = null;
    start.current = null;
    if (changed.current) emitChange();
    changed.current = false;
  }
  useEffect(() => {
    const cancelMove = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drawing.current && (moveBuffer.current || selectionMoving.current)) {
        event.preventDefault();
        finish(true);
      }
      if (event.key === 'Escape' && !drawing.current && selectionRef.current) {
        event.preventDefault();
        updateSelection(null);
      }
      if (!drawing.current && tool === 'select' && selectionRef.current && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const delta: Point = event.key === 'ArrowLeft' ? [-1, 0] : event.key === 'ArrowRight' ? [1, 0] : event.key === 'ArrowUp' ? [0, -1] : [0, 1];
        moveSelectionBy(delta[0], delta[1]);
      }
    };
    window.addEventListener('keydown', cancelMove);
    return () => window.removeEventListener('keydown', cancelMove);
  }, [frame, activeLayer, tool, readonly]);
  const selected = layers.find((layer) => layer.id === activeLayer);
  const region = finding?.frameId === frame.id ? finding.region : null;
  const cursorClass =
    tool === 'pan'
      ? 'pan-cursor'
      : tool === 'select'
        ? 'select-cursor'
        : tool === 'eyedropper'
          ? 'eyedropper-cursor'
          : tool === 'fill'
            ? 'fill-cursor'
            : tool === 'move-layer'
              ? 'move-layer-cursor'
              : '';
  return (
    <div className="canvas-wrap">
      <div
        className="pixel-board"
        style={{
          width: frame.width * zoom,
          height: frame.height * zoom,
          transform: `translate(${pan[0] * zoom}px, ${pan[1] * zoom}px)`,
        }}
      >
        <canvas
          ref={canvasRef}
          width={frame.width}
          height={frame.height}
          aria-label={label}
          aria-busy={loading}
          className={cursorClass}
          onPointerDown={(event) => {
            if (readonly || !ready.current || event.button !== 0) return;
            const point = position(event);
            setCursor(point);
            event.currentTarget.setPointerCapture(event.pointerId);
            if (tool === 'pan') {
              panDrawing.current = true;
              panStart.current = { pointer: [event.clientX, event.clientY], offset: pan };
              return;
            }
            if (tool === 'eyedropper') {
              const context = canvasRef.current?.getContext('2d');
              if (context) onPickColor?.(rgbaToHex(context.getImageData(point[0], point[1], 1, 1).data, 0));
              return;
            }
            if (tool === 'select') {
              const current = selectionRef.current;
              if (current && point[0] >= current.x && point[0] < current.x + current.width && point[1] >= current.y && point[1] < current.y + current.height && selected && !selected.locked && selected.visible) {
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
            if (!selected || selected.locked || !selected.visible) return;
            const context = sourceRef.current.get(activeLayer)?.getContext('2d');
            if (!context) return;
            if (tool === 'fill') {
              context.imageSmoothingEnabled = false;
              context.fillStyle = colorRef.current;
              if (fillAt(point, context)) {
                drawRef.current();
                emitChange();
              }
              return;
            }
            drawing.current = true;
            start.current = point;
            previous.current = null;
            changed.current = false;
            if (tool === 'move-layer') {
              const pixels = context.getImageData(0, 0, frame.width, frame.height);
              moveBounds.current = contentBounds(pixels);
              moveStart.current = [event.clientX, event.clientY];
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
          onPointerUp={event => { paint(event); finish(); }}
          onPointerCancel={() => finish(true)}
          onLostPointerCapture={() => finish(true)}
          onPointerLeave={() => setCursor(null)}
        />
        {grid && zoom >= 5 ? (
          <div className="pixel-grid" style={{ backgroundSize: `${zoom}px ${zoom}px` }} />
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
            />
          </>
        ) : null}
        {guides && frame.baselineY !== null ? (
          <div className="baseline-guide" style={{ top: frame.baselineY * zoom }}>
            <span>基线 {frame.baselineY}</span>
          </div>
        ) : null}
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
      </div>
      <span className="coordinates">
        {cursor ? `${cursor[0]}, ${cursor[1]}` : `${frame.width} × ${frame.height}`}
      </span>
    </div>
  );
});
