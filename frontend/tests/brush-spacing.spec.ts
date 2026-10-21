import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

async function openBlank(page: Page, request: APIRequestContext) {
  const project = await (await request.post('/api/projects', { data: { name: '笔刷间距回归' } })).json();
  await request.post(`/api/projects/${project.id}/assets/blank`, { data: { name: '间距测试', width: 64, height: 64 } });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  const canvas = page.getByLabel('像素编辑画布');
  await expect(page.locator('.document-bar')).toContainText('间距测试');
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
  await page.getByLabel('画笔粗细').fill('3');
  await page.getByLabel('笔刷间距').fill('200');
  await page.keyboard.press('Escape');
  const bounds = (await canvas.boundingBox())!;
  const move = (x: number, y: number, steps = 1) => page.mouse.move(bounds.x + bounds.width * (x + .5) / 64, bounds.y + bounds.height * (y + .5) / 64, { steps });
  const row = (y: number) => canvas.evaluate((element: HTMLCanvasElement, y) => {
    const data = element.getContext('2d')!.getImageData(0, y, 64, 1).data;
    return Array.from({ length: 64 }, (_, x) => data[x * 4 + 3]);
  }, y);
  return { canvas, move, row };
}

test('spacing produces equal dots at every pointer speed and undo restores an entire stroke', async ({ page, request }) => {
  const { move, row } = await openBlank(page, request);
  const expected = Array.from({ length: 64 }, (_, x) => {
    for (let center = 6; center <= 54; center += 6) if (Math.abs(x - center) <= 1) return 255;
    return 0;
  });
  for (const [y, steps, reverse] of [[12, 1, false], [24, 16, false], [36, 48, false], [48, 16, true]] as const) {
    await move(reverse ? 54 : 6, y);
    await page.mouse.down();
    await move(reverse ? 6 : 54, y, steps);
    await page.mouse.up();
    await expect.poll(() => row(y)).toEqual(expected);
  }
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => row(48)).toEqual(Array(64).fill(0));
  await expect.poll(() => row(36)).toEqual(expected);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(() => row(48)).toEqual(expected);
});

test('spacing carries distance around corners without forcing a final stamp, and resets on a new stroke', async ({ page, request }) => {
  const { canvas, move } = await openBlank(page, request);
  await move(8, 8);
  await page.mouse.down();
  for (const [x, y] of [[10, 8], [10, 10], [12, 10], [12, 19]]) await move(x, y);
  await page.mouse.up();
  const alpha = (x: number, y: number) => canvas.evaluate((element: HTMLCanvasElement, point) => element.getContext('2d')!.getImageData(point.x, point.y, 1, 1).data[3], { x, y });
  for (const [x, y] of [[8, 8], [12, 10], [12, 16]]) await expect.poll(() => alpha(x, y)).toBe(255);
  await expect.poll(() => alpha(10, 10)).toBe(0);
  await expect.poll(() => alpha(12, 19)).toBe(0);
  await move(40, 40);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => alpha(40, 40)).toBe(255);
  await expect.poll(() => alpha(26, 28)).toBe(0);
});

test('preview shows the same stamp gaps while preserving its isolated brush tip', async ({ page, request }) => {
  const { canvas } = await openBlank(page, request);
  const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
  const preview = page.locator('.brush-preview canvas');
  const sample = () => preview.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d')!;
    return { tip: Array.from(context.getImageData(12, 14, 9, 9).data), stroke: Array.from(context.getImageData(32, 0, 28, 36).data) };
  });
  await page.getByLabel('笔刷间距').fill('10');
  await expect(preview).toHaveAccessibleName(/间距 10%/);
  const dense = await sample();
  await page.getByLabel('笔刷间距').fill('200');
  await expect(preview).toHaveAccessibleName(/间距 200%/);
  await expect.poll(async () => (await sample()).stroke).not.toEqual(dense.stroke);
  const sparse = await sample();
  expect(sparse.tip).toEqual(dense.tip);
  expect(sparse.stroke.filter((value, index) => index % 4 === 3 && value > 0).length)
    .toBeLessThan(dense.stroke.filter((value, index) => index % 4 === 3 && value > 0).length);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(original);
});
