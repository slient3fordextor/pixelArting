import { expect, test, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('desktop downloads the selected frame and restores drafts after a backend port conflict', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pixelart-desktop-persistence-'));
  const profile = path.join(temporary, 'profile');
  await mkdir(profile);
  const launch = () => electron.launch({
    executablePath: path.resolve('../desktop/node_modules/electron/dist/electron'),
    args: [path.resolve('../desktop')],
    env: { ...process.env, PIXELART_DATA_DIR: path.join(temporary, 'data'), PIXELART_DESKTOP_USER_DATA: profile },
  });
  const unrelated = createServer(socket => socket.end());
  let desktop = await launch();
  try {
    const page = await desktop.firstWindow();
    page.on('dialog', dialog => { if (dialog.type() !== 'beforeunload') void dialog.accept(); });
    const canvas = page.getByLabel('像素编辑画布');
    await expect(canvas).toBeVisible();
    expect(page.url()).toBe('pixelart://workbench/');
    const inlineScriptRan = await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.pixelartInlineScriptRan = true';
      document.head.append(script);
      return Boolean((window as unknown as { pixelartInlineScriptRan: boolean }).pixelartInlineScriptRan);
    });
    expect(inlineScriptRan).toBe(false);
    const originalPort = Number(await readFile(path.join(profile, 'backend-port'), 'utf8'));
    await page.getByRole('button', { name: '复制当前帧', exact: true }).click();
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.click(bounds.x + bounds.width * 2.5 / 64, bounds.y + bounds.height * 2.5 / 64);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(2, 2, 1, 1).data[3])).toBe(255);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('版本已保存');

    const downloadedPath = path.join(temporary, 'selected-frame.png');
    await desktop.evaluate(({ BrowserWindow }, filename) => {
      BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (_event, item) => item.setSavePath(filename));
    }, downloadedPath);
    await page.locator('.asset-row.selected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '导出当前帧 PNG', exact: true }).click();
    await expect.poll(async () => readFile(downloadedPath).then(bytes => bytes.length).catch(() => 0)).toBeGreaterThan(0);
    const png = (await readFile(downloadedPath)).toString('base64');
    const exportedPixel = await page.evaluate(async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const surface = document.createElement('canvas'); surface.width = image.width; surface.height = image.height;
      const context = surface.getContext('2d')!; context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(2, 2, 1, 1).data);
    }, png);
    expect(exportedPixel).toEqual([33, 143, 131, 255]);
    await page.getByLabel('图层名称').fill('桌面恢复图层');
    await page.getByRole('button', { name: '质检', exact: true }).click();
    await page.getByLabel('颜色上限').fill('23');
    await expect(page.locator('.status-bar')).toContainText('草稿已自动保存');
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.session.flushStorageData();
      window.destroy();
    });
    await desktop.close();
    await expect.poll(async () => fetch(`http://127.0.0.1:${originalPort}/api/health`).then(() => true).catch(() => false)).toBe(false);
    await new Promise<void>((resolve, reject) => { unrelated.once('error', reject); unrelated.listen(originalPort, '127.0.0.1', resolve); });

    desktop = await launch();
    const reopened = await desktop.firstWindow();
    reopened.on('dialog', dialog => { if (dialog.type() !== 'beforeunload') void dialog.accept(); });
    await expect(reopened.getByLabel('像素编辑画布')).toBeVisible();
    expect(reopened.url()).toBe('pixelart://workbench/');
    expect(await reopened.evaluate(() => location.origin)).toBe('pixelart://workbench');
    expect(Number(await readFile(path.join(profile, 'backend-port'), 'utf8'))).not.toBe(originalPort);
    await expect(reopened.locator('.toast')).toContainText('已恢复未保存草稿');
    await expect(reopened.getByLabel('图层名称')).toHaveValue('桌面恢复图层');
    await expect(reopened.getByRole('button', { name: '第 2 帧', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(reopened.locator('.draft-badge')).toBeVisible();
    await reopened.getByRole('button', { name: '质检', exact: true }).click();
    await expect(reopened.getByLabel('颜色上限')).toHaveValue('23');
    await reopened.getByRole('button', { name: '保存', exact: true }).click();
    await expect(reopened.locator('.toast')).toContainText('版本已保存');
    await reopened.evaluate(() => { location.href = 'https://example.invalid'; });
    expect(reopened.url()).toBe('pixelart://workbench/');
    await reopened.screenshot({ path: '/tmp/pixelarting-desktop-recovered-draft.png' });
  } finally {
    await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach(window => window.destroy()); }).catch(() => {});
    await desktop.close().catch(() => {});
    if (unrelated.listening) await new Promise<void>(resolve => unrelated.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
