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

async function createBlankAsset(page: ElectronPage, name: string, size: number | { width: number; height: number } = 64) {
  await expect(page.getByLabel('像素编辑画布')).toHaveAttribute('aria-busy', 'false');
  // Route the accelerator through the document instead of whichever inspector
  // field happened to retain focus after the previous async load.
  await page.getByText('PixelArting', { exact: true }).click();
  await page.keyboard.press('Control+N');
  await expect(page.getByRole('dialog')).toContainText('新建素材');
  const nameInput = page.getByLabel('素材名称');
  await nameInput.fill(name);
  await expect(nameInput).toHaveValue(name);
  if (size !== 64) {
    await page.getByLabel('新素材宽度').fill(String(typeof size === 'number' ? size : size.width));
    await page.getByLabel('新素材高度').fill(String(typeof size === 'number' ? size : size.height));
  }
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

test('desktop wheel pans in both axes and anchors Ctrl zoom', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'WheelNavigationAsset');
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const bounds = (await canvas.boundingBox())!;
    const zoom = bounds.width / 64;
    const pointer = { x: bounds.x + 20.5 * zoom, y: bounds.y + 24.5 * zoom };
    const scroll = await page.locator('.stage').evaluate(element => [element.scrollLeft, element.scrollTop]);
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.wheel(0, -120);
    await expect(page.locator('.zoom-label')).toHaveText(`${zoom * 100}%`);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.y - bounds.y)).toBe(120);
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.y - bounds.y)).toBe(0);
    await page.keyboard.down('Alt');
    await page.mouse.wheel(0, -120);
    await expect(page.locator('.zoom-label')).toHaveText(`${zoom * 100}%`);
    await page.keyboard.up('Alt');
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await expect(page.locator('.zoom-label')).toHaveText(`${(zoom + 1) * 100}%`);
    await expect.poll(async () => Math.abs((await canvas.boundingBox())!.x + 20.5 * (zoom + 1) - pointer.x)).toBeLessThan(1);
    await expect.poll(async () => Math.abs((await canvas.boundingBox())!.y + 24.5 * (zoom + 1) - pointer.y)).toBeLessThan(1);
    expect(await page.locator('.stage').evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual(scroll);

    // Ctrl wins over Shift so the same gesture cannot also pan horizontally.
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 120);
    await expect(page.locator('.zoom-label')).toHaveText(`${zoom * 100}%`);
    await expect.poll(async () => Math.abs((await canvas.boundingBox())!.x - bounds.x)).toBeLessThan(1);
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    const beforePan = (await canvas.boundingBox())!;
    await page.mouse.move(beforePan.x + beforePan.width / 2, beforePan.y + beforePan.height / 2);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - beforePan.x)).toBe(-120);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.y - beforePan.y)).toBe(0);
    const afterPan = (await canvas.boundingBox())!;
    await page.mouse.move(afterPan.x + afterPan.width / 2, afterPan.y + afterPan.height / 2);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - beforePan.x)).toBe(0);
    await page.keyboard.up('Shift');
    await expect(page.locator('.zoom-label')).toHaveText(`${zoom * 100}%`);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    // Wheel events are synchronous here so rapid input also exercises stale state.
    await canvas.evaluate(element => {
      const rect = element.getBoundingClientRect();
      for (let index = 0; index < 24; index++) element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, cancelable: true }));
    });
    await expect(page.locator('.zoom-label')).toHaveText('1200%');
    await expect(page.getByRole('button', { name: '放大', exact: true })).toBeDisabled();
    for (let index = 0; index < 32; index++) {
      await canvas.dispatchEvent('wheel', { ctrlKey: true, deltaY: 120, clientX: pointer.x, clientY: pointer.y });
    }
    await expect(page.locator('.zoom-label')).toHaveText('5%');
    await expect(page.getByRole('button', { name: '缩小', exact: true })).toBeDisabled();
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    expect(errors).toEqual([]);
  } finally {
    await closeDesktop(session);
  }
});

test('desktop custom zoom accepts precise values, cancels and keeps navigation shortcuts isolated', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'CustomZoomAsset');
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const input = page.getByRole('textbox', { name: '画布缩放百分比', exact: true });
    const open = () => page.getByRole('button', { name: '自定义画布缩放', exact: true }).click();
    const label = page.locator('.zoom-label');
    await open();
    await input.fill('137.5');
    await input.press('Enter');
    await expect(label).toHaveText('137.5%');
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(88);
    await open();
    await input.fill('800');
    await input.press('Escape');
    await expect(label).toHaveText('137.5%');
    for (const value of ['', 'oops', 'Infinity']) {
      await open();
      await input.fill(value);
      await input.press('Enter');
      await expect(label).toHaveText('137.5%');
    }
    await open();
    await input.fill('125');
    await page.getByText('PixelArting', { exact: true }).click();
    await expect(label).toHaveText('125%');
    await open();
    await input.fill('f');
    await input.press('Shift+f');
    await expect(input).toBeVisible();
    await input.press('Escape');
    await expect(label).toHaveText('125%');
    for (const [value, expected] of [['99999', '1200%'], ['-10', '5%']]) {
      await open();
      await input.fill(value);
      await input.press('Enter');
      await expect(label).toHaveText(expected);
    }
    await open();
    await input.fill('137.5');
    await input.press('Enter');
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await expect(label).toHaveText('200%');
    await page.getByRole('button', { name: '缩小', exact: true }).click();
    await expect(label).toHaveText('100%');
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  } finally { await closeDesktop(session); }
});

test('desktop fill window fits wide and tall canvases to the limiting side without cropping pixels', async ({}, testInfo) => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    for (const size of [{ width: 512, height: 128 }, { width: 128, height: 512 }]) {
      const canvas = await createBlankAsset(page, `Fill${size.width}x${size.height}`, size);
      const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
      await page.getByRole('button', { name: '适应窗口 (Shift+F)', exact: true }).click();
      const fitWidth = (await canvas.boundingBox())!.width;
      await page.locator('.stage').dispatchEvent('wheel', { deltaY: 2000 });
      await page.locator('.stage').dispatchEvent('wheel', { shiftKey: true, deltaY: 2000 });
      await page.getByRole('button', { name: '填充窗口', exact: true }).click();
      await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(fitWidth);
      await page.screenshot({ path: testInfo.outputPath(`fill-${size.width}x${size.height}.png`) });
      await expect.poll(() => canvas.evaluate(element => {
        const board = element.getBoundingClientRect();
        const stage = element.closest('.stage')!;
        const workspace = stage.getBoundingClientRect();
        const centerX = workspace.left + workspace.width / 2;
        const centerY = workspace.top + workspace.height / 2;
        const view = element.closest('.stage-view')!;
        const label = view.querySelector<HTMLElement>('.stage-label')!;
        const style = getComputedStyle(stage);
        const viewStyle = getComputedStyle(view);
        const footer = parseFloat(getComputedStyle(element.closest('.canvas-wrap')!).paddingBottom);
        const top = workspace.top + parseFloat(style.paddingTop) + label.offsetHeight + parseFloat(viewStyle.rowGap);
        const bottom = workspace.bottom - parseFloat(style.paddingBottom) - footer;
        const left = workspace.left + parseFloat(style.paddingLeft) + parseFloat(viewStyle.paddingLeft);
        const right = workspace.right - parseFloat(style.paddingRight) - parseFloat(viewStyle.paddingRight);
        return {
          coversCenter: board.left <= centerX && board.right >= centerX && board.top <= centerY && board.bottom >= centerY,
          fullyVisible: board.left >= left - 1 && board.right <= right + 1 && board.top >= top - 1 && board.bottom <= bottom + 1,
          touchesOneSide: Math.abs(board.width - (right - left)) < 6 || Math.abs(board.height - (bottom - top)) < 6,
        };
      })).toEqual({ coversCenter: true, fullyVisible: true, touchesOneSide: true });
      await expect(page.locator('.brush-cursor')).toHaveCount(0);
      const filled = (await canvas.boundingBox())!;
      const workspace = (await page.locator('.stage').boundingBox())!;
      expect(Math.abs(filled.x + filled.width / 2 - workspace.x - workspace.width / 2)).toBeLessThan(2);
      await page.locator('.stage').dispatchEvent('wheel', { shiftKey: true, deltaY: 60 });
      await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - filled.x)).toBe(-60);
      await page.getByRole('button', { name: '填充窗口', exact: true }).click();
      await expect.poll(async () => Math.abs((await canvas.boundingBox())!.x - filled.x)).toBeLessThan(1);
      await page.getByRole('button', { name: '适应窗口 (Shift+F)', exact: true }).click();
      await expect.poll(() => canvas.evaluate(element => {
        const board = element.getBoundingClientRect();
        const stage = element.closest('.stage')!.getBoundingClientRect();
        return board.left >= stage.left && board.right <= stage.right && board.top >= stage.top && board.bottom <= stage.bottom;
      })).toBe(true);
      expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
      await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    }
  } finally { await closeDesktop(session); }
});

