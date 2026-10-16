import { expect, test } from '@playwright/test';

test('tools and options share one row and float, close and restore together', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const panel = page.locator('[data-panel=tools]');
  await expect(panel.getByRole('toolbar', { name: '绘图工具' })).toBeVisible();
  await expect(panel.getByLabel('画笔工具设置')).toBeHidden();
  await panel.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
  await expect(panel.getByLabel('画笔工具设置')).toBeVisible();
  await expect(panel.getByLabel('画笔粗细')).toBeVisible();
  await expect(panel.locator('.panel-title svg')).toBeVisible();
  await expect(page.locator('.panel-docked:not([data-panel=tools]) > .workspace-panel-heading .panel-title svg')).toHaveCount(0);
  const handleIcon = await panel.locator('.panel-title svg').innerHTML();
  await expect(page.getByRole('button', { name: '浮动工具栏', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '关闭工具栏', exact: true })).toHaveCount(0);

  for (const width of [1440, 1280, 1000, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await panel.evaluate(element => {
      const buttons = Array.from(element.querySelectorAll('.drawing-tools button'));
      const first = buttons[0].getBoundingClientRect();
      const last = buttons.at(-1)!.getBoundingClientRect();
      const options = element.querySelector('.tool-settings-panel')!.getBoundingClientRect();
      return first.top === last.top && options.top <= first.top && options.bottom >= first.bottom;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '工具栏菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '浮动工具栏', exact: true }).click();
  await expect(panel).toHaveAttribute('data-mode', 'floating');
  await expect(panel.locator('.panel-title svg')).toBeVisible();
  expect(await panel.locator('.panel-title svg').innerHTML()).toBe(handleIcon);
  for (const width of [1440, 650, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await panel.evaluate(element => {
      const handle = element.querySelector('.panel-title')!.getBoundingClientRect();
      const tool = element.querySelector('.drawing-tools button')!.getBoundingClientRect();
      const options = element.querySelector('.tool-settings-panel')!.getBoundingClientRect();
      const close = element.querySelector('[aria-label="关闭工具栏"]')!.getBoundingClientRect();
      return handle.top === tool.top && close.top === tool.top && options.top <= tool.top && options.bottom >= tool.bottom && element.getBoundingClientRect().height < 50;
    })).toBe(true);
    await expect(panel.getByRole('button', { name: '工具栏菜单', exact: true })).toBeInViewport();
    await expect(panel.getByRole('button', { name: '关闭工具栏', exact: true })).toBeInViewport();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(panel.getByRole('button', { name: '停靠工具栏', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '填充 (G)', exact: true }).click();
  await expect(panel.getByLabel('填充容差')).toBeVisible();
  await panel.getByLabel('填充范围').selectOption('all');
  await panel.getByRole('button', { name: '橡皮 (E)', exact: true }).click();
  await expect(panel.getByLabel('橡皮工具设置')).toBeVisible();
  await expect(panel.getByLabel('橡皮粗细')).toBeVisible();
  await expect(panel.getByLabel('橡皮形状')).toBeVisible();
  await expect(panel.getByLabel('画笔不透明度')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭工具栏', exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByText('PixelArting', { exact: true }).click();
  await page.keyboard.press('b');
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: '窗口', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: /工具栏/ }).click();
  await expect(panel.getByRole('button', { name: '铅笔 (B)', exact: true })).toBeVisible();
  await expect(panel.getByLabel('画笔不透明度')).toBeVisible();
  await page.getByRole('button', { name: '停靠工具栏', exact: true }).click();
  await expect(panel).toHaveAttribute('data-mode', 'docked');
  await expect(panel.locator('.panel-title svg')).toBeVisible();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
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
