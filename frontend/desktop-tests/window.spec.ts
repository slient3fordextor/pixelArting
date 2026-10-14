import { expect, test, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('native window starts its service, supports editing and protects unsaved work on close', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pixelart-desktop-window-'));
  const profile = path.join(temporary, 'profile');
  await mkdir(profile);
  const desktop = await electron.launch({
    executablePath: path.resolve('../desktop/node_modules/electron/dist/electron'),
    args: [path.resolve('../desktop')],
    env: { ...process.env, PIXELART_DATA_DIR: path.join(temporary, 'data'), PIXELART_DESKTOP_USER_DATA: profile },
  });
  try {
    const page = await desktop.firstWindow();
    // Electron resolves beforeunload through its native will-prevent-unload handler.
    page.on('dialog', () => {});
    const canvas = page.getByLabel('像素编辑画布');
    await expect(canvas).toBeVisible();
    await page.keyboard.press('e');
    await expect(page.getByRole('button', { name: '橡皮 (E)', exact: true })).toHaveClass(/active/);
    await page.keyboard.press('b');
    await expect(page.getByRole('button', { name: '铅笔 (B)', exact: true })).toHaveClass(/active/);
    await desktop.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items[2].submenu!.items[1].click(); });
    await expect(page.getByRole('button', { name: '橡皮 (E)', exact: true })).toHaveClass(/active/);
    const url = page.url();
    expect(url).toBe('pixelart://workbench/');
    expect(await page.evaluate(() => location.origin)).toBe('pixelart://workbench');
    const port = Number(await readFile(path.join(profile, 'backend-port'), 'utf8'));
    const backendUrl = `http://127.0.0.1:${port}`;
    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { title: window.getTitle(), ...window.webContents.getLastWebPreferences() };
    });
    expect(preferences.title).toContain('PixelArting');
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.sandbox).toBe(true);
    expect(await page.evaluate(() => typeof (window as unknown as { require: unknown }).require)).toBe('undefined');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
      element.getContext('2d')!.getImageData(32, 32, 1, 1).data[3]
    )).toBeGreaterThan(0);
    await canvas.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '新建图层', exact: true })).toBeVisible();
    await page.screenshot({ path: '/tmp/pixelarting-desktop-window.png' });
    await page.keyboard.press('Escape');

    await desktop.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items[0].submenu!.items[0].click(); });
    await expect(page.getByRole('dialog')).toContainText('新建素材');
    await page.getByLabel('素材名称').fill('桌面手绘');
    await page.getByRole('button', { name: '创建素材', exact: true }).click();
    await expect(page.locator('.document-bar')).toContainText('桌面手绘');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    const desktopAsset = page.locator('.asset-row').filter({ hasText: '桌面手绘' }).first();
    await expect(desktopAsset.locator('.asset-name')).toBeVisible();
    await desktopAsset.locator('.asset-name').dblclick();
    await expect(page.getByLabel('重命名素材 桌面手绘')).toBeFocused();
    await page.screenshot({ path: '/tmp/pixelarting-native-rename.png' });
    await page.getByLabel('重命名素材 桌面手绘').fill('桌面双击改名');
    await page.getByLabel('重命名素材 桌面手绘').press('Enter');
    await expect(page.locator('.asset-row').filter({ hasText: '桌面双击改名' })).toHaveCount(1);
    const renamedDesktopAsset = page.locator('.asset-row').filter({ hasText: '桌面双击改名' }).first();
    await renamedDesktopAsset.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名素材', exact: true }).click();
    await page.getByLabel('重命名素材 桌面双击改名').fill('桌面右键改名');
    await page.getByLabel('重命名素材 桌面双击改名').press('Enter');
    await expect(page.locator('.asset-row').filter({ hasText: '桌面右键改名' })).toHaveCount(1);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
      element.getContext('2d')!.getImageData(0, 0, 1, 1).data[3]
    )).toBe(0);
    await page.keyboard.press('b');
    const bounds = (await canvas.boundingBox())!;
    const start = { x: bounds.x + bounds.width * 5.5 / 64, y: bounds.y + bounds.height * 5.5 / 64 };
    await page.mouse.click(start.x, start.y);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
      element.getContext('2d')!.getImageData(5, 5, 1, 1).data[3]
    )).toBe(0);
    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
      element.getContext('2d')!.getImageData(5, 5, 1, 1).data[3]
    )).toBe(255);
    await page.getByRole('button', { name: '移动图层 (V)', exact: true }).click();
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + bounds.width * 3 / 64, start.y + bounds.height * 2 / 64);
    await page.mouse.up();
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
      Array.from(element.getContext('2d')!.getImageData(8, 7, 1, 1).data)
    )).toEqual([33, 143, 131, 255]);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
      element.getContext('2d')!.getImageData(5, 5, 1, 1).data[3]
    )).toBe(0);
    await page.getByLabel('帧基线').fill('48');
    await page.getByLabel('原点 x').fill('32');
    await page.getByLabel('原点 y').fill('48');
    await expect(page.locator('.origin-marker')).toBeVisible();
    await expect(page.locator('.baseline-guide')).toBeVisible();
    await page.screenshot({ path: '/tmp/pixelarting-native-layer-drag.png' });
    await expect(page.locator('.draft-badge')).toBeVisible();
    await desktop.evaluate(({ dialog, BrowserWindow }) => {
      (globalThis as unknown as { closeConfirmCount: number }).closeConfirmCount = 0;
      dialog.showMessageBoxSync = () => {
        (globalThis as unknown as { closeConfirmCount: number }).closeConfirmCount++;
        return 0;
      };
      BrowserWindow.getAllWindows()[0].close();
    });
    await expect.poll(() => desktop.evaluate(() => (globalThis as unknown as { closeConfirmCount: number }).closeConfirmCount)).toBe(1);
    await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(page.locator('.draft-badge')).toBeVisible();
    await desktop.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items[0].submenu!.items[2].click(); });
    await expect(page.locator('.toast')).toContainText('版本已保存');
    await desktop.close();
    await expect.poll(async () => {
      try { await fetch(`${backendUrl}/api/health`); return true; } catch { return false; }
    }).toBe(false);
  } finally {
    await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach(window => window.destroy()); }).catch(() => {});
    await desktop.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});
