import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import type { Asset, Document } from '../src/types';

async function fixture(page: Page, request: APIRequestContext, width = 16, height = 16) {
  const project = await (await request.post('/api/projects', { data: { name: '选区与图层回归' } })).json();
  const asset: Asset = await (await request.post(`/api/projects/${project.id}/assets/blank`, { data: { name: '变换素材', width, height } })).json();
  asset.document.layers[0].name = '底图';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const images = await page.evaluate(({ width, height }) => {
    const make = (paint: (ctx: CanvasRenderingContext2D) => void) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      paint(canvas.getContext('2d')!); return canvas.toDataURL();
    };
    return {
      pattern: make(ctx => {
        ctx.fillStyle = '#ff0000'; ctx.fillRect(2, 2, 1, 1);
        ctx.fillStyle = '#00ff00'; ctx.fillRect(3, 2, 1, 1);
        ctx.fillStyle = '#0000ff'; ctx.fillRect(4, 3, 1, 1);
      }),
      red: make(ctx => { ctx.fillStyle = '#ff0000'; ctx.fillRect(2, 2, 3, 2); }),
      blue: make(ctx => { ctx.fillStyle = '#0000ff'; ctx.fillRect(2, 2, 3, 2); }),
      blank: make(() => {}),
    };
  }, { width, height });
  return { project, asset, images };
}

async function openDocument(page: Page, request: APIRequestContext, projectId: string, asset: Asset, document: Document) {
  const response = await request.post(`/api/assets/${asset.id}/save`, { data: { expectedCurrentVersionId: asset.currentVersionId, document } });
  expect(response.ok()).toBe(true);
  await page.getByLabel('项目', { exact: true }).selectOption(projectId);
  await expect(page.getByLabel('像素编辑画布', { exact: true })).toHaveAttribute('aria-busy', 'false');
}

async function select(page: Page, x: number, y: number, width: number, height: number) {
  const tool = page.getByRole('button', { name: '矩形选区 (M)', exact: true });
  if (!(await tool.getAttribute('class'))?.includes('active')) await tool.click();
  await page.keyboard.press('Escape');
  const canvas = page.getByLabel('像素编辑画布', { exact: true });
  const bounds = (await canvas.boundingBox())!;
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
  const point = (px: number, py: number) => ({ x: bounds.x + bounds.width * (px + .5) / size.width, y: bounds.y + bounds.height * (py + .5) / size.height });
  const from = point(x, y), to = point(x + width - 1, y + height - 1);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y); await page.mouse.up();
  await expect(page.locator('.selection-region')).toBeVisible();
  await tool.click();
}

const pixel = (page: Page, x: number, y: number) => page.getByLabel('像素编辑画布', { exact: true }).evaluate((el: HTMLCanvasElement, point) => Array.from(el.getContext('2d')!.getImageData(point.x, point.y, 1, 1).data), { x, y });
const snapshot = (page: Page) => page.getByLabel('像素编辑画布', { exact: true }).evaluate((el: HTMLCanvasElement) => el.toDataURL());

test('selection flips and right-angle rotations preserve exact pixels and each undo step', async ({ page, request }) => {
  const { project, asset, images } = await fixture(page, request);
  asset.document.frames[0].pixels.base = images.pattern;
  await openDocument(page, request, project.id, asset, asset.document);
  const before = await snapshot(page);
  await select(page, 2, 2, 3, 2);
  await page.getByRole('button', { name: '水平翻转选区', exact: true }).click();
  expect(await pixel(page, 4, 2)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 2, 3)).toEqual([0, 0, 255, 255]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => snapshot(page)).toBe(before);
  await page.getByRole('button', { name: '矩形选区 (M)', exact: true }).click();
  await page.getByRole('button', { name: '垂直翻转选区', exact: true }).click();
  expect(await pixel(page, 2, 3)).toEqual([255, 0, 0, 255]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => snapshot(page)).toBe(before);
  await page.getByRole('button', { name: '矩形选区 (M)', exact: true }).click();
  await page.getByRole('button', { name: '顺时针旋转选区', exact: true }).click();
  expect(await pixel(page, 3, 1)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 2, 3)).toEqual([0, 0, 255, 255]);
  await expect(page.getByLabel('选区缩放宽度')).toHaveValue('2');
  await expect(page.getByLabel('选区缩放高度')).toHaveValue('3');
  await page.getByRole('button', { name: '逆时针旋转选区', exact: true }).click();
  // Odd-sized center changes round toward the top-left, never outside the canvas.
  expect(await pixel(page, 1, 1)).toEqual([255, 0, 0, 255]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('像素编辑画布')).toHaveAttribute('aria-busy', 'false');
  expect(await pixel(page, 3, 1)).toEqual([255, 0, 0, 255]);
});

