import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;
let imageData = '';
let failText = false;
const calls: { path: string; model: string; size?: string; authorized: boolean }[] = [];

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url || '', model: body.model, size: body.size, authorized: request.headers.authorization === 'Bearer local-integration-fixture' });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/chat/completions') {
      const input = JSON.parse(body.messages.at(-1).content);
      const content = failText ? 'invalid JSON' : JSON.stringify({ candidates: [{
        id: 'candidate_1', summary: '工具像素候选', commands: [
          { tool: 'create_canvas', args: { width: input.width, height: input.height, name: '工具绘制素材' } },
          { tool: 'set_palette', args: { colors: ['#218F83', '#D49A6A'] } },
          { tool: 'draw_rect', args: { x: 1, y: 2, width: 4, height: 3, color: '#218F83' } },
          { tool: 'create_layer', args: { id: 'detail', name: '细节' } },
          { tool: 'set_pixel_batch', args: { layerId: 'detail', pixels: [{ x: 2, y: 2, color: '#D49A6A' }] } },
          { tool: 'set_origin', args: { x: 4, y: 6, baselineY: 6 } },
          { tool: 'set_collision_rect', args: { x: 1, y: 5, width: 4, height: 2 } },
        ],
      }] });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    } else if (request.url === '/v1/images/generations') {
      response.end(JSON.stringify({ data: [{ b64_json: imageData }] }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Unknown fixture endpoint' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function configure(page: Page) {
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  if (!await page.getByLabel('AI Base URL').isVisible()) await page.locator('.ai-settings summary').filter({ hasText: '连接设置' }).click();
  await page.getByLabel('AI Base URL').fill(baseUrl);
  await page.getByLabel('AI API Key').fill('local-integration-fixture');
  await page.getByLabel('AI 文本模型').fill('fixture-text-model');
  await page.getByLabel('AI 图像模型').fill('fixture-image-model');
  await page.getByRole('button', { name: '保存连接设置', exact: true }).click();
  await expect(page.locator('.ai-notice')).toContainText('AI 设置已保存');
  await expect(page.getByLabel('AI API Key')).toHaveValue('');
  await page.getByLabel('AI 生成宽度').fill('8');
  await page.getByLabel('AI 生成高度').fill('8');
  await page.getByLabel('AI 候选数量').fill('1');
}

test('text model commands render candidates and import editable layers only after confirmation', async ({ page, request }) => {
  failText = false;
  await page.setViewportSize({ width: 1440, height: 1000 });
  const project = await (await request.post('/api/projects', { data: { name: 'AI 工具完整流程' } })).json();
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await configure(page);
  await page.getByLabel('AI 生成描述').fill('8 色以内的蓝绿色道具，独立细节图层和脚底碰撞框');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.locator('.ai-candidate img')).toHaveCount(1);
  await expect.poll(() => page.locator('.ai-candidate img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(8);
  expect((await request.get(`/api/projects/${project.id}/assets`)).ok()).toBe(true);
  expect(await (await request.get(`/api/projects/${project.id}/assets`)).json()).toHaveLength(0);
  await page.getByRole('button', { name: '选择并导入', exact: true }).click();
  await expect(page.locator('.ai-notice')).toContainText('候选已导入');
  const items = await (await request.get(`/api/projects/${project.id}/assets`)).json();
  expect(items).toHaveLength(1);
  const asset = await (await request.get(`/api/assets/${items[0].id}`)).json();
  expect(asset.document.layers).toHaveLength(2);
  expect(asset.document.frames[0].origin).toEqual({ x: 4, y: 6 });
  expect(asset.document.frames[0].collisionRects).toEqual([{ x: 1, y: 5, width: 4, height: 2 }]);
  expect(asset.document.provenance).toMatchObject({ kind: 'ai', mode: 'agent_draw', model: 'fixture-text-model' });
  await page.getByRole('button', { name: '关闭 AI 生成', exact: true }).click();
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(2, 2, 1, 1).data))).toEqual([212, 154, 106, 255]);
  expect(calls.at(-1)).toMatchObject({ path: '/v1/chat/completions', model: 'fixture-text-model', authorized: true });
});

test('image model PNG candidates are resized into the requested pixel canvas', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: 'AI 图片完整流程' } })).json();
  await page.goto('/');
  imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#C83D71'; context.fillRect(0, 0, 8, 16);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await configure(page);
  await page.getByRole('button', { name: '图像模型生成', exact: true }).click();
  await page.getByLabel('AI 生成描述').fill('透明背景的粉红色小物品');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.locator('.ai-candidate img')).toHaveCount(1);
  await expect.poll(() => page.locator('.ai-candidate img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(8);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator('.ai-modal').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('button', { name: '选择并导入', exact: true }).click();
  await expect(page.locator('.ai-notice')).toContainText('候选已导入');
  const items = await (await request.get(`/api/projects/${project.id}/assets`)).json();
  const asset = await (await request.get(`/api/assets/${items[0].id}`)).json();
  expect(asset.document.frames[0]).toMatchObject({ width: 8, height: 8 });
  expect(asset.document.provenance).toMatchObject({ kind: 'ai', mode: 'image_model', model: 'fixture-image-model' });
  await page.getByRole('button', { name: '关闭 AI 生成', exact: true }).click();
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')!.getImageData(1, 1, 1, 1).data))).toEqual([200, 61, 113, 255]);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(6, 1, 1, 1).data[3])).toBe(0);
  expect(calls.at(-1)).toMatchObject({ path: '/v1/images/generations', model: 'fixture-image-model', size: '1024x1024', authorized: true });
});

test('invalid model output fails without creating an asset and can be retried', async ({ page, request }) => {
  failText = true;
  const project = await (await request.post('/api/projects', { data: { name: 'AI 失败重试' } })).json();
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await configure(page);
  await page.getByLabel('AI 生成描述').fill('一个小道具');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.locator('.ai-task strong').first()).toHaveText('失败');
  expect(await (await request.get(`/api/projects/${project.id}/assets`)).json()).toHaveLength(0);
  failText = false;
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(page.locator('.ai-candidate img')).toHaveCount(1);
  await expect(page.locator('.ai-task strong').first()).toHaveText('已完成');
});