test('desktop global Shift-wheel pans from blank workspace and sidebars and respects controls', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'GlobalWheelAsset');
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const origin = (await canvas.boundingBox())!;
    const stage = page.locator('.stage');
    const workspace = (await stage.boundingBox())!;
    const blank = { x: workspace.x + 8, y: workspace.y + 8 };
    await page.mouse.move(blank.x, blank.y);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - origin.x)).toBe(-120);
    const sidebar = (await page.locator('.library .section-label').first().boundingBox())!;
    await page.mouse.move(sidebar.x + 10, sidebar.y + sidebar.height / 2);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - origin.x)).toBe(0);
    await page.keyboard.up('Shift');
    expect(await page.locator('.library .section-label').first().evaluate(element => {
      const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(false);

    // The canvas remains recoverable even after it is entirely outside the viewport.
    await stage.dispatchEvent('wheel', { shiftKey: true, deltaY: 2000 });
    await expect.poll(async () => (await canvas.boundingBox())!.x + origin.width).toBeLessThan(workspace.x);
    await page.mouse.move(blank.x, blank.y);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -2000);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - origin.x)).toBe(0);
    await page.keyboard.up('Shift');

    const input = page.getByLabel('图层名称');
    expect(await input.evaluate(element => {
      const event = new WheelEvent('wheel', { shiftKey: true, deltaY: 120, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(false);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - origin.x)).toBe(0);
    await page.getByRole('button', { name: '新建素材', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.getByRole('dialog').evaluate(element => {
      const event = new WheelEvent('wheel', { shiftKey: true, deltaY: 120, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(false);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - origin.x)).toBe(0);
    await page.getByLabel('关闭对话框').click();
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.y - origin.y)).toBe(0);
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  } finally {
    await closeDesktop(session);
  }
});

test('desktop ordinary wheel pans beyond both canvas edges and returns from blank space', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'UnboundedVerticalPanAsset');
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const origin = (await canvas.boundingBox())!;
    const zoom = await page.locator('.zoom-label').innerText();
    const stage = page.locator('.stage');
    const workspace = (await stage.boundingBox())!;
    await page.mouse.move(workspace.x + 8, workspace.y + 8);
    for (const [delta, offset] of [[2000, -2000], [120, -2120], [-4240, 2120], [-120, 2240], [2240, 0]]) {
      await page.mouse.wheel(0, delta);
      await expect.poll(async () => Math.round((await canvas.boundingBox())!.y - origin.y)).toBe(offset);
      await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - origin.x)).toBe(0);
    }
    expect(await stage.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([0, 0]);
    for (const keyboard of [true, false]) {
      await stage.dispatchEvent('wheel', { shiftKey: true, deltaY: 2000 });
      await stage.dispatchEvent('wheel', { deltaY: 2000 });
      await expect.poll(async () => (await canvas.boundingBox())!.x + origin.width).toBeLessThan(workspace.x);
      await expect.poll(async () => (await canvas.boundingBox())!.y + origin.height).toBeLessThan(workspace.y);
      if (keyboard) await page.keyboard.press('f');
      else await page.getByRole('button', { name: '定位画布 (F)', exact: true }).click();
      await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - origin.x)).toBe(0);
      await expect.poll(async () => Math.round((await canvas.boundingBox())!.y - origin.y)).toBe(0);
    }
    await expect(page.locator('.zoom-label')).toHaveText(zoom);
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  } finally {
    await closeDesktop(session);
  }
});

test('desktop temporary pan preserves pixels and restores the selected tool', async ({}, testInfo) => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'PanNavigationAsset');
    await page.keyboard.press('b');
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const origin = (await canvas.boundingBox())!;
    for (const middle of [false, true]) {
      const bounds = (await canvas.boundingBox())!;
      const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      await page.mouse.move(start.x, start.y);
      if (!middle) {
        await page.keyboard.down('Space');
        await expect(canvas).toHaveCSS('cursor', 'grab');
        await expect(page.getByLabel('画笔范围预览')).toHaveCount(0);
      }
      await page.mouse.down({ button: middle ? 'middle' : 'left' });
      await expect(canvas).toHaveCSS('cursor', 'grabbing');
      await page.mouse.move(start.x + 35, start.y + 25, { steps: 4 });
      await page.mouse.up({ button: middle ? 'middle' : 'left' });
      if (!middle) await page.keyboard.up('Space');
      await expect(canvas).toHaveCSS('cursor', 'none');
      await expect(page.getByRole('button', { name: '铅笔 (B)', exact: true })).toHaveClass(/active/);
      await expect.poll(async () => Math.round((await canvas.boundingBox())!.x - bounds.x)).toBe(35);
      await expect.poll(async () => Math.round((await canvas.boundingBox())!.y - bounds.y)).toBe(25);
    }
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '定位画布 (F)', exact: true }).click();
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.x)).toBe(Math.round(origin.x));
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.y)).toBe(Math.round(origin.y));
    await clickPixel(page, canvas, 20, 20);
    await expect.poll(() => pixel(canvas, 20, 20)).toEqual([33, 143, 131, 255]);
    await page.keyboard.press('Control+Z');
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await page.screenshot({ path: testInfo.outputPath('canvas-navigation.png') });
  } finally {
    await closeDesktop(session);
  }
});

test('desktop space pan respects text focus and clears on window blur', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'NavigationFocusAsset');
    const layerName = page.getByLabel('图层名称');
    await layerName.fill('前景');
    await layerName.press('End');
    await page.keyboard.press('Space');
    await expect(layerName).toHaveValue('前景 ');
    await expect(canvas).toHaveCSS('cursor', 'none');
    await page.getByText('PixelArting', { exact: true }).click();
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.keyboard.down('Space');
    await page.mouse.down();
    await expect(canvas).toHaveCSS('cursor', 'grabbing');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(canvas).toHaveCSS('cursor', 'none');
    await page.mouse.up();
    await page.keyboard.up('Space');
    await clickPixel(page, canvas, 20, 20);
    await expect.poll(() => pixel(canvas, 20, 20)).toEqual([33, 143, 131, 255]);
  } finally {
    await closeDesktop(session);
  }
});

