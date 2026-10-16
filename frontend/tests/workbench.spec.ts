import { expect, test } from '@playwright/test';

test('multilayer editing, persistence, quality checks and repair preview', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toBeVisible();
  await expect(page.locator('.origin-marker')).toBeVisible();
  await expect(page.locator('.baseline-guide')).toBeVisible();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const data = element.getContext('2d')!.getImageData(0, 0, 64, 64).data;
    let count = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) count++;
    return count;
  })).toBeGreaterThan(100);

  const count = await page.locator('.layer-row').count();
  await page.getByRole('button', { name: '新建图层', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(count + 1);
  await page.getByLabel('图层名称').fill('浏览器测试层');
  const rect = await canvas.boundingBox();
  await page.mouse.click(rect!.x + 4 * 6 + 2, rect!.y + 4 * 6 + 2);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText('版本已保存');
  await page.reload();
  await expect(page.locator('.layer-row')).toHaveCount(count + 1);
  await expect(page.getByLabel('图层名称')).toHaveValue('浏览器测试层');
  await page.getByRole('button', { name: '锁定 浏览器测试层', exact: true }).click();
  const lockedPixels = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL());
  const rect2 = await canvas.boundingBox();
  await page.mouse.click(rect2!.x + 70, rect2!.y + 70);
  expect(await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL())).toBe(lockedPixels);
  await page.getByRole('button', { name: '解锁 浏览器测试层', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText('版本已保存');
  await page.getByRole('button', { name: '质检', exact: true }).click();
  await page.getByRole('button', { name: '运行质检', exact: true }).click();
  await expect(page.locator('.rule-state')).toHaveCount(8);
  await page.getByRole('button', { name: '预览修复', exact: true }).click();
  await expect(page.getByLabel('修复结果画布')).toBeVisible();
  await page.getByRole('button', { name: '应用修复', exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText('修复已提交');
  await page.locator('.export-menu summary').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '分层 PNG + JSON 包', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('pixelart.zip');
  expect(errors).toEqual([]);
});

test('mobile layout keeps canvas and import controls available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  await expect(page.getByRole('button', { name: '上传 PNG 或 Sprite Sheet', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '上传 PNG 或 Sprite Sheet', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('continuous color selection uses the latest color without editing the document', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
    element.getContext('2d')!.getImageData(32, 32, 1, 1).data[3]
  )).toBeGreaterThan(0);
  const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const picker = page.locator('input[type="color"][aria-label="绘图颜色"]');
  await picker.evaluate((element: HTMLInputElement) => {
    for (let index = 0; index < 120; index++) {
      element.value = `#${(index * 7919).toString(16).padStart(6, '0')}`;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.value = '#a123bc';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('.color-hex')).toHaveText('#A123BC');
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(before);
  await expect(page.locator('.draft-badge')).toHaveCount(0);

  const rect = await canvas.boundingBox();
  await page.mouse.click(rect!.x + rect!.width * 4.5 / 64, rect!.y + rect!.height * 4.5 / 64);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
    Array.from(element.getContext('2d')!.getImageData(4, 4, 1, 1).data)
  )).toEqual([161, 35, 188, 255]);

  await page.getByRole('button', { name: '选择颜色 #24343E', exact: true }).click();
  await expect(picker).toHaveValue('#24343e');
  await expect(page.getByRole('button', { name: '选择颜色 #24343E', exact: true })).toHaveClass(/chosen/);
  await page.mouse.click(rect!.x + rect!.width * 5.5 / 64, rect!.y + rect!.height * 4.5 / 64);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
    Array.from(element.getContext('2d')!.getImageData(5, 4, 1, 1).data)
  )).toEqual([36, 52, 62, 255]);
});

