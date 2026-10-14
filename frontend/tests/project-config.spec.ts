import { expect, test } from '@playwright/test';

test('project settings remain separate after switching and reloading', async ({ page, request }) => {
  const first = await (await request.post('/api/projects', { data: { name: '配置隔离 A' } })).json();
  const second = await (await request.post('/api/projects', { data: { name: '配置隔离 B' } })).json();
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(first.id);
  await page.getByRole('button', { name: '质检', exact: true }).click();
  await page.getByLabel('目标宽度').fill('32');
  await page.getByLabel('预期 walk 帧数').fill('6');
  await page.getByLabel('基线容差').fill('2');
  await page.getByLabel('导出检查目标').selectOption('godot');
  await page.getByLabel('项目调色板').fill('#24343E, #218F83');
  await page.getByRole('button', { name: '应用调色板', exact: true }).click();
  await page.getByRole('button', { name: '保存项目配置', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('项目配置已保存');
  await page.getByLabel('项目', { exact: true }).selectOption(second.id);
  await expect(page.getByLabel('目标宽度')).toHaveValue('64');
  await expect(page.getByLabel('项目调色板')).toHaveValue('');
  await page.reload();
  await page.getByLabel('项目', { exact: true }).selectOption(first.id);
  await page.getByRole('button', { name: '质检', exact: true }).click();
  await expect(page.getByLabel('目标宽度')).toHaveValue('32');
  await expect(page.getByLabel('预期 walk 帧数')).toHaveValue('6');
  await expect(page.getByLabel('基线容差')).toHaveValue('2');
  await expect(page.getByLabel('导出检查目标')).toHaveValue('godot');
  await expect(page.getByLabel('项目调色板')).toHaveValue('#24343E, #218F83');
});

test('saved check reports can be reopened after reloading', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: '报告历史验证' } })).json();
  await request.post(`/api/projects/${project.id}/assets/blank`, { data: { name: '质检素材' } });
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: '质检', exact: true }).click();
  await page.getByRole('button', { name: '运行质检', exact: true }).click();
  await expect(page.locator('.rule-state')).toHaveCount(8);
  const reportId = await page.getByLabel('检查历史').inputValue();
  await page.reload();
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: '质检', exact: true }).click();
  await page.getByLabel('检查历史').selectOption(reportId);
  await expect(page.locator('.rule-state')).toHaveCount(8);
});
