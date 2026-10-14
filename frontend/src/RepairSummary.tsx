import type { FrameChange, FrameMetadata } from './types';

function origin(value: FrameMetadata['origin']) { return value ? `${value.x}, ${value.y}` : '未设置'; }
function collisions(value: FrameMetadata['collisionRects']) { return value.map(rect => `(${rect.x}, ${rect.y}) ${rect.width} x ${rect.height}`).join('; ') || '无'; }

export function RepairSummary({ change }: { change: FrameChange }) {
  return <div className="repair-summary" aria-label="修复差异">
    <span>当前帧 {change.changedPixels ?? 0} 像素变化</span>
    <table className="metadata-comparison"><thead><tr><th>帧属性</th><th>修复前</th><th>修复后</th></tr></thead><tbody>
      <tr><td>画布尺寸</td><td>{change.before.join(' x ')}</td><td>{change.after.join(' x ')}</td></tr>
      <tr><td>原点</td><td>{origin(change.metadataBefore.origin)}</td><td>{origin(change.metadataAfter.origin)}</td></tr>
      <tr><td>基线 Y</td><td>{change.metadataBefore.baselineY ?? '未设置'}</td><td>{change.metadataAfter.baselineY ?? '未设置'}</td></tr>
      <tr><td>碰撞框</td><td>{collisions(change.metadataBefore.collisionRects)}</td><td>{collisions(change.metadataAfter.collisionRects)}</td></tr>
    </tbody></table>
  </div>;
}
