import hashlib
import json

import numpy as np

from .images import composite
from .models import CheckConfig, Document, RULES
from .store import uid


def inspect(document: Document, config: CheckConfig) -> dict:
    images = {frame.id: np.array(composite(document, frame)) for frame in document.frames}
    colors = set()
    for array in images.values():
        colors.update(map(tuple, array[array[:, :, 3] > 0][:, :3].tolist()))
    findings = []
    results = []
    palette = {tuple(bytes.fromhex(color[1:])) for color in config.palette}

    def finding(rule, message, frame=None, region=None, fixes=(), severity="error"):
        findings.append({"id": uid(), "ruleId": rule, "ruleVersion": "1.0.0", "severity": severity, "frameId": frame, "region": region, "message": message, "canAutoFix": bool(fixes), "fixIds": list(fixes)})

    def region(mask):
        ys, xs = np.where(mask)
        return {"x": int(xs.min()), "y": int(ys.min()), "width": int(xs.max() - xs.min() + 1), "height": int(ys.max() - ys.min() + 1)}

    for rule in RULES:
        start = len(findings)
        reason = None
        if not config.enabled[rule]:
            results.append({"ruleId": rule, "status": "disabled", "reason": None})
            continue
        if rule == "size.grid":
            for frame in document.frames:
                if (frame.width, frame.height) != (config.targetWidth, config.targetHeight):
                    fixes = ["resize-nearest-v1"]
                    if frame.width <= config.targetWidth and frame.height <= config.targetHeight:
                        fixes.append("pad-canvas-v1")
                    finding(rule, f"画布 {frame.width}×{frame.height}，目标 {config.targetWidth}×{config.targetHeight}", frame.id, fixes=fixes)
        elif rule == "palette.limit":
            if len(colors) > config.maxColors:
                finding(rule, f"可见合成图共 {len(colors)} 色，超过 {config.maxColors} 色", fixes=("map-palette-v1",))
        elif rule == "palette.membership":
            if not palette:
                reason = "未设置项目调色板"
            else:
                for frame_id, array in images.items():
                    mask = np.array([[tuple(pixel[:3]) not in palette and pixel[3] > 0 for pixel in row] for row in array])
                    if mask.any():
                        finding(rule, "可见合成图包含调色板外的颜色", frame_id, region(mask), ("map-palette-v1",))
        elif rule == "transparency.halo":
            if config.allowSemiTransparent:
                reason = "当前配置允许半透明"
            else:
                for frame_id, array in images.items():
                    mask = (array[:, :, 3] > 0) & (array[:, :, 3] < 255)
                    if mask.any():
                        finding(rule, f"发现 {int(mask.sum())} 个半透明像素；图层透明度也可能是原因", frame_id, region(mask), ("remove-halo-v1",), "warning")
        elif rule == "animation.structure":
            if document.type != "character":
                reason = "普通单图不要求角色动作和方向"
            else:
                pairs = {(a.action, a.direction): a for a in document.animations}
                for direction in ("down", "left", "right", "up"):
                    for action, count in (("idle", config.expectedIdleFrames), ("walk", config.expectedWalkFrames)):
                        animation = pairs.get((action, direction))
                        if not animation:
                            finding(rule, f"缺少 {direction}/{action} 动画")
                        elif len(animation.frames) != count:
                            finding(rule, f"{direction}/{action} 有 {len(animation.frames)} 帧，预期 {count} 帧")
                if len({(f.width, f.height) for f in document.frames}) > 1:
                    finding(rule, "动画帧画布尺寸不一致", fixes=("pad-canvas-v1",))
        elif rule == "animation.baseline":
            if not document.animations:
                reason = "没有动画映射"
            elif config.targetBaselineY is None:
                reason = "未设置目标基线"
            elif any(f.baselineY is None for f in document.frames):
                reason = "部分帧尚未标记基线"
            else:
                for frame in document.frames:
                    if abs(frame.baselineY - config.targetBaselineY) > config.baselineTolerancePx:
                        finding(rule, f"基线 {frame.baselineY} 与目标 {config.targetBaselineY} 不一致", frame.id, fixes=("align-frames-v1",), severity="warning")
        elif rule == "anchor.bounds":
            for frame in document.frames:
                if frame.origin and not (0 <= frame.origin.x < frame.width and 0 <= frame.origin.y < frame.height):
                    finding(rule, "原点不在画布内", frame.id)
                if frame.baselineY is not None and not 0 <= frame.baselineY < frame.height:
                    finding(rule, "基线不在画布内", frame.id)
                for rect in frame.collisionRects:
                    if rect.x < 0 or rect.y < 0 or rect.x + rect.width > frame.width or rect.y + rect.height > frame.height:
                        finding(rule, "碰撞框超出画布", frame.id)
        elif rule == "export.integrity":
            if config.exportTarget == "godot" and not document.animations:
                finding(rule, "Godot SpriteFrames 导出需要明确的动作和方向映射", severity="blocking")
        results.append({"ruleId": rule, "status": "skipped" if reason else "findings" if len(findings) > start else "passed", "reason": reason})
    snapshot = config.model_dump()
    return {"config": snapshot, "configHash": hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest(), "executorVersion": "0.1.0", "ruleVersions": dict.fromkeys(RULES, "1.0.0"), "rules": results, "findings": findings, "colorCount": len(colors), "frameCount": len(document.frames)}
