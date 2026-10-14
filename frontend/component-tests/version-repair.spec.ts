import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

async function historyFixture(page: Page, request: APIRequestContext) {
  await page.goto('/component-tests/fixture.html');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgba(200, 20, 0, 0.4)';
    context.fillRect(1, 1, 1, 1);
    return canvas.toDataURL();
  });
  const project = await (await request.post('/api/projects', { data: { name: '版本组件回归' } })).json();
  let asset = await (await request.post(`/api/projects/${project.id}/assets/blank`, { data: { name: '历史角色', width: 4, height: 4 } })).json();
  const document = asset.document;
  document.type = 'character';
  document.frames[0].pixels.base = image;
  document.frames[0].origin = { x: 1, y: 1 };
  document.frames[0].baselineY = 2;
  document.frames[0].collisionRects = [{ x: 1, y: 1, width: 2, height: 2 }];
  document.frames.push({ ...structuredClone(document.frames[0]), id: 'frame_1' });
  document.animations = [{ action: 'idle', direction: 'down', loop: false, frames: [{ frameId: 'frame_0', durationMs: 50 }, { frameId: 'frame_1', durationMs: 50 }] }];
  asset = await (await request.post(`/api/assets/${asset.id}/save`, { data: { expectedCurrentVersionId: asset.currentVersionId, document } })).json();
  const historicVersionId = asset.currentVersionId;
  await request.post(`/api/assets/${asset.id}/check`, { data: { versionId: historicVersionId } });
  const preview = await (await request.post(`/api/assets/${asset.id}/preview`, { data: { versionId: historicVersionId, actions: [{ id: 'remove-halo-v1', alphaThreshold: 160 }] } })).json();
  asset = (await (await request.post(`/api/assets/${asset.id}/commit`, { data: { previewId: preview.previewId, expectedCurrentVersionId: historicVersionId } })).json()).asset;
  await page.goto(`/component-tests/fixture.html?asset=${asset.id}`);
  await expect(page.getByLabel('当前版本', { exact: true })).toHaveText(asset.currentVersionId);
  return { asset, historicVersionId };
}

test('history preview, animation, comparison and exports never change the current version', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { asset, historicVersionId } = await historyFixture(page, request);
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.getByRole('button', { name: '预览版本 2', exact: true }).click();
  const canvas = page.getByLabel('历史版本画布');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(1, 1, 1, 1).data[3])).toBeGreaterThan(0);
  const unchanged = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await canvas.click();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(unchanged);
  await page.getByRole('tab', { name: '与当前对比', exact: true }).click();
  const current = page.getByLabel('当前工作稿对比画布');
  await expect(current).toBeVisible();
  await expect.poll(() => current.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(1, 1, 1, 1).data[3])).toBe(0);
  await page.getByLabel('历史动画', { exact: true }).selectOption('idle_down');
  await page.getByRole('button', { name: '播放历史动画', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放历史动画', exact: true })).toBeVisible();
  await expect(page.getByLabel('历史帧', { exact: true })).toHaveValue('1');
  await page.screenshot({ path: '/tmp/pixelarting-history-compare.png' });
  await page.getByRole('tab', { name: '质检记录', exact: true }).click();
  await expect(page.locator('.history-report-panel')).toContainText(historicVersionId.slice(0, 7));
  await expect(page.locator('.history-report-panel')).toContainText('半透明像素');
  await expect(page.locator('.history-report-panel')).not.toContainText(asset.currentVersionId.slice(0, 7));

  await page.getByRole('tab', { name: '预览', exact: true }).click();
  await page.getByLabel('历史帧', { exact: true }).selectOption('1');
  await page.locator('.history-preview-actions summary').click();
  const download = page.waitForEvent('download');
  const exported = page.waitForRequest(request => request.url().includes('/export?'));
  await page.getByRole('button', { name: '历史当前帧 PNG', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`pixelart-${historicVersionId.slice(0, 7)}.png`);
  const query = new URL((await exported).url()).searchParams;
  expect(query.get('versionId')).toBe(historicVersionId);
  expect(query.get('frameId')).toBe('frame_1');
  expect((await (await request.get(`/api/assets/${asset.id}`)).json()).currentVersionId).toBe(asset.currentVersionId);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: '与当前对比', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const dialog = await page.getByRole('dialog').boundingBox();
  expect(dialog!.x).toBeGreaterThanOrEqual(0);
  expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/pixelarting-history-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('restoration honors cancellation and rejects a stale current version', async ({ page, request }) => {
  const { asset, historicVersionId } = await historyFixture(page, request);
  await page.getByLabel('允许恢复', { exact: true }).uncheck();
  await page.getByRole('button', { name: '预览版本 2', exact: true }).click();
  await expect(page.getByLabel('历史版本画布')).toBeVisible();
  await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
  expect((await (await request.get(`/api/assets/${asset.id}`)).json()).currentVersionId).toBe(asset.currentVersionId);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '关闭版本预览', exact: true }).click();
  await page.getByLabel('允许恢复', { exact: true }).check();
  const update = structuredClone(asset.document);
  update.name = '外部保存';
  await request.post(`/api/assets/${asset.id}/save`, { data: { expectedCurrentVersionId: asset.currentVersionId, document: update } });
  await page.getByRole('button', { name: '预览版本 2', exact: true }).click();
  await expect(page.getByLabel('历史版本画布')).toBeVisible();
  await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('当前版本已变化');
  await page.reload();
  await page.getByRole('button', { name: '预览版本 2', exact: true }).click();
  await expect(page.getByLabel('历史版本画布')).toBeVisible();
  await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('当前版本', { exact: true })).toHaveText(historicVersionId);
});