test('color picker controls opacity, foreground/background, swapping and transparent paint', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toHaveAttribute('aria-busy', 'false');
  await page.locator('.assets-label').getByRole('button', { name: '新建素材', exact: true }).click();
  await page.getByLabel('素材名称').fill('颜色选择器测试');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  const point = (x: number, y: number) => ({ x: rect!.x + rect!.width * (x + 0.5) / 64, y: rect!.y + rect!.height * (y + 0.5) / 64 });
  const pixel = (x: number, y: number) => canvas.evaluate((element: HTMLCanvasElement, position) => Array.from(element.getContext('2d')!.getImageData(position.x, position.y, 1, 1).data), { x, y });
  await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
  const opacity = page.getByLabel('颜色不透明度');
  await opacity.press('Home');
  for (let index = 0; index < 50; index++) await opacity.press('ArrowRight');
  await expect(opacity).toHaveValue('50');
  await page.mouse.click(point(20, 20).x, point(20, 20).y);
  await expect.poll(async () => (await pixel(20, 20))[3]).toBe(128);
  const translucent = await pixel(20, 20);
  expect(Math.abs(translucent[0] - 33)).toBeLessThanOrEqual(1);
  expect(Math.abs(translucent[1] - 143)).toBeLessThanOrEqual(1);
  expect(Math.abs(translucent[2] - 131)).toBeLessThanOrEqual(1);
  await page.locator('input[type="color"][aria-label="背景色"]').fill('#ff0000');
  await page.getByRole('button', { name: '使用背景色' }).click();
  await expect(page.locator('input[type="color"][aria-label="绘图颜色"]')).toHaveValue('#ff0000');
  await page.getByRole('button', { name: '交换前景色和背景色' }).click();
  await expect(page.locator('input[type="color"][aria-label="绘图颜色"]')).toHaveValue('#218f83');
  await page.getByRole('button', { name: '调整颜色' }).click();
  await expect(page.getByRole('group', { name: '调整颜色' })).toBeVisible();
  await page.getByLabel('红色通道').fill('255');
  await page.getByLabel('绿色通道').fill('0');
  await page.getByLabel('蓝色通道').fill('0');
  await expect(page.locator('.color-hex')).toHaveText('#FF0000');
  await page.getByLabel('色相').fill('120');
  await expect(page.locator('.color-hex')).toHaveText('#00FF00');
  await page.getByRole('button', { name: '使用透明色' }).click();
  await expect(opacity).toHaveValue('0');
  await page.mouse.click(point(20, 20).x, point(20, 20).y);
  await expect.poll(() => pixel(20, 20)).toEqual([0, 0, 0, 0]);
  await opacity.fill('100');
  await expect(opacity).toHaveValue('100');
  await page.waitForTimeout(100);
  await page.evaluate(() => localStorage.removeItem('pixelart-color-opacity-v1'));
});

test('first-phase pixel tools draw shapes, fill pixels and expose selection controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toBeVisible();
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  const point = (x: number, y: number) => ({ x: rect!.x + rect!.width * x / 64, y: rect!.y + rect!.height * y / 64 });
  await page.getByRole('button', { name: '直线 (L)', exact: true }).click();
  await page.mouse.move(point(5, 5).x, point(5, 5).y);
  await page.mouse.down();
  await page.mouse.move(point(15, 15).x, point(15, 15).y);
  await page.mouse.up();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(10, 10, 1, 1).data[3])).toBeGreaterThan(0);
  await page.getByRole('button', { name: '矩形 (R)', exact: true }).click();
  await page.mouse.move(point(20, 10).x, point(20, 10).y);
  await page.mouse.down();
  await page.mouse.move(point(28, 18).x, point(28, 18).y);
  await page.mouse.up();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(20, 10, 1, 1).data[3])).toBeGreaterThan(0);
  await page.getByRole('button', { name: '椭圆 (O)', exact: true }).click();
  await page.mouse.move(point(32, 10).x, point(32, 10).y);
  await page.mouse.down();
  await page.mouse.move(point(44, 22).x, point(44, 22).y);
  await page.mouse.up();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const data = element.getContext('2d')!.getImageData(38, 10, 1, 1).data;
    return data[3];
  })).toBeGreaterThan(0);
  await page.getByRole('button', { name: '矩形选区 (M)', exact: true }).click();
  await page.mouse.move(point(2, 2).x, point(2, 2).y);
  await page.mouse.down();
  await page.mouse.move(point(8, 8).x, point(8, 8).y);
  await page.mouse.up();
  await expect(page.locator('.selection-region')).toBeVisible();
  await page.getByRole('button', { name: '填充 (G)', exact: true }).click();
  await page.mouse.click(point(4, 4).x, point(4, 4).y);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(4, 4, 1, 1).data[3])).toBeGreaterThan(0);
  await page.getByRole('button', { name: '取色器 (I)', exact: true }).click();
  await page.mouse.click(point(4, 4).x, point(4, 4).y);
  await expect(page.locator('.color-hex')).toHaveText('#218F83');
  await expect(page.getByRole('button', { name: '移动画布 (H)', exact: true })).toBeVisible();
});