test('desktop shortcuts switch tools, open commands, and respect text focus', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    page.on('dialog', () => {});
    await expect(page.getByLabel('像素编辑画布')).toBeVisible();

    const canvas = await createBlankAsset(page, 'InputShortcutAsset');
    await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
    await expect(page.getByLabel('画笔工具设置')).toContainText('铅笔设置');
    await page.getByRole('button', { name: '橡皮 (E)', exact: true }).click();
    await expect(page.getByLabel('橡皮工具设置')).toContainText('橡皮设置');
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
    await expect(page.getByLabel('画笔工具设置')).toContainText('铅笔设置');
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

async function setShapeStroke(page: ElectronPage, value: number) {
  await openActiveToolSettings(page);
  const slider = page.getByLabel('图形描边粗细');
  await slider.press('Home');
  for (let index = 1; index < value; index++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue(String(value));
}

async function pixelLocation(canvas: CanvasLocator, x: number, y: number) {
  const rect = (await canvas.boundingBox())!;
  return { x: rect.x + (x + 0.5) * rect.width / 64, y: rect.y + (y + 0.5) * rect.height / 64 };
}

async function dragPixels(page: ElectronPage, canvas: CanvasLocator, start: [number, number], end: [number, number], keys: string[] = []) {
  const from = await pixelLocation(canvas, ...start);
  const to = await pixelLocation(canvas, ...end);
  await page.mouse.move(from.x, from.y);
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 3 });
  await page.mouse.up();
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
}

async function paintedBounds(canvas: CanvasLocator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const { width, height } = element;
    const data = element.getContext('2d')!.getImageData(0, 0, width, height).data;
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!data[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    return right < 0 ? null : { left, top, right, bottom };
  });
}

async function undoShape(page: ElectronPage, canvas: CanvasLocator) {
  await page.keyboard.press('Control+Z');
  await expect.poll(() => paintedBounds(canvas)).toBeNull();
}

type ColorRect = [number, number, number, number, [number, number, number, number]];

async function importPixelLayer(page: ElectronPage, name: string, rectangles: ColorRect[]) {
  const source = await page.evaluate(rects => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(64, 64);
    for (const [left, top, width, height, color] of rects) {
      for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) image.data.set(color, (y * 64 + x) * 4);
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }, rectangles);
  const count = await page.locator('.layer-row').count();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入 PNG 图层', exact: true }).click();
  await (await chooser).setFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: Buffer.from(source, 'base64') });
  await expect(page.locator('.layer-row')).toHaveCount(count + 1);
  await expect(page.getByLabel('图层名称')).toHaveValue(name);
  await expect(page.getByLabel('像素编辑画布')).toHaveAttribute('aria-busy', 'false');
}

async function setFillTolerance(page: ElectronPage, value: number) {
  await openActiveToolSettings(page);
  const slider = page.getByLabel('填充容差', { exact: true });
  await slider.press('Home');
  for (let index = 0; index < value; index++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue(String(value));
}

async function setDrawingColor(page: ElectronPage, color: string) {
  await page.getByLabel('绘图颜色').evaluate((element: HTMLInputElement, value) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, color);
  await expect(page.locator('.color-hex')).toHaveText(color.toUpperCase());
}

test('desktop eyedropper switches raw and visible sampling including protected layers and transparency', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'EyedropperSources');
    await importPixelLayer(page, 'Blue', [[4, 4, 12, 12, [0, 0, 255, 255]]]);
    await importPixelLayer(page, 'Red', [[8, 8, 4, 4, [255, 0, 0, 128]]]);
    // An edit selection does not restrict reading pixels outside that selection.
    await page.getByRole('button', { name: '矩形选区 (M)', exact: true }).click();
    await dragPixels(page, canvas, [1, 1], [2, 2]);
    await page.getByRole('button', { name: '取色器 (I)', exact: true }).click();
    await expect(page.getByLabel('取色器设置', { exact: true })).toBeVisible();
    await expect(page.getByLabel('取色器取样来源')).toHaveValue('merged');
    const expectedMerged = (await pixel(canvas, 8, 8)).slice(0, 3).map(channel => channel.toString(16).padStart(2, '0')).join('');
    await clickPixel(page, canvas, 8, 8);
    await expect(page.locator('.color-hex')).toHaveText(`#${expectedMerged.toUpperCase()}`);
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const originalSource = await page.locator('.layer-row.selected img').getAttribute('src');
    await selectToolSetting(page, '取色器取样来源', 'layer');
    await clickPixel(page, canvas, 8, 8);
    await expect(page.getByLabel('绘图颜色')).toHaveValue('#ff0000');
    // The active layer is transparent here even though a lower layer is blue.
    await clickPixel(page, canvas, 5, 5);
    await expect(page.getByLabel('绘图颜色')).toHaveValue('#ff0000');
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    expect(await page.locator('.layer-row.selected img').getAttribute('src')).toBe(originalSource);
    await page.getByRole('button', { name: '锁定 Red', exact: true }).click();
    await setDrawingColor(page, '#ffffff');
    await clickPixel(page, canvas, 8, 8);
    await expect(page.getByLabel('绘图颜色')).toHaveValue('#ff0000');
    await page.getByRole('button', { name: '解锁 Red', exact: true }).click();
    await page.getByRole('button', { name: '隐藏 Red', exact: true }).click();
    await setDrawingColor(page, '#ffffff');
    await clickPixel(page, canvas, 8, 8);
    await expect(page.getByLabel('绘图颜色')).toHaveValue('#ff0000');
    await selectToolSetting(page, '取色器取样来源', 'merged');
    await clickPixel(page, canvas, 8, 8);
    await expect(page.getByLabel('绘图颜色')).toHaveValue('#0000ff');
    await page.getByRole('button', { name: '显示 Red', exact: true }).click();
    await page.getByLabel('图层不透明度').press('Home');
    await clickPixel(page, canvas, 8, 8);
    await expect(page.getByLabel('绘图颜色')).toHaveValue('#0000ff');
    await selectToolSetting(page, '取色器取样来源', 'layer');
    await clickPixel(page, canvas, 8, 8);
    await expect(page.getByLabel('绘图颜色')).toHaveValue('#ff0000');
    await selectToolSetting(page, '取色器取样来源', 'merged');
    await clickPixel(page, canvas, 40, 40);
    await expect(page.getByLabel('绘图颜色')).toHaveValue('#ff0000');
  } finally { await closeDesktop(session); }
});

test('desktop eyedropper repeats colors, persists independent settings and leaves pixels and history intact', async ({}, testInfo) => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'EyedropperHistory');
    await importPixelLayer(page, 'Swatch', [[4, 4, 4, 4, [36, 52, 62, 255]]]);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('版本已保存');
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Swatch', exact: true }).click();
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await clickMenuItem(session.desktop, '工具', '取色器');
    await expect(page.getByLabel('取色器设置', { exact: true })).toBeVisible();
    await selectToolSetting(page, '取色器取样来源', 'layer');
    for (let index = 0; index < 2; index++) {
      await clickPixel(page, canvas, 4, 4);
      await expect(page.getByLabel('绘图颜色')).toHaveValue('#24343e');
      await expect(page.locator('.color-hex')).toHaveText('#24343E');
      await expect(page.getByRole('button', { name: '选择颜色 #24343E', exact: true })).toHaveClass(/chosen/);
      await page.getByRole('button', { name: '选择颜色 #218F83', exact: true }).click();
      await expect(page.getByLabel('绘图颜色')).toHaveValue('#218f83');
    }
    await clickPixel(page, canvas, 4, 4);
    await expect(page.locator('.color-hex')).toHaveText('#24343E');
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await expect(page.locator('.draft-badge')).toHaveCount(0);
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
    await clickPixel(page, canvas, 10, 10);
    await expect.poll(() => pixel(canvas, 10, 10)).toEqual([36, 52, 62, 255]);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    // Discard the reversible brush test so reload does not ask to restore a draft.
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('版本已保存');
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await page.getByText('PixelArting', { exact: true }).click();
    await page.keyboard.press('i');
    await expect(page.getByLabel('取色器取样来源')).toHaveValue('layer');
    await page.screenshot({ path: testInfo.outputPath('eyedropper-settings.png') });
    await page.getByRole('button', { name: '填充 (G)', exact: true }).click();
    await expect(page.getByLabel('填充取样来源')).toHaveValue('layer');
    await selectToolSetting(page, '填充取样来源', 'merged');
    await page.getByRole('button', { name: '取色器 (I)', exact: true }).click();
    await expect(page.getByLabel('取色器取样来源')).toHaveValue('layer');
    await page.evaluate(() => localStorage.setItem('pixelart-eyedropper-sample-v1', 'invalid'));
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '取色器 (I)', exact: true }).click();
    await expect(page.getByLabel('取色器取样来源')).toHaveValue('merged');
    await page.getByRole('button', { name: '填充 (G)', exact: true }).click();
    await expect(page.getByLabel('填充取样来源')).toHaveValue('merged');
  } finally { await closeDesktop(session); }
});

