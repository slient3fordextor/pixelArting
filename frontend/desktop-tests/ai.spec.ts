import { expect, test, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

async function stopDesktop(desktop: ElectronApp | undefined) {
  if (!desktop) return;
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(window => window.destroy());
  }).catch(() => {});
  await desktop.close().catch(() => {});
}

test('desktop renders text model commands through its protocol and retains private settings after restart', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pixelart-desktop-ai-'));
  const profile = path.join(temporary, 'profile');
  const calls: { path: string; authorized: boolean; model: string; request: Record<string, unknown> }[] = [];
  const fixtureErrors: string[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const input = JSON.parse(body.messages.at(-1).content);
      calls.push({
        path: request.url || '',
        authorized: request.headers.authorization === 'Bearer local-desktop-fixture',
        model: body.model,
        request: input,
      });
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Unknown fixture endpoint' }));
        return;
      }
      const content = JSON.stringify({ candidates: [{
        id: 'desktop_candidate', summary: 'Desktop pixel candidate', commands: [
          { tool: 'create_canvas', args: { width: input.width, height: input.height, name: 'Desktop AI Sprite' } },
          { tool: 'set_palette', args: { colors: ['#C83D71', '#218F83'] } },
          { tool: 'draw_rect', args: { x: 2, y: 2, width: 3, height: 2, color: '#C83D71' } },
          { tool: 'create_layer', args: { id: 'detail', name: 'Detail' } },
          { tool: 'set_pixel_batch', args: { layerId: 'detail', pixels: [{ x: 3, y: 2, color: '#218F83' }] } },
        ],
      }] });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    } catch (error) {
      fixtureErrors.push(error instanceof Error ? error.message : String(error));
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'Invalid fixture request' }));
    }
  });
  let desktop: ElectronApp | undefined;
  try {
    await mkdir(profile);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const launch = () => electron.launch({
      executablePath: path.resolve('../desktop/node_modules/electron/dist/electron'),
      args: [path.resolve('../desktop')],
      env: {
        ...process.env,
        PIXELART_DATA_DIR: path.join(temporary, 'data'),
        PIXELART_DESKTOP_USER_DATA: profile,
        OPENAI_API_KEY: '',
        // An accidental external provider URL must fail locally, never contact a real service.
        HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
        http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      },
    });
    desktop = await launch();
    const page = await desktop.firstWindow();
    const canvas = page.getByLabel('像素编辑画布');
    await expect(canvas).toBeVisible();
    expect(page.url()).toBe('pixelart://workbench/');
    const initialAssetCount = await page.locator('.asset-row').count();
    await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
    await expect(page.getByLabel('AI Base URL')).toBeVisible();
    await page.getByLabel('AI Base URL').fill(baseUrl);
    await page.getByLabel('AI API Key').fill('local-desktop-fixture');
    await page.getByLabel('AI 文本模型').fill('desktop-text-fixture');
    await page.getByRole('button', { name: '保存连接设置', exact: true }).click();
    await expect(page.locator('.ai-notice')).toContainText('AI 设置已保存');
    const saved = await page.evaluate(async () => (await fetch('/api/ai/config')).json());
    expect(saved).toMatchObject({ baseUrl, textModel: 'desktop-text-fixture', hasApiKey: true });
    expect(saved).not.toHaveProperty('apiKey');
    await page.getByLabel('AI 生成描述').fill('Draw a small magenta item with one green detail pixel');
    await page.getByLabel('AI 生成宽度').fill('8');
    await page.getByLabel('AI 生成高度').fill('8');
    await page.getByLabel('AI 候选数量').fill('1');
    await page.getByLabel('AI 颜色上限').fill('2');
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    await expect(page.locator('.ai-candidate img')).toHaveCount(1);
    await expect.poll(() => page.locator('.ai-candidate img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(8);
    await expect(page.locator('.asset-row')).toHaveCount(initialAssetCount);
    expect(fixtureErrors).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: '/v1/chat/completions', authorized: true, model: 'desktop-text-fixture',
      request: { width: 8, height: 8, variations: 1, paletteLimit: 2, transparentBackground: true },
    });
    await page.getByRole('button', { name: '选择并导入', exact: true }).click();
    await expect(page.locator('.ai-notice')).toContainText('候选已导入为新素材');
    await page.getByRole('button', { name: '关闭 AI 生成', exact: true }).click();
    await expect(page.locator('.document-bar')).toContainText('Desktop AI Sprite');
    await expect(page.locator('.asset-row')).toHaveCount(initialAssetCount + 1);
    await expect(canvas).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
      Array.from(element.getContext('2d')!.getImageData(2, 2, 1, 1).data)
    )).toEqual([200, 61, 113, 255]);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
      Array.from(element.getContext('2d')!.getImageData(3, 2, 1, 1).data)
    )).toEqual([33, 143, 131, 255]);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
      element.getContext('2d')!.getImageData(0, 0, 1, 1).data[3]
    )).toBe(0);

    const backendPort = Number(await readFile(path.join(profile, 'backend-port'), 'utf8'));
    await stopDesktop(desktop);
    desktop = undefined;
    await expect.poll(async () => fetch(`http://127.0.0.1:${backendPort}/api/health`).then(() => true).catch(() => false)).toBe(false);
    desktop = await launch();
    const reopened = await desktop.firstWindow();
    await expect(reopened.getByLabel('像素编辑画布')).toBeVisible();
    expect(reopened.url()).toBe('pixelart://workbench/');
    await reopened.getByRole('button', { name: 'AI 生成', exact: true }).click();
    await expect(reopened.locator('.ai-settings > summary')).toContainText('密钥已配置');
    await reopened.locator('.ai-settings > summary').click();
    await expect(reopened.getByLabel('AI API Key')).toBeVisible();
    await expect(reopened.getByLabel('AI API Key')).toHaveAttribute('type', 'password');
    await expect(reopened.getByLabel('AI API Key')).toHaveValue('');
    await expect(reopened.getByLabel('AI 文本模型')).toHaveValue('desktop-text-fixture');
    await expect(reopened.getByLabel('AI Base URL')).toHaveValue(baseUrl);
    const restored = await reopened.evaluate(async () => (await fetch('/api/ai/config')).json());
    expect(restored).toMatchObject({ baseUrl, textModel: 'desktop-text-fixture', hasApiKey: true });
    expect(restored).not.toHaveProperty('apiKey');
    expect(calls).toHaveLength(1);
  } finally {
    await stopDesktop(desktop);
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