test('pencil and eraser use the selected square brush size', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toBeVisible();
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  const point = (x: number, y: number) => ({ x: rect!.x + rect!.width * (x + 0.5) / 64, y: rect!.y + rect!.height * (y + 0.5) / 64 });
  const pixelAlpha = (x: number, y: number) => canvas.evaluate((element: HTMLCanvasElement, position) => element.getContext('2d')!.getImageData(position.x, position.y, 1, 1).data[3], { x, y });

  await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
  await expect(page.getByLabel('画笔工具设置')).toBeVisible();
  const size = page.getByLabel('画笔粗细');
  await size.press('Home');
  await size.press('ArrowRight');
  await size.press('ArrowRight');
  await expect(size).toHaveValue('3');
  await page.mouse.move(point(50, 50).x, point(50, 50).y);
  await expect(page.getByLabel('画笔范围预览')).toBeVisible();
  await expect(canvas).toHaveCSS('cursor', 'none');
  await page.mouse.click(point(50, 50).x, point(50, 50).y);
  for (const y of [49, 50, 51]) for (const x of [49, 50, 51]) {
    await expect.poll(() => pixelAlpha(x, y)).toBe(255);
  }

  await page.getByRole('button', { name: '橡皮 (E)', exact: true }).click();
  await page.mouse.click(point(50, 50).x, point(50, 50).y);
  for (const y of [49, 50, 51]) for (const x of [49, 50, 51]) {
    await expect.poll(() => pixelAlpha(x, y)).toBe(0);
  }
});

test('pencil opacity creates translucent pixels while eraser stays complete', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '新建素材', exact: true }).click();
  await page.getByLabel('素材名称').fill('透明画笔测试');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  const canvas = page.getByLabel('像素编辑画布');
  await expect(page.locator('.document-bar')).toContainText('透明画笔测试');
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  const point = (x: number, y: number) => ({ x: rect!.x + rect!.width * (x + 0.5) / 64, y: rect!.y + rect!.height * (y + 0.5) / 64 });
  const pixel = (x: number, y: number) => canvas.evaluate((element: HTMLCanvasElement, position) => Array.from(element.getContext('2d')!.getImageData(position.x, position.y, 1, 1).data), { x, y });
  await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
  const opacity = page.getByLabel('画笔不透明度');
  await opacity.press('Home');
  for (let index = 1; index < 50; index++) await opacity.press('ArrowRight');
  await expect(opacity).toHaveValue('50');
  await page.mouse.click(point(40, 40).x, point(40, 40).y);
  await expect.poll(() => pixel(40, 40)).toEqual([
    expect.any(Number), expect.any(Number), expect.any(Number), 128,
  ]);
  // Unpremultiplying translucent canvas pixels can round RGB by one unit.
  const rgba = await pixel(40, 40);
  for (const [index, channel] of [33, 143, 131].entries()) expect(Math.abs(rgba[index] - channel)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '橡皮 (E)', exact: true }).click();
  await page.mouse.click(point(40, 40).x, point(40, 40).y);
  await expect.poll(() => pixel(40, 40)).toEqual([0, 0, 0, 0]);
});