test('desktop fill uses seed tolerance and four-neighbor or global matching without extra history', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'FillTolerance');
    await importPixelLayer(page, 'Colors', [
      [0, 0, 64, 64, [0, 0, 0, 255]],
      [4, 4, 3, 3, [100, 100, 100, 255]], [7, 4, 2, 3, [108, 105, 102, 255]],
      [12, 4, 3, 3, [100, 100, 100, 255]], [9, 7, 1, 1, [100, 100, 100, 255]],
    ]);
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await page.getByRole('button', { name: '填充 (G)', exact: true }).click();
    await expect(page.getByLabel('填充工具设置')).toBeVisible();
    await clickPixel(page, canvas, 4, 4);
    await expect.poll(() => pixel(canvas, 6, 6)).toEqual([33, 143, 131, 255]);
    expect(await pixel(canvas, 7, 4)).toEqual([108, 105, 102, 255]);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await setFillTolerance(page, 8);
    await clickPixel(page, canvas, 4, 4);
    await expect.poll(() => pixel(canvas, 8, 6)).toEqual([33, 143, 131, 255]);
    expect(await pixel(canvas, 9, 7)).toEqual([100, 100, 100, 255]);
    expect(await pixel(canvas, 12, 4)).toEqual([100, 100, 100, 255]);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await selectToolSetting(page, '填充范围', 'all');
    await clickPixel(page, canvas, 4, 4);
    await expect.poll(() => pixel(canvas, 12, 4)).toEqual([33, 143, 131, 255]);
    expect(await pixel(canvas, 9, 7)).toEqual([33, 143, 131, 255]);
    expect(await pixel(canvas, 0, 0)).toEqual([0, 0, 0, 255]);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    // Matching the seed color still replaces nearby colors within tolerance.
    await setDrawingColor(page, '#646464');
    await clickPixel(page, canvas, 4, 4);
    await expect.poll(() => pixel(canvas, 7, 4)).toEqual([100, 100, 100, 255]);
    await clickPixel(page, canvas, 4, 4);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
  } finally { await closeDesktop(session); }
});

test('desktop fill respects selection and layer protection and remembers validated settings', async ({}, testInfo) => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'FillSelection');
    await page.getByRole('button', { name: '矩形选区 (M)', exact: true }).click();
    await dragPixels(page, canvas, [10, 10], [20, 20]);
    await expect(page.locator('.selection-region')).toBeVisible();
    await page.getByRole('button', { name: '填充 (G)', exact: true }).click();
    await page.getByLabel('填充容差', { exact: true }).press('End');
    await selectToolSetting(page, '填充范围', 'all');
    await clickPixel(page, canvas, 5, 5);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await expect.poll(() => paintedBounds(canvas)).toBeNull();
    await clickPixel(page, canvas, 12, 12);
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 10, top: 10, right: 20, bottom: 20 });
    await clickPixel(page, canvas, 12, 12);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => paintedBounds(canvas)).toBeNull();
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await page.keyboard.press('Control+Y');
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 10, top: 10, right: 20, bottom: 20 });
    await page.keyboard.press('Escape');
    for (const [protect, restore] of [['锁定 图层 1', '解锁 图层 1'], ['隐藏 图层 1', '显示 图层 1']]) {
      await page.getByRole('button', { name: protect, exact: true }).click();
      const before = await page.locator('.layer-row.selected img').getAttribute('src');
      await setDrawingColor(page, '#ffffff');
      await clickPixel(page, canvas, 12, 12);
      expect(await page.locator('.layer-row.selected img').getAttribute('src')).toBe(before);
      await page.getByRole('button', { name: restore, exact: true }).click();
    }
    await selectToolSetting(page, '填充取样来源', 'merged');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('版本已保存');
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '填充 (G)', exact: true }).click();
    await expect(page.getByLabel('填充容差', { exact: true })).toHaveValue('255');
    await expect(page.getByLabel('填充范围')).toHaveValue('all');
    await expect(page.getByLabel('填充取样来源')).toHaveValue('merged');
    await page.screenshot({ path: testInfo.outputPath('fill-settings.png') });
    await page.evaluate(() => localStorage.setItem('pixelart-fill-settings-v1', '{broken'));
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '填充 (G)', exact: true }).click();
    await expect(page.getByLabel('填充容差', { exact: true })).toHaveValue('0');
    await expect(page.getByLabel('填充范围')).toHaveValue('contiguous');
    await expect(page.getByLabel('填充取样来源')).toHaveValue('layer');
  } finally { await closeDesktop(session); }
});

test('desktop fill distinguishes transparent and semi-transparent pixels including alpha tolerance', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'FillAlpha');
    await importPixelLayer(page, 'Alpha', [[10, 10, 1, 1, [0, 0, 0, 128]], [11, 10, 1, 1, [0, 0, 0, 129]], [12, 10, 1, 1, [0, 0, 0, 255]]]);
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await page.getByRole('button', { name: '填充 (G)', exact: true }).click();
    await clickPixel(page, canvas, 10, 10);
    await expect.poll(() => pixel(canvas, 10, 10)).toEqual([33, 143, 131, 255]);
    expect(await pixel(canvas, 11, 10)).toEqual([0, 0, 0, 129]);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await setFillTolerance(page, 1);
    await clickPixel(page, canvas, 10, 10);
    await expect.poll(() => pixel(canvas, 11, 10)).toEqual([33, 143, 131, 255]);
    expect(await pixel(canvas, 12, 10)).toEqual([0, 0, 0, 255]);
    expect(await pixel(canvas, 9, 10)).toEqual([0, 0, 0, 0]);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await setFillTolerance(page, 0);
    await selectToolSetting(page, '填充范围', 'all');
    await clickPixel(page, canvas, 0, 0);
    await expect.poll(() => pixel(canvas, 63, 63)).toEqual([33, 143, 131, 255]);
    expect(await pixel(canvas, 10, 10)).toEqual([0, 0, 0, 128]);
    expect(await pixel(canvas, 11, 10)).toEqual([0, 0, 0, 129]);
    expect(await pixel(canvas, 12, 10)).toEqual([0, 0, 0, 255]);
  } finally { await closeDesktop(session); }
});

