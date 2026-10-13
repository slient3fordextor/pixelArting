import { expect, test, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type ElectronPage = Awaited<ReturnType<ElectronApp['firstWindow']>>;
type CanvasLocator = ReturnType<ElectronPage['getByLabel']>;
type DesktopSession = {
  desktop: ElectronApp;
  temporary: string;
};

async function launchDesktop(): Promise<DesktopSession> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pixelart-desktop-shortcuts-'));
  const profile = path.join(temporary, 'profile');
  await mkdir(profile);
  const desktop = await electron.launch({
    executablePath: path.resolve('../desktop/node_modules/electron/dist/electron'),
    args: [path.resolve('../desktop')],
    env: {
      ...process.env,
      PIXELART_DATA_DIR: path.join(temporary, 'data'),
      PIXELART_DESKTOP_USER_DATA: profile,
    },
  });
  return { desktop, temporary };
}

async function closeDesktop(session: DesktopSession) {
  await session.desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => window.destroy());
  }).catch(() => {});
  await session.desktop.close().catch(() => {});
  await rm(session.temporary, { recursive: true, force: true });
}

async function createBlankAsset(page: ElectronPage, name: string) {
  // Route the accelerator through the document instead of whichever inspector
  // field happened to retain focus after the previous async load.
  await page.getByText('PixelArting', { exact: true }).click();
  await page.keyboard.press('Control+N');
  await expect(page.getByRole('dialog')).toContainText('新建素材');
  const nameInput = page.getByLabel('素材名称');
  await nameInput.fill(name);
  await expect(nameInput).toHaveValue(name);
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await expect(page.locator('.document-bar')).toContainText(name);
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  return canvas;
}

async function pixel(canvas: CanvasLocator, x: number, y: number) {
  return canvas.evaluate((element: HTMLCanvasElement, position) =>
    Array.from(element.getContext('2d')!.getImageData(position.x, position.y, 1, 1).data), { x, y });
}

async function clickPixel(page: ElectronPage, canvas: CanvasLocator, x: number, y: number) {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Pixel canvas has no layout bounds');
  await page.mouse.click(bounds.x + (x + 0.5) * bounds.width / 64, bounds.y + (y + 0.5) * bounds.height / 64);
}

async function clickMenuItem(desktop: DesktopSession['desktop'], menuLabel: string, itemLabel: string) {
  await desktop.evaluate(({ Menu }, labels) => {
    const menu = Menu.getApplicationMenu()?.items.find(item => item.label === labels.menuLabel);
    const item = menu?.submenu?.items.find(entry => entry.label === labels.itemLabel);
    if (!item) throw new Error(`Missing native menu item ${labels.menuLabel}/${labels.itemLabel}`);
    item.click();
  }, { menuLabel, itemLabel });
}

test('desktop shortcuts switch tools, open commands, and respect text focus', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    page.on('dialog', () => {});
    await expect(page.getByLabel('像素编辑画布')).toBeVisible();

    const canvas = await createBlankAsset(page, 'InputShortcutAsset');
    const toolShortcuts: Array<[string, string]> = [
      ['b', '铅笔 (B)'], ['e', '橡皮 (E)'], ['i', '取色器 (I)'], ['g', '填充 (G)'],
      ['l', '直线 (L)'], ['r', '矩形 (R)'], ['o', '椭圆 (O)'], ['m', '矩形选区 (M)'],
      ['h', '移动画布 (H)'], ['v', '移动图层 (V)'],
    ];
    for (const [key, label] of toolShortcuts) {
      await page.keyboard.press(key);
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveClass(/active/);
    }

    await clickMenuItem(session.desktop, '工具', '铅笔');
    await expect(page.getByRole('button', { name: '铅笔 (B)', exact: true })).toHaveClass(/active/);
    const acceleratorRegistration = await session.desktop.evaluate(({ Menu }) => {
      const item = (menuLabel: string, itemLabel: string) => Menu.getApplicationMenu()?.items
        .find(entry => entry.label === menuLabel)?.submenu?.items.find(entry => entry.label === itemLabel);
      return {
        tool: item('工具', '铅笔')?.registerAccelerator,
        copy: item('编辑', '复制')?.registerAccelerator,
      };
    });
    expect(acceleratorRegistration).toEqual({ tool: false, copy: false });

    await page.keyboard.press('Control+O');
    await expect(page.getByRole('dialog')).toContainText('导入素材');
    await page.getByLabel('关闭对话框').click();
    await page.keyboard.press('Control+S');
    await expect(page.locator('.toast')).toContainText('版本已保存');

    await clickPixel(page, canvas, 2, 2);
    await expect.poll(() => pixel(canvas, 2, 2)).toEqual([33, 143, 131, 255]);
    const layerName = page.getByLabel('图层名称');
    const originalLayerName = await layerName.inputValue();
    await layerName.click();
    await layerName.press('End');
    await layerName.pressSequentially('E');
    await expect(layerName).toHaveValue(`${originalLayerName}E`);
    await page.keyboard.press('Control+Z');
    await expect(layerName).toHaveValue(originalLayerName);
    await expect.poll(() => pixel(canvas, 2, 2)).toEqual([33, 143, 131, 255]);

    await layerName.press('Control+A');
    await clickMenuItem(session.desktop, '编辑', '复制');
    await clickMenuItem(session.desktop, '编辑', '剪切');
    await expect(layerName).toHaveValue('');
    await clickMenuItem(session.desktop, '编辑', '粘贴');
    await expect(layerName).toHaveValue(originalLayerName);

    await page.getByText('PixelArting', { exact: true }).click();
    await page.keyboard.press('Control+N');
    await expect(page.getByRole('dialog')).toContainText('新建素材');
    await page.getByLabel('关闭对话框').click();
  } finally {
    await closeDesktop(session);
  }
});