test('keyboard shortcuts switch tools and undo canvas edits', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toBeVisible();
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  const point = (x: number, y: number) => ({ x: rect!.x + rect!.width * (x + 0.5) / 64, y: rect!.y + rect!.height * (y + 0.5) / 64 });

  await page.keyboard.press('e');
  await expect(page.getByRole('button', { name: '橡皮 (E)', exact: true })).toHaveClass(/active/);
  await page.keyboard.press('b');
  await expect(page.getByRole('button', { name: '铅笔 (B)', exact: true })).toHaveClass(/active/);
  await expect(page.getByLabel('画笔粗细')).toHaveValue('1');
  await page.keyboard.press(']');
  await expect(page.getByLabel('画笔粗细')).toHaveValue('2');
  await page.keyboard.press('[');
  await expect(page.getByLabel('画笔粗细')).toHaveValue('1');

  const before = await canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(2, 2, 1, 1).data));
  await page.mouse.click(point(2, 2).x, point(2, 2).y);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(2, 2, 1, 1).data))).not.toEqual(before);
  await page.keyboard.press('Control+Z');
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(2, 2, 1, 1).data))).toEqual(before);
  await page.keyboard.press('Control+Shift+Z');
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(2, 2, 1, 1).data))).not.toEqual(before);
});

test('blank assets, image layers and context menus preserve editing protections', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: '新建素材', exact: true }).click();
  await page.getByLabel('素材名称').fill('自定义素材');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await expect(page.locator('.document-bar')).toContainText('自定义素材');
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
    element.getContext('2d')!.getImageData(32, 32, 1, 1).data[3]
  )).toBe(0);

  await canvas.click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: '新建图层', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  const pixels = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.locator('.layer-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制图层', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(3);
  await expect(page.getByLabel('图层名称')).toHaveValue('图层 2 副本');
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(pixels);
  await page.locator('.layer-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '锁定图层', exact: true }).click();
  await page.locator('.layer-row').first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '删除图层', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: '重命名图层', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  await page.locator('.frame-item').first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '删除帧', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: '复制帧', exact: true }).click();
  await expect(page.locator('.frame-item')).toHaveCount(2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.frame-item')).toHaveCount(1);
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.frame-item')).toHaveCount(2);

  // Import a real PNG into a new layer while another inspector tab is open.
  const projects = await (await request.get('/api/projects')).json();
  const assets = await (await request.get(`/api/projects/${projects[0].id}/assets`)).json();
  const source = assets.find((item: { name: string }) => item.name !== '自定义素材');
  const original = await (await request.get(`/api/assets/${source.id}`)).json();
  const image = await request.get(`/api/assets/${source.id}/export?versionId=${original.currentVersionId}`);
  await page.getByRole('button', { name: '质检', exact: true }).click();
  await canvas.click({ button: 'right' });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '导入 PNG 为新图层', exact: true }).click();
  await (await chooser).setFiles({ name: '自定义图层.png', mimeType: 'image/png', buffer: await image.body() });
  await expect(page.locator('.layer-row')).toHaveCount(4);
  await expect(page.getByLabel('图层名称')).toHaveValue('自定义图层');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText('版本已保存');
  await page.reload();
  await expect(page.locator('.layer-row')).toHaveCount(4);
  await expect(page.locator('.document-bar')).toContainText('自定义素材');

  await page.locator('.library').evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1438, clientY: 998 })));
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1440);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1000);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '导入 PNG / Sprite Sheet', exact: true })).toBeFocused();
  await page.locator('.brand').click();
  await expect(menu).toHaveCount(0);
});

