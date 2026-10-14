import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('asset context-menu PNG export downloads the selected frame', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const project = await (await request.post('/api/projects', { data: { name: '当前帧导出项目' } })).json();
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  const canvas = page.getByLabel('像素编辑画布');
  await page.getByRole('button', { name: '新建素材', exact: true }).first().click();
  await page.getByLabel('素材名称').fill('当前帧导出验证');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '复制当前帧', exact: true }).click();
  await expect(page.getByRole('button', { name: '第 2 帧', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 5.5 / 64, bounds.y + bounds.height * 5.5 / 64);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(5, 5, 1, 1).data[3])).toBe(255);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText('版本已保存');

  const projectId = await page.getByLabel('项目', { exact: true }).inputValue();
  const assets = await (await request.get(`/api/projects/${projectId}/assets`)).json();
  const selectedAsset = assets.find((item: { name: string }) => item.name === '当前帧导出验证');
  const asset = await (await request.get(`/api/assets/${selectedAsset.id}`)).json();
  const expected = await request.get(`/api/assets/${asset.id}/export?versionId=${asset.currentVersionId}&target=png&frameId=${asset.document.frames[1].id}`);
  const firstFrame = await request.get(`/api/assets/${asset.id}/export?versionId=${asset.currentVersionId}&target=png&frameId=${asset.document.frames[0].id}`);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.asset-row').filter({ hasText: '当前帧导出验证' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '导出当前帧 PNG', exact: true }).click();
  const download = await downloadPromise;
  const downloadedPath = testInfo.outputPath('selected-frame.png');
  await download.saveAs(downloadedPath);
  const actual = await readFile(downloadedPath);
  expect(actual.equals(await expected.body())).toBe(true);
  expect(actual.equals(await firstFrame.body())).toBe(false);
});

test('header export menu downloads frame sequence and sprite sheet bundles', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: '批量导出项目' } })).json();
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: '新建素材', exact: true }).first().click();
  await page.getByLabel('素材名称').fill('批量导出验证');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await expect(page.getByLabel('像素编辑画布')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '复制当前帧', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText('版本已保存');

  const exportMenu = page.locator('header .export-menu');
  await exportMenu.locator('summary').click();
  const framesDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '帧序列 PNG ZIP', exact: true }).click();
  const framesDownload = await framesDownloadPromise;
  expect(framesDownload.suggestedFilename()).toBe('pixelart.zip');

  const sheetDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Sprite Sheet PNG ZIP', exact: true }).click();
  const sheetDownload = await sheetDownloadPromise;
  expect(sheetDownload.suggestedFilename()).toBe('pixelart.zip');
  await exportMenu.locator('summary').click();

  await page.getByRole('button', { name: '质检', exact: true }).click();
  await expect(page.getByLabel('导出检查目标')).toHaveValue('png');
  await expect(page.getByLabel('导出检查目标').locator('option[value="frames"]')).toHaveText('帧序列 PNG');
  await expect(page.getByLabel('导出检查目标').locator('option[value="sheet"]')).toHaveText('Sprite Sheet PNG');
});
