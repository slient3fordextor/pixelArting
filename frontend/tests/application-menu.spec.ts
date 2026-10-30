import { expect, test } from '@playwright/test';

async function openFile(page: import('@playwright/test').Page) {
  await page.locator('.app-menu > summary').filter({ hasText: /^文件$/ }).click();
}

test('projects belong to the file menu and settings work when menus close', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  await expect(page.locator('.library .project-picker')).toHaveCount(0);
  await expect(page.locator('.library')).not.toContainText('新建项目');
  await openFile(page);
  await page.getByRole('menuitem', { name: '新建项目', exact: true }).click();
  await expect(page.locator('.app-menu[open]')).toHaveCount(0);
  await page.getByLabel('项目名称', { exact: true }).fill('菜单新建项目');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.locator('.header-project')).toContainText('菜单新建项目');
  await openFile(page);
  await page.getByRole('menuitem', { name: '项目设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '项目设置', exact: true })).toBeVisible();
  await page.getByLabel('修改项目名称').fill('菜单改名项目');
  await page.getByRole('button', { name: '保存项目名称', exact: true }).click();
  await expect(page.locator('.header-project')).toContainText('菜单改名项目');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pixelart-command', { detail: 'project-settings' })));
  await expect(page.getByRole('dialog', { name: '项目设置', exact: true })).toBeVisible();
});

test('project switching protects dirty work and file menu exposes backups', async ({ page, request }) => {
  const target = await (await request.post('/api/projects', { data: { name: '菜单切换目标' } })).json();
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  const previous = await page.locator('.header-project').innerText();
  await page.getByRole('button', { name: '质检', exact: true }).click();
  await page.getByLabel('目标宽度').fill('33');
  await openFile(page);
  await expect(page.getByRole('menuitem', { name: '备份项目', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '恢复项目备份', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '打开 / 切换项目…', exact: true }).click();
  await page.getByRole('option', { name: target.name, exact: true }).click();
  await expect(page.getByRole('dialog', { name: '尚有未保存的修改' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.locator('.header-project')).toHaveText(previous);
  await page.getByRole('button', { name: '切换项目', exact: true }).click();
  await page.getByRole('option', { name: target.name, exact: true }).click();
  await page.getByRole('button', { name: '放弃并继续', exact: true }).click();
  await expect(page.locator('.header-project')).toHaveText(target.name);
});

test('menus support keyboard navigation and outside dismissal', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  const file = page.locator('.app-menu > summary').filter({ hasText: /^文件$/ });
  await file.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '新建项目', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.app-menu[open] > summary')).toHaveText('编辑');
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-menu[open]')).toHaveCount(0);
  await openFile(page);
  await page.locator('.document-bar').click();
  await expect(page.locator('.app-menu[open]')).toHaveCount(0);
});

test('menus and docked panels fit desktop and narrow workspaces', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  for (const width of [1440, 1000, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await openFile(page);
    const bounds = (await page.locator('.file-menu-dropdown').boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/pixelarting-menu-${width}.png` });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
});