test('desktop canvas history and selection shortcuts preserve one-step edits', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    page.on('dialog', () => {});
    await expect(page.getByLabel('像素编辑画布')).toBeVisible();
    const canvas = await createBlankAsset(page, 'CanvasShortcutAsset');

    await page.keyboard.press('b');
    await clickPixel(page, canvas, 5, 5);
    await expect.poll(() => pixel(canvas, 5, 5)).toEqual([33, 143, 131, 255]);
    await clickPixel(page, canvas, 8, 5);
    await expect.poll(() => pixel(canvas, 8, 5)).toEqual([33, 143, 131, 255]);

    await page.keyboard.press('Control+Z');
    await expect.poll(() => pixel(canvas, 5, 5)).toEqual([33, 143, 131, 255]);
    await expect.poll(() => pixel(canvas, 8, 5)).toEqual([0, 0, 0, 0]);
    await page.keyboard.press('Control+Y');
    await expect.poll(() => pixel(canvas, 8, 5)).toEqual([33, 143, 131, 255]);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => pixel(canvas, 8, 5)).toEqual([0, 0, 0, 0]);
    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => pixel(canvas, 8, 5)).toEqual([33, 143, 131, 255]);

    await page.keyboard.press('Control+Z');
    await clickMenuItem(session.desktop, '编辑', '撤销');
    await expect.poll(() => pixel(canvas, 5, 5)).toEqual([0, 0, 0, 0]);
    await expect.poll(() => pixel(canvas, 8, 5)).toEqual([0, 0, 0, 0]);
    await clickMenuItem(session.desktop, '编辑', '重做');
    await expect.poll(() => pixel(canvas, 5, 5)).toEqual([33, 143, 131, 255]);
    await expect.poll(() => pixel(canvas, 8, 5)).toEqual([0, 0, 0, 0]);
    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => pixel(canvas, 8, 5)).toEqual([33, 143, 131, 255]);

    await page.keyboard.press('b');
    await clickPixel(page, canvas, 12, 12);
    await expect.poll(() => pixel(canvas, 12, 12)).toEqual([33, 143, 131, 255]);
    await page.keyboard.press('m');
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error('Pixel canvas has no layout bounds');
    const selectionPoint = (x: number, y: number) => ({
      x: bounds.x + (x + 0.5) * bounds.width / 64,
      y: bounds.y + (y + 0.5) * bounds.height / 64,
    });
    const start = selectionPoint(12, 12);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('.selection-region')).toBeVisible();
    await page.keyboard.press('Control+C');
    await page.keyboard.press('Control+X');
    await expect.poll(() => pixel(canvas, 12, 12)).toEqual([0, 0, 0, 0]);
    await page.keyboard.press('Control+V');
    await expect.poll(() => pixel(canvas, 12, 12)).toEqual([33, 143, 131, 255]);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => pixel(canvas, 12, 12)).toEqual([0, 0, 0, 0]);
    await expect.poll(() => pixel(canvas, 13, 12)).toEqual([33, 143, 131, 255]);
    await page.keyboard.press('Delete');
    await expect.poll(() => pixel(canvas, 13, 12)).toEqual([0, 0, 0, 0]);
    await page.keyboard.press('Control+V');
    await expect.poll(() => pixel(canvas, 13, 12)).toEqual([33, 143, 131, 255]);
    await clickMenuItem(session.desktop, '编辑', '复制');
    await clickMenuItem(session.desktop, '编辑', '剪切');
    await expect.poll(() => pixel(canvas, 13, 12)).toEqual([0, 0, 0, 0]);
    await clickMenuItem(session.desktop, '编辑', '粘贴');
    await expect.poll(() => pixel(canvas, 13, 12)).toEqual([33, 143, 131, 255]);
    await page.keyboard.press('Escape');
    await expect(page.locator('.selection-region')).toHaveCount(0);
  } finally {
    await closeDesktop(session);
  }
});
