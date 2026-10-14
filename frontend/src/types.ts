export type Layer = { id: string; name: string; visible: boolean; locked: boolean; opacity: number };
export type Frame = {
  id: string; width: number; height: number; pixels: Record<string, string>;
  origin: { x: number; y: number } | null; baselineY: number | null;
  collisionRects: { x: number; y: number; width: number; height: number }[];
};
export type Direction = 'down' | 'left' | 'right' | 'up';
export type Animation = { action: 'idle' | 'walk'; direction: Direction; loop: boolean; frames: { frameId: string; durationMs: number }[] };
export type Document = { schemaVersion: '1.1'; name: string; type: 'image' | 'character'; layers: Layer[]; frames: Frame[]; animations: Animation[]; provenance: Record<string, unknown> };
export type Version = { id: string; parent: string | null; operation: string; checksum: string; created: string };
export type Asset = { id: string; name: string; projectId: string; currentVersionId: string; versions: Version[]; document: Document };
export type AssetItem = Pick<Asset, 'id' | 'name' | 'currentVersionId'> & { frameCount: number; layerCount: number; width: number; height: number };
export type Project = { id: string; name: string };
export type CheckConfig = {
  targetWidth: number; targetHeight: number; maxColors: number; palette: string[];
  allowSemiTransparent: boolean; baselineTolerancePx: number; targetBaselineY: number | null;
  expectedIdleFrames: number; expectedWalkFrames: number; enabled: Record<string, boolean>;
  exportTarget: 'png' | 'json' | 'godot'; godotVersion: '4.7.2';
};
export type Finding = { id: string; ruleId: string; severity: string; frameId: string | null; message: string; region: { x: number; y: number; width: number; height: number } | null; fixIds: string[] };
export type Report = { id?: string; assetVersionId?: string; created?: string; config?: CheckConfig; findings: Finding[]; rules: { ruleId: string; status: string; reason: string | null }[]; colorCount: number; frameCount: number };
export type RepairAction = { id: string; alphaThreshold: number; offsetX: number; offsetY: number };
export type FrameMetadata = Pick<Frame, 'origin' | 'baselineY' | 'collisionRects'>;
export type FrameChange = {
  frameId: string; changedPixels: number | null; before: number[]; after: number[];
  changedBounds: { x: number; y: number; width: number; height: number } | null;
  metadataBefore: FrameMetadata; metadataAfter: FrameMetadata; metadataChanged: boolean;
};
export type Preview = { previewId: string; baseVersionId: string; actions: RepairAction[]; document: Document; changes: FrameChange[]; report: Report };
export const RULE_NAMES: Record<string, string> = {
  'size.grid': '画布尺寸', 'palette.limit': '颜色数量', 'palette.membership': '调色板一致性',
  'transparency.halo': '半透明像素', 'animation.structure': '动画结构',
  'animation.baseline': '动画基线', 'anchor.bounds': '原点与碰撞框', 'export.integrity': '导出完整性',
};
export const FIX_NAMES: Record<string, string> = {
  'resize-nearest-v1': '最近邻缩放', 'map-palette-v1': '调色板映射', 'remove-halo-v1': '透明度二值化',
  'pad-canvas-v1': '补齐画布', 'align-frames-v1': '对齐基线',
};
export const defaultConfig: CheckConfig = {
  targetWidth: 64, targetHeight: 64, maxColors: 32, palette: [], allowSemiTransparent: false,
  baselineTolerancePx: 0, targetBaselineY: null, expectedIdleFrames: 1, expectedWalkFrames: 4,
  enabled: Object.fromEntries(Object.keys(RULE_NAMES).map(key => [key, true])), exportTarget: 'png', godotVersion: '4.7.2',
};