test('desktop fill samples visible composition while writing only the selected layer', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'FillMerged');
    await importPixelLayer(page, 'Barrier', [[32, 0, 1, 64, [0, 0, 0, 255]]]);
    const barrier = page.getByRole('button', { name: 'Barrier', exact: true });
    const originalBarrier = await barrier.locator('img').getAttribute('src');
    await page.getByRole('button', { name: '新建图层', exact: true }).click();
    await expect(page.locator('.layer-row')).toHaveCount(3);
    const paint = page.locator('.layer-row.selected .layer-select');
    const paintName = (await paint.innerText()).trim();
    await page.getByRole('button', { name: '填充 (G)', exact: true }).click();
    await selectToolSetting(page, '填充取样来源', 'merged');
    await clickPixel(page, canvas, 10, 10);
    await expect.poll(() => pixel(canvas, 0, 63)).toEqual([33, 143, 131, 255]);
    expect(await pixel(canvas, 40, 10)).toEqual([0, 0, 0, 0]);
    expect(await pixel(canvas, 32, 10)).toEqual([0, 0, 0, 255]);
    expect(await barrier.locator('img').getAttribute('src')).toBe(originalBarrier);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => pixel(canvas, 10, 10)).toEqual([0, 0, 0, 0]);
    await selectToolSetting(page, '填充取样来源', 'layer');
    await clickPixel(page, canvas, 10, 10);
    await expect.poll(() => pixel(canvas, 40, 10)).toEqual([33, 143, 131, 255]);
    expect(await pixel(canvas, 32, 10)).toEqual([33, 143, 131, 255]);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => pixel(canvas, 10, 10)).toEqual([0, 0, 0, 0]);
    await selectToolSetting(page, '填充取样来源', 'merged');
    await page.getByRole('button', { name: '隐藏 Barrier', exact: true }).click();
    await clickPixel(page, canvas, 10, 10);
    await expect.poll(() => pixel(canvas, 40, 10)).toEqual([33, 143, 131, 255]);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => pixel(canvas, 10, 10)).toEqual([0, 0, 0, 0]);
    await page.getByRole('button', { name: '显示 Barrier', exact: true }).click();
    await barrier.click();
    await page.getByLabel('图层不透明度').press('Home');
    await page.getByRole('button', { name: paintName, exact: true }).click();
    await clickPixel(page, canvas, 10, 10);
    await expect.poll(() => pixel(canvas, 40, 10)).toEqual([33, 143, 131, 255]);
    expect(await barrier.locator('img').getAttribute('src')).toBe(originalBarrier);
  } finally { await closeDesktop(session); }
});

test('desktop shape tools draw thick outlines and fills and remember independent settings', async ({}, testInfo) => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'ShapeSettingsAsset');
    await page.getByRole('button', { name: '矩形 (R)', exact: true }).click();
    await expect(page.getByLabel('图形工具设置')).toContainText('矩形设置');
    await setShapeStroke(page, 3);
    await dragPixels(page, canvas, [8, 8], [20, 18]);
    await expect.poll(() => pixel(canvas, 10, 10)).toEqual([33, 143, 131, 255]);
    await expect.poll(() => pixel(canvas, 11, 11)).toEqual([0, 0, 0, 0]);
    await expect.poll(() => pixel(canvas, 20, 18)).toEqual([33, 143, 131, 255]);
    await undoShape(page, canvas);
    await page.keyboard.press('Control+Y');
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 8, top: 8, right: 20, bottom: 18 });
    await undoShape(page, canvas);

    await page.getByRole('button', { name: '椭圆 (O)', exact: true }).click();
    await setShapeStroke(page, 2);
    await dragPixels(page, canvas, [8, 8], [24, 24]);
    await expect.poll(() => pixel(canvas, 16, 8)).toEqual([33, 143, 131, 255]);
    await expect.poll(() => pixel(canvas, 16, 9)).toEqual([33, 143, 131, 255]);
    await expect.poll(() => pixel(canvas, 16, 16)).toEqual([0, 0, 0, 0]);
    await expect.poll(() => pixel(canvas, 8, 8)).toEqual([0, 0, 0, 0]);
    await undoShape(page, canvas);
    await selectToolSetting(page, '图形绘制模式', 'fill');
    await expect(page.getByLabel('图形描边粗细')).toBeDisabled();
    await dragPixels(page, canvas, [8, 8], [24, 24]);
    await expect.poll(() => pixel(canvas, 16, 16)).toEqual([33, 143, 131, 255]);
    await expect.poll(() => pixel(canvas, 8, 8)).toEqual([0, 0, 0, 0]);
    await undoShape(page, canvas);
    await page.getByRole('button', { name: '矩形 (R)', exact: true }).click();
    await dragPixels(page, canvas, [8, 8], [24, 24]);
    await expect.poll(() => pixel(canvas, 16, 16)).toEqual([33, 143, 131, 255]);
    await expect.poll(() => pixel(canvas, 8, 8)).toEqual([33, 143, 131, 255]);
    await undoShape(page, canvas);

    await page.getByRole('button', { name: '直线 (L)', exact: true }).click();
    await expect(page.getByLabel('图形绘制模式')).toHaveCount(0);
    await setShapeStroke(page, 3);
    await dragPixels(page, canvas, [10, 12], [20, 12]);
    for (const y of [11, 12, 13]) await expect.poll(() => pixel(canvas, 15, y)).toEqual([33, 143, 131, 255]);
    await expect.poll(() => pixel(canvas, 15, 14)).toEqual([0, 0, 0, 0]);
    await undoShape(page, canvas);
    await page.keyboard.press('Control+S');
    await expect(page.locator('.toast')).toContainText('版本已保存');
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '矩形 (R)', exact: true }).click();
    await expect(page.getByLabel('图形描边粗细')).toHaveValue('3');
    await expect(page.getByLabel('图形绘制模式')).toHaveValue('fill');
    await page.screenshot({ path: testInfo.outputPath('shape-settings.png') });
    await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
    await expect(page.getByLabel('画笔粗细')).toHaveValue('1');
  } finally { await closeDesktop(session); }
});

test('desktop shape modifiers update previews, clip safely and cancel without history', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'ShapeConstraintAsset');
    await page.getByRole('button', { name: '矩形 (R)', exact: true }).click();
    await selectToolSetting(page, '图形绘制模式', 'fill');
    const from = await pixelLocation(canvas, 20, 20);
    const to = await pixelLocation(canvas, 26, 23);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y);
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 20, top: 20, right: 26, bottom: 23 });
    await page.keyboard.down('Shift');
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 20, top: 20, right: 26, bottom: 26 });
    await page.keyboard.up('Shift');
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 20, top: 20, right: 26, bottom: 23 });
    await page.keyboard.down('Alt');
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 14, top: 17, right: 26, bottom: 23 });
    await page.keyboard.down('Shift');
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 14, top: 14, right: 26, bottom: 26 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    await undoShape(page, canvas);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();

    await dragPixels(page, canvas, [30, 30], [26, 22], ['Shift']);
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 22, top: 22, right: 30, bottom: 30 });
    await undoShape(page, canvas);
    await dragPixels(page, canvas, [2, 2], [10, 7], ['Shift', 'Alt']);
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 0, top: 0, right: 10, bottom: 10 });
    await undoShape(page, canvas);
    await page.getByRole('button', { name: '直线 (L)', exact: true }).click();
    await dragPixels(page, canvas, [10, 10], [22, 13], ['Shift']);
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 10, top: 10, right: 22, bottom: 10 });
    await undoShape(page, canvas);

    await page.getByRole('button', { name: '矩形选区 (M)', exact: true }).click();
    await dragPixels(page, canvas, [10, 10], [20, 20]);
    await page.getByRole('button', { name: '矩形 (R)', exact: true }).click();
    await dragPixels(page, canvas, [5, 5], [25, 25]);
    await expect.poll(() => paintedBounds(canvas)).toEqual({ left: 10, top: 10, right: 20, bottom: 20 });
    await undoShape(page, canvas);
    await page.keyboard.press('Escape');
    const start = await pixelLocation(canvas, 8, 8);
    const end = await pixelLocation(canvas, 20, 20);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y);
    await expect.poll(() => paintedBounds(canvas)).not.toBeNull();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(() => paintedBounds(canvas)).toBeNull();
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  } finally { await closeDesktop(session); }
});

