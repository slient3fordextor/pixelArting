import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

async function openImporter(page: Page, request: APIRequestContext, allow = true) {
  const project = await (await request.post('/api/projects', { data: { name: 'Browser import project' } })).json();
  await page.goto(`/import-tests/fixtures/sheet-import.html?projectId=${project.id}&allow=${allow ? 'yes' : 'no'}`);
  await expect(page.getByLabel('PNG 文件')).toBeVisible();
  return project.id as string;
}

async function imageFile(page: Page, sheet = true) {
  const encoded = await page.evaluate(useSheet => {
    const canvas = document.createElement('canvas');
    canvas.width = useSheet ? 18 : 4;
    canvas.height = useSheet ? 11 : 3;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ff00ff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < (useSheet ? 6 : 1); index++) {
      context.fillStyle = `rgb(${index * 30}, 100, 200)`;
      context.fillRect(useSheet ? 1 + (index % 3) * 6 : 0, useSheet ? 2 + Math.floor(index / 3) * 4 : 0, 4, 3);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }, sheet);
  return { name: sheet ? 'sheet.png' : 'single.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') };
}

test('retained input retries invalid layouts and confirms row and per-frame mappings', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const projectId = await openImporter(page, request);
  await page.getByLabel('PNG 文件').setInputFiles(await imageFile(page));
  await page.getByRole('radio', { name: 'Sprite Sheet', exact: true }).check();
  for (const [label, value] of [['单帧宽度', '5'], ['单帧高度', '3'], ['左右边距', '1'], ['上下边距', '2'], ['水平间距', '2'], ['垂直间距', '1'], ['行数（0 自动）', '2'], ['列数（0 自动）', '3']]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: '预览切分', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('水平布局未完整覆盖');
  await expect(page.locator('.sheet-file-zone')).toContainText('sheet.png');
  await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
  await page.getByLabel('单帧宽度', { exact: true }).fill('4');
  await page.getByRole('button', { name: '预览切分', exact: true }).click();
  await expect(page.getByRole('region', { name: '切分预览' })).toBeVisible();
  await expect(page.locator('.sheet-frame')).toHaveCount(6);
  await page.getByLabel('水平间距', { exact: true }).fill('1');
  await expect(page.getByRole('region', { name: '切分预览' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
  await page.getByLabel('水平间距', { exact: true }).fill('2');
  await page.getByRole('button', { name: '预览切分', exact: true }).click();
  await expect(page.locator('.sheet-frame')).toHaveCount(6);
  expect(await (await request.get(`/api/projects/${projectId}/assets`)).json()).toEqual([]);
  await expect.poll(() => page.getByAltText('切分帧 1', { exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(4);
  expect(await page.getByAltText('切分帧 4', { exact: true }).evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = 3;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  })).toEqual([90, 100, 200, 255]);
  await page.getByLabel('第 1 行动作方向').selectOption('idle:down');
  await page.getByLabel('第 2 行动作方向').selectOption('walk:down');
  await page.getByLabel('统一帧时长', { exact: true }).fill('120');
  await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
  await page.getByLabel('确认动作与方向映射').check();
  await page.getByRole('radio', { name: '逐帧', exact: true }).check();
  await page.getByLabel('帧 2 动作方向').selectOption('idle:left');
  await page.getByLabel('帧 2 时长').fill('80');
  await expect(page.getByLabel('确认动作与方向映射')).not.toBeChecked();
  await page.getByLabel('确认动作与方向映射').check();
  await page.screenshot({ path: '/tmp/pixelarting-sheet-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已导入 sheet');
  const imported = JSON.parse((await page.getByTestId('imported-asset').textContent())!);
  expect(imported.document.type).toBe('character');
  expect(imported.document.frames).toHaveLength(6);
  expect(imported.document.animations.find((item: { action: string; direction: string }) => item.action === 'idle' && item.direction === 'left').frames).toEqual([{ frameId: 'frame_1', durationMs: 80 }]);
  expect(imported.document.animations.find((item: { action: string }) => item.action === 'walk').frames.map((item: { frameId: string }) => item.frameId)).toEqual(['frame_3', 'frame_4', 'frame_5']);
  expect(await (await request.get(`/api/projects/${projectId}/assets`)).json()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('mobile single-image preview keeps input after failed import and retries', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const projectId = await openImporter(page, request);
  await page.getByLabel('PNG 文件').setInputFiles(await imageFile(page, false));
  await page.getByRole('button', { name: '预览切分', exact: true }).click();
  await expect(page.locator('.sheet-frame')).toHaveCount(1);
  await page.route(`**/api/projects/${projectId}/assets`, async route => {
    await route.fulfill({ status: 503, json: { detail: '导入暂时失败，请重试' } });
  }, { times: 1 });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('导入暂时失败');
  await expect(page.locator('.sheet-file-zone')).toContainText('single.png');
  await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const overflow = await page.locator('.sprite-sheet-import').evaluate(element => Array.from(element.querySelectorAll('button,input,select,img')).some(child => {
    const bounds = child.getBoundingClientRect();
    return bounds.left < 0 || bounds.right > window.innerWidth;
  }));
  expect(overflow).toBe(false);
  expect(await page.locator('.sheet-segmented label').evaluateAll(labels => labels.every(label => label.getBoundingClientRect().height < 24))).toBe(true);
  await page.screenshot({ path: '/tmp/pixelarting-sheet-mobile.png', fullPage: true });
  await page.locator('.modal').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: '/tmp/pixelarting-sheet-mobile-top.png', fullPage: true });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已导入 single');
  expect(await (await request.get(`/api/projects/${projectId}/assets`)).json()).toHaveLength(1);
});

test('unsaved-work guard can cancel import without losing the preview', async ({ page, request }) => {
  const projectId = await openImporter(page, request, false);
  await page.getByLabel('PNG 文件').setInputFiles(await imageFile(page, false));
  await page.getByRole('button', { name: '预览切分', exact: true }).click();
  await expect(page.locator('.sheet-frame')).toHaveCount(1);
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeEnabled();
  expect(await (await request.get(`/api/projects/${projectId}/assets`)).json()).toEqual([]);
  await expect(page.getByRole('region', { name: '切分预览' })).toBeVisible();
});