test('all assets show actual previews and deletion requires confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  const preview = page.getByAltText('森林旅者 · 示例预览');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  const count = await page.locator('.asset-row').count();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '删除素材 自定义素材', exact: true }).click();
  await expect(page.locator('.asset-row')).toHaveCount(count);
  await expect(page.locator('.document-bar')).toContainText('自定义素材');
  const nextAssetName = await page.locator('.asset-row').filter({ hasNot: page.getByRole('button', { name: '删除素材 自定义素材', exact: true }) }).first().locator('.asset-name').innerText();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除素材 自定义素材', exact: true }).click();
  await expect(page.locator('.asset-row')).toHaveCount(count - 1);
  await expect(page.locator('.document-bar')).toContainText(nextAssetName);
  await page.reload();
  await expect(page.locator('.asset-row')).toHaveCount(count - 1);
  await expect(page.getByRole('button', { name: '删除素材 自定义素材', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称').fill('删除空项目验证');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByRole('button', { name: '新建素材', exact: true }).first().click();
  await page.getByLabel('素材名称').fill('最后一个素材');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除素材 最后一个素材', exact: true }).click();
  await expect(page.locator('.asset-row')).toHaveCount(0);
  await expect(page.getByLabel('像素编辑画布')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.locator('.empty-workbench')).toBeVisible();
});

test('asset and empty-library menus support snapshot copy, paste and rename', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();

  await page.getByRole('button', { name: '新建素材', exact: true }).first().click();
  await page.getByLabel('素材名称').fill('复制目标');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await expect(page.locator('.document-bar')).toContainText('复制目标');
  await page.locator('.asset-list').evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1440, clientY: 998 })));
  await expect(page.getByRole('menuitem', { name: '粘贴素材', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  const target = page.locator('.asset-row').filter({ has: page.locator('strong').filter({ hasText: /^复制目标$/ }) }).first();
  await target.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '复制素材', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '粘贴素材', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '复制素材', exact: true }).click();

  await page.locator('.asset-row').filter({ hasText: '森林旅者' }).first().locator('.asset-item').click();
  const canvas = page.getByLabel('像素编辑画布');
  const rect = await canvas.boundingBox();
  await page.mouse.click(rect!.x + 14, rect!.y + 14);
  await expect(page.locator('.draft-badge')).toBeVisible();

  await page.locator('.asset-list').evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1440, clientY: 998 })));
  const emptyMenu = page.getByRole('menu');
  await expect(emptyMenu).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '粘贴素材', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: '粘贴素材', exact: true }).click();
  await expect(page.locator('.asset-row').filter({ hasText: '复制目标 副本' })).toHaveCount(1);
  await expect(page.locator('.document-bar')).toContainText('森林旅者');
  await expect(page.locator('.draft-badge')).toBeVisible();

  const normalBounds = await target.boundingBox();
  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名素材', exact: true }).click();
  const renameInput = page.getByLabel('重命名素材 复制目标');
  await expect(renameInput).toBeFocused();
  const editingBounds = await renameInput.evaluate(element => {
    const row = element.closest('.asset-row')!.getBoundingClientRect();
    return { width: row.width, height: row.height };
  });
  expect(editingBounds.width).toBe(normalBounds!.width);
  expect(editingBounds.height).toBe(normalBounds!.height);
  expect(await renameInput.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 4]);
  for (const viewport of [{ width: 1000, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await renameInput.scrollIntoViewIfNeeded();
    await renameInput.fill('角色行走动画素材名称长度验证');
    const geometry = await renameInput.evaluate(element => {
      const input = element.getBoundingClientRect();
      const row = element.closest('.asset-row')!.getBoundingClientRect();
      const thumbnail = element.closest('.asset-row')!.querySelector('.asset-thumbnail')!.getBoundingClientRect();
      const remove = element.closest('.asset-row')!.querySelector(':scope > button')!.getBoundingClientRect();
      return { inside: input.left >= thumbnail.right && input.right <= remove.left && input.top >= row.top && input.bottom <= row.bottom };
    });
    expect(geometry.inside).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await renameInput.fill('不提交的名字');
  await renameInput.press('Escape');
  await expect(target.locator('strong')).toHaveText('复制目标');
  await expect(page.locator('.document-bar')).toContainText('森林旅者');
  await target.locator('.asset-name').dblclick();
  await expect(renameInput).toBeFocused();
  await renameInput.fill('复制目标改名');
  await renameInput.press('Enter');
  await expect(page.locator('.asset-row').filter({ hasText: '复制目标改名' })).toHaveCount(1);
  await expect(page.locator('.document-bar')).toContainText('森林旅者');
  await expect(page.locator('.asset-row strong').filter({ hasText: /^复制目标$/ })).toHaveCount(0);
});

test('frame guides respond immediately and layer dragging preserves other layers and frames', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: '新建素材', exact: true }).first().click();
  await page.getByLabel('素材名称').fill('图层位移验证');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await expect(page.locator('.document-bar')).toContainText('图层位移验证');
  const box = (await canvas.boundingBox())!;
  const point = (x: number, y: number) => ({ x: box.x + box.width * (x + 0.5) / 64, y: box.y + box.height * (y + 0.5) / 64 });
  const pixel = (x: number, y: number) => canvas.evaluate((element: HTMLCanvasElement, position) =>
    Array.from(element.getContext('2d')!.getImageData(position[0], position[1], 1, 1).data), [x, y]);
  const drag = async (from: [number, number], to: [number, number]) => {
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    const start = point(...from), end = point(...to);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 4 });
    await page.mouse.up();
  };
  await expect.poll(() => pixel(10, 10)).toEqual([0, 0, 0, 0]);
  await page.mouse.click(point(2, 2).x, point(2, 2).y);
  await expect.poll(() => pixel(2, 2)).toEqual([33, 143, 131, 255]);
  await page.getByRole('button', { name: '新建图层', exact: true }).click();
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  await page.mouse.click(point(10, 10).x, point(10, 10).y);
  await expect.poll(() => pixel(10, 10)).toEqual([33, 143, 131, 255]);
  await page.getByRole('button', { name: '复制当前帧', exact: true }).click();
  const baseImage = await page.locator('.layer-row').nth(1).locator('img').getAttribute('src');
  const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());

  await page.getByLabel('帧基线').fill('50');
  await page.getByLabel('原点 x').fill('24');
  await page.getByLabel('原点 y').fill('48');
  await expect(page.locator('.baseline-guide')).toHaveCSS('top', `${50 * box.height / 64}px`);
  await expect(page.locator('.origin-guide-x')).toHaveCSS('left', `${24 * box.width / 64}px`);
  await expect(page.locator('.origin-guide-y')).toHaveCSS('top', `${48 * box.height / 64}px`);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(before);
  await page.getByRole('button', { name: '帧参考线', exact: true }).click();
  await expect(page.locator('.origin-marker, .baseline-guide')).toHaveCount(0);
  await page.getByRole('button', { name: '帧参考线', exact: true }).click();
  await expect(page.locator('.origin-marker')).toBeVisible();
  await canvas.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动图层', exact: true }).click();

  await drag([10, 10], [15, 13]);
  await expect.poll(() => pixel(10, 10)).toEqual([0, 0, 0, 0]);
  await expect.poll(() => pixel(15, 13)).toEqual([33, 143, 131, 255]);
  await expect.poll(() => pixel(2, 2)).toEqual([33, 143, 131, 255]);
  expect(await page.locator('.layer-row').nth(1).locator('img').getAttribute('src')).toBe(baseImage);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => pixel(10, 10)).toEqual([33, 143, 131, 255]);
  await expect.poll(() => pixel(15, 13)).toEqual([0, 0, 0, 0]);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(() => pixel(15, 13)).toEqual([33, 143, 131, 255]);

  await page.mouse.move(point(15, 13).x, point(15, 13).y);
  await page.mouse.down();
  await page.mouse.move(point(18, 13).x, point(18, 13).y);
  await expect.poll(() => pixel(18, 13)).toEqual([33, 143, 131, 255]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => pixel(15, 13)).toEqual([33, 143, 131, 255]);
  await expect.poll(() => pixel(18, 13)).toEqual([0, 0, 0, 0]);

  await drag([15, 13], [80, 13]);
  await expect.poll(() => pixel(63, 13)).toEqual([33, 143, 131, 255]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => pixel(15, 13)).toEqual([33, 143, 131, 255]);
  await page.locator('.frame-item').first().click();
  await expect.poll(() => pixel(10, 10)).toEqual([33, 143, 131, 255]);
  await expect.poll(() => pixel(15, 13)).toEqual([0, 0, 0, 0]);
  await page.locator('.frame-item').nth(1).click();
  await expect.poll(() => pixel(15, 13)).toEqual([33, 143, 131, 255]);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText('版本已保存');
  await page.reload();
  await page.locator('.asset-row').filter({ hasText: '图层位移验证' }).locator('.asset-item').click();
  await page.locator('.frame-item').nth(1).click();
  await expect.poll(() => pixel(15, 13)).toEqual([33, 143, 131, 255]);
  await expect(page.getByLabel('帧基线')).toHaveValue('50');
  await expect(page.getByLabel('原点 x')).toHaveValue('24');
  await page.getByRole('button', { name: '锁定 图层 2', exact: true }).click();
  await page.getByRole('button', { name: '移动图层 (V)', exact: true }).click();
  const locked = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await drag([15, 13], [20, 13]);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(locked);
});