test('desktop fit window restores large canvases and supports zoom below 100 percent', async ({}, testInfo) => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'FitLargeAsset', 512);
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await page.getByText('PixelArting', { exact: true }).click();
    await page.keyboard.press('Shift+f');
    const fits = () => canvas.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const stage = element.closest('.stage')!.getBoundingClientRect();
      return bounds.left >= stage.left && bounds.top >= stage.top && bounds.right <= stage.right && bounds.bottom <= stage.bottom;
    });
    await expect.poll(fits).toBe(true);
    expect(Number.parseInt(await page.locator('.zoom-label').innerText())).toBeLessThan(100);
    const fitted = (await canvas.boundingBox())!;
    await page.mouse.move(fitted.x + fitted.width / 2, fitted.y + fitted.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(fitted.width);
    await page.locator('.stage').dispatchEvent('wheel', { deltaY: 2000 });
    await page.locator('.stage').dispatchEvent('wheel', { shiftKey: true, deltaY: 2000 });
    await page.getByRole('button', { name: '适应窗口 (Shift+F)', exact: true }).click();
    await expect.poll(fits).toBe(true);
    await session.desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
    await expect.poll(async () => page.evaluate(() => window.innerWidth)).toBeLessThan(1200);
    await page.getByRole('button', { name: '适应窗口 (Shift+F)', exact: true }).click();
    await expect.poll(fits).toBe(true);
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('fit-window.png') });
  } finally { await closeDesktop(session); }
});

async function commitDrawingColor(page: ElectronPage, color: string) {
  await page.getByLabel('绘图颜色').evaluate((input: HTMLInputElement, next) => {
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, color);
  await expect(page.locator('.color-hex')).toHaveText(color.toUpperCase());
}

async function drawingSwatches(page: ElectronPage) {
  return page.getByRole('group', { name: '绘图色板', exact: true }).getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')!.replace('选择颜色 ', '')));
}

test('desktop drawing palette adds, removes, reorders and persists without editing the asset', async ({}, testInfo) => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'PaletteManagement');
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const defaults = await drawingSwatches(page);
    await page.getByRole('button', { name: '管理色板', exact: true }).click();
    await commitDrawingColor(page, '#a123bc');
    const add = page.getByRole('button', { name: '添加当前颜色到色板', exact: true });
    await add.click();
    await expect(add).toBeDisabled();
    expect(await drawingSwatches(page)).toEqual([...defaults, '#A123BC']);
    await page.getByRole('button', { name: '当前色块前移', exact: true }).focus();
    await page.keyboard.press('Enter');
    expect((await drawingSwatches(page)).slice(-2)).toEqual(['#A123BC', defaults.at(-1)]);
    await page.getByRole('button', { name: '当前色块后移', exact: true }).click();
    const swatch = (color: string) => page.getByRole('button', { name: `选择颜色 ${color}`, exact: true });
    await swatch('#A123BC').dragTo(swatch(defaults[0]));
    await expect.poll(() => drawingSwatches(page)).toEqual(['#A123BC', ...defaults]);
    await page.screenshot({ path: testInfo.outputPath('palette-management.png') });
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    expect(await drawingSwatches(page)).toEqual(['#A123BC', ...defaults]);
    await page.getByRole('button', { name: '管理色板', exact: true }).click();
    for (const color of ['#A123BC', ...defaults]) {
      await swatch(color).click();
      await page.getByRole('button', { name: '删除当前色块', exact: true }).click();
    }
    expect(await drawingSwatches(page)).toEqual([]);
    await expect(page.getByLabel('绘图颜色')).toHaveValue(defaults.at(-1)!.toLowerCase());
    await expect(page.getByRole('button', { name: '删除当前色块', exact: true })).toBeDisabled();
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    expect(await drawingSwatches(page)).toEqual([]);
    await page.getByRole('button', { name: '管理色板', exact: true }).click();
    await page.getByRole('button', { name: '恢复默认色板', exact: true }).click();
    expect(await drawingSwatches(page)).toEqual(defaults);
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await expect(page.locator('.draft-badge')).toHaveCount(0);
    await expect(page.locator('.dirty-dot')).toHaveCount(0);
  } finally { await closeDesktop(session); }
});