test('nearest-neighbor resize and precise placement stay bounded and persist', async ({ page, request }) => {
  const { project, asset, images } = await fixture(page, request);
  asset.document.frames[0].pixels.base = images.pattern;
  await openDocument(page, request, project.id, asset, asset.document);
  await select(page, 2, 2, 3, 2);
  await page.getByLabel('选区缩放宽度').fill('6'); await page.getByLabel('选区缩放高度').fill('4');
  await page.getByRole('button', { name: '缩放选区', exact: true }).click();
  expect(await pixel(page, 0, 1)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 1, 2)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 4, 3)).toEqual([0, 0, 255, 255]);
  await page.getByLabel('选区位置 X').fill('10'); await page.getByLabel('选区位置 Y').fill('12');
  await page.getByRole('button', { name: '定位选区', exact: true }).click();
  expect(await pixel(page, 10, 12)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 15, 15)).toEqual([0, 0, 255, 255]);
  expect(await pixel(page, 0, 1)).toEqual([0, 0, 0, 0]);
  await page.getByLabel('选区位置 X').fill('11');
  await expect(page.getByRole('button', { name: '定位选区', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '居中选区', exact: true }).click();
  await expect(page.getByLabel('选区位置 X')).toHaveValue('5');
  await expect(page.getByLabel('选区位置 Y')).toHaveValue('6');
  const beforeSave = await snapshot(page);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('版本已保存');
  await page.reload(); await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await expect.poll(() => snapshot(page)).toBe(beforeSave);
});

test('selection transformations reject locked layers, oversized rotations and empty edits', async ({ page, request }) => {
  const { project, asset } = await fixture(page, request, 16, 4);
  await openDocument(page, request, project.id, asset, asset.document);
  await select(page, 0, 0, 6, 2);
  await expect(page.getByRole('button', { name: '顺时针旋转选区', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '水平翻转选区', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '锁定 底图', exact: true }).click();
  await page.getByRole('button', { name: '矩形选区 (M)', exact: true }).click();
  await expect(page.getByRole('button', { name: '水平翻转选区', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '缩放选区', exact: true })).toBeDisabled();
});

test('copy selection reads the active layer while merged copy reads the visible composite', async ({ page, request }) => {
  const { project, asset, images } = await fixture(page, request);
  asset.document.layers.push({ id: 'top', name: '蓝色层', opacity: 255, visible: true, locked: false });
  asset.document.frames[0].pixels = { base: images.red, top: images.blue };
  await openDocument(page, request, project.id, asset, asset.document);
  await page.locator('.layer-select').filter({ hasText: '底图' }).click();
  await select(page, 2, 2, 3, 2);
  await page.getByRole('button', { name: '复制选区', exact: true }).click();
  await page.getByRole('button', { name: '新建图层', exact: true }).click();
  await page.getByRole('button', { name: '粘贴选区', exact: true }).click();
  expect(await pixel(page, 2, 2)).toEqual([255, 0, 0, 255]);
  await page.getByRole('button', { name: '隐藏 图层 3', exact: true }).click();
  await page.getByLabel('像素编辑画布').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '合并复制选区', exact: true }).click();
  await page.getByRole('button', { name: '显示 图层 3', exact: true }).click();
  await page.getByRole('button', { name: '粘贴选区', exact: true }).click();
  expect(await pixel(page, 2, 2)).toEqual([0, 0, 255, 255]);
});