test('frame timeline switches frames and previews unassigned sequences', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: '新建素材', exact: true }).click();
  await page.getByLabel('素材名称').fill('时间轴回归素材');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await expect(page.locator('.frame-item')).toHaveCount(1);
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  const point = (x: number, y: number) => ({ x: rect!.x + rect!.width * (x + 0.5) / 64, y: rect!.y + rect!.height * (y + 0.5) / 64 });

  await page.getByRole('button', { name: '复制当前帧', exact: true }).click();
  await expect(page.locator('.frame-item')).toHaveCount(2);
  await page.mouse.click(point(6, 6).x, point(6, 6).y);
  const filled = await canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(6, 6, 1, 1).data));
  await page.locator('.frame-item').first().click();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(6, 6, 1, 1).data))).not.toEqual(filled);

  const play = page.getByRole('button', { name: '播放动画', exact: true });
  await expect(play).toBeEnabled();
  await page.getByLabel('帧时长').fill('600');
  const playbackMode = page.getByLabel('播放方式');
  await expect(playbackMode.locator('option')).toHaveCount(3);
  await playbackMode.selectOption('reverse');
  await play.click();
  await expect(page.locator('.frame-item.selected')).toHaveAttribute('aria-label', '第 2 帧');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await playbackMode.selectOption('pingpong');
  await expect(playbackMode).toHaveValue('pingpong');
  await play.click();
  await expect.poll(() => page.locator('.frame-item.selected').getAttribute('aria-label'), { timeout: 1000 }).toBe('第 2 帧');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
});

