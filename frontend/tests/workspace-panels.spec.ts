import { expect, test } from '@playwright/test';

test('tool settings open independently, dismiss and preserve values without editing the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const panel = page.locator('[data-panel=tools]');
  const pencil = panel.getByRole('button', { name: '铅笔 (B)', exact: true });
  const popup = page.locator('.tool-settings-popover');
  await expect(popup).toHaveCount(0);
  await pencil.click();
  await expect(popup).toHaveAccessibleName('铅笔设置');
  await expect(pencil).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByLabel('画笔粗细')).toHaveCount(0);
  await popup.getByLabel('画笔粗细').fill('7');
  await popup.getByLabel('画笔不透明度').fill('50');
  const preview = popup.locator('.brush-preview canvas');
  await expect.poll(() => preview.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, 32, 36).data;
    const occupied: { x: number; y: number; alpha: number }[] = [];
    for (let y = 0; y < 36; y++) for (let x = 0; x < 32; x++) {
      const alpha = pixels[(y * 32 + x) * 4 + 3];
      if (alpha) occupied.push({ x, y, alpha });
    }
    return {
      width: Math.max(...occupied.map(pixel => pixel.x)) - Math.min(...occupied.map(pixel => pixel.x)) + 1,
      height: Math.max(...occupied.map(pixel => pixel.y)) - Math.min(...occupied.map(pixel => pixel.y)) + 1,
      alphas: [...new Set(occupied.map(pixel => pixel.alpha))],
    };
  })).toEqual({ width: 7, height: 7, alphas: [128] });
  await popup.getByLabel('画笔形状').selectOption('circle');
  await expect.poll(() => preview.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d')!;
    return [context.getImageData(13, 15, 1, 1).data[3], context.getImageData(16, 18, 1, 1).data[3]];
  })).toEqual([0, 128]);
  await popup.getByLabel('启用笔压').check();
  await popup.getByLabel('笔刷间距').fill('150');
  expect(await popup.locator('.brush-preview').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.children).every(child => child.getBoundingClientRect().bottom <= bounds.bottom);
  })).toBe(true);
  await page.screenshot({ path: test.info().outputPath('tool-settings.png') });
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(pencil).toBeFocused();
  await pencil.click();
  await expect(popup.getByLabel('画笔粗细')).toHaveValue('7');
  await expect(popup.getByLabel('画笔不透明度')).toHaveValue('50');
  await expect(popup.getByLabel('画笔形状')).toHaveValue('circle');
  await expect(popup.getByLabel('启用笔压')).toBeChecked();
  await expect(popup.getByLabel('笔刷间距')).toHaveValue('150');
  await pencil.click();
  await expect(popup).toHaveCount(0);

  for (const [button, title] of [
    ['橡皮 (E)', '橡皮设置'], ['取色器 (I)', '取色器设置'], ['填充 (G)', '填充设置'],
    ['直线 (L)', '直线设置'], ['矩形 (R)', '矩形设置'], ['椭圆 (O)', '椭圆设置'],
    ['矩形选区 (M)', '矩形选区设置'], ['套索选区 (Q)', '套索选区设置'],
    ['按颜色选择', '按颜色选择设置'], ['魔棒选择', '魔棒选择设置'],
    ['移动画布 (H)', '移动画布设置'], ['移动图层 (V)', '移动图层设置'],
  ]) {
    await panel.getByRole('button', { name: button, exact: true }).click();
    await expect(popup).toHaveCount(1);
    await expect(popup).toHaveAccessibleName(title);
  }
  await page.getByText('PixelArting', { exact: true }).click();
  await expect(popup).toHaveCount(0);
  await panel.getByRole('button', { name: '填充 (G)', exact: true }).click();
  await popup.getByLabel('填充范围').selectOption('all');
  await popup.getByLabel('填充容差').fill('30');
  await popup.getByRole('button', { name: '关闭填充设置', exact: true }).click();
  await panel.getByRole('button', { name: '填充 (G)', exact: true }).click();
  await expect(popup.getByLabel('填充范围')).toHaveValue('all');
  await expect(popup.getByLabel('填充容差')).toHaveValue('30');
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
});

test('tool popovers fit narrow screens and follow the floating toolbar', async ({ page }) => {
  await page.goto('/');
  const panel = page.locator('[data-panel=tools]');
  const popup = page.locator('.tool-settings-popover');
  for (const floating of [false, true]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (floating) {
      await page.getByRole('button', { name: '工具栏菜单', exact: true }).click();
      await page.getByRole('menuitem', { name: '浮动工具栏', exact: true }).click();
    }
    for (const width of [1440, 650, 390]) {
      await page.setViewportSize({ width, height: 700 });
      const height = (await panel.boundingBox())!.height;
      await panel.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
      await expect(popup).toBeVisible();
      const bounds = (await popup.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(8);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
      expect(bounds.y).toBeGreaterThanOrEqual(8);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(692);
      expect((await panel.boundingBox())!.height).toBe(height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.keyboard.press('Escape');
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
  await page.getByRole('button', { name: '关闭工具栏', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(popup).toHaveCount(0);
});

test('panel headers detach by dragging and dock by double click, preserving position across reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const panel = page.locator('[data-panel=tools]');
  const title = panel.locator('.panel-title');
  await expect(panel).toBeVisible();
  const handle = (await title.boundingBox())!;
  await page.mouse.move(handle.x + 15, handle.y + 12);
  await page.mouse.down();
  await page.mouse.move(handle.x + 115, handle.y + 150, { steps: 8 });
  await page.mouse.up();
  await expect(panel).toHaveAttribute('data-mode', 'floating');
  const position = (await panel.boundingBox())!;
  expect(position.y).toBeGreaterThan(handle.y + 100);
  await page.reload();
  await expect(panel).toHaveAttribute('data-mode', 'floating');
  expect((await panel.boundingBox())!.x).toBe(position.x);
  expect((await panel.boundingBox())!.y).toBe(position.y);
  await page.setViewportSize({ width: 650, height: 740 });
  await expect.poll(() => panel.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.x >= 8 && bounds.y >= 64 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  })).toBe(true);
  await title.dblclick();
  await expect(panel).toHaveAttribute('data-mode', 'docked');
});

test('docked panel menu supports keyboard navigation and dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '调色板菜单', exact: true });
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: '浮动调色板', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '隐藏调色板', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('menu', { name: '调色板菜单', exact: true })).toHaveCount(0);
  await trigger.click();
  await page.getByRole('menuitem', { name: '隐藏调色板', exact: true }).click();
  await expect(page.locator('[data-panel=palette]')).toBeHidden();
  await page.getByRole('button', { name: '窗口', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: /调色板/ }).click();
  await expect(page.getByLabel('绘图调色板', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '最小化检查器', exact: true }).click();
  await page.getByRole('button', { name: '检查器菜单', exact: true }).click();
  const menu = page.getByRole('menu', { name: '检查器菜单', exact: true });
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440);
  await page.getByRole('menuitem', { name: '浮动检查器', exact: true }).click();
  await expect(page.locator('[data-panel=inspector]')).toHaveAttribute('data-mode', 'floating');
  await page.getByRole('button', { name: '检查器菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '隐藏检查器', exact: true }).click();
  await expect(page.locator('[data-panel=inspector]')).toBeHidden();
});
