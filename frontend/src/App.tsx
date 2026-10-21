import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCheck, ChevronRight, ClipboardPaste, Copy, CopyPlus, Download, Eraser, Eye, EyeOff,
  FilePlus2, Folder, Grid2X2, Hand, History, ImagePlus, Layers, Layers2, Lock, Minus, Move, PaintBucket, Pause, Pencil, Pipette, Play, Plus, Redo2,
  Circle, Crosshair, Focus, Maximize, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Scissors, Square, SquareDashedMousePointer,
  RefreshCw, Save, ScanLine, Settings2, Trash2, Undo2, Unlock, Upload, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, MouseEvent } from 'react';
import { api, blankImage, loadImage } from './api';
import { CanvasEditor } from './CanvasEditor';
import { CanvasZoomControl } from './CanvasZoomControl';
import { FillToolSettings } from './FillToolSettings';
import { ToolSettingsPopover } from './ToolSettingsPopover';
import { BrushPreview } from './BrushPreview';
import { EyedropperToolSettings } from './EyedropperToolSettings';
import { SelectionToolSettings } from './SelectionToolSettings';
import { LayerList } from './LayerList';
import { mergeLayerPixels } from './layerPixels';
import { WorkspacePanel } from './WorkspacePanel';
import { WorkspaceWindowMenu } from './WorkspaceWindowMenu';
import { useWorkspaceLayout } from './workspaceLayout';
import { normalizeFillSettings } from './drawingFill';
import type { BrushShape, CanvasEditorHandle, DrawingTool, Rect } from './CanvasEditor';
import { MIN_ZOOM, MAX_ZOOM, stepZoom } from './canvasView';
import { isShapeTool } from './drawingShapes';
import type { ShapeMode } from './drawingShapes';
import { DrawingPalette } from './DrawingPalette';
import { FrameMetadataEditor } from './FrameMetadataEditor';
import { SpriteSheetImport } from './SpriteSheetImport';
import { RepairControls } from './RepairControls';
import { RepairSummary } from './RepairSummary';
import { VersionHistory } from './VersionHistory';
import { ExchangeControls } from './ExchangeControls';
import { ProjectControls } from './ProjectControls';
import { AIControls } from './AIControls';
import { ContextMenu } from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import { defaultConfig, RULE_NAMES } from './types';
import type { Asset, AssetItem, BlendMode, CheckConfig, ColorSampleSource, Direction, Document, Finding, Frame, Layer, Preview, Project, Report } from './types';

function IconButton({ icon: Icon, label, onClick, disabled = false, active = false, ariaExpanded }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean; active?: boolean; ariaExpanded?: boolean }) {
  return <button className={`icon-button ${active ? 'active' : ''}`} type="button" title={label} aria-label={label} aria-expanded={ariaExpanded} onClick={onClick} disabled={disabled}><Icon size={17} /></button>;
}

const drawingTools: { value: DrawingTool; label: string; icon: LucideIcon }[] = [
  { value: 'pencil', label: '铅笔 (B)', icon: Pencil },
  { value: 'eraser', label: '橡皮 (E)', icon: Eraser },
  { value: 'eyedropper', label: '取色器 (I)', icon: Pipette },
  { value: 'fill', label: '填充 (G)', icon: PaintBucket },
  { value: 'line', label: '直线 (L)', icon: Minus },
  { value: 'rectangle', label: '矩形 (R)', icon: Square },
  { value: 'ellipse', label: '椭圆 (O)', icon: Circle },
  { value: 'select', label: '矩形选区 (M)', icon: SquareDashedMousePointer },
  { value: 'lasso', label: '套索选区 (Q)', icon: SquareDashedMousePointer },
  { value: 'color-select', label: '按颜色选择', icon: Pipette },
  { value: 'magic-wand', label: '魔棒选择', icon: PaintBucket },
  { value: 'pan', label: '移动画布 (H)', icon: Hand },
  { value: 'move-layer', label: '移动图层 (V)', icon: Move },
];

const directionNames: Record<Direction, string> = { down: '下', left: '左', right: '右', up: '上' };
type PlaybackMode = 'forward' | 'reverse' | 'pingpong';
type PlaybackFrame = { frameId: string; durationMs: number };
type CanvasDisplaySettings = {
  backgroundStyle: 'checker' | 'solid';
  backgroundColor: string;
  checkerSize: number;
  gridColor: string;
  gridOpacity: number;
  gridSize: number;
};

function arrangePlayback(sequence: PlaybackFrame[], mode: PlaybackMode) {
  if (mode === 'reverse') return [...sequence].reverse();
  if (mode === 'pingpong' && sequence.length > 1) return [...sequence, ...sequence.slice(0, -1).reverse()];
  return sequence;
}

const CANVAS_DISPLAY_STORAGE_KEY = 'pixelart-canvas-display-v1';
const defaultCanvasDisplay: CanvasDisplaySettings = { backgroundStyle: 'checker', backgroundColor: '#FFFFFF', checkerSize: 16, gridColor: '#6E7473', gridOpacity: 20, gridSize: 1 };

function readCanvasDisplaySettings(): CanvasDisplaySettings {
  try {
    const value = JSON.parse(localStorage.getItem(CANVAS_DISPLAY_STORAGE_KEY) || '{}');
    return {
      backgroundStyle: value.backgroundStyle === 'solid' ? 'solid' : 'checker',
      backgroundColor: typeof value.backgroundColor === 'string' && /^#[\da-f]{6}$/i.test(value.backgroundColor) ? value.backgroundColor.toUpperCase() : defaultCanvasDisplay.backgroundColor,
      checkerSize: Number.isFinite(value.checkerSize) ? Math.max(4, Math.min(32, Math.round(value.checkerSize))) : defaultCanvasDisplay.checkerSize,
      gridColor: typeof value.gridColor === 'string' && /^#[\da-f]{6}$/i.test(value.gridColor) ? value.gridColor.toUpperCase() : defaultCanvasDisplay.gridColor,
      gridOpacity: Number.isFinite(value.gridOpacity) ? Math.max(5, Math.min(100, Math.round(value.gridOpacity))) : defaultCanvasDisplay.gridOpacity,
      gridSize: Number.isFinite(value.gridSize) ? Math.max(1, Math.min(8, Math.round(value.gridSize))) : defaultCanvasDisplay.gridSize,
    };
  } catch { return defaultCanvasDisplay; }
}

const statusNames: Record<string, string> = { passed: '通过', findings: '问题', skipped: '跳过', disabled: '关闭', failed: '失败' };
const DRAFT_STORAGE_PREFIX = 'pixelart-draft-v1:';
const CONFIG_DRAFT_STORAGE_PREFIX = 'pixelart-config-draft-v1:';
const BRUSH_SIZE_STORAGE_KEY = 'pixelart-brush-size-v1';
const BRUSH_OPACITY_STORAGE_KEY = 'pixelart-brush-opacity-v1';
const BRUSH_SHAPE_STORAGE_KEY = 'pixelart-brush-shape-v1';
const BRUSH_PRESSURE_STORAGE_KEY = 'pixelart-brush-pressure-v1';
const BRUSH_SPACING_STORAGE_KEY = 'pixelart-brush-spacing-v1';
const SHAPE_SETTINGS_STORAGE_KEY = 'pixelart-shape-settings-v1';
const FILL_SETTINGS_STORAGE_KEY = 'pixelart-fill-settings-v1';
const EYEDROPPER_SAMPLE_STORAGE_KEY = 'pixelart-eyedropper-sample-v1';
const COLOR_OPACITY_STORAGE_KEY = 'pixelart-color-opacity-v1';

function readEyedropperSample(): ColorSampleSource {
  try { return localStorage.getItem(EYEDROPPER_SAMPLE_STORAGE_KEY) === 'layer' ? 'layer' : 'merged'; }
  catch { return 'merged'; }
}

function readFillSettings() {
  try { return normalizeFillSettings(JSON.parse(localStorage.getItem(FILL_SETTINGS_STORAGE_KEY) || '{}')); }
  catch { return normalizeFillSettings(null); }
}

function readShapeSettings(): { strokeSize: number; mode: ShapeMode } {
  try {
    const value = JSON.parse(localStorage.getItem(SHAPE_SETTINGS_STORAGE_KEY) || '{}');
    return { strokeSize: Number.isFinite(value.strokeSize) ? Math.max(1, Math.min(16, Math.round(value.strokeSize))) : 1, mode: value.mode === 'fill' ? 'fill' : 'stroke' };
  } catch { return { strokeSize: 1, mode: 'stroke' }; }
}

function readBrushSize() {
  try {
    const value = Number.parseInt(localStorage.getItem(BRUSH_SIZE_STORAGE_KEY) || '1', 10);
    return Number.isFinite(value) ? Math.max(1, Math.min(16, value)) : 1;
  } catch {
    return 1;
  }
}

function readBrushOpacity() {
  try {
    const value = Number.parseInt(localStorage.getItem(BRUSH_OPACITY_STORAGE_KEY) || '100', 10);
    return Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : 100;
  } catch {
    return 100;
  }
}

function readBrushPressure() {
  try { return localStorage.getItem(BRUSH_PRESSURE_STORAGE_KEY) === 'true'; } catch { return false; }
}

function readBrushSpacing() {
  try {
    const value = Number.parseInt(localStorage.getItem(BRUSH_SPACING_STORAGE_KEY) || '100', 10);
    return Number.isFinite(value) ? Math.max(10, Math.min(200, value)) : 100;
  } catch { return 100; }
}

function readBrushShape(): BrushShape {
  try {
    return localStorage.getItem(BRUSH_SHAPE_STORAGE_KEY) === 'circle' ? 'circle' : 'square';
  } catch {
    return 'square';
  }
}

function readColorOpacity() {
  try {
    const value = Number.parseInt(localStorage.getItem(COLOR_OPACITY_STORAGE_KEY) || '100', 10);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;
  } catch { return 100; }
}

type StoredDraft = {
  assetId: string;
  baseVersionId: string;
  document: Document;
  frameIndex: number;
  selectedLayer: string;
  updatedAt: string;
};
type StoredConfigDraft = {
  projectId: string;
  baseConfig: CheckConfig;
  config: CheckConfig;
  paletteText: string;
  updatedAt: string;
};

function isTextEditingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && target.matches('input, textarea, select, [contenteditable="true"]');
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [draft, setDraft] = useState<Document | null>(null);
  const [selectedLayer, setSelectedLayer] = useState('');
  const [frameIndex, setFrameIndex] = useState(0);
  const [tool, setTool] = useState<DrawingTool>('pencil');
  const [toolSettingsOpen, setToolSettingsOpen] = useState(false);
  const drawingToolsRef = useRef<HTMLDivElement>(null);
  const [focusMode, setFocusMode] = useState(false);
  const { layout, updatePanel, restorePanel, resetLayout, expandToolOptions, activePanel, setActivePanel } = useWorkspaceLayout(setFocusMode);
  const panelProps = (id: keyof typeof layout) => ({ id, state: layout[id], active: activePanel === id, onActivate: setActivePanel, onChange: updatePanel });
  const [brushSize, setBrushSize] = useState(readBrushSize);
  const [brushOpacity, setBrushOpacity] = useState(readBrushOpacity);
  const [brushShape, setBrushShape] = useState<BrushShape>(readBrushShape);
  const [brushPressure, setBrushPressure] = useState(readBrushPressure);
  const [brushSpacing, setBrushSpacing] = useState(readBrushSpacing);
  const [shapeSettings, setShapeSettings] = useState(readShapeSettings);
  const [fillSettings, setFillSettings] = useState(readFillSettings);
  const [eyedropperSample, setEyedropperSample] = useState(readEyedropperSample);
  const [pickedColor, setPickedColor] = useState<{ color: string; opacity?: number } | null>(null);
  const colorRef = useRef('#218F83');
  const colorOpacityRef = useRef(readColorOpacity());
  const [colorOpacity, setColorOpacity] = useState(colorOpacityRef.current);
  const [zoom, setZoom] = useState(window.innerWidth < 600 ? 3 : window.innerHeight < 850 ? 4 : 6);
  const [grid, setGrid] = useState(false);
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [canvasDisplay, setCanvasDisplay] = useState<CanvasDisplaySettings>(readCanvasDisplaySettings);
  const [guides, setGuides] = useState(true);
  const [onion, setOnion] = useState(false);
  const [onionSettingsOpen, setOnionSettingsOpen] = useState(false);
  const [onionFrameCount, setOnionFrameCount] = useState(1);
  const [onionOpacity, setOnionOpacity] = useState(25);
  const [onionColor, setOnionColor] = useState('#218F83');
  const [dirty, setDirty] = useState(false);
  const [drawingStroke, setDrawingStroke] = useState(false);
  const finishingStroke = useRef(false);
  const latestDirty = useRef(false);
  const [conflictingDraft, setConflictingDraft] = useState<StoredDraft | null>(null);
  const [undo, setUndo] = useState<Document[]>([]);
  const [redo, setRedo] = useState<Document[]>([]);
  const [config, setConfig] = useState<CheckConfig>(() => structuredClone(defaultConfig));
  const [savedConfig, setSavedConfig] = useState<CheckConfig>(() => structuredClone(defaultConfig));
  const [reports, setReports] = useState<Report[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [finding, setFinding] = useState<Finding | null>(null);
  const [tab, setTab] = useState<'layers' | 'quality' | 'versions'>('layers');
  const libraryCollapsed = layout.library.visibility !== 'visible';
  const inspectorCollapsed = layout.inspector.visibility !== 'visible';
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [paletteText, setPaletteText] = useState(config.palette.join(', '));
  const [dialog, setDialog] = useState<'project' | 'upload' | 'asset' | null>(null);
  const [projectName, setProjectName] = useState('');
  const [assetName, setAssetName] = useState('未命名素材');
  const [assetWidth, setAssetWidth] = useState(64);
  const [assetHeight, setAssetHeight] = useState(64);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'canvas' | 'layer' | 'frame' | 'library' | 'asset'; layerId?: string; frameIndex?: number; assetId?: string } | null>(null);
  const assetClipboard = useRef<{ document: Document; sourceAssetId?: string; versionId?: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [action, setAction] = useState<'idle' | 'walk'>('idle');
  const [direction, setDirection] = useState<Direction>('down');
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>('forward');
  const [animationFrameIndex, setAnimationFrameIndex] = useState<number | null>(null);
  const [selectedFrames, setSelectedFrames] = useState<Set<string>>(new Set());
  const frameDragIndex = useRef<number | null>(null);
  const [duration, setDuration] = useState(200);
  const layerInput = useRef<HTMLInputElement>(null);
  const layerNameInput = useRef<HTMLInputElement>(null);
  const canvasEditorRef = useRef<CanvasEditorHandle>(null);
  const previewEditorRef = useRef<CanvasEditorHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [selectionClipboard, setSelectionClipboard] = useState(false);
  const initialization = useRef(false);
  const loadSequence = useRef(0);
  const latestDraft = useRef<Document | null>(null);
  const latestAsset = useRef<Asset | null>(null);
  const latestFrameIndex = useRef(0);
  const latestSelectedLayer = useRef('');
  const [draftStatus, setDraftStatus] = useState<'none' | 'saving' | 'saved' | 'error'>('none');
  const [configDraftStatus, setConfigDraftStatus] = useState<'none' | 'saving' | 'saved' | 'error'>('none');
  const [leaveRequest, setLeaveRequest] = useState<{ resolve: (answer: boolean) => void } | null>(null);
  const [savingBeforeLeave, setSavingBeforeLeave] = useState(false);
  const configDirty = JSON.stringify(config) !== JSON.stringify(savedConfig)
    || JSON.stringify(paletteText.split(/[,\s]+/).filter(Boolean)) !== JSON.stringify(config.palette);

  latestDraft.current = draft;
  latestDirty.current = dirty;
  latestAsset.current = asset;
  latestFrameIndex.current = frameIndex;
  latestSelectedLayer.current = selectedLayer;

  useEffect(() => {
    try { localStorage.setItem(CANVAS_DISPLAY_STORAGE_KEY, JSON.stringify(canvasDisplay)); } catch { /* Storage may be unavailable. */ }
  }, [canvasDisplay]);

  function selectTool(next: DrawingTool) {
    setToolSettingsOpen(current => tool === next ? !current : true);
    setTool(next);
    // Selecting a tool updates its options without resurrecting a closed panel.
    expandToolOptions();
  }

  function fitCanvas(mode: 'fit' | 'fill' = 'fit') {
    if (drawingStroke || !draft || !stageRef.current) return;
    const stage = stageRef.current;
    const view = stage.querySelector<HTMLElement>('.stage-view');
    const canvas = view?.querySelector<HTMLCanvasElement>('canvas:not(.onion-overlay)');
    if (!view || !canvas) return;
    const currentFrame = draft.frames[frameIndex];
    const style = getComputedStyle(stage);
    const count = preview ? 2 : 1;
    const width = (stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (parseFloat(style.columnGap) || 0) * (count - 1)) / count - (view.offsetWidth - canvas.offsetWidth) - 4;
    const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - (view.offsetHeight - canvas.offsetHeight) - 4;
    if (width <= 0 || height <= 0) return;
    const scale = Math.min(MAX_ZOOM, width / currentFrame.width, height / currentFrame.height);
    const next = Math.max(MIN_ZOOM, mode === 'fill' ? Math.floor(scale * 1000) / 1000 : scale >= 1 ? Math.floor(scale) : Math.floor(scale * 100) / 100);
    flushSync(() => { setZoom(next); locateCanvas(); });
    if (mode === 'fill') {
      const rect = stage.getBoundingClientRect();
      const gap = parseFloat(style.columnGap) || 0;
      const slot = (stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - gap * (count - 1)) / count;
      const label = view.querySelector<HTMLElement>('.stage-label');
      const topChrome = (label?.offsetHeight || 0) + (parseFloat(getComputedStyle(view).rowGap) || 0);
      const centerY = rect.top + stage.clientTop + parseFloat(style.paddingTop) + topChrome + height / 2;
      const views = stage.querySelectorAll<HTMLElement>('.stage-view');
      [canvasEditorRef.current, previewEditorRef.current].slice(0, count).forEach((editor, index) => {
        const board = views[index]?.querySelector<HTMLCanvasElement>('canvas:not(.onion-overlay)');
        if (!editor || !board) return;
        const bounds = board.getBoundingClientRect();
        const centerX = rect.left + stage.clientLeft + parseFloat(style.paddingLeft) + index * (slot + gap) + slot / 2;
        editor.panBy(bounds.left + bounds.width / 2 - centerX, bounds.top + bounds.height / 2 - centerY);
      });
    }
  }

  function locateCanvas() {
    if (drawingStroke) return;
    canvasEditorRef.current?.resetView();
    previewEditorRef.current?.resetView();
    stageRef.current?.scrollTo(0, 0);
  }

  useEffect(() => {
    try { localStorage.setItem(BRUSH_SIZE_STORAGE_KEY, String(brushSize)); } catch { /* Storage may be unavailable. */ }
  }, [brushSize]);
  useEffect(() => {
    try { localStorage.setItem(BRUSH_OPACITY_STORAGE_KEY, String(brushOpacity)); } catch { /* Storage may be unavailable. */ }
  }, [brushOpacity]);
  useEffect(() => {
    try { localStorage.setItem(BRUSH_SHAPE_STORAGE_KEY, brushShape); } catch { /* Storage may be unavailable. */ }
  }, [brushShape]);
  useEffect(() => {
    try { localStorage.setItem(BRUSH_PRESSURE_STORAGE_KEY, String(brushPressure)); } catch { /* Storage may be unavailable. */ }
  }, [brushPressure]);
  useEffect(() => {
    try { localStorage.setItem(BRUSH_SPACING_STORAGE_KEY, String(brushSpacing)); } catch { /* Storage may be unavailable. */ }
  }, [brushSpacing]);

  useEffect(() => {
    try { localStorage.setItem(SHAPE_SETTINGS_STORAGE_KEY, JSON.stringify(shapeSettings)); } catch { /* Storage may be unavailable. */ }
  }, [shapeSettings]);
  useEffect(() => {
    try { localStorage.setItem(FILL_SETTINGS_STORAGE_KEY, JSON.stringify(fillSettings)); } catch { /* Storage may be unavailable. */ }
  }, [fillSettings]);
  useEffect(() => {
    try { localStorage.setItem(EYEDROPPER_SAMPLE_STORAGE_KEY, eyedropperSample); } catch { /* Storage may be unavailable. */ }
  }, [eyedropperSample]);
  useEffect(() => {
    colorOpacityRef.current = colorOpacity;
    try { localStorage.setItem(COLOR_OPACITY_STORAGE_KEY, String(colorOpacity)); } catch { /* Storage may be unavailable. */ }
  }, [colorOpacity]);

  useEffect(() => {
    const panCanvas = (event: WheelEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented || !canvasEditorRef.current) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const stage = stageRef.current!;
      if (!event.shiftKey && (!(event.target instanceof Node) || !stage.contains(event.target))) return;
      const deltaX = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX;
      const deltaY = event.shiftKey ? 0 : event.deltaY;
      if (!deltaX && !deltaY) return;
      event.preventDefault();
      const unitX = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientWidth : 1;
      const unitY = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      const pointer: [number, number] = [event.clientX, event.clientY];
      canvasEditorRef.current.panBy(deltaX * unitX, deltaY * unitY, pointer);
      previewEditorRef.current?.panBy(deltaX * unitX, deltaY * unitY, pointer);
    };
    window.addEventListener('wheel', panCanvas, { passive: false });
    return () => window.removeEventListener('wheel', panCanvas);
  }, []);

  useEffect(() => {
    if (initialization.current) return;
    initialization.current = true;
    run(async () => {
      const list = await api<Project[]>('/projects');
      const next = list.length ? list : [await api<Project>('/demo', {})];
      setProjects(next);
      await switchProject(next[0].id);
    });
  }, []);

  useEffect(() => {
    if (!asset) { setReports([]); return; }
    let cancelled = false;
    api<Report[]>(`/assets/${asset.id}/reports?versionId=${asset.currentVersionId}`).then(history => {
      if (!cancelled) setReports(history);
    }).catch(() => { if (!cancelled) setReports([]); });
    return () => { cancelled = true; };
  }, [asset?.id, asset?.currentVersionId]);

  function draftStorageKey(assetId: string) {
    return `${DRAFT_STORAGE_PREFIX}${assetId}`;
  }

  function persistDraftSnapshot(currentAsset: Asset | null, currentDraft: Document | null, currentFrameIndex = latestFrameIndex.current, currentSelectedLayer = latestSelectedLayer.current) {
    if (!currentAsset || !currentDraft) return false;
    try {
      const payload: StoredDraft = {
        assetId: currentAsset.id,
        baseVersionId: currentAsset.currentVersionId,
        document: structuredClone(currentDraft),
        frameIndex: currentFrameIndex,
        selectedLayer: currentSelectedLayer,
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(draftStorageKey(currentAsset.id), JSON.stringify(payload));
      return true;
    } catch {
      // A large document can exceed the browser quota; the formal version remains intact.
      return false;
    }
  }

  function discardStoredDraft(assetId: string) {
    try { localStorage.removeItem(draftStorageKey(assetId)); } catch { /* Storage may be unavailable. */ }
  }

  function configDraftStorageKey(id: string) {
    return `${CONFIG_DRAFT_STORAGE_PREFIX}${id}`;
  }

  function persistConfigDraft(id: string, currentConfig: CheckConfig, currentPaletteText: string, baseConfig: CheckConfig) {
    if (!id) return false;
    try {
      const payload: StoredConfigDraft = { projectId: id, baseConfig: structuredClone(baseConfig), config: structuredClone(currentConfig), paletteText: currentPaletteText, updatedAt: new Date().toISOString() };
      localStorage.setItem(configDraftStorageKey(id), JSON.stringify(payload));
      return true;
    } catch { return false; }
  }

  function discardConfigDraft(id: string) {
    try { localStorage.removeItem(configDraftStorageKey(id)); } catch { /* Storage may be unavailable. */ }
  }

  function recoverConfigDraft(id: string, serverConfig: CheckConfig): StoredConfigDraft | null {
    try {
      const raw = localStorage.getItem(configDraftStorageKey(id));
      if (!raw) return null;
      const stored = JSON.parse(raw) as StoredConfigDraft;
      if (stored.projectId !== id || !stored.config || JSON.stringify(stored.baseConfig) !== JSON.stringify(serverConfig)) return null;
      return { ...stored, config: structuredClone(stored.config), baseConfig: structuredClone(stored.baseConfig) };
    } catch { return null; }
  }

  async function confirmDiscardCurrentDraft(_message?: string) {
    completeStroke();
    if (!latestDirty.current && !configDirty) return true;
    return new Promise<boolean>(resolve => setLeaveRequest({ resolve }));
  }

  async function finishLeave(choice: 'save' | 'discard' | 'cancel') {
    if (!leaveRequest || savingBeforeLeave) return;
    if (choice === 'save') {
      setSavingBeforeLeave(true);
      try {
        if (dirty) await saveDraft();
        if (configDirty) await saveProjectConfig();
      } catch (error) {
        setNotice({ message: error instanceof Error ? error.message : '保存失败', error: true });
        setSavingBeforeLeave(false);
        return;
      }
      setSavingBeforeLeave(false);
    } else if (choice === 'discard') {
      if (asset && dirty) {
        discardStoredDraft(asset.id);
        setDraft(structuredClone(asset.document));
        setFrameIndex(index => Math.min(index, asset.document.frames.length - 1));
        setSelectedLayer(layer => asset.document.layers.some(item => item.id === layer) ? layer : asset.document.layers.at(-1)!.id);
        setDirty(false); setUndo([]); setRedo([]);
      }
      setConfig(structuredClone(savedConfig));
      setPaletteText(savedConfig.palette.join(', '));
      if (projectId) discardConfigDraft(projectId);
    }
    leaveRequest.resolve(choice !== 'cancel');
    setLeaveRequest(null);
  }

  function recoverStoredDraft(next: Asset): StoredDraft | null {
    let stored: StoredDraft;
    try {
      const raw = localStorage.getItem(draftStorageKey(next.id));
      if (!raw) return null;
      stored = JSON.parse(raw) as StoredDraft;
    } catch {
      discardStoredDraft(next.id);
      return null;
    }
    if (stored.assetId !== next.id || !stored.document?.frames?.length) {
      discardStoredDraft(next.id);
      return null;
    }
    if (stored.baseVersionId !== next.currentVersionId) {
      setConflictingDraft(stored);
      return null;
    }
    const updated = new Date(stored.updatedAt);
    const stamp = Number.isNaN(updated.getTime()) ? '' : `（${updated.toLocaleString('zh-CN')}）`;
    if (!window.confirm(`发现素材「${next.name}」的未保存草稿${stamp}，是否恢复？\n\n选择“取消”将删除该草稿。`)) {
      discardStoredDraft(next.id);
      return null;
    }
    return { ...stored, document: structuredClone(stored.document) };
  }

  useEffect(() => {
    if (!asset || !draft || !dirty) {
      setDraftStatus('none');
      return;
    }
    setDraftStatus('saving');
    const timer = window.setTimeout(() => setDraftStatus(persistDraftSnapshot(asset, draft, frameIndex, selectedLayer) ? 'saved' : 'error'), 600);
    return () => window.clearTimeout(timer);
  }, [asset, draft, dirty, frameIndex, selectedLayer]);

  useEffect(() => {
    if (!projectId || !configDirty) {
      setConfigDraftStatus('none');
      return;
    }
    setConfigDraftStatus('saving');
    const timer = window.setTimeout(() => setConfigDraftStatus(persistConfigDraft(projectId, config, paletteText, savedConfig) ? 'saved' : 'error'), 600);
    return () => window.clearTimeout(timer);
  }, [projectId, config, paletteText, savedConfig, configDirty]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty && !configDirty && !drawingStroke) return;
      if (dirty) persistDraftSnapshot(latestAsset.current, latestDraft.current);
      if (configDirty && projectId) persistConfigDraft(projectId, config, paletteText, savedConfig);
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, configDirty, drawingStroke]);

  useEffect(() => {
    const close = (event: Event) => {
      const { action, resolve } = (event as CustomEvent<{ action: 'save' | 'discard'; resolve: (allowed: boolean) => void }>).detail;
      if (action === 'discard') {
        if (asset) discardStoredDraft(asset.id);
        if (projectId) discardConfigDraft(projectId);
        resolve(true);
        return;
      }
      if (busy || leaveRequest) {
        setNotice({ message: '当前操作完成后才能保存并关闭', error: true });
        resolve(false);
        return;
      }
      setBusy(true);
      void (async () => {
        try {
          if (dirty || drawingStroke) await saveDraft();
          if (configDirty) await saveProjectConfig();
          resolve(true);
        } catch (error) {
          setNotice({ message: error instanceof Error ? error.message : '保存失败', error: true });
          resolve(false);
        } finally { setBusy(false); }
      })();
    };
    window.addEventListener('pixelart-save-before-close', close);
    return () => window.removeEventListener('pixelart-save-before-close', close);
  }, [asset, draft, dirty, drawingStroke, configDirty, config, paletteText, busy, leaveRequest, frameIndex, selectedLayer]);

  useEffect(() => {
    if (!playing || !draft) return;
    const animation = draft.animations.find(a => a.action === action && a.direction === direction);
    const sequence = arrangePlayback(animation?.frames ?? draft.frames.map(frame => ({ frameId: frame.id, durationMs: duration })), playbackMode);
    if (!sequence.length) { setPlaying(false); return; }
    let index = 0;
    let timer: ReturnType<typeof setTimeout>;
    // Keep a sequence cursor: animations may reference the same frame more than once.
    const advance = () => {
      timer = setTimeout(() => {
        if (animation && !animation.loop && index === sequence.length - 1) { setPlaying(false); return; }
        index = (index + 1) % sequence.length;
        setFrameIndex(draft.frames.findIndex(frame => frame.id === sequence[index].frameId));
        setAnimationFrameIndex(animation ? index : null);
        advance();
      }, sequence[index].durationMs);
    };
    advance();
    return () => clearTimeout(timer);
  }, [playing, draft, action, direction, playbackMode]);

  async function run(task: () => Promise<void>, success?: string) {
    completeStroke();
    setBusy(true);
    setNotice(null);
    try { await task(); if (success) setNotice({ message: success, error: false }); }
    catch (error) { setNotice({ message: error instanceof Error ? error.message : '操作失败', error: true }); }
    finally { setBusy(false); }
  }

  function install(next: Asset) {
    setConflictingDraft(null);
    const recovered = recoverStoredDraft(next);
    const recoveredDocument = recovered?.document || structuredClone(next.document);
    const recoveredLayer = recovered?.selectedLayer && recoveredDocument.layers.some(layer => layer.id === recovered.selectedLayer)
      ? recovered.selectedLayer
      : recoveredDocument.layers.at(-1)!.id;
    const recoveredFrame = recovered && Number.isFinite(recovered.frameIndex)
      ? Math.max(0, Math.min(recovered.frameIndex, recoveredDocument.frames.length - 1))
      : 0;
    setAsset(next); setDraft(recoveredDocument); setSelectedLayer(recoveredLayer);
    setAssets(list => list.map(item => item.id === next.id ? { ...item, name: next.name, currentVersionId: next.currentVersionId, frameCount: next.document.frames.length, layerCount: next.document.layers.length, width: next.document.frames[0].width, height: next.document.frames[0].height } : item));
    setFrameIndex(recoveredFrame); setDirty(Boolean(recovered)); setDraftStatus(recovered ? 'saved' : 'none'); setUndo([]); setRedo([]); setReport(null); setFinding(null); setPreview(null); setPlaying(false); setMenu(null);
    setAction(recoveredDocument.animations[0]?.action ?? 'idle');
    setDirection(recoveredDocument.animations[0]?.direction ?? 'down');
    setAnimationFrameIndex(null);
    setSelectedFrames(new Set());
    if (recovered) setNotice({ message: '已恢复未保存草稿；点击“保存”后才会写入正式版本', error: false });
  }

  async function switchProject(id: string) {
    if (!await confirmDiscardCurrentDraft()) return;
    const sequence = ++loadSequence.current;
    const [list, projectConfig] = await Promise.all([
      api<AssetItem[]>(`/projects/${id}/assets`),
      api<CheckConfig>(`/projects/${id}/check-config`),
    ]);
    const next = list.length ? await api<Asset>(`/assets/${list[0].id}`) : null;
    if (sequence !== loadSequence.current) return;
    const recoveredConfig = recoverConfigDraft(id, projectConfig);
    setProjectId(id); setAssets(list);
    setConfig(recoveredConfig?.config || projectConfig); setSavedConfig(structuredClone(projectConfig)); setPaletteText(recoveredConfig?.paletteText ?? projectConfig.palette.join(', '));
    setAssetWidth(projectConfig.targetWidth); setAssetHeight(projectConfig.targetHeight);
    if (recoveredConfig) setNotice({ message: '已恢复未保存项目配置；点击“保存项目配置”后才会写入正式配置', error: false });
    if (next) install(next);
    else { setAsset(null); setDraft(null); setDirty(false); setReport(null); setPreview(null); setConflictingDraft(null); }
  }

  async function switchAsset(id: string) {
    if (!await confirmDiscardCurrentDraft()) return;
    const sequence = ++loadSequence.current;
    const next = await api<Asset>(`/assets/${id}`);
    if (sequence === loadSequence.current) install(next);
  }

  async function snapshotFor(item: AssetItem) {
    if (item.id === asset?.id && draft) return { document: structuredClone(draft), sourceAssetId: item.id, versionId: asset.currentVersionId };
    const source = await api<Asset>(`/assets/${item.id}`);
    return { document: structuredClone(source.document), sourceAssetId: source.id, versionId: source.currentVersionId };
  }

  async function copyAsset(item: AssetItem) {
    assetClipboard.current = await snapshotFor(item);
    setMenu(null);
    setNotice({ message: item.id === asset?.id && dirty ? '已复制素材（含未保存编辑）' : '已复制素材', error: false });
  }

  async function pasteAsset() {
    const clip = assetClipboard.current;
    if (!clip || !projectId) return;
    const next = await api<Asset>(`/projects/${projectId}/assets/copy`, clip);
    setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`));
    setMenu(null);
    if (!dirty) install(next);
    setNotice({ message: dirty ? `已粘贴为「${next.name}」，当前草稿未改变` : `已粘贴素材「${next.name}」`, error: false });
  }

  async function duplicateAsset(item: AssetItem) {
    const snapshot = await snapshotFor(item);
    const next = await api<Asset>(`/projects/${projectId}/assets/copy`, snapshot);
    setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`));
    setMenu(null);
    if (!dirty) install(next);
    setNotice({ message: dirty ? `已创建副本「${next.name}」，当前草稿未改变` : `已创建副本「${next.name}」`, error: false });
  }

  const renameCancel = useRef(false);

  function beginRename(item: AssetItem) {
    if (locked) return;
    renameCancel.current = false;
    setRenamingAssetId(item.id);
    setRenameValue(item.name);
    setMenu(null);
  }

  function renameAsset(item: AssetItem, requestedName?: string) {
    const name = requestedName?.trim();
    if (!name || name === item.name) return;
    if (item.id === asset?.id && dirty && draft) {
      edit(document => { document.name = name.slice(0, 100); });
      setNotice({ message: '名称已修改，保存后写入版本', error: false });
      return;
    }
    run(async () => {
      const next = await api<Asset>(`/assets/${item.id}/rename`, { expectedCurrentVersionId: item.currentVersionId, name });
      if (item.id === asset?.id) install(next);
      setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`));
    }, '素材已重命名');
  }

  function finishInlineRename(item: AssetItem) {
    if (renamingAssetId !== item.id || renameCancel.current) return;
    setRenamingAssetId(null);
    renameAsset(item, renameValue);
  }

  async function refreshAssets() {
    if (!projectId) return;
    setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`));
    setMenu(null);
  }

  async function exportAsset(item: AssetItem, target: 'png' | 'frames' | 'sheet' | 'json' | 'godot', frameId?: string) {
    if (item.id === asset?.id && dirty) { setNotice({ message: '当前素材有未保存编辑，请先保存再导出', error: true }); return; }
    const selectedFrame = target === 'png' && frameId ? `&frameId=${encodeURIComponent(frameId)}` : '';
    const response = await fetch(`/api/assets/${item.id}/export?versionId=${item.currentVersionId}&target=${target}${selectedFrame}`);
    if (!response.ok) throw new Error((await response.json()).detail || '导出失败');
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${item.name}.${target === 'png' ? 'png' : 'zip'}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMenu(null);
  }

  function edit(change: (document: Document) => void) {
    const current = latestDraft.current;
    if (!current || (busy && !finishingStroke.current) || preview || playing) return;
    const next = structuredClone(current);
    change(next);
    latestDraft.current = next; latestDirty.current = true;
    setUndo(history => [...history.slice(-24), current]); setRedo([]); setDraft(next); setDirty(true); setReport(null); setFinding(null);
  }

  function completeStroke() {
    if (!canvasEditorRef.current) return;
    finishingStroke.current = true;
    try { flushSync(() => canvasEditorRef.current?.finishStroke()); }
    finally { finishingStroke.current = false; }
  }

  async function saveDraft() {
    completeStroke();
    const currentAsset = latestAsset.current, currentDraft = latestDraft.current;
    if (!currentAsset || !currentDraft) return;
    const next = await api<Asset>(`/assets/${currentAsset.id}/save`, { expectedCurrentVersionId: currentAsset.currentVersionId, document: currentDraft });
    const index = frameIndex, layer = selectedLayer;
    discardStoredDraft(currentAsset.id);
    install(next); setFrameIndex(index); setSelectedLayer(layer);
    setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`));
  }

  async function saveCurrent() {
    if (dirty || drawingStroke) await saveDraft();
    if (configDirty) await saveProjectConfig();
  }

  function deleteAsset(item: AssetItem) {
    const warning = item.id === asset?.id && dirty ? '当前素材有未保存的编辑。' : '';
    if (!window.confirm(`${warning}删除「${item.name}」及其全部版本？此操作不可撤销。`)) return;
    run(async () => {
      await api(`/assets/${item.id}`, { expectedCurrentVersionId: item.id === asset?.id ? asset.currentVersionId : item.currentVersionId }, 'DELETE');
      discardStoredDraft(item.id);
      const list = await api<AssetItem[]>(`/projects/${projectId}/assets`);
      setAssets(list); setMenu(null);
      if (item.id === asset?.id) {
        setConflictingDraft(null);
        if (list.length) install(await api<Asset>(`/assets/${list[0].id}`));
        else {
          setAsset(null); setDraft(null); setDirty(false); setUndo([]); setRedo([]); setReport(null); setFinding(null); setPreview(null); setPlaying(false);
        }
      }
    }, '素材已删除');
  }

  function patchConfig(change: Partial<CheckConfig>) {
    setConfig(current => ({ ...current, ...change })); setReport(null); setFinding(null);
  }

  async function saveProjectConfig() {
    if (!projectId) return;
    const palette = paletteText.split(/[,\s]+/).filter(Boolean);
    if (palette.some(color => !/^#[\da-f]{6}$/i.test(color))) throw new Error('调色板请使用 #RRGGBB，以逗号或空格分隔');
    const updated = await api<CheckConfig>(`/projects/${projectId}/check-config`, { ...config, palette }, 'PUT');
    setConfig(updated); setSavedConfig(structuredClone(updated)); setPaletteText(updated.palette.join(', '));
    discardConfigDraft(projectId);
  }

  function patchLayer(id: string, change: Partial<Layer>) {
    edit(document => {
      const layer = document.layers.find(item => item.id === id);
      if (!layer || (change.opacity !== undefined && layer.opacityLocked)) return;
      Object.assign(layer, change);
    });
  }

  function newLayer() {
    if (!draft || draft.layers.length >= 16) return;
    const id = `layer_${crypto.randomUUID().replaceAll('-', '')}`;
    edit(document => {
      document.layers.push({ id, name: `图层 ${document.layers.length + 1}`, visible: true, locked: false, opacity: 255, blendMode: 'normal', pixelsLocked: false, opacityLocked: false, groupId: null });
      document.frames.forEach(f => { f.pixels[id] = blankImage(f.width, f.height); });
    });
    setSelectedLayer(id);
    setTab('layers');
  }

  function duplicateLayer(id: string) {
    if (!draft || draft.layers.length >= 16) return;
    const copyId = `layer_${crypto.randomUUID().replaceAll('-', '')}`;
    edit(document => {
      const index = document.layers.findIndex(layer => layer.id === id);
      const layer = document.layers[index];
      document.layers.splice(index + 1, 0, { ...layer, id: copyId, name: `${layer.name.slice(0, 75)} 副本`, locked: false });
      document.frames.forEach(f => { f.pixels[copyId] = f.pixels[id]; });
    });
    setSelectedLayer(copyId);
  }

  function deleteLayer(id: string) {
    const layer = draft?.layers.find(l => l.id === id);
    if (!draft || !layer || layer.locked || draft.layers.length <= 1 || !window.confirm(`删除「${layer.name}」及其所有帧图像？`)) return;
    edit(document => {
      document.layers = document.layers.filter(l => l.id !== id);
      document.frames.forEach(f => delete f.pixels[id]);
    });
    if (selectedLayer === id) setSelectedLayer(draft.layers.filter(l => l.id !== id).at(-1)!.id);
  }

  function moveLayer(id: string, offset: number) {
    const index = latestDraft.current?.layers.findIndex(layer => layer.id === id) ?? -1;
    const target = latestDraft.current?.layers[index + offset];
    if (index < 0 || !target) return;
    reorderLayer(id, target.id, offset > 0);
  }

  function reorderLayer(id: string, targetId: string, above: boolean) {
    const source = latestDraft.current;
    const layer = source?.layers.find(item => item.id === id);
    if (!source || locked || drawingStroke || !layer || layer.locked || id === targetId || !source.layers.some(item => item.id === targetId)) return;
    const reordered = source.layers.filter(item => item.id !== id);
    const target = reordered.findIndex(item => item.id === targetId);
    reordered.splice(target + (above ? 1 : 0), 0, layer);
    if (reordered.every((item, index) => item.id === source.layers[index].id)) return;
    edit(document => {
      document.layers = reordered;
    });
  }

  async function mergeLayers(id?: string) {
    const source = latestDraft.current;
    if (!source) return;
    const index = source.layers.findIndex(layer => layer.id === id);
    const layers = id ? source.layers.slice(Math.max(0, index - 1), index + 1) : source.layers.filter(layer => layer.visible);
    if (layers.length < 2 || layers.some(layer => layer.locked || !layer.visible)) return;
    const merged = await mergeLayerPixels(source, layers.map(layer => layer.id));
    if (latestDraft.current !== source) throw new Error('图层已改变，请重试合并');
    edit(document => { document.layers = merged.document.layers; document.frames = merged.document.frames; });
    setSelectedLayer(merged.layerId);
  }

  function duplicateFrame(index: number) {
    if (!draft || locked || draft.frames.length >= 64) return;
    edit(document => {
      const copy = structuredClone(document.frames[index]);
      const sourceId = copy.id;
      copy.id = `frame_${crypto.randomUUID().replaceAll('-', '')}`;
      document.frames.splice(index + 1, 0, copy);
      const animation = document.animations.find(a => a.action === action && a.direction === direction);
      const refIndex = animation?.frames.findIndex(ref => ref.frameId === sourceId) ?? -1;
      if (animation && refIndex >= 0 && animation.frames.length < 128) {
        animation.frames.splice(refIndex + 1, 0, { ...animation.frames[refIndex], frameId: copy.id });
      }
    });
    setFrameIndex(index + 1);
    setAnimationFrameIndex(null);
  }

  function reorderFrame(from: number, to: number) {
    if (!draft || locked || from === to || from < 0 || to < 0 || from >= draft.frames.length || to >= draft.frames.length) return;
    edit(document => {
      const [moved] = document.frames.splice(from, 1);
      document.frames.splice(to, 0, moved);
    });
    setFrameIndex(to);
  }

  function createBlankFrame(index: number) {
    if (!draft || locked || draft.frames.length >= 64) return;
    edit(document => {
      const source = document.frames[index] || document.frames.at(-1)!;
      const blank: Frame = {
        id: `frame_${crypto.randomUUID().replaceAll('-', '')}`,
        width: source.width,
        height: source.height,
        pixels: Object.fromEntries(document.layers.map(layer => [layer.id, blankImage(source.width, source.height)])),
        origin: null,
        baselineY: null,
        collisionRects: [],
      };
      document.frames.splice(index + 1, 0, blank);
    });
    setFrameIndex(index + 1);
    setAnimationFrameIndex(null);
  }

  function deleteFrame(index: number) {
    if (!draft || locked || draft.frames.length <= 1) return;
    edit(document => {
      const id = document.frames[index].id;
      document.frames.splice(index, 1);
      document.animations = document.animations.map(a => ({ ...a, frames: a.frames.filter(f => f.frameId !== id) })).filter(a => a.frames.length);
    });
    setFrameIndex(Math.min(index, draft.frames.length - 2));
    setAnimationFrameIndex(null);
  }

  function toggleFrameSelection(frameId: string, additive = false) {
    setSelectedFrames(current => {
      const next = additive ? new Set(current) : new Set<string>();
      if (additive && next.has(frameId)) next.delete(frameId); else next.add(frameId);
      return next;
    });
  }

  function deleteSelectedFrames() {
    if (!draft || locked || selectedFrames.size === 0 || selectedFrames.size >= draft.frames.length) return;
    const ids = selectedFrames;
    edit(document => {
      document.frames = document.frames.filter(frame => !ids.has(frame.id));
      document.animations = document.animations.map(animation => ({ ...animation, frames: animation.frames.filter(ref => !ids.has(ref.frameId)) })).filter(animation => animation.frames.length > 0);
    });
    setFrameIndex(index => Math.min(index, Math.max(0, (draft.frames.length - ids.size) - 1)));
    setAnimationFrameIndex(null); setSelectedFrames(new Set());
  }

  function duplicateSelectedFrames() {
    if (!draft || locked || !selectedFrames.size || draft.frames.length + selectedFrames.size > 64) return;
    const ids = selectedFrames;
    const selected = draft.frames.filter(frame => ids.has(frame.id));
    const copies = selected.map(frame => ({ ...structuredClone(frame), id: `frame_${crypto.randomUUID().replaceAll('-', '')}` }));
    const lastIndex = Math.max(...selected.map(frame => draft.frames.findIndex(item => item.id === frame.id)));
    edit(document => {
      document.frames.splice(lastIndex + 1, 0, ...copies);
      for (const animation of document.animations) {
        const additions = new Map(selected.map((frame, index) => [frame.id, copies[index]]));
        const next: typeof animation.frames = [];
        for (const ref of animation.frames) { next.push(ref); const copy = additions.get(ref.frameId); if (copy) next.push({ frameId: copy.id, durationMs: ref.durationMs }); }
        animation.frames = next;
      }
    });
    setSelectedFrames(new Set(copies.map(frame => frame.id)));
  }

  function applyDurationToSelected() {
    if (!draft || locked || !Number.isInteger(duration) || duration < 1 || duration > 60000 || selectedFrames.size === 0) return;
    edit(document => { for (const animation of document.animations) for (const ref of animation.frames) if (selectedFrames.has(ref.frameId)) ref.durationMs = duration; });
  }

  function moveFrame(index: number, offset: number) {
    if (!draft || locked) return;
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= draft.frames.length) return;
    const selectedId = draft.frames[frameIndex]?.id;
    edit(document => {
      [document.frames[index], document.frames[nextIndex]] = [document.frames[nextIndex], document.frames[index]];
    });
    if (selectedId === draft.frames[index].id) setFrameIndex(nextIndex);
    else if (selectedId === draft.frames[nextIndex].id) setFrameIndex(index);
  }

  function undoEdit() {
    if (locked || !draft || !undo.length) return;
    const previous = undo.at(-1)!;
    setRedo(history => [...history, draft]); setDraft(previous); setUndo(history => history.slice(0, -1));
    setFrameIndex(Math.min(frameIndex, previous.frames.length - 1));
    if (!previous.layers.some(layer => layer.id === selectedLayer)) setSelectedLayer(previous.layers.at(-1)!.id);
    setDirty(true); setReport(null); setFinding(null);
  }

  function redoEdit() {
    if (locked || !draft || !redo.length) return;
    const next = redo.at(-1)!;
    setUndo(history => [...history, draft]); setDraft(next); setRedo(history => history.slice(0, -1));
    setFrameIndex(Math.min(frameIndex, next.frames.length - 1));
    if (!next.layers.some(layer => layer.id === selectedLayer)) setSelectedLayer(next.layers.at(-1)!.id);
    setDirty(true); setReport(null); setFinding(null);
  }

  function restoreEditHistory(index: number) {
    const current = latestDraft.current;
    if (!current || index < 0 || index >= undo.length || busy || preview || playing) return;
    const target = structuredClone(undo[index]);
    const future = [structuredClone(current), ...undo.slice(index + 1).reverse().map(item => structuredClone(item))];
    latestDraft.current = target;
    latestDirty.current = true;
    setUndo(undo.slice(0, index));
    setRedo(future);
    setDraft(target);
    setDirty(true);
    setReport(null);
    setFinding(null);
  }

  function importLayer() {
    setTab('layers');
    layerInput.current?.click();
  }

  function openUpload() { setDialog('upload'); }

  function context(event: MouseEvent, target: Omit<NonNullable<typeof menu>, 'x' | 'y'>) {
    if ((event.target as HTMLElement).closest('input, textarea, select')) return;
    event.preventDefault();
    if (target.layerId) setSelectedLayer(target.layerId);
    if (target.frameIndex !== undefined && !locked) { setFrameIndex(target.frameIndex); setAnimationFrameIndex(null); setPlaying(false); }
    setMenu({ ...target, x: event.clientX, y: event.clientY });
  }

  async function addLayerFile(file: File) {
    if (!draft || draft.layers.length >= 16) throw new Error('最多 16 个图层');
    const source = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
    const image = await loadImage(source);
    if (image.width !== draft.frames[frameIndex].width || image.height !== draft.frames[frameIndex].height) throw new Error('导入图层尺寸必须与当前帧一致');
    const id = `layer_${crypto.randomUUID().replaceAll('-', '')}`;
    edit(document => {
      document.layers.push({ id, name: file.name.replace(/\.png$/i, '').slice(0, 80), visible: true, locked: false, opacity: 255 });
      document.frames.forEach((f, i) => { f.pixels[id] = i === frameIndex ? source : blankImage(f.width, f.height); });
    });
    setSelectedLayer(id);
  }

  const frame = draft?.frames[frameIndex];
  const currentProject = projects.find(project => project.id === projectId) || null;
  const previewChange = preview?.changes.find(change => change.frameId === frame?.id);
  const activeLayer = draft?.layers.find(layer => layer.id === selectedLayer);
  const activeLayerIndex = draft?.layers.findIndex(layer => layer.id === selectedLayer) ?? -1;
  const belowLayer = draft?.layers[activeLayerIndex - 1];
  const canMergeDown = !!activeLayer?.visible && !activeLayer.locked && !activeLayer.pixelsLocked && !activeLayer.opacityLocked && !!belowLayer?.visible && !belowLayer.locked && !belowLayer.pixelsLocked && !belowLayer.opacityLocked;
  const visibleLayers = draft?.layers.filter(layer => layer.visible) ?? [];
  const canMergeVisible = visibleLayers.length > 1 && visibleLayers.every(layer => !layer.locked && !layer.pixelsLocked && !layer.opacityLocked);
  const currentAnimation = draft?.animations.find(a => a.action === action && a.direction === direction);
  const currentRefIndex = animationFrameIndex !== null && currentAnimation?.frames[animationFrameIndex]?.frameId === frame?.id
    ? animationFrameIndex
    : currentAnimation?.frames.findIndex(ref => ref.frameId === frame?.id) ?? -1;
  const currentRef = currentRefIndex >= 0 ? currentAnimation?.frames[currentRefIndex] : undefined;
  const locked = busy || !!preview || playing || !!leaveRequest;
  const onionSequence = currentAnimation && currentRefIndex >= 0
    ? currentAnimation.frames.map(ref => draft?.frames.find(item => item.id === ref.frameId))
    : draft?.frames ?? [];
  const onionIndex = currentAnimation && currentRefIndex >= 0 ? currentRefIndex : frameIndex;
  const onionFrames = onion && draft && !playing && !preview
    ? Array.from({ length: onionFrameCount }, (_, offset) => [onionIndex - offset - 1, onionIndex + offset + 1]).flat().map(index => onionSequence[index]).filter((item): item is Frame => Boolean(item))
    : [];
  const validDuration = Number.isInteger(duration) && duration >= 1 && duration <= 60000;
  useEffect(() => {
    setDuration(currentRef?.durationMs ?? 200);
  }, [action, direction, frame?.id, currentRef?.durationMs]);

  function selectAnimation(nextAction: typeof action, nextDirection: Direction) {
    setPlaying(false); setAction(nextAction); setDirection(nextDirection);
    const animation = draft?.animations.find(a => a.action === nextAction && a.direction === nextDirection);
    setAnimationFrameIndex(animation ? 0 : null);
    if (animation && draft) setFrameIndex(draft.frames.findIndex(frame => frame.id === animation.frames[0].frameId));
  }

  function togglePlayback() {
    if (playing) { setPlaying(false); return; }
    if (!draft || busy || preview || (!currentAnimation && !validDuration)) return;
    const sequence = arrangePlayback(currentAnimation?.frames ?? draft.frames.map(item => ({ frameId: item.id, durationMs: duration })), playbackMode);
    const firstId = sequence[0]?.frameId ?? draft.frames[0].id;
    setFrameIndex(draft.frames.findIndex(frame => frame.id === firstId));
    setAnimationFrameIndex(currentAnimation ? currentAnimation.frames.findIndex(frame => frame.frameId === firstId) : null);
    setPlaying(true);
  }

  function updateAnimationFrame() {
    if (!frame || !validDuration) return;
    edit(document => {
      document.type = 'character';
      let animation = document.animations.find(a => a.action === action && a.direction === direction);
      if (!animation) {
        animation = { action, direction, loop: true, frames: [] };
        document.animations.push(animation);
      }
      const ref = currentRefIndex >= 0 ? animation.frames[currentRefIndex] : undefined;
      if (ref) ref.durationMs = duration;
      else {
        animation.frames.push({ frameId: frame.id, durationMs: duration });
      }
    });
  }

  function removeCurrentAnimationFrame() {
    if (!draft || !frame || !currentAnimation || !currentRef) return;
    edit(document => {
      document.animations = document.animations
        .map(animation => animation.action === action && animation.direction === direction
          ? { ...animation, frames: animation.frames.filter((_, index) => index !== currentRefIndex) }
          : animation)
        .filter(animation => animation.frames.length > 0);
    });
    setAnimationFrameIndex(null);
  }

  function deleteCurrentAnimation() {
    if (!draft || !currentAnimation) return;
    edit(document => {
      document.animations = document.animations.filter(animation => !(animation.action === action && animation.direction === direction));
    });
    setAnimationFrameIndex(null);
  }

  function toggleCurrentAnimationLoop() {
    if (!currentAnimation) return;
    edit(document => {
      const animation = document.animations.find(item => item.action === action && item.direction === direction);
      if (animation) animation.loop = !animation.loop;
    });
  }

  function moveAnimationFrame(offset: number) {
    if (!draft || !currentAnimation || !currentRef) return;
    const refIndex = currentRefIndex;
    const nextIndex = refIndex + offset;
    if (refIndex < 0 || nextIndex < 0 || nextIndex >= currentAnimation.frames.length) return;
    edit(document => {
      const animation = document.animations.find(item => item.action === action && item.direction === direction);
      if (!animation) return;
      [animation.frames[refIndex], animation.frames[nextIndex]] = [animation.frames[nextIndex], animation.frames[refIndex]];
    });
    setAnimationFrameIndex(nextIndex);
  }

  function addAllAnimationFrames() {
    if (!draft || !validDuration) return;
    edit(document => {
      document.type = 'character';
      let animation = document.animations.find(item => item.action === action && item.direction === direction);
      if (!animation) {
        animation = { action, direction, loop: true, frames: [] };
        document.animations.push(animation);
      }
      const included = new Set(animation.frames.map(ref => ref.frameId));
      for (const item of document.frames) {
        if (!included.has(item.id) && animation.frames.length < 128) {
          animation.frames.push({ frameId: item.id, durationMs: duration });
        }
      }
    });
  }
  const menuLayer = draft?.layers.find(layer => layer.id === menu?.layerId);
  const menuLayerIndex = draft?.layers.findIndex(layer => layer.id === menuLayer?.id) ?? -1;
  useEffect(() => {
    const command = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      setMenu(null);
      const textEditing = isTextEditingTarget(document.activeElement);
      if (!textEditing && document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (name === 'copy') {
        if (textEditing) document.execCommand('copy');
        else canvasEditorRef.current?.copySelection();
        return;
      }
      if (name === 'cut') {
        if (textEditing) document.execCommand('cut');
        else if (!locked) canvasEditorRef.current?.cutSelection();
        return;
      }
      if (name === 'paste') {
        if (textEditing) document.execCommand('paste');
        else if (!locked) canvasEditorRef.current?.pasteSelection();
        return;
      }
      if (locked) return;
      if (name === 'new-asset' && projectId) setDialog('asset');
      if (name === 'open' && projectId) openUpload();
      if (name === 'save' && draft) run(saveDraft, '版本已保存');
      if (name === 'undo') {
        if (textEditing) document.execCommand('undo');
        else undoEdit();
      }
      if (name === 'redo') {
        if (textEditing) document.execCommand('redo');
        else redoEdit();
      }
      if (name.startsWith('tool:')) {
        if (textEditing) return;
        const next = name.slice(5) as DrawingTool;
        if (['pencil', 'eraser', 'eyedropper', 'fill', 'line', 'rectangle', 'ellipse', 'select', 'lasso', 'color-select', 'magic-wand', 'pan', 'move-layer'].includes(next)) {
          selectTool(next);
        }
      }
    };
    window.addEventListener('pixelart-command', command);
    return () => window.removeEventListener('pixelart-command', command);
  }, [locked, projectId, draft, asset, frameIndex, selectedLayer, undo, redo, selection, tool]);
  useEffect(() => {
    const shortcuts: Record<string, DrawingTool> = { b: 'pencil', e: 'eraser', i: 'eyedropper', g: 'fill', l: 'line', r: 'rectangle', o: 'ellipse', m: 'select', q: 'lasso', h: 'pan', v: 'move-layer' };
    const handler = (event: KeyboardEvent) => {
      if (isTextEditingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && !event.altKey) {
        const command = event.key.toLowerCase();
        if (command === 's' && !locked && draft) {
          event.preventDefault();
          void run(saveDraft, '版本已保存');
          return;
        }
        if (command === 'n' && !locked && projectId) {
          event.preventDefault();
          setDialog('asset');
          return;
        }
        if (command === 'o' && !locked && projectId) {
          event.preventDefault();
          openUpload();
          return;
        }
        if ((command === 'z' || command === 'y') && !locked) {
          event.preventDefault();
          if (command === 'y' || event.shiftKey) redoEdit();
          else undoEdit();
          return;
        }
        if (command === 'c' && selection) { event.preventDefault(); canvasEditorRef.current?.copySelection(); return; }
        if (command === 'x' && selection && !locked) { event.preventDefault(); canvasEditorRef.current?.cutSelection(); return; }
        if (command === 'v' && !locked && canvasEditorRef.current?.hasClipboard()) { event.preventDefault(); canvasEditorRef.current.pasteSelection(); return; }
      }
      if (!modifier && !event.altKey && (event.key === 'Delete' || event.key === 'Backspace') && selection && !locked) {
        event.preventDefault(); canvasEditorRef.current?.deleteSelection(); return;
      }
      if (event.key === 'Escape' && selection) { event.preventDefault(); canvasEditorRef.current?.clearSelection(); return; }
      if (!modifier && !event.altKey && (event.key === '[' || event.key === ']') && !locked) {
        event.preventDefault();
        const delta = event.key === ']' ? 1 : -1;
        if (isShapeTool(tool)) setShapeSettings(value => ({ ...value, strokeSize: Math.max(1, Math.min(16, value.strokeSize + delta)) }));
        else setBrushSize(value => Math.max(1, Math.min(16, value + delta)));
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === 'f' && draft) {
        event.preventDefault();
        if (event.shiftKey) fitCanvas();
        else locateCanvas();
        return;
      }
      const next = shortcuts[event.key.toLowerCase()];
      if (next && !locked) { event.preventDefault(); selectTool(next); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [locked, projectId, selection, undo, redo, draft, frameIndex, selectedLayer, drawingStroke, tool, preview]);
  useEffect(() => {
    const toggleFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTextEditingTarget(event.target) || (event.target instanceof Element && event.target.closest('.workspace-panel, .workspace-window-menu')) || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      setFocusMode(value => !value);
    };
    window.addEventListener('keydown', toggleFocus);
    return () => window.removeEventListener('keydown', toggleFocus);
  }, []);
  let menuItems: MenuItem[] = [];
  if (menu?.kind === 'library') menuItems = [
    { label: '新建素材', icon: FilePlus2, disabled: locked || !projectId, action: () => setDialog('asset') },
    { label: '导入 PNG / Sprite Sheet', icon: Upload, disabled: locked || !projectId, action: openUpload },
    { label: '粘贴素材', icon: ClipboardPaste, disabled: locked || !projectId || !assetClipboard.current, action: () => run(pasteAsset) },
    null, { label: '刷新素材列表', icon: RefreshCw, disabled: locked || !projectId, action: () => run(refreshAssets) },
    null, { label: '新建项目', icon: Folder, disabled: locked, action: () => setDialog('project') },
  ];
  if (menu?.kind === 'asset') {
    const item = assets.find(value => value.id === menu.assetId);
    if (item) menuItems = [
      { label: '打开编辑', icon: Eye, disabled: locked, action: () => run(() => switchAsset(item.id)) },
      { label: '重命名素材', icon: Pencil, disabled: locked, action: () => beginRename(item) },
      null, { label: '复制素材', icon: Copy, disabled: locked, action: () => run(() => copyAsset(item)) },
      { label: '创建副本', icon: CopyPlus, disabled: locked || !projectId, action: () => run(() => duplicateAsset(item)) },
      null, { label: '导出当前帧 PNG', icon: Download, disabled: locked || (item.id === asset?.id && dirty), action: () => run(() => exportAsset(item, 'png', item.id === asset?.id ? frame?.id : undefined)) },
      { label: '导出帧序列 PNG ZIP', icon: Download, disabled: locked || (item.id === asset?.id && dirty), action: () => run(() => exportAsset(item, 'frames')) },
      { label: '导出 Sprite Sheet PNG ZIP', icon: Download, disabled: locked || (item.id === asset?.id && dirty), action: () => run(() => exportAsset(item, 'sheet')) },
      { label: '导出分层 PNG + JSON', icon: Download, disabled: locked || (item.id === asset?.id && dirty), action: () => run(() => exportAsset(item, 'json')) },
      { label: '查看版本', icon: History, disabled: locked, action: () => run(async () => { await switchAsset(item.id); setTab('versions'); }) },
      null, { label: '删除素材', icon: Trash2, danger: true, disabled: locked, action: () => deleteAsset(item) },
    ];
  }
  if (menu?.kind === 'canvas') menuItems = [
    { label: '铅笔', icon: Pencil, disabled: locked, action: () => selectTool('pencil') },
    { label: '橡皮', icon: Eraser, disabled: locked, action: () => selectTool('eraser') },
    { label: '取色器', icon: Pipette, disabled: locked, action: () => selectTool('eyedropper') },
    { label: '填充', icon: PaintBucket, disabled: locked, action: () => selectTool('fill') },
    { label: '直线', icon: Minus, disabled: locked, action: () => selectTool('line') },
    { label: '矩形', icon: Square, disabled: locked, action: () => selectTool('rectangle') },
    { label: '椭圆', icon: Circle, disabled: locked, action: () => selectTool('ellipse') },
    { label: '矩形选区', icon: SquareDashedMousePointer, disabled: locked, action: () => selectTool('select') },
    { label: '复制选区', icon: Copy, disabled: !selection, action: () => canvasEditorRef.current?.copySelection() },
    { label: '合并复制选区', icon: CopyPlus, disabled: !selection, action: () => canvasEditorRef.current?.copyMergedSelection() },
    { label: '剪切选区', icon: Scissors, disabled: locked || !selection, action: () => canvasEditorRef.current?.cutSelection() },
    { label: '粘贴选区', icon: ClipboardPaste, disabled: locked || !selectionClipboard, action: () => canvasEditorRef.current?.pasteSelection() },
    { label: '删除选区', icon: Trash2, danger: true, disabled: locked || !selection, action: () => canvasEditorRef.current?.deleteSelection() },
    { label: '取消选区', icon: X, disabled: !selection, action: () => canvasEditorRef.current?.clearSelection() },
    { label: '移动画布', icon: Hand, disabled: locked, action: () => selectTool('pan') },
    { label: '移动图层', icon: Move, disabled: locked, action: () => selectTool('move-layer') },
    null, { label: '撤销', icon: Undo2, disabled: locked || !undo.length, action: undoEdit },
    { label: '重做', icon: Redo2, disabled: locked || !redo.length, action: redoEdit },
    null, { label: '新建图层', icon: Plus, disabled: locked || !draft || draft.layers.length >= 16, action: newLayer },
    { label: '导入 PNG 为新图层', icon: ImagePlus, disabled: locked || !draft || draft.layers.length >= 16, action: importLayer },
    { label: '清空当前图层', icon: Trash2, danger: true, disabled: locked || !activeLayer || activeLayer.locked, action: () => {
      if (frame && window.confirm('清空当前帧中的选中图层？')) edit(document => { document.frames[frameIndex].pixels[selectedLayer] = blankImage(frame.width, frame.height); });
    } },
    null, { label: grid ? '隐藏像素网格' : '显示像素网格', icon: Grid2X2, action: () => setGrid(v => !v) },
  ];
  if (menu?.kind === 'layer' && menuLayer && draft) menuItems = [
    { label: '移动图层', icon: Move, disabled: locked || menuLayer.locked || !menuLayer.visible, action: () => selectTool('move-layer') },
    { label: '重命名图层', icon: Pencil, disabled: locked || menuLayer.locked, action: () => { layerNameInput.current?.focus(); layerNameInput.current?.select(); } },
    { label: '复制图层', icon: Copy, disabled: locked || draft.layers.length >= 16, action: () => duplicateLayer(menuLayer.id) },
    { label: menuLayer.visible ? '隐藏图层' : '显示图层', icon: menuLayer.visible ? EyeOff : Eye, disabled: locked, action: () => patchLayer(menuLayer.id, { visible: !menuLayer.visible }) },
    { label: menuLayer.locked ? '解锁图层' : '锁定图层', icon: menuLayer.locked ? Unlock : Lock, disabled: locked, action: () => patchLayer(menuLayer.id, { locked: !menuLayer.locked }) },
    null, { label: '上移图层', icon: ArrowUp, disabled: locked || menuLayer.locked || menuLayerIndex === draft.layers.length - 1, action: () => moveLayer(menuLayer.id, 1) },
    { label: '下移图层', icon: ArrowDown, disabled: locked || menuLayer.locked || menuLayerIndex === 0, action: () => moveLayer(menuLayer.id, -1) },
    { label: '向下合并图层', icon: Layers2, disabled: locked || drawingStroke || menuLayer.locked || !menuLayer.visible || menuLayerIndex <= 0 || !draft.layers[menuLayerIndex - 1].visible || draft.layers[menuLayerIndex - 1].locked, action: () => run(() => mergeLayers(menuLayer.id), '已合并全部帧的图层，可撤销') },
    { label: '合并可见图层', icon: Layers, disabled: locked || drawingStroke || !canMergeVisible, action: () => run(() => mergeLayers(), '已合并全部帧的可见图层，可撤销') },
    null, { label: '新建图层', icon: Plus, disabled: locked || draft.layers.length >= 16, action: newLayer },
    { label: '导入 PNG 为新图层', icon: ImagePlus, disabled: locked || draft.layers.length >= 16, action: importLayer },
    { label: '删除图层', icon: Trash2, danger: true, disabled: locked || menuLayer.locked || draft.layers.length <= 1, action: () => deleteLayer(menuLayer.id) },
  ];
  if (menu?.kind === 'frame' && draft) menuItems = [
    { label: '帧前移', icon: ArrowLeft, disabled: locked || menu.frameIndex === 0, action: () => moveFrame(menu.frameIndex!, -1) },
    { label: '帧后移', icon: ArrowRight, disabled: locked || menu.frameIndex === draft.frames.length - 1, action: () => moveFrame(menu.frameIndex!, 1) },
    null,
    { label: '新建空白帧', icon: FilePlus2, disabled: locked || draft.frames.length >= 64, action: () => createBlankFrame(menu.frameIndex!) },
    { label: '复制帧', icon: Copy, disabled: locked || draft.frames.length >= 64, action: () => duplicateFrame(menu.frameIndex!) },
    { label: '删除帧', icon: Trash2, danger: true, disabled: locked || draft.frames.length <= 1, action: () => deleteFrame(menu.frameIndex!) },
  ];

  return <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`} style={{
    '--library-space': layout.library.visibility !== 'visible' || layout.library.mode === 'floating' ? '0px' : layout.library.minimized ? '42px' : 'var(--library-width)',
    '--inspector-space': layout.inspector.visibility !== 'visible' || layout.inspector.mode === 'floating' ? '0px' : layout.inspector.minimized ? '42px' : 'var(--inspector-width)',
  } as CSSProperties}>
    <header className="app-header">
      <div className="brand"><Grid2X2 size={23} /><span>PixelArting</span><span className="local-badge">LOCAL</span></div>
      <div className="header-meta"><span>64 × 64</span><span>Godot 4.7.2</span></div>
      <div className="header-actions">
        <WorkspaceWindowMenu layout={layout} onRestore={id => { setFocusMode(false); restorePanel(id); }} onHide={id => updatePanel(id, { visibility: 'hidden' })} onReset={() => { setFocusMode(false); resetLayout(); }} />
        <IconButton icon={libraryCollapsed ? PanelLeftOpen : PanelLeftClose} label={libraryCollapsed ? '显示项目栏' : '切换项目栏显示'} onClick={() => libraryCollapsed ? restorePanel('library') : updatePanel('library', { visibility: 'hidden' })} />
        <IconButton icon={inspectorCollapsed ? PanelRightOpen : PanelRightClose} label={inspectorCollapsed ? '显示检查器' : '切换检查器显示'} onClick={() => inspectorCollapsed ? restorePanel('inspector') : updatePanel('inspector', { visibility: 'hidden' })} />
        <AIControls projectId={projectId} disabled={locked || !!leaveRequest} suspended={!!leaveRequest} beforeImport={confirmDiscardCurrentDraft} onBusyChange={setBusy} onImported={async next => { install(next); setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`)); }} />
        <button className="button secondary" disabled={!draft || locked} onClick={() => run(saveCurrent, '版本已保存')}><Save size={16} /><span>保存</span>{dirty || configDirty ? <i className="dirty-dot" /> : null}</button>
        <details className="export-menu"><summary className={`button primary ${!asset || dirty || locked ? 'disabled' : ''}`}><Download size={16} />导出</summary>
          <div className="dropdown">{(['png', 'frames', 'sheet', 'json', 'godot'] as const).map(target => <button key={target} disabled={!asset || dirty || locked} onClick={() => run(async () => {
            if (!asset) return;
            if (target === 'godot' && !draft?.animations.length) { setNotice({ message: '请先在时间轴中分配动作和方向', error: true }); return; }
            const frameQuery = target === 'png' && frame?.id ? `&frameId=${encodeURIComponent(frame.id)}` : '';
            const response = await fetch(`/api/assets/${asset.id}/export?versionId=${asset.currentVersionId}&target=${target}${frameQuery}`);
            if (!response.ok) { const error = await response.json(); throw new Error(error.detail || '导出失败'); }
            const url = URL.createObjectURL(await response.blob());
            const anchor = document.createElement('a'); anchor.href = url;
            anchor.download = `pixelart.${target === 'png' ? 'png' : 'zip'}`; anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          })}>{target === 'png' ? '当前帧 PNG' : target === 'frames' ? '帧序列 PNG ZIP' : target === 'sheet' ? 'Sprite Sheet PNG ZIP' : target === 'json' ? '分层 PNG + JSON 包' : 'Godot SpriteFrames 包'}</button>)}</div>
        </details>
      </div>
    </header>

    <WorkspacePanel {...panelProps('library')} className="library" onContextMenu={event => context(event, { kind: 'library' })}>
      <div className="section-label"><span>项目</span><div className="inline-tools"><IconButton icon={Plus} label="新建项目" disabled={locked} onClick={() => setDialog('project')} /><ProjectControls project={currentProject} busy={busy} beforeDelete={confirmDiscardCurrentDraft} onBusyChange={setBusy} onUpdated={async updated => { setProjects(list => list.map(item => item.id === updated.id ? updated : item)); }} onDeleted={async () => {
        const list = await api<Project[]>('/projects'); setProjects(list);
        if (list.length) await switchProject(list[0].id); else { setProjectId(''); setAsset(null); setDraft(null); }
      }} /></div></div>
      <label className="project-picker"><Folder size={16} /><select aria-label="项目" value={projectId} disabled={locked} onChange={event => { const nextProjectId = event.currentTarget.value; void run(() => switchProject(nextProjectId)); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <div className="section-label assets-label"><span>素材 <small>{assets.length}</small></span><div className="inline-tools"><IconButton icon={FilePlus2} label="新建素材" disabled={locked || !projectId} onClick={() => setDialog('asset')} /><IconButton icon={Upload} label="上传 PNG 或 Sprite Sheet" disabled={locked || !projectId} onClick={openUpload} /><ExchangeControls projectId={projectId} busy={busy} beforeImport={confirmDiscardCurrentDraft} onBusyChange={setBusy} onImported={async next => { install(next); setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`)); }} onProjectImported={async imported => { setProjects(list => [...list, imported]); await switchProject(imported.id); }} /></div></div>
      <div className="asset-list">{assets.map(item => <div key={item.id} className={`asset-row ${item.id === asset?.id ? 'selected' : ''} ${renamingAssetId === item.id ? 'renaming' : ''}`} onContextMenu={event => { event.stopPropagation(); context(event, { kind: 'asset', assetId: item.id }); }}>
        <div role="button" tabIndex={locked ? -1 : 0} aria-disabled={locked} aria-label={`${item.name}预览`} className="asset-item" onClick={() => { if (!locked) run(() => switchAsset(item.id)); }} onKeyDown={event => { if (!locked && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); run(() => switchAsset(item.id)); } }}>
          <div className="asset-thumbnail">{item.id === asset?.id && frame && draft ? <Miniature frame={frame} layers={draft.layers} /> : <img src={`/api/assets/${item.id}/thumbnail?versionId=${item.currentVersionId}`} alt={`${item.name}预览`} loading="lazy" />}</div>
          <span className="asset-copy"><span className="asset-name" onClick={event => event.stopPropagation()} onDoubleClick={event => { event.stopPropagation(); beginRename(item); }}>
            {renamingAssetId === item.id ? <input type="text" aria-label={`重命名素材 ${item.name}`} autoFocus maxLength={100} value={renameValue} onChange={event => setRenameValue(event.target.value)} onFocus={event => event.currentTarget.select()} onClick={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.preventDefault(); renameCancel.current = true; setRenamingAssetId(null); } }} onBlur={() => finishInlineRename(item)} /> : <strong title={item.name}>{item.name}</strong>}
          </span><small>{item.id === asset?.id ? `${draft?.frames.length} 帧 · ${draft?.layers.length} 图层` : `${item.frameCount} 帧 · ${item.layerCount} 图层`}<br />{item.width} × {item.height}</small></span>
        </div>
        <IconButton icon={Trash2} label={`删除素材 ${item.name}`} disabled={locked} onClick={() => deleteAsset(item)} />
      </div>)}</div>
      {!assets.length ? <p className="empty-text">暂无素材</p> : null}
      <div className="library-bottom"><span className="connection-dot" />本地工作区<span>v0.1</span></div>
    </WorkspacePanel>

    <main className="workbench">
      <div className="document-bar"><div><span className="breadcrumb">素材 <ChevronRight size={13} /></span><strong>{draft?.name || '工作台'}</strong>{dirty ? <span className="draft-badge">未保存</span> : null}</div><span className="version-label">{asset ? `v${asset.versions.length}` : ''}</span></div>
      {conflictingDraft ? <div className="draft-conflict" role="status"><span>存在基于旧版本的草稿</span><button className="button secondary" disabled={locked} onClick={() => run(async () => {
        const next = await api<Asset>(`/projects/${projectId}/assets/copy`, { document: conflictingDraft.document, sourceAssetId: conflictingDraft.assetId, versionId: conflictingDraft.baseVersionId });
        discardStoredDraft(conflictingDraft.assetId); install(next); setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`));
      }, '旧版草稿已另存为独立素材')}><CopyPlus size={16} />另存副本</button><IconButton icon={X} label="暂不恢复旧版草稿" onClick={() => setConflictingDraft(null)} /></div> : null}
      {draft && frame ? <>
        <WorkspacePanel {...panelProps('tools')} className="tool-options">
          <div ref={drawingToolsRef} className="tool-group drawing-tools" role="toolbar" aria-label="绘图工具">
            {drawingTools.map(({ value, label, icon: Icon }) => <button key={value} type="button"
              className={`icon-button ${tool === value ? 'active' : ''}`} title={label} aria-label={label}
              aria-haspopup="dialog" aria-expanded={tool === value && toolSettingsOpen && !locked && !focusMode}
              disabled={locked} onClick={() => selectTool(value)}><Icon size={17} /></button>)}
          </div>
          <ToolSettingsPopover key={tool} title={`${drawingTools.find(item => item.value === tool)!.label.replace(/ \(.*\)$/, '')}设置`}
            anchorRef={drawingToolsRef} open={toolSettingsOpen && layout.tools.visibility === 'visible' && !layout.tools.minimized && !focusMode && !locked}
            onClose={() => setToolSettingsOpen(false)}>
            {tool === 'pencil' ? <div className="tool-settings-panel" aria-label="画笔工具设置"><strong>铅笔设置</strong><BrushPreview size={brushSize} spacing={brushSpacing} opacity={brushOpacity} shape={brushShape} color={colorRef.current} colorOpacity={colorOpacity} /><label className="brush-size-control"><span>粗细</span><input aria-label="画笔粗细" type="range" min="1" max="16" step="1" value={brushSize} disabled={locked} onChange={event => setBrushSize(Number(event.target.value))} /><output>{brushSize} px</output></label><label className="brush-opacity-control"><span>不透明度</span><input aria-label="画笔不透明度" type="range" min="1" max="100" step="1" value={brushOpacity} disabled={locked} onChange={event => setBrushOpacity(Number(event.target.value))} /><output>{brushOpacity}%</output></label><label className="brush-shape-control"><span>形状</span><select aria-label="画笔形状" value={brushShape} disabled={locked} onChange={event => setBrushShape(event.target.value as BrushShape)}><option value="square">方形</option><option value="circle">圆形</option></select></label><label className="checkbox-row"><input type="checkbox" aria-label="启用笔压" checked={brushPressure} disabled={locked} onChange={event => setBrushPressure(event.target.checked)} />启用笔压</label><label className="brush-size-control"><span>间距</span><input aria-label="笔刷间距" type="range" min="10" max="200" step="5" value={brushSpacing} disabled={locked} onChange={event => setBrushSpacing(Number(event.target.value))} /><output>{brushSpacing}%</output></label></div> : null}
            {tool === 'eraser' ? <div className="tool-settings-panel" aria-label="橡皮工具设置"><strong>橡皮设置</strong><label className="brush-size-control"><span>粗细</span><input aria-label="橡皮粗细" type="range" min="1" max="16" step="1" value={brushSize} disabled={locked} onChange={event => setBrushSize(Number(event.target.value))} /><output>{brushSize} px</output></label><label className="brush-shape-control"><span>形状</span><select aria-label="橡皮形状" value={brushShape} disabled={locked} onChange={event => setBrushShape(event.target.value as BrushShape)}><option value="square">方形</option><option value="circle">圆形</option></select></label><span className="tool-settings-hint">橡皮始终完全擦除像素</span></div> : null}
            {tool === 'eyedropper' ? <EyedropperToolSettings sample={eyedropperSample} disabled={locked || drawingStroke} onChange={setEyedropperSample} /> : null}
            {tool === 'fill' ? <FillToolSettings settings={fillSettings} disabled={locked || drawingStroke} onChange={setFillSettings} /> : null}
            {isShapeTool(tool) ? <div className="tool-settings-panel" aria-label="图形工具设置">
              <strong>{tool === 'line' ? '直线' : tool === 'rectangle' ? '矩形' : '椭圆'}设置</strong>
              <label className="brush-size-control"><span>描边粗细</span><input aria-label="图形描边粗细" type="range" min="1" max="16" step="1" value={shapeSettings.strokeSize} disabled={locked || drawingStroke || (tool !== 'line' && shapeSettings.mode === 'fill')} onChange={event => setShapeSettings(value => ({ ...value, strokeSize: Number(event.target.value) }))} /><output>{shapeSettings.strokeSize} px</output></label>
              {tool !== 'line' ? <label className="brush-shape-control"><span>绘制</span><select aria-label="图形绘制模式" value={shapeSettings.mode} disabled={locked || drawingStroke} onChange={event => setShapeSettings(value => ({ ...value, mode: event.target.value as ShapeMode }))}><option value="stroke">描边</option><option value="fill">填充</option></select></label> : null}
              <span className="tool-settings-hint">{tool === 'line' ? 'Shift：45° 吸附' : 'Shift：等比例'} · Alt：中心绘制 · Esc：取消</span>

            </div> : null}
            {tool === 'select' ? <SelectionToolSettings key={`${selection?.x}:${selection?.y}:${selection?.width}:${selection?.height}`} selection={selection} canvasWidth={frame.width} canvasHeight={frame.height} disabled={locked || drawingStroke || !activeLayer?.visible || !!activeLayer?.locked || !!activeLayer?.pixelsLocked} onTransform={transform => canvasEditorRef.current?.transformSelection(transform)} onResize={(width, height) => canvasEditorRef.current?.resizeSelection(width, height)} onMove={(x, y) => canvasEditorRef.current?.positionSelection(x, y)} /> : null}
            {['lasso', 'color-select', 'magic-wand'].includes(tool) ? <div className="tool-settings-panel" aria-label="高级选区设置"><strong>{tool === 'lasso' ? '套索选区' : tool === 'color-select' ? '按颜色选择' : '魔棒选择'}</strong><span className="tool-settings-hint">{tool === 'lasso' ? '拖动绘制闭合区域，松开鼠标确认' : tool === 'color-select' ? '点击后选择当前图层中相近颜色的所有像素' : '点击后选择当前图层中相邻的同色区域'}</span></div> : null}
            {tool === 'pan' || tool === 'move-layer' ? <p className="tool-options-empty">{tool === 'pan' ? '拖动以移动画布，也可按住空格临时移动画布。' : '拖动以移动当前图层，锁定的图层无法移动。'}</p> : null}
          </ToolSettingsPopover>
        </WorkspacePanel>
        <div ref={stageRef} className={`stage ${preview ? 'comparing' : ''}`} onContextMenu={event => context(event, { kind: 'canvas' })}>
          <div className="stage-view"><span className="stage-label">{preview ? '当前版本' : activeLayer?.name}{activeLayer?.locked ? ' · 已锁定' : ''}</span><CanvasEditor ref={canvasEditorRef} key={asset?.id} frame={frame} layers={draft.layers} activeLayer={selectedLayer} tool={tool} colorRef={colorRef} colorOpacityRef={colorOpacityRef} brushSize={brushSize} brushOpacity={brushOpacity} brushPressure={brushPressure} brushSpacing={brushSpacing} brushShape={brushShape} shapeStrokeSize={shapeSettings.strokeSize} shapeMode={shapeSettings.mode} fillSettings={fillSettings} eyedropperSample={eyedropperSample} zoom={zoom} onZoomChange={setZoom} grid={grid} gridColor={canvasDisplay.gridColor} gridOpacity={canvasDisplay.gridOpacity} gridSize={canvasDisplay.gridSize} backgroundStyle={canvasDisplay.backgroundStyle} backgroundColor={canvasDisplay.backgroundColor} checkerSize={canvasDisplay.checkerSize} guides={guides} onionFrames={onionFrames} onionOpacity={onionOpacity} onionColor={onionColor} readonly={locked} finding={finding} difference={previewChange?.changedBounds} onStrokeStateChange={setDrawingStroke} onSelectionChange={setSelection} onClipboardChange={setSelectionClipboard} onFrameMetadataChange={metadata => edit(document => { document.frames[frameIndex] = { ...document.frames[frameIndex], ...metadata }; })} onPickColor={(color, opacity) => { colorRef.current = color; setPickedColor({ color, opacity }); }} onChange={image => edit(document => { document.frames[frameIndex].pixels[selectedLayer] = image; })} /></div>
          {preview ? <div className="stage-view"><span className="stage-label accent-text">修复预览</span><CanvasEditor ref={previewEditorRef} frame={preview.document.frames[frameIndex]} layers={preview.document.layers} activeLayer={selectedLayer} tool={tool} colorRef={colorRef} colorOpacityRef={colorOpacityRef} brushSize={brushSize} brushOpacity={brushOpacity} brushPressure={brushPressure} brushSpacing={brushSpacing} brushShape={brushShape} shapeStrokeSize={shapeSettings.strokeSize} shapeMode={shapeSettings.mode} fillSettings={fillSettings} eyedropperSample={eyedropperSample} zoom={zoom} onZoomChange={setZoom} grid={grid} gridColor={canvasDisplay.gridColor} gridOpacity={canvasDisplay.gridOpacity} gridSize={canvasDisplay.gridSize} backgroundStyle={canvasDisplay.backgroundStyle} backgroundColor={canvasDisplay.backgroundColor} checkerSize={canvasDisplay.checkerSize} guides={guides} difference={previewChange?.changedBounds} readonly label="修复结果画布" /></div> : null}
        </div>
        <div className="canvas-toolbar-wrap">
          <div className="canvas-toolbar" aria-label="画布操作">
            <div className="tool-group selection-tools" role="group" aria-label="编辑操作"><IconButton icon={Copy} label="复制选区" disabled={!selection} onClick={() => canvasEditorRef.current?.copySelection()} /><IconButton icon={Scissors} label="剪切选区" disabled={locked || !selection} onClick={() => canvasEditorRef.current?.cutSelection()} /><IconButton icon={ClipboardPaste} label="粘贴选区" disabled={locked || !selectionClipboard} onClick={() => canvasEditorRef.current?.pasteSelection()} /><IconButton icon={Upload} label="粘贴系统图片" disabled={locked} onClick={() => void canvasEditorRef.current?.pasteSystemImage().then(ok => { if (!ok) setNotice({ message: '系统剪贴板中没有可用图片，或浏览器未授予读取权限', error: true }); })} /><IconButton icon={Trash2} label="删除选区" disabled={locked || !selection} onClick={() => canvasEditorRef.current?.deleteSelection()} /><IconButton icon={X} label="取消选区" disabled={!selection} onClick={() => canvasEditorRef.current?.clearSelection()} /><span className="separator" /><IconButton icon={Undo2} label="撤销" disabled={!undo.length || locked} onClick={undoEdit} /><IconButton icon={Redo2} label="重做" disabled={!redo.length || locked} onClick={redoEdit} /><IconButton icon={History} label="编辑历史" active={historyOpen} onClick={() => setHistoryOpen(value => !value)} /></div>
            <div className="tool-group canvas-view-tools"><IconButton icon={Layers} label="洋葱皮预览" active={onion} disabled={!!preview || playing} onClick={() => setOnion(v => !v)} /><IconButton icon={Settings2} label="洋葱皮设置" active={onionSettingsOpen} disabled={!!preview || playing} onClick={() => setOnionSettingsOpen(v => !v)} /><IconButton icon={Crosshair} label="帧参考线" active={guides} onClick={() => setGuides(v => !v)} /><IconButton icon={Grid2X2} label="像素网格" active={grid} onClick={() => setGrid(v => !v)} /><IconButton icon={Settings2} label="画布显示设置" active={displaySettingsOpen} onClick={() => setDisplaySettingsOpen(value => !value)} /><IconButton icon={ImagePlus} label="画布导航器" active={navigatorOpen} onClick={() => setNavigatorOpen(value => !value)} /><span className="separator" /><IconButton icon={ZoomOut} label="缩小" disabled={zoom <= MIN_ZOOM || drawingStroke} onClick={() => setZoom(v => stepZoom(v, -1))} /><CanvasZoomControl zoom={zoom} disabled={drawingStroke} onChange={value => { setZoom(value); locateCanvas(); }} /><IconButton icon={ZoomIn} label="放大" disabled={zoom >= MAX_ZOOM || drawingStroke} onClick={() => setZoom(v => stepZoom(v, 1))} /><button className="button secondary canvas-locate" type="button" aria-label="适应窗口 (Shift+F)" title="适应窗口 (Shift+F)" disabled={drawingStroke} onClick={() => fitCanvas()}><Maximize size={15} />适应窗口</button><button className="button secondary canvas-locate" type="button" aria-label="填充窗口" title="按受限边精确贴合可绘图区域，完整显示画布" disabled={drawingStroke} onClick={() => fitCanvas('fill')}><ScanLine size={15} />填充窗口</button><button className="button secondary canvas-locate" type="button" aria-label="定位画布 (F)" title="定位画布 (F)" disabled={drawingStroke} onClick={locateCanvas}><Focus size={15} />定位画布</button></div>
          </div>
          {historyOpen ? <div className="canvas-display-popover edit-history-popover" role="group" aria-label="编辑历史"><div className="canvas-display-heading"><strong>编辑历史</strong><button type="button" aria-label="关闭编辑历史" onClick={() => setHistoryOpen(false)}>×</button></div><div className="edit-history-list">{undo.length ? undo.map((item, index) => <button type="button" key={`${index}-${item.name}`} onClick={() => restoreEditHistory(index)} disabled={locked || busy || !!preview || playing}>撤销至第 {index + 1} 步</button>) : <span>暂无撤销记录</span>}{redo.length ? <div className="edit-history-divider">可重做 {redo.length} 步</div> : null}</div></div> : null}
          {navigatorOpen ? <div className="canvas-display-popover navigator-popover" role="group" aria-label="画布导航器"><div className="canvas-display-heading"><strong>画布导航器</strong><button type="button" aria-label="关闭画布导航器" onClick={() => setNavigatorOpen(false)}>×</button></div><Miniature frame={frame} layers={draft.layers} /><button type="button" className="button secondary" onClick={locateCanvas}><Focus size={14} />定位画布</button></div> : null}
          {onionSettingsOpen ? <div className="canvas-display-popover onion-settings" role="group" aria-label="洋葱皮设置"><div className="canvas-display-heading"><strong>洋葱皮</strong><button type="button" aria-label="关闭洋葱皮设置" onClick={() => setOnionSettingsOpen(false)}>×</button></div><label>前后帧数<input aria-label="洋葱皮帧数" type="range" min="1" max="8" value={onionFrameCount} onChange={event => setOnionFrameCount(Number(event.target.value))} /><output>{onionFrameCount}</output></label><label>透明度<input aria-label="洋葱皮透明度" type="range" min="5" max="100" value={onionOpacity} onChange={event => setOnionOpacity(Number(event.target.value))} /><output>{onionOpacity}%</output></label><label>颜色<input aria-label="洋葱皮颜色" type="color" value={onionColor} onChange={event => setOnionColor(event.target.value.toUpperCase())} /></label></div> : null}
          {displaySettingsOpen ? <div className="canvas-display-popover" role="group" aria-label="画布显示设置">
            <div className="canvas-display-heading"><strong>画布显示</strong><button type="button" aria-label="关闭画布显示设置" onClick={() => setDisplaySettingsOpen(false)}>×</button></div>
            <label>透明背景<select aria-label="透明背景样式" value={canvasDisplay.backgroundStyle} onChange={event => setCanvasDisplay(value => ({ ...value, backgroundStyle: event.target.value as CanvasDisplaySettings['backgroundStyle'] }))}><option value="checker">棋盘格</option><option value="solid">纯色</option></select></label>
            <label>背景颜色<input aria-label="画布背景颜色" type="color" value={canvasDisplay.backgroundColor} disabled={canvasDisplay.backgroundStyle !== 'solid'} onChange={event => setCanvasDisplay(value => ({ ...value, backgroundColor: event.target.value.toUpperCase() }))} /></label>
            <label>棋盘格大小<input aria-label="棋盘格大小" type="range" min="4" max="32" step="1" value={canvasDisplay.checkerSize} disabled={canvasDisplay.backgroundStyle !== 'checker'} onChange={event => setCanvasDisplay(value => ({ ...value, checkerSize: Number(event.target.value) }))} /><output>{canvasDisplay.checkerSize}px</output></label>
            <div className="canvas-display-divider" />
            <label>网格颜色<input aria-label="网格颜色" type="color" value={canvasDisplay.gridColor} onChange={event => setCanvasDisplay(value => ({ ...value, gridColor: event.target.value.toUpperCase() }))} /></label>
            <label>网格透明度<input aria-label="网格透明度" type="range" min="5" max="100" step="1" value={canvasDisplay.gridOpacity} onChange={event => setCanvasDisplay(value => ({ ...value, gridOpacity: Number(event.target.value) }))} /><output>{canvasDisplay.gridOpacity}%</output></label>
            <label>网格间隔<input aria-label="网格间隔" type="range" min="1" max="8" step="1" value={canvasDisplay.gridSize} onChange={event => setCanvasDisplay(value => ({ ...value, gridSize: Number(event.target.value) }))} /><output>{canvasDisplay.gridSize}px</output></label>
          </div> : null}
        </div>
        {preview ? <><div className="preview-strip"><span>{preview.changes.reduce((sum, c) => sum + (c.changedPixels || 0), 0)} 像素变化 · 重检 {preview.report.findings.length} 个问题</span><label>帧<select aria-label="修复预览帧" value={frameIndex} disabled={busy} onChange={event => setFrameIndex(Number(event.target.value))}>{draft.frames.map((item, index) => <option key={item.id} value={index}>{index + 1}</option>)}</select></label><button className="button secondary" disabled={busy} onClick={() => setPreview(null)}><X size={15} />放弃</button><button className="button primary" disabled={busy} onClick={() => run(async () => { const next = await api<{ asset: Asset; report: Report }>(`/assets/${asset!.id}/commit`, { previewId: preview.previewId, expectedCurrentVersionId: asset!.currentVersionId }); install(next.asset); setReport(next.report); setTab('quality'); }, '修复已提交，原版本保留')}><Check size={15} />应用修复</button></div>{previewChange ? <RepairSummary change={previewChange} /> : null}</> : null}
        <WorkspacePanel {...panelProps('palette')} className="palette-panel"><DrawingPalette key={projectId} projectId={projectId} colorRef={colorRef} colorOpacityRef={colorOpacityRef} palette={config.palette} pickedColor={pickedColor} onOpacityChange={setColorOpacity} /></WorkspacePanel>
        <WorkspacePanel {...panelProps('timeline')} className="timeline" actions={<><small>{draft.frames.length} 帧{selectedFrames.size ? ` · 已选 ${selectedFrames.size}` : ''}</small><IconButton icon={playing ? Pause : Play} label={playing ? '暂停' : '播放动画'} disabled={!!preview || busy || (!currentAnimation && !validDuration)} active={playing} onClick={togglePlayback} /><IconButton icon={FilePlus2} label="新建空白帧" disabled={locked || draft.frames.length >= 64} onClick={() => createBlankFrame(frameIndex)} /><IconButton icon={Plus} label="复制当前帧" disabled={locked || draft.frames.length >= 64} onClick={() => duplicateFrame(frameIndex)} /><IconButton icon={CopyPlus} label="复制选中帧" disabled={locked || !selectedFrames.size || draft.frames.length + selectedFrames.size > 64} onClick={duplicateSelectedFrames} /><IconButton icon={Trash2} label="删除当前帧" disabled={locked || draft.frames.length <= 1} onClick={() => deleteFrame(frameIndex)} /><IconButton icon={Trash2} label="删除选中帧" disabled={locked || selectedFrames.size === 0 || selectedFrames.size >= draft.frames.length} onClick={deleteSelectedFrames} /></>}>
          <><div className="frame-list">{draft.frames.map((f, i) => { const mappingIndex = currentAnimation?.frames.findIndex(ref => ref.frameId === f.id) ?? -1; const mapped = mappingIndex >= 0 ? currentAnimation?.frames[mappingIndex] : undefined; const selectedFrame = selectedFrames.has(f.id); return <button key={f.id} aria-label={`第 ${i + 1} 帧`} aria-pressed={i === frameIndex} className={`frame-item ${i === frameIndex ? 'selected' : ''} ${selectedFrame ? 'multi-selected' : ''}`} disabled={!!preview || busy} draggable={!locked && !preview && !busy} onDragStart={event => { frameDragIndex.current = i; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(i)); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const from = frameDragIndex.current ?? Number(event.dataTransfer.getData('text/plain')); frameDragIndex.current = null; reorderFrame(from, i); }} onDragEnd={() => { frameDragIndex.current = null; }} onContextMenu={event => context(event, { kind: 'frame', frameIndex: i })} onClick={event => { toggleFrameSelection(f.id, event.shiftKey); setFrameIndex(i); setAnimationFrameIndex(null); setPlaying(false); }}><Miniature frame={f} layers={draft.layers} /><span>{String(i + 1).padStart(2, '0')}</span>{mapped ? <small className="frame-duration">#{mappingIndex + 1} · {mapped.durationMs} ms</small> : null}</button>; })}</div>
          <div className="animation-controls">
            <select aria-label="动作" value={action} disabled={busy || !!preview} onChange={e => selectAnimation(e.target.value as typeof action, direction)}><option value="idle">idle</option><option value="walk">walk</option></select>
            <select aria-label="方向" value={direction} disabled={busy || !!preview} onChange={e => selectAnimation(action, e.target.value as Direction)}>{Object.entries(directionNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
            <label><input aria-label="帧时长" type="number" min={1} max={60000} step={1} value={duration} disabled={locked} onChange={e => setDuration(Number(e.target.value))} /> ms</label>
            <label className="playback-mode-control">播放方式<select aria-label="播放方式" value={playbackMode} disabled={locked} onChange={e => { setPlaybackMode(e.target.value as PlaybackMode); setPlaying(false); }}><option value="forward">正向</option><option value="reverse">反向</option><option value="pingpong">往返</option></select></label>
            <button className="button secondary" disabled={locked || !validDuration || (!currentRef && (currentAnimation?.frames.length ?? 0) >= 128)} onClick={updateAnimationFrame}>{currentRef ? '更新时长' : '加入动画'}</button>
            <button className="button secondary" disabled={locked || !validDuration || !selectedFrames.size} onClick={applyDurationToSelected}>批量设时长</button>
            <IconButton icon={CheckCheck} label="加入全部帧" disabled={locked || !validDuration || (currentAnimation?.frames.length ?? 0) >= 128 || draft.frames.every(item => currentAnimation?.frames.some(ref => ref.frameId === item.id))} onClick={addAllAnimationFrames} />
            <IconButton icon={X} label="移除当前帧" disabled={locked || !currentRef} onClick={removeCurrentAnimationFrame} />
            <IconButton icon={ArrowLeft} label="动作帧前移" disabled={locked || currentRefIndex <= 0} onClick={() => moveAnimationFrame(-1)} />
            <IconButton icon={ArrowRight} label="动作帧后移" disabled={locked || currentRefIndex < 0 || currentRefIndex === (currentAnimation?.frames.length ?? 0) - 1} onClick={() => moveAnimationFrame(1)} />
            <label className="loop-toggle"><input aria-label="循环播放" type="checkbox" checked={currentAnimation?.loop ?? true} disabled={locked || !currentAnimation} onChange={toggleCurrentAnimationLoop} />循环</label>
            <IconButton icon={Trash2} label="删除当前动画" disabled={locked || !currentAnimation} onClick={deleteCurrentAnimation} />
            <span className="mapping-count">{currentAnimation?.frames.length || 0} 帧</span>
          </div>
          {currentAnimation ? <div className="animation-sequence" aria-label="当前动画序列">{currentAnimation.frames.map((ref, index) => {
            const sourceIndex = draft.frames.findIndex(item => item.id === ref.frameId);
            const source = draft.frames[sourceIndex];
            return source ? <button key={`${ref.frameId}-${index}`} className={`animation-step ${index === currentRefIndex ? 'selected' : ''}`} aria-label={`动作第 ${index + 1} 帧（素材帧 ${sourceIndex + 1}）`} aria-pressed={index === currentRefIndex} disabled={busy || !!preview} onClick={() => { setFrameIndex(sourceIndex); setAnimationFrameIndex(index); setPlaying(false); }}><Miniature frame={source} layers={draft.layers} /><span>{index + 1} · {ref.durationMs} ms</span></button> : null;
          })}</div> : null}</>
        </WorkspacePanel>
      </> : <div className="empty-workbench"><ImagePlus size={42} /><h1>素材工作台</h1><div className="inline-tools"><button className="button primary" disabled={!projectId || busy} onClick={() => setDialog('asset')}><FilePlus2 size={16} />新建素材</button><button className="button secondary" disabled={!projectId || busy} onClick={openUpload}><Upload size={16} />上传 PNG</button></div></div>}
    </main>

    <WorkspacePanel {...panelProps('inspector')} className="inspector">
      <div className="panel-tabs">{(['layers', 'quality', 'versions'] as const).map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t === 'layers' ? <Layers size={15} /> : t === 'quality' ? <ScanLine size={15} /> : <History size={15} />}{t === 'layers' ? '图层' : t === 'quality' ? '质检' : '版本'}</button>)}</div>
      {tab === 'layers' && draft && frame ? <div className="panel-content">
        <div className="section-label"><span>图层 <small>{draft.layers.length} / 16</small></span><div className="inline-tools"><IconButton icon={ImagePlus} label="导入 PNG 图层" disabled={locked || draft.layers.length >= 16} onClick={importLayer} /><IconButton icon={Plus} label="新建图层" disabled={locked || draft.layers.length >= 16} onClick={newLayer} /></div></div>
        <LayerList layers={draft.layers} frame={frame} selectedLayer={selectedLayer} disabled={locked || drawingStroke} onSelect={setSelectedLayer} onPatch={patchLayer} onContext={(event, id) => context(event, { kind: 'layer', layerId: id })} onReorder={reorderLayer} />
        {activeLayer ? <div className="layer-properties"><label className="field-label">图层名称<input ref={layerNameInput} aria-label="图层名称" value={activeLayer.name} maxLength={80} disabled={locked || activeLayer.locked} onChange={e => patchLayer(activeLayer.id, { name: e.target.value })} /></label><label className="opacity-label"><span>不透明度</span><output>{Math.round(activeLayer.opacity / 255 * 100)}%</output></label><input aria-label="图层不透明度" type="range" min={0} max={255} value={activeLayer.opacity} disabled={locked || activeLayer.locked || activeLayer.opacityLocked} onChange={e => patchLayer(activeLayer.id, { opacity: Number(e.target.value) })} /><label className="field-label">混合模式<select aria-label="图层混合模式" value={activeLayer.blendMode || 'normal'} disabled={locked || activeLayer.locked} onChange={e => patchLayer(activeLayer.id, { blendMode: e.target.value as BlendMode })}><option value="normal">正常</option><option value="multiply">正片叠底</option><option value="screen">滤色</option><option value="overlay">叠加</option><option value="darken">变暗</option><option value="lighten">变亮</option><option value="difference">差值</option><option value="exclusion">排除</option></select></label><label className="checkbox-row"><input type="checkbox" aria-label="像素锁定" checked={activeLayer.pixelsLocked === true} disabled={locked || activeLayer.locked} onChange={e => patchLayer(activeLayer.id, { pixelsLocked: e.target.checked })} />像素锁定</label><label className="checkbox-row"><input type="checkbox" aria-label="不透明度锁定" checked={activeLayer.opacityLocked === true} disabled={locked || activeLayer.locked} onChange={e => patchLayer(activeLayer.id, { opacityLocked: e.target.checked })} />不透明度锁定</label><div className="layer-actions"><IconButton icon={ArrowUp} label="上移图层" disabled={locked || activeLayer.locked || selectedLayer === draft.layers.at(-1)!.id} onClick={() => moveLayer(selectedLayer, 1)} /><IconButton icon={ArrowDown} label="下移图层" disabled={locked || activeLayer.locked || selectedLayer === draft.layers[0].id} onClick={() => moveLayer(selectedLayer, -1)} /><IconButton icon={Layers2} label="向下合并图层" disabled={locked || drawingStroke || !canMergeDown} onClick={() => run(() => mergeLayers(selectedLayer), '已合并全部帧的图层，可撤销')} /><IconButton icon={Layers} label="合并可见图层" disabled={locked || drawingStroke || !canMergeVisible} onClick={() => run(() => mergeLayers(), '已合并全部帧的可见图层，可撤销')} /><IconButton icon={Trash2} label="删除图层" disabled={locked || activeLayer.locked || draft.layers.length <= 1} onClick={() => deleteLayer(selectedLayer)} /></div></div> : null}
        <div className="panel-divider" /><div className="section-label"><span>帧属性</span><Settings2 size={15} /></div><div className="property-grid"><label>宽<input value={frame.width} readOnly /></label><label>高<input value={frame.height} readOnly /></label></div><label className="field-label">基线 Y<input aria-label="帧基线" type="number" min={0} max={frame.height - 1} value={frame.baselineY ?? ''} placeholder="未设置" disabled={locked} onChange={e => edit(document => { document.frames[frameIndex].baselineY = e.target.value === '' ? null : Number(e.target.value); })} /></label><div className="property-grid">{(['x', 'y'] as const).map(axis => <label key={axis}>原点 {axis.toUpperCase()}<input aria-label={`原点 ${axis}`} type="number" min={0} max={(axis === 'x' ? frame.width : frame.height) - 1} value={frame.origin?.[axis] ?? ''} disabled={locked} onChange={e => edit(document => { const f = document.frames[frameIndex]; f.origin = e.target.value === '' ? null : { ...(f.origin || { x: 0, y: 0 }), [axis]: Number(e.target.value) }; })} /></label>)}</div>
        <FrameMetadataEditor frame={frame} locked={locked} onChange={collisionRects => edit(document => { document.frames[frameIndex].collisionRects = collisionRects; })} />
      </div> : null}
      {tab === 'quality' ? <div className="panel-content"><fieldset className="config-fields" disabled={busy || !!leaveRequest}>
        <div className="section-label"><span>项目检查配置</span><small>{config.targetWidth} × {config.targetHeight}</small></div><div className="property-grid"><label>宽<input aria-label="目标宽度" type="number" min={1} max={512} value={config.targetWidth} onChange={e => patchConfig({ targetWidth: Number(e.target.value) })} /></label><label>高<input aria-label="目标高度" type="number" min={1} max={512} value={config.targetHeight} onChange={e => patchConfig({ targetHeight: Number(e.target.value) })} /></label><label>颜色上限<input aria-label="颜色上限" type="number" min={1} max={256} value={config.maxColors} onChange={e => patchConfig({ maxColors: Number(e.target.value) })} /></label><label>目标基线<input aria-label="目标基线" type="number" min={0} max={config.targetHeight - 1} value={config.targetBaselineY ?? ''} placeholder="未设置" onChange={e => patchConfig({ targetBaselineY: e.target.value === '' ? null : Number(e.target.value) })} /></label><label>idle 帧数<input aria-label="预期 idle 帧数" type="number" min={1} max={64} value={config.expectedIdleFrames} onChange={e => patchConfig({ expectedIdleFrames: Number(e.target.value) })} /></label><label>walk 帧数<input aria-label="预期 walk 帧数" type="number" min={1} max={64} value={config.expectedWalkFrames} onChange={e => patchConfig({ expectedWalkFrames: Number(e.target.value) })} /></label><label>基线容差<input aria-label="基线容差" type="number" min={0} max={512} value={config.baselineTolerancePx} onChange={e => patchConfig({ baselineTolerancePx: Number(e.target.value) })} /></label><label>导出检查目标<select aria-label="导出检查目标" value={config.exportTarget} onChange={e => patchConfig({ exportTarget: e.target.value as CheckConfig['exportTarget'] })}><option value="png">PNG</option><option value="frames">帧序列 PNG</option><option value="sheet">Sprite Sheet PNG</option><option value="json">分层 PNG + JSON</option><option value="godot">Godot</option></select></label></div>
        <label className="checkbox-row"><input type="checkbox" checked={config.allowSemiTransparent} onChange={e => patchConfig({ allowSemiTransparent: e.target.checked })} />允许半透明</label><label className="field-label">项目调色板<textarea aria-label="项目调色板" rows={2} value={paletteText} placeholder="#24343E, #218F83" onChange={e => { setPaletteText(e.target.value); setReport(null); }} /></label><button className="text-command" onClick={() => { const palette = paletteText.split(/[,\s]+/).filter(Boolean); if (palette.some(c => !/^#[\da-f]{6}$/i.test(c))) setNotice({ message: '调色板请使用 #RRGGBB，以逗号或空格分隔', error: true }); else { patchConfig({ palette }); setNotice({ message: '调色板已更新', error: false }); } }}>应用调色板</button>
        <div className="rule-list">{Object.entries(RULE_NAMES).map(([id, name]) => <label className="rule-row" key={id}><input type="checkbox" checked={config.enabled[id]} onChange={e => patchConfig({ enabled: { ...config.enabled, [id]: e.target.checked } })} /><span>{name}</span>{report ? <span className={`rule-state ${report.rules.find(r => r.ruleId === id)?.status}`} title={report.rules.find(r => r.ruleId === id)?.reason || ''}>{statusNames[report.rules.find(r => r.ruleId === id)?.status || '']}</span> : null}</label>)}</div>
        <button className="button secondary full" disabled={!projectId || busy || !configDirty} onClick={() => run(saveProjectConfig, '项目配置已保存')}><Save size={16} />保存项目配置</button>
        </fieldset><button className="button primary full" disabled={!asset || dirty || locked} onClick={() => run(async () => { const result = await api<Report>(`/assets/${asset!.id}/check`, { versionId: asset!.currentVersionId, config }); setReport(result); setReports(history => [result, ...history]); setFinding(null); })}><ScanLine size={16} />运行质检</button>
        {reports.length ? <label className="field-label">检查历史<select aria-label="检查历史" value={report?.id ?? ''} onChange={event => { setReport(reports.find(item => item.id === event.target.value) ?? null); setFinding(null); }}><option value="">选择报告</option>{reports.map(item => <option key={item.id} value={item.id}>{item.created ? new Date(item.created).toLocaleString('zh-CN') : item.id?.slice(0, 8)} · {item.findings.length} 个问题</option>)}</select></label> : null}
        {report ? <><div className="report-summary"><CheckCheck size={17} /><span>{report.colorCount} 色 · {report.findings.length} 个问题</span></div><div className="findings">{report.findings.map(item => <button key={item.id} className={`finding-item ${finding?.id === item.id ? 'selected' : ''}`} onClick={() => { setFinding(item); const index = draft?.frames.findIndex(f => f.id === item.frameId) ?? -1; if (index >= 0) setFrameIndex(index); }}><span className={`severity ${item.severity}`}>{item.severity === 'warning' ? '警告' : item.severity === 'blocking' ? '阻断' : '错误'}</span><strong>{RULE_NAMES[item.ruleId]}</strong><p>{item.message}</p></button>)}</div>{report.rules.filter(r => r.status === 'skipped').map(r => <p key={r.ruleId} className="skip-reason">{RULE_NAMES[r.ruleId]}：{r.reason}</p>)}</> : null}
        <RepairControls asset={asset} config={config} dirty={dirty} busy={busy} locked={locked} onBusyChange={setBusy} onPreview={result => { setPreview(result); setFinding(null); setPlaying(false); }} />
      </div> : null}
      {tab === 'versions' ? <div className="panel-content"><VersionHistory asset={asset} draft={draft} selectedLayer={selectedLayer} frameIndex={frameIndex} zoom={zoom} colorRef={colorRef} busy={busy} locked={locked} onBusyChange={setBusy} onRestore={install} beforeRestore={confirmDiscardCurrentDraft} /></div> : null}
    </WorkspacePanel>

    <input ref={layerInput} type="file" accept="image/png" hidden onChange={e => { const file = e.target.files?.[0]; if (file && !locked) { if (file.size > 8 * 1024 * 1024 || file.type !== 'image/png') setNotice({ message: '请选择 8 MB 以内的 PNG', error: true }); else run(() => addLayerFile(file)); } e.target.value = ''; }} />
    {menu ? <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} /> : null}
    <footer className="status-bar"><span>{busy ? '处理中…' : draftStatus === 'saving' || configDraftStatus === 'saving' ? '自动保存中…' : draftStatus === 'saved' || configDraftStatus === 'saved' ? '草稿已自动保存' : draftStatus === 'error' || configDraftStatus === 'error' ? '自动保存失败' : dirty || configDirty ? '未保存的编辑' : '就绪'}</span><span>{frame ? `${frame.width} × ${frame.height} · RGBA · ${draft?.layers.length} 图层` : 'PNG / Sprite Sheet'}</span><span>Python · FastAPI</span></footer>
    {notice ? <div role={notice.error ? 'alert' : 'status'} className={`toast ${notice.error ? 'error' : ''}`}><span>{notice.message}</span><IconButton icon={X} label="关闭提示" onClick={() => setNotice(null)} /></div> : null}
    {leaveRequest ? <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="leave-title" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void finishLeave('cancel'); }
        if (event.key === 'Tab') {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const next = event.shiftKey ? buttons.at(-1) : buttons[0];
          const edge = event.shiftKey ? buttons[0] : buttons.at(-1);
          if (event.target === edge) { event.preventDefault(); next?.focus(); }
        }
      }}>
        <div className="modal-heading"><h2 id="leave-title">尚有未保存的修改</h2></div>
        <p>{dirty ? '素材编辑' : ''}{dirty && configDirty ? '、' : ''}{configDirty ? '项目配置' : ''}</p>
        <div className="leave-actions">
          <button className="button primary" disabled={savingBeforeLeave} onClick={() => void finishLeave('save')}><Save size={16} />保存后继续</button>
          <button className="button secondary" disabled={savingBeforeLeave} onClick={() => void finishLeave('discard')}><Trash2 size={16} />放弃并继续</button>
          <button className="button secondary" autoFocus disabled={savingBeforeLeave} onClick={() => void finishLeave('cancel')}><X size={16} />继续编辑</button>
        </div>
      </section>
    </div> : null}
    {dialog ? <div className="modal-backdrop" inert={!!leaveRequest} style={leaveRequest ? { visibility: 'hidden' } : undefined} onMouseDown={event => { if (event.target === event.currentTarget && !busy) setDialog(null); }}>
      <section className={`modal ${dialog === 'upload' ? 'import-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="modal-heading"><h2 id="dialog-title">{dialog === 'project' ? '新建项目' : dialog === 'asset' ? '新建素材' : '导入素材'}</h2><IconButton icon={X} label="关闭对话框" disabled={busy} onClick={() => setDialog(null)} /></div>
        {dialog === 'project' ? <form onSubmit={event => { event.preventDefault(); run(async () => {
          const created = await api<Project>('/projects', { name: projectName.trim() });
          setProjects(await api<Project[]>('/projects')); await switchProject(created.id); setDialog(null); setProjectName('');
        }); }}>
          <label className="field-label">项目名称<input autoFocus value={projectName} maxLength={80} required onChange={e => setProjectName(e.target.value)} /></label>
          <button className="button primary full" disabled={busy || !projectName.trim()}><Plus size={16} />创建项目</button>
        </form> : dialog === 'asset' ? <form onSubmit={event => { event.preventDefault(); run(async () => {
          if (!await confirmDiscardCurrentDraft()) return;
          const next = await api<Asset>(`/projects/${projectId}/assets/blank`, { name: assetName.trim(), width: assetWidth, height: assetHeight });
          install(next); setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`)); setTab('layers'); setDialog(null);
        }); }}>
          <label className="field-label">素材名称<input aria-label="素材名称" autoFocus value={assetName} maxLength={100} required onChange={e => setAssetName(e.target.value)} /></label>
          <div className="property-grid"><label>宽<input aria-label="新素材宽度" type="number" min={1} max={512} value={assetWidth} required onChange={e => setAssetWidth(Number(e.target.value))} /></label><label>高<input aria-label="新素材高度" type="number" min={1} max={512} value={assetHeight} required onChange={e => setAssetHeight(Number(e.target.value))} /></label></div>
          <button className="button primary full" disabled={busy || !assetName.trim()}><FilePlus2 size={16} />创建素材</button>
        </form> : <SpriteSheetImport projectId={projectId} busy={busy} beforeImport={confirmDiscardCurrentDraft} onBusyChange={setBusy} onImport={async next => {
          install(next); setAssets(await api<AssetItem[]>(`/projects/${projectId}/assets`)); setTab('layers'); setDialog(null);
        }} />}
      </section>
    </div> : null}
  </div>;
}

function Miniature({ frame, layers }: { frame: Document['frames'][number]; layers: Layer[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all(layers.map(async layer => ({ layer, image: await loadImage(frame.pixels[layer.id]) }))).then(entries => {
      if (cancelled) return;
      const context = ref.current?.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, frame.width, frame.height);
      for (const { layer, image } of entries) { if (layer.visible) { context.globalAlpha = layer.opacity / 255; context.globalCompositeOperation = (layer.blendMode && layer.blendMode !== 'normal' ? layer.blendMode : 'source-over') as GlobalCompositeOperation; context.drawImage(image, 0, 0); } }
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [frame, layers]);
  return <canvas ref={ref} width={frame.width} height={frame.height} aria-hidden="true" />;
}