test('animation sequences keep independent order, loop settings and blank frame pixels', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  await page.getByRole('button', { name: '新建素材', exact: true }).first().click();
  await page.getByLabel('素材名称').fill('独立动作编排');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await page.getByRole('button', { name: '新建图层', exact: true }).click();
  const canvas = page.getByLabel('像素编辑画布');
  const rect = await canvas.boundingBox();
  await page.mouse.click(rect!.x + rect!.width * 8.5 / 64, rect!.y + rect!.height * 8.5 / 64);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(8, 8, 1, 1).data[3])).toBe(255);

  await page.getByRole('button', { name: '新建空白帧', exact: true }).click();
  await expect(page.locator('.frame-item')).toHaveCount(2);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(false);
  await page.getByRole('button', { name: '新建空白帧', exact: true }).click();
  await expect(page.locator('.frame-item')).toHaveCount(3);

  for (const [index, duration] of [[1, 60], [0, 80], [2, 40]]) {
    await page.locator('.frame-item').nth(index).click();
    await page.getByLabel('帧时长').fill(String(duration));
    await page.getByRole('button', { name: '加入动画', exact: true }).click();
  }
  await expect(page.locator('.animation-step')).toHaveCount(3);
  await expect(page.locator('.animation-step').first()).toHaveAttribute('aria-label', '动作第 1 帧（素材帧 2）');
  await page.getByRole('button', { name: '动作帧前移', exact: true }).click();
  await expect(page.locator('.animation-step').nth(1)).toHaveAttribute('aria-label', '动作第 2 帧（素材帧 3）');
  await expect(page.locator('.animation-step').nth(2)).toHaveAttribute('aria-label', '动作第 3 帧（素材帧 1）');

  await page.locator('.frame-item').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '帧后移', exact: true }).click();
  await expect(page.locator('.animation-step').first()).toHaveAttribute('aria-label', '动作第 1 帧（素材帧 1）');
  await expect(page.locator('.animation-step').nth(1)).toHaveAttribute('aria-label', '动作第 2 帧（素材帧 3）');
  await expect(page.locator('.animation-step').nth(2)).toHaveAttribute('aria-label', '动作第 3 帧（素材帧 2）');
  await page.getByLabel('循环播放').uncheck();
  await page.getByRole('button', { name: '播放动画', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放动画', exact: true })).toBeVisible();
  await expect(page.locator('.frame-item.selected')).toHaveAttribute('aria-label', '第 2 帧');

  await page.getByLabel('动作', { exact: true }).selectOption('walk');
  await page.getByLabel('方向', { exact: true }).selectOption('left');
  await page.getByRole('button', { name: '加入全部帧', exact: true }).click();
  await expect(page.locator('.animation-step')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '加入全部帧', exact: true })).toBeDisabled();
  await page.getByLabel('动作', { exact: true }).selectOption('idle');
  await page.getByLabel('方向', { exact: true }).selectOption('down');
  await expect(page.getByLabel('循环播放')).not.toBeChecked();

  const saved = page.waitForResponse(response => response.url().endsWith('/save') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const asset = await (await saved).json();
  const idle = asset.document.animations.find((animation: { action: string; direction: string }) => animation.action === 'idle' && animation.direction === 'down');
  const walk = asset.document.animations.find((animation: { action: string; direction: string }) => animation.action === 'walk' && animation.direction === 'left');
  expect(idle.loop).toBe(false);
  expect(idle.frames.map((ref: { frameId: string }) => ref.frameId)).toEqual([asset.document.frames[0].id, asset.document.frames[2].id, asset.document.frames[1].id]);
  expect(walk.frames.map((ref: { frameId: string }) => ref.frameId)).toEqual(asset.document.frames.map((frame: { id: string }) => frame.id));
  expect(asset.document.frames.every((frame: { pixels: Record<string, string> }) => Object.keys(frame.pixels).length === 2)).toBe(true);
  await page.reload();
  await expect(page.locator('.animation-step')).toHaveCount(3);
  await expect(page.getByLabel('循环播放')).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('removing animation references and deleting actions preserve source frames and other actions', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  await page.getByRole('button', { name: '新建素材', exact: true }).first().click();
  await page.getByLabel('素材名称').fill('动作引用管理');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  const projects = await (await request.get('/api/projects')).json();
  const assets = await (await request.get(`/api/projects/${projects[0].id}/assets`)).json();
  const item = assets.find((candidate: { name: string }) => candidate.name === '动作引用管理');
  const source = await (await request.get(`/api/assets/${item.id}`)).json();
  source.document.type = 'character';
  source.document.animations = [
    { action: 'idle', direction: 'down', loop: true, frames: [{ frameId: 'frame_0', durationMs: 150 }, { frameId: 'frame_0', durationMs: 400 }] },
    { action: 'walk', direction: 'down', loop: true, frames: [{ frameId: 'frame_0', durationMs: 200 }] },
  ];
  expect((await request.post(`/api/assets/${item.id}/save`, { data: { expectedCurrentVersionId: source.currentVersionId, document: source.document } })).ok()).toBe(true);
  await page.reload();
  await expect(page.locator('.animation-step')).toHaveCount(2);
  await page.locator('.animation-step').nth(1).click();
  await expect(page.getByLabel('帧时长')).toHaveValue('400');
  await page.getByLabel('帧时长').fill('50');
  await page.getByRole('button', { name: '更新时长', exact: true }).click();
  await expect(page.locator('.animation-step').first()).toContainText('150 ms');
  await expect(page.locator('.animation-step').nth(1)).toContainText('50 ms');
  await page.getByRole('button', { name: '移除当前帧', exact: true }).click();
  await expect(page.locator('.animation-step')).toHaveCount(1);
  await expect(page.locator('.animation-step').first()).toContainText('150 ms');
  await expect(page.locator('.frame-item')).toHaveCount(1);
  await page.getByRole('button', { name: '删除当前动画', exact: true }).click();
  await expect(page.locator('.animation-step')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除当前动画', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.animation-step')).toHaveCount(1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.animation-step')).toHaveCount(0);
  await page.getByLabel('动作', { exact: true }).selectOption('walk');
  await expect(page.locator('.animation-step')).toHaveCount(1);
  await expect(page.locator('.animation-step').first()).toContainText('200 ms');
  const saved = page.waitForResponse(response => response.url().endsWith('/save') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const result = await (await saved).json();
  expect(result.document.frames).toEqual(source.document.frames);
  expect(result.document.animations).toEqual([source.document.animations[1]]);
});
