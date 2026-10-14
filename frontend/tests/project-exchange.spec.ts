import { expect, test } from '@playwright/test';

test('project management renames and guarded deletion; saved project backup restores as a new project', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: '管理与备份项目' } })).json();
  await request.post(`/api/projects/${project.id}/assets/blank`, { data: { name: '备份素材', width: 12, height: 12 } });
  await page.goto('/'); await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: '管理项目', exact: true }).click();
  await page.getByLabel('修改项目名称').fill('管理与备份项目改名');
  await page.getByRole('button', { name: '保存项目名称', exact: true }).click();
  await expect(page.getByLabel('项目', { exact: true })).toHaveValue(project.id);
  await expect(page.getByLabel('项目', { exact: true }).locator('option:checked')).toHaveText('管理与备份项目改名');

  const backup = page.waitForEvent('download');
  await page.getByRole('button', { name: '备份项目', exact: true }).click();
  const archive = await backup;
  const path = await archive.path(); expect(path).not.toBeNull();
  await page.getByRole('button', { name: '恢复项目备份', exact: true }).click();
  await page.getByLabel('项目备份 ZIP 文件').setInputFiles(path!);
  await expect(page.locator('.exchange-notice[role="status"]')).toContainText('当前已保存版本已恢复为新项目');
  await expect(page.getByLabel('项目', { exact: true }).locator('option', { hasText: '管理与备份项目改名' })).toHaveCount(2);
  await page.getByRole('button', { name: '管理项目', exact: true }).click();
  await page.getByLabel('输入项目名确认删除').fill('管理与备份项目改名');
  await page.getByRole('button', { name: '永久删除项目', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('项目', { exact: true }).locator('option', { hasText: '管理与备份项目改名' })).toHaveCount(1);
  const projects = await (await request.get('/api/projects')).json();
  expect(projects.some((item: { id: string }) => item.id === project.id)).toBe(false);
});