test('desktop recent colors commit final inputs, deduplicate, remember twelve and paint the selected color', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'RecentColors');
    const recentButtons = page.getByRole('group', { name: '最近使用颜色', exact: true }).getByRole('button');
    await page.getByLabel('绘图颜色').evaluate((input: HTMLInputElement) => {
      for (let i = 0; i < 120; i++) {
        input.value = `#${(0x100000 + i).toString(16)}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.value = '#a123bc';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('.color-hex')).toHaveText('#A123BC');
    await expect(recentButtons).toHaveCount(0);
    await page.getByLabel('绘图颜色').dispatchEvent('change');
    await expect(recentButtons).toHaveCount(1);
    await commitDrawingColor(page, '#A123BC');
    await expect(recentButtons).toHaveCount(1);
    for (let i = 0; i < 13; i++) await commitDrawingColor(page, `#${(0x200000 + i).toString(16)}`);
    await expect(recentButtons).toHaveCount(12);
    await expect(recentButtons.first()).toHaveAttribute('aria-label', '使用最近颜色 #20000C');
    await expect(recentButtons.last()).toHaveAttribute('aria-label', '使用最近颜色 #200001');
    await page.getByRole('button', { name: '使用最近颜色 #200005', exact: true }).click();
    await expect(recentButtons.first()).toHaveAttribute('aria-label', '使用最近颜色 #200005');
    await expect(recentButtons).toHaveCount(12);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    const saved = await recentButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    expect(await recentButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(saved);
    await page.getByRole('button', { name: '使用最近颜色 #200005', exact: true }).click();
    await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
    await clickPixel(page, canvas, 10, 10);
    await expect.poll(() => pixel(canvas, 10, 10)).toEqual([32, 0, 5, 255]);
    await page.getByRole('button', { name: '选择颜色 #24343E', exact: true }).click();
    await page.getByRole('button', { name: '取色器 (I)', exact: true }).click();
    await clickPixel(page, canvas, 10, 10);
    await expect(page.locator('.color-hex')).toHaveText('#200005');
    await expect(recentButtons.first()).toHaveAttribute('aria-label', '使用最近颜色 #200005');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(() => pixel(canvas, 10, 10)).toEqual([0, 0, 0, 0]);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  } finally { await closeDesktop(session); }
});

test('desktop drawing palettes isolate projects and validate stored colors', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'ProjectPalette');
    const firstProject = await page.getByLabel('项目', { exact: true }).inputValue();
    const defaults = await drawingSwatches(page);
    await commitDrawingColor(page, '#a123bc');
    await page.getByRole('button', { name: '添加当前颜色到色板', exact: true }).click();
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill('IndependentPalette');
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const secondProject = await page.getByLabel('项目', { exact: true }).inputValue();
    expect(secondProject).not.toBe(firstProject);
    await page.locator('.empty-workbench').getByRole('button', { name: '新建素材', exact: true }).click();
    await page.getByLabel('素材名称').fill('SecondPalette');
    await page.getByRole('button', { name: '创建素材', exact: true }).click();
    await expect(page.locator('.document-bar')).toContainText('SecondPalette');
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    expect(await drawingSwatches(page)).toEqual(defaults);
    await expect(page.getByRole('button', { name: '使用最近颜色 #A123BC', exact: true })).toBeVisible();
    await commitDrawingColor(page, '#def123');
    await page.getByRole('button', { name: '添加当前颜色到色板', exact: true }).click();
    await page.getByLabel('项目', { exact: true }).selectOption(firstProject);
    await expect.poll(() => drawingSwatches(page)).toEqual([...defaults, '#A123BC']);
    await expect(page.getByLabel('绘图颜色')).toHaveValue('#def123');
    await expect(page.getByRole('button', { name: '使用最近颜色 #DEF123', exact: true })).toBeVisible();
    await page.evaluate(id => {
      localStorage.setItem(`pixelart-drawing-palette-v1:${id}`, JSON.stringify(['#abcdef', '#ABCDEF', 'bad', null, '#123456']));
      localStorage.setItem('pixelart-recent-colors-v1', '{broken');
    }, firstProject);
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    expect(await drawingSwatches(page)).toEqual(['#ABCDEF', '#123456']);
    await expect(page.getByRole('group', { name: '最近使用颜色', exact: true }).getByRole('button')).toHaveCount(0);
    await page.evaluate(id => localStorage.setItem(`pixelart-drawing-palette-v1:${id}`, 'invalid'), firstProject);
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    expect(await drawingSwatches(page)).toEqual(defaults);
    await page.evaluate(id => localStorage.setItem(`pixelart-drawing-palette-v1:${id}`, JSON.stringify(Array.from({ length: 257 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`))), firstProject);
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    expect(await drawingSwatches(page)).toHaveLength(256);
    await commitDrawingColor(page, '#a123bc');
    await expect(page.getByRole('button', { name: '添加当前颜色到色板', exact: true })).toBeDisabled();
    await page.getByLabel('项目', { exact: true }).selectOption(secondProject);
    await expect.poll(() => drawingSwatches(page)).toEqual([...defaults, '#DEF123']);
  } finally { await closeDesktop(session); }
});

test('desktop drawing swatches can load the project palette without changing quality rules', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'QualityPalette');
    const defaults = await drawingSwatches(page);
    await page.getByRole('button', { name: '质检', exact: true }).click();
    await page.getByLabel('项目调色板', { exact: true }).fill('#abcdef, #123456');
    await page.getByRole('button', { name: '应用调色板', exact: true }).click();
    await expect.poll(() => drawingSwatches(page)).toEqual(['#ABCDEF', '#123456']);
    await page.getByRole('button', { name: '保存项目配置', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('项目配置已保存');
    await page.getByRole('button', { name: '管理色板', exact: true }).click();
    await page.getByRole('button', { name: '选择颜色 #ABCDEF', exact: true }).click();
    await page.getByRole('button', { name: '删除当前色块', exact: true }).click();
    expect(await drawingSwatches(page)).toEqual(['#123456']);
    await expect(page.getByLabel('项目调色板', { exact: true })).toHaveValue('#ABCDEF, #123456');
    await expect(page.getByRole('button', { name: '保存项目配置', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '恢复默认色板', exact: true }).click();
    expect(await drawingSwatches(page)).toEqual(defaults);
    await page.getByRole('button', { name: '载入项目色板', exact: true }).click();
    expect(await drawingSwatches(page)).toEqual(['#ABCDEF', '#123456']);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await expect(page.locator('.dirty-dot')).toHaveCount(0);
    await page.getByRole('button', { name: '当前色块后移', exact: true }).focus();
    // Escape closes only the palette manager and returns focus to its toggle.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: '色板管理', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '管理色板', exact: true })).toBeFocused();
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    expect(await drawingSwatches(page)).toEqual(['#ABCDEF', '#123456']);
  } finally { await closeDesktop(session); }
});

test('desktop Tab toggles focus canvas mode without changing navigation or edits', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'FocusCanvas');
    const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await page.getByText('PixelArting', { exact: true }).click();
    await page.keyboard.press('Tab');
    await expect(page.locator('.app-shell')).toHaveClass(/focus-mode/);
    await expect(page.locator('.library')).toBeHidden();
    await expect(page.locator('.inspector')).toBeHidden();
    await expect(page.getByRole('group', { name: '最近使用颜色', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '折叠时间轴', exact: true })).toBeHidden();
    await expect(canvas).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator('.app-shell')).not.toHaveClass(/focus-mode/);
    await expect(page.locator('.library')).toBeVisible();
    await expect(page.getByRole('button', { name: '折叠时间轴', exact: true })).toBeVisible();
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(before);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  } finally { await closeDesktop(session); }
});

test('desktop timeline collapse keeps frame actions available and restores on expand', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'CompactTimeline');
    await expect(page.getByRole('button', { name: '第 1 帧', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '折叠时间轴', exact: true }).click();
    await expect(page.getByRole('button', { name: '展开时间轴', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: '第 1 帧', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '新建空白帧', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '新建空白帧', exact: true }).click();
    await expect(page.locator('[data-panel=timeline] > .workspace-panel-heading')).toContainText('2 帧');
    await page.getByRole('button', { name: '展开时间轴', exact: true }).click();
    await expect(page.getByRole('button', { name: '折叠时间轴', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: '第 2 帧', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
    await page.keyboard.press('Control+Z');
    await expect(page.getByRole('button', { name: '第 2 帧', exact: true })).toHaveCount(0);
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
  } finally { await closeDesktop(session); }
});

test('desktop sidebars can collapse independently while preserving the canvas', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'SidebarLayout');
    const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await workspacePanelAction(page, '项目栏', '隐藏');
    await expect(page.locator('.library')).toBeHidden();
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.getByRole('button', { name: '显示项目栏', exact: true })).toBeVisible();
    await workspacePanelAction(page, '检查器', '隐藏');
    await expect(page.locator('.inspector')).toBeHidden();
    await expect(canvas).toBeVisible();
    await page.getByRole('button', { name: '显示项目栏', exact: true }).click();
    await expect(page.locator('.library')).toBeVisible();
    await expect(page.getByRole('button', { name: '显示检查器', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '显示检查器', exact: true }).click();
    await expect(page.locator('.inspector')).toBeVisible();
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(before);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  } finally { await closeDesktop(session); }
});

async function openActiveToolSettings(page: ElectronPage) {
  const panel = page.locator('[data-panel=tools]');
  if (!await panel.isVisible()) await restoreWorkspacePanel(page, '工具栏');
  else if (!await panel.locator('.workspace-panel-body').isVisible()) await page.getByRole('button', { name: '展开工具栏', exact: true }).click();
}

async function workspacePanelAction(page: ElectronPage, title: string, action: string) {
  const direct = page.getByRole('button', { name: `${action}${title}`, exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByRole('button', { name: `${title}菜单`, exact: true }).click();
    await page.getByRole('menuitem', { name: `${action}${title}`, exact: true }).click();
  }
}

async function selectToolSetting(page: ElectronPage, label: string, value: string) {
  await openActiveToolSettings(page);
  await page.getByLabel(label, { exact: true }).selectOption(value);
}

async function restoreWorkspacePanel(page: ElectronPage, title: string) {
  await page.getByRole('button', { name: '窗口', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: new RegExp(title) }).click();
}

test('desktop managed panels minimize hide close restore and persist independently', async ({}, testInfo) => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'ManagedWorkspace');
    const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const stage = page.locator('.stage');
    const initial = (await stage.boundingBox())!;
    await page.getByRole('button', { name: '最小化项目栏', exact: true }).click();
    expect((await page.locator('.library').boundingBox())!.width).toBe(42);
    expect((await stage.boundingBox())!.width).toBeGreaterThan(initial.width);
    await expect(page.getByLabel('项目', { exact: true })).toBeHidden();
    await page.getByRole('button', { name: '展开项目栏', exact: true }).click();
    await expect(page.getByLabel('项目', { exact: true })).toBeVisible();
    for (const [id, title] of [['library', '项目栏'], ['inspector', '检查器'], ['tools', '工具栏'], ['palette', '调色板'], ['timeline', '时间轴']]) {
      const panel = page.locator(`[data-panel=${id}]`);
      await workspacePanelAction(page, title, '隐藏');
      await expect(panel).toBeHidden();
      await restoreWorkspacePanel(page, title);
      await expect(panel).toBeVisible();
      await workspacePanelAction(page, title, '关闭');
      await expect(panel).toHaveAttribute('data-visibility', 'closed');
      await expect(panel).toBeHidden();
      await restoreWorkspacePanel(page, title);
      await expect(panel).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath('managed-docked-workspace.png') });
    await workspacePanelAction(page, '工具栏', '关闭');
    await page.getByText('PixelArting', { exact: true }).click();
    await page.keyboard.press('g');
    await expect(page.locator('[data-panel=tools]')).toBeHidden();
    await workspacePanelAction(page, '调色板', '隐藏');
    await page.getByRole('button', { name: '最小化检查器', exact: true }).click();
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('[data-panel=tools]')).toHaveAttribute('data-visibility', 'closed');
    await expect(page.locator('[data-panel=palette]')).toHaveAttribute('data-visibility', 'hidden');
    expect((await page.locator('.inspector').boundingBox())!.width).toBe(42);
    await clickMenuItem(session.desktop, '窗口', '工具栏');
    await expect(page.locator('[data-panel=tools]')).toBeVisible();
    await page.getByRole('button', { name: '窗口', exact: true }).click();
    await page.getByRole('menuitem', { name: '恢复默认工作区', exact: true }).click();
    for (const id of ['library', 'inspector', 'tools', 'palette', 'timeline']) {
      await expect(page.locator(`[data-panel=${id}]`)).toBeVisible();
      await expect(page.locator(`[data-panel=${id}]`)).toHaveAttribute('data-mode', 'docked');
    }
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(before);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  } finally { await closeDesktop(session); }
});

test('desktop floating panels drag dock stay reachable after resize and preserve their position', async ({}, testInfo) => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'FloatingWorkspace');
    await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const panel = page.locator('[data-panel=tools]');
    await workspacePanelAction(page, '工具栏', '浮动');
    await expect(panel).toHaveAttribute('data-mode', 'floating');
    const before = (await panel.boundingBox())!;
    const handle = await panel.locator('.panel-title').boundingBox();
    await page.mouse.move(handle!.x + 24, handle!.y + 14);
    await page.mouse.down();
    await page.mouse.move(handle!.x + 230, handle!.y + 150, { steps: 5 });
    await page.mouse.up();
    const after = (await panel.boundingBox())!;
    expect(after.x).toBeGreaterThan(before.x + 100);
    expect(after.y).toBeGreaterThan(before.y + 70);
    await page.getByText('PixelArting', { exact: true }).click();
    await expect(panel).toBeVisible();
    expect(await panel.boundingBox()).toEqual(after);
    await page.getByRole('button', { name: '最小化工具栏', exact: true }).click();
    await expect(page.getByLabel('画笔粗细')).toBeHidden();
    const minimizedHandle = (await panel.locator('.panel-title').boundingBox())!;
    await page.mouse.move(minimizedHandle.x + 20, minimizedHandle.y + 10);
    await page.mouse.down();
    await page.mouse.move(minimizedHandle.x + 60, minimizedHandle.y + 30);
    await page.mouse.up();
    await expect(page.getByLabel('画笔粗细')).toBeHidden();
    await page.getByRole('button', { name: '展开工具栏', exact: true }).click();
    await expect(page.getByLabel('画笔粗细')).toBeVisible();
    const restored = (await panel.boundingBox())!;
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await expect(panel).toHaveAttribute('data-mode', 'floating');
    expect((await panel.boundingBox())!.x).toBe(restored.x);
    expect((await panel.boundingBox())!.y).toBe(restored.y);
    // Every panel shares the same detach/dock behavior.
    await page.getByRole('button', { name: '停靠工具栏', exact: true }).click();
    for (const title of ['项目栏', '检查器', '调色板', '时间轴']) {
      await workspacePanelAction(page, title, '浮动');
      if (title === '时间轴') {
        await page.getByRole('button', { name: '折叠时间轴', exact: true }).click();
        const close = page.getByRole('button', { name: '关闭时间轴', exact: true });
        expect(await close.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const panelBounds = element.closest('.workspace-panel')!.getBoundingClientRect();
          return bounds.right <= panelBounds.right;
        })).toBe(true);
        await page.getByRole('button', { name: '展开时间轴', exact: true }).click();
      }
      if (title === '调色板') {
        await page.getByRole('button', { name: '管理色板', exact: true }).click();
        const manager = page.getByRole('group', { name: '色板管理', exact: true });
        await expect(manager).toBeVisible();
        expect(await manager.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const panelBounds = element.closest('.workspace-panel')!.getBoundingClientRect();
          return bounds.top >= panelBounds.top && bounds.bottom <= panelBounds.bottom;
        })).toBe(true);
        await page.keyboard.press('Escape');
      }
      await page.getByRole('button', { name: `停靠${title}`, exact: true }).click();
    }
    await workspacePanelAction(page, '工具栏', '浮动');
    await session.desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 740));
    await expect.poll(() => panel.evaluate(element => {
      const r = element.getBoundingClientRect();
      return r.left >= 8 && r.top >= 64 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('managed-floating-workspace.png') });
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  } finally { await closeDesktop(session); }
});

test('desktop docked tool options stay open while painting and keep opacity accurate', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'DockedBrush');
    await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
    await page.getByRole('button', { name: '适应窗口 (Shift+F)', exact: true }).click();
    const panel = page.locator('[data-panel=tools]');
    await expect(panel).toHaveAttribute('data-mode', 'docked');
    const opacity = page.getByLabel('画笔不透明度', { exact: true });
    await opacity.press('Home');
    for (let index = 1; index < 50; index++) await opacity.press('ArrowRight');
    await opacity.press('Tab');
    await expect(page.locator('.app-shell')).not.toHaveClass(/focus-mode/);
    const point = await pixelLocation(canvas, 20, 20);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 0.2, point.y + 0.2);
    await page.mouse.up();
    await expect(opacity).toBeVisible();
    await expect(opacity).toHaveValue('50');
    await expect.poll(async () => (await pixel(canvas, 20, 20))[3]).toBe(128);
    await page.keyboard.press('Control+Z');
    await expect.poll(() => paintedBounds(canvas)).toBeNull();
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    for (const [label, settings] of [['橡皮 (E)', '橡皮工具设置'], ['取色器 (I)', '取色器设置'], ['填充 (G)', '填充工具设置'], ['直线 (L)', '图形工具设置'], ['矩形 (R)', '图形工具设置'], ['椭圆 (O)', '图形工具设置']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByLabel(settings, { exact: true })).toBeVisible();
      await expect(panel).toHaveAttribute('data-mode', 'docked');
    }
  } finally { await closeDesktop(session); }
});

test('desktop workspace ignores invalid storage and restores closed panels from the native Window menu', async () => {
  const session = await launchDesktop();
  try {
    const page = await session.desktop.firstWindow();
    const canvas = await createBlankAsset(page, 'LayoutRecovery');
    await page.evaluate(() => localStorage.setItem('pixelart-workspace-layout-v1', JSON.stringify({ library: null, inspector: { visibility: 'closed' }, tools: { visibility: 'visible', mode: 'floating', x: 999999, y: -9999 }, palette: 'bad' })));
    await page.reload();
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.library')).toBeVisible();
    await expect(page.locator('.inspector')).toBeHidden();
    await expect.poll(() => page.locator('[data-panel=tools]').evaluate(element => {
      const r = element.getBoundingClientRect();
      return r.x >= 8 && r.y >= 64 && r.right <= window.innerWidth;
    })).toBe(true);
    await clickMenuItem(session.desktop, '窗口', '检查器');
    await expect(page.locator('.inspector')).toBeVisible();
    await page.getByText('PixelArting', { exact: true }).click();
    await page.keyboard.press('Tab');
    await expect(page.locator('.app-shell')).toHaveClass(/focus-mode/);
    await clickMenuItem(session.desktop, '窗口', '恢复默认工作区');
    await expect(page.locator('.app-shell')).not.toHaveClass(/focus-mode/);
    await expect(page.locator('[data-panel=tools]')).toHaveAttribute('data-mode', 'docked');
    await page.getByRole('button', { name: '窗口', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemcheckbox').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: '窗口面板' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '窗口', exact: true })).toBeFocused();
  } finally { await closeDesktop(session); }
});
