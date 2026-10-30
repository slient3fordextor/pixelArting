import { expect, test } from '@playwright/test';

async function openLibrary(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  return page.getByRole('dialog', { name: '素材库', exact: true });
}

test('new project assets stay in the sidebar until explicitly confirmed for the library', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  await page.locator('.library').getByRole('button', { name: '新建素材', exact: true }).click();
  await page.getByLabel('素材名称').fill('待确认收录角色');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await expect(page.locator('.asset-row.selected')).toContainText('待确认收录角色');
  expect((await (await request.get('/api/assets/library')).json()).length).toBe(0);
  const library = await openLibrary(page);
  await expect(library).toContainText('还没有收录素材');
  await expect(library.getByRole('button', { name: '新建素材', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭素材库', exact: true }).click();

  const collect = page.getByRole('button', { name: '加入素材库 待确认收录角色', exact: true });
  await collect.click();
  await expect(page.getByRole('dialog', { name: '加入素材库', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect((await (await request.get('/api/assets/library')).json()).length).toBe(0);
  await collect.click();
  await page.getByRole('button', { name: '确认加入素材库', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('加入素材库');
  const entries = await (await request.get('/api/assets/library')).json();
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe('待确认收录角色');

  await openLibrary(page);
  const card = page.locator('.asset-library-card').filter({ hasText: '待确认收录角色' });
  await expect(card).toHaveCount(1);
  const count = await page.locator('.asset-row').count();
  await card.getByRole('button', { name: '使用素材 待确认收录角色', exact: true }).click();
  await expect(page.locator('.asset-row')).toHaveCount(count + 1);
  await expect(page.locator('.asset-row.selected')).toContainText('待确认收录角色 副本');
  await openLibrary(page);
  await card.getByRole('button', { name: '移出素材库', exact: true }).click();
  await expect(page.locator('.asset-library-card')).toHaveCount(0);
  await expect(page.locator('.asset-row')).toHaveCount(count + 1);
});

test('unsaved pixel edits must be saved before collecting and reuse preserves dirty work', async ({ page, request }) => {
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  await page.locator('.library').getByRole('button', { name: '新建素材', exact: true }).click();
  await page.getByLabel('素材名称').fill('草稿保护素材');
  await page.getByRole('button', { name: '创建素材', exact: true }).click();
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  await canvas.click({ position: { x: 20, y: 20 } });
  await expect(page.locator('.draft-badge')).toBeVisible();
  const collect = page.getByRole('button', { name: '加入素材库 草稿保护素材', exact: true });
  await expect(collect).toBeDisabled();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(collect).toBeEnabled();
  await collect.click();
  await page.getByRole('button', { name: '确认加入素材库', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '加入素材库', exact: true })).toHaveCount(0);
  const entry = (await (await request.get('/api/assets/library')).json()).find((item: { name: string }) => item.name === '草稿保护素材');
  const originalThumbnail = await (await request.get(`/api/library/${entry.id}/thumbnail`)).body();
  await page.getByRole('button', { name: '橡皮 (E)', exact: true }).click();
  await page.keyboard.press('Escape');
  await canvas.click({ position: { x: 20, y: 20 } });
  await expect(page.locator('.draft-badge')).toBeVisible();
  const draftImage = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const count = await page.locator('.asset-row').count();
  await openLibrary(page);
  await page.getByRole('button', { name: '使用素材 草稿保护素材', exact: true }).click();
  await expect(page.locator('.asset-row')).toHaveCount(count + 1);
  await expect(page.locator('.draft-badge')).toBeVisible();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(draftImage);
  expect(await (await request.get(`/api/library/${entry.id}/thumbnail`)).body()).toEqual(originalThumbnail);
});
