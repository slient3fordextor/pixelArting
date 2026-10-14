import { expect, test } from '@playwright/test';

test('saving during a held pointer commits the complete stroke before a slow request', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: '笔画保存测试' } })).json();
  const asset = await (await request.post(`/api/projects/${project.id}/assets/blank`, { data: { name: '笔画素材', width: 16, height: 16 } })).json();
  await page.goto('/'); await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  const canvas = page.getByLabel('像素编辑画布', { exact: true });
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/assets/${asset.id}/save`, async route => { await blocked; await route.continue(); });
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 2.5 / 16, bounds.y + bounds.height * 2.5 / 16);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 5.5 / 16, bounds.y + bounds.height * 2.5 / 16);
  const pending = page.waitForRequest(`**/api/assets/${asset.id}/save`);
  await page.keyboard.press('Control+s'); await pending;
  await page.mouse.up(); release();
  await expect(page.locator('.toast')).toContainText('版本已保存');
  const saved = await (await request.get(`/api/assets/${asset.id}`)).json();
  const alphas = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return [2, 3, 4, 5].map(x => context.getImageData(x, 2, 1, 1).data[3]);
  }, saved.document.frames[0].pixels.base);
  expect(alphas).toEqual([255, 255, 255, 255]);
  await expect(page.locator('.draft-badge')).toHaveCount(0);
});

test('a real version conflict keeps the local draft across reload and can save it as a copy', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: '冲突草稿测试' } })).json();
  const asset = await (await request.post(`/api/projects/${project.id}/assets/blank`, { data: { name: '冲突素材' } })).json();
  await page.goto('/'); await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByLabel('帧基线').fill('18');
  await expect(page.locator('.status-bar')).toContainText('草稿已自动保存');
  const externalDocument = structuredClone(asset.document); externalDocument.frames[0].baselineY = 27;
  const external = await (await request.post(`/api/assets/${asset.id}/save`, { data: { expectedCurrentVersionId: asset.currentVersionId, document: externalDocument } })).json();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('版本');
  await page.reload(); await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await expect(page.locator('.draft-conflict')).toContainText('旧版本');
  await expect(page.getByLabel('帧基线')).toHaveValue('27');
  expect(await page.evaluate(id => localStorage.getItem(`pixelart-draft-v1:${id}`), asset.id)).not.toBeNull();
  await page.getByRole('button', { name: '另存副本', exact: true }).click();
  await expect(page.getByLabel('帧基线')).toHaveValue('18');
  const current = await (await request.get(`/api/assets/${asset.id}`)).json();
  expect(current.currentVersionId).toBe(external.currentVersionId);
  expect(current.document.frames[0].baselineY).toBe(27);
  expect(await page.evaluate(id => localStorage.getItem(`pixelart-draft-v1:${id}`), asset.id)).toBeNull();
});

test('onion skins follow animation order and moving collision boxes preserves dimensions', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: '动画参考测试' } })).json();
  const asset = await (await request.post(`/api/projects/${project.id}/assets/blank`, { data: { name: '动画参考素材', width: 32, height: 32 } })).json();
  await page.goto('/');
  const images = await page.evaluate(() => ['#ff0000', '#00ff00', '#0000ff'].map(color => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(4, 4, 1, 1);
    return canvas.toDataURL();
  }));
  const document = structuredClone(asset.document);
  document.frames = images.map((image, i) => ({ ...structuredClone(document.frames[0]), id: `frame_${i}`, pixels: { base: image } }));
  document.animations = [{ action: 'walk', direction: 'down', loop: true, frames: [{ frameId: 'frame_2', durationMs: 200 }, { frameId: 'frame_0', durationMs: 200 }] }];
  await request.post(`/api/assets/${asset.id}/save`, { data: { expectedCurrentVersionId: asset.currentVersionId, document } });
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: '洋葱皮预览', exact: true }).click();
  await expect.poll(() => page.getByLabel('洋葱皮预览画布').evaluate((el: HTMLCanvasElement) => Array.from(el.getContext('2d')!.getImageData(4, 4, 1, 1).data).slice(0, 3))).toEqual([0, 0, 255]);
  await page.getByRole('button', { name: '添加碰撞框', exact: true }).click();
  await page.getByLabel('碰撞框 1 x', { exact: true }).fill('31');
  await expect(page.getByLabel('碰撞框 1 x', { exact: true })).toHaveValue('16');
  await expect(page.getByLabel('碰撞框 1 width', { exact: true })).toHaveValue('16');
  await page.getByLabel('碰撞框 1 x', { exact: true }).fill('0');
  await expect(page.getByLabel('碰撞框 1 width', { exact: true })).toHaveValue('16');
});