test('repair controls send explicit parameters, reject invalid inputs and respect dirty drafts', async ({ page, request }) => {
  const { asset } = await historyFixture(page, request);
  await page.getByLabel('草稿未保存', { exact: true }).check();
  await expect(page.getByRole('button', { name: '预览修复', exact: true })).toBeDisabled();
  await page.getByLabel('草稿未保存', { exact: true }).uncheck();
  await page.getByLabel('透明度阈值', { exact: true }).fill('0');
  await expect(page.getByRole('button', { name: '预览修复', exact: true })).toBeDisabled();
  await page.getByLabel('透明度阈值', { exact: true }).fill('170');
  await page.getByRole('button', { name: '预览修复', exact: true }).click();
  await expect(page.getByLabel('修复预览参数', { exact: true })).toContainText('"alphaThreshold":170');
  await expect(page.getByLabel('修复基础版本', { exact: true })).toHaveText(asset.currentVersionId);
  await page.getByLabel('修复动作', { exact: true }).selectOption('pad-canvas-v1');
  await page.getByLabel('修复水平偏移', { exact: true }).fill('1');
  await page.getByLabel('修复垂直偏移', { exact: true }).fill('2');
  await page.getByRole('button', { name: '预览修复', exact: true }).click();
  await expect(page.getByLabel('修复预览参数', { exact: true })).toContainText('"offsetX":1,"offsetY":2');
  await expect(page.getByLabel('组件修复结果画布')).toHaveAttribute('width', '8');
  await page.getByLabel('修复水平偏移', { exact: true }).fill('8');
  await page.getByRole('button', { name: '预览修复', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('透明画布补齐不能裁切原图');
});

test('restoring after an asynchronous save uses the saved current version', async ({ page, request }) => {
  const { asset, historicVersionId } = await historyFixture(page, request);
  await page.getByLabel('先保存再恢复', { exact: true }).check();
  await page.getByRole('button', { name: '预览版本 2', exact: true }).click();
  await expect(page.getByLabel('历史版本画布')).toBeVisible();
  await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('当前版本', { exact: true })).toHaveText(historicVersionId);
  const restored = await (await request.get(`/api/assets/${asset.id}`)).json();
  expect(restored.currentVersionId).toBe(historicVersionId);
  expect(restored.versions.some((version: { operation: string; id: string }) => version.operation === 'edit' && version.id !== historicVersionId)).toBe(true);
});