test('real layer dragging reorders the shared stack, supports undo and saves', async ({ page, request }) => {
  const { project, asset, images } = await fixture(page, request);
  asset.document.layers.push({ id: 'top', name: '蓝色层', opacity: 255, visible: true, locked: false });
  asset.document.frames[0].pixels = { base: images.red, top: images.blue };
  await openDocument(page, request, project.id, asset, asset.document);
  const handle = page.getByRole('button', { name: '拖拽排序 底图', exact: true });
  const target = page.locator('.layer-row').filter({ hasText: '蓝色层' });
  const bounds = (await target.boundingBox())!;
  await handle.dragTo(target, { targetPosition: { x: bounds.width / 2, y: 4 } });
  await expect(page.locator('.layer-select').first()).toHaveText('底图');
  expect(await pixel(page, 2, 2)).toEqual([255, 0, 0, 255]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.layer-select').first()).toHaveText('蓝色层');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('版本已保存');
  const saved = await (await request.get(`/api/assets/${asset.id}`)).json();
  expect(saved.document.layers.map((layer: { id: string }) => layer.id)).toEqual(['top', 'base']);
});

test('merge down preserves opacity and all animation frames and can undo atomically', async ({ page, request }) => {
  const { project, asset, images } = await fixture(page, request);
  asset.document.layers[0].opacity = 128;
  asset.document.layers.push({ id: 'top', name: '蓝色层', opacity: 128, visible: true, locked: false });
  asset.document.frames[0].pixels = { base: images.red, top: images.blue };
  asset.document.frames.push({ ...structuredClone(asset.document.frames[0]), id: 'second', pixels: { base: images.blue, top: images.red } });
  asset.document.animations = [{ action: 'walk', direction: 'down', loop: true, frames: [{ frameId: asset.document.frames[0].id, durationMs: 100 }, { frameId: 'second', durationMs: 300 }] }];
  await openDocument(page, request, project.id, asset, asset.document);
  const first = await snapshot(page);
  await page.getByRole('button', { name: '第 2 帧', exact: true }).click();
  await expect(page.getByLabel('像素编辑画布')).toHaveAttribute('aria-busy', 'false');
  const second = await snapshot(page);
  await page.getByRole('button', { name: '向下合并图层', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await expect.poll(() => snapshot(page)).toBe(second);
  await expect(page.getByLabel('图层不透明度')).toHaveValue('255');
  await page.getByRole('button', { name: '第 1 帧', exact: true }).click();
  await expect.poll(() => snapshot(page)).toBe(first);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await expect.poll(() => snapshot(page)).toBe(first);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('版本已保存');
  const saved = await (await request.get(`/api/assets/${asset.id}`)).json();
  expect(saved.document.frames.map((frame: { pixels: object }) => Object.keys(frame.pixels))).toEqual([['base'], ['base']]);
  expect(saved.document.animations).toEqual(asset.document.animations);
});

test('merge visible retains hidden locked layers and refuses any visible locked layer', async ({ page, request }) => {
  const { project, asset, images } = await fixture(page, request);
  asset.document.layers.push({ id: 'hidden', name: '隐藏保护层', opacity: 100, visible: false, locked: true }, { id: 'top', name: '蓝色层', opacity: 128, visible: true, locked: true });
  asset.document.frames[0].pixels = { base: images.red, hidden: images.pattern, top: images.blue };
  await openDocument(page, request, project.id, asset, asset.document);
  await expect(page.getByRole('button', { name: '合并可见图层', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '向下合并图层', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '拖拽排序 蓝色层', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '解锁 蓝色层', exact: true }).click();
  const before = await snapshot(page);
  await page.getByRole('button', { name: '合并可见图层', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await expect.poll(() => snapshot(page)).toBe(before);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('版本已保存');
  const saved = await (await request.get(`/api/assets/${asset.id}`)).json();
  expect(saved.document.layers.find((layer: { id: string }) => layer.id === 'hidden')).toEqual(asset.document.layers[1]);
  expect(saved.document.frames[0].pixels.hidden).toBe(images.pattern);
});
