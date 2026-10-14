import { expect, test } from '@playwright/test';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8Dwn4GBgYGJAQoAHgQCAc8oUAAAAABJRU5ErkJggg==';
const configured = { baseUrl: 'https://ai.example.test/v1', textModel: 'text-example', imageModel: 'image-example', imageSize: '1024x1024', requestTimeoutSeconds: 120, hasApiKey: true };

test('AI settings protect credentials and both modes display actual candidates', async ({ page, request }) => {
  const generationBodies: Record<string, unknown>[] = [];
  let config = { ...configured, hasApiKey: false };
  await page.route('**/api/ai/config', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      if (body.clearApiKey) config = { ...config, hasApiKey: false };
      else {
        expect(body.apiKey).toBe('private-test-key');
        expect(body.textModel).toBe('user-text-model');
        expect(body.imageModel).toBe('user-image-model');
        config = { ...config, ...body, hasApiKey: true };
      }
      delete (config as Record<string, unknown>).apiKey;
    }
    await route.fulfill({ json: config });
  });
  await page.route('**/api/ai/generations*', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    const body = route.request().postDataJSON(); generationBodies.push(body);
    return route.fulfill({ json: { id: `generation-${generationBodies.length}`, projectId: body.projectId, mode: body.mode, status: 'succeeded', request: body, result: { model: body.model, candidates: [{ id: 'candidate-1', image, summary: '蓝色法师' }] } } });
  });
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toBeVisible();
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 素材生成' });
  await expect(dialog).toContainText('密钥未配置');
  await expect(page.getByRole('button', { name: '开始生成', exact: true })).toBeDisabled();
  await page.getByLabel('AI API Key').fill('private-test-key');
  await expect(page.getByLabel('AI API Key')).toHaveAttribute('type', 'password');
  await page.getByLabel('AI 文本模型').fill('user-text-model');
  await page.getByLabel('AI 图像模型').fill('user-image-model');
  await page.getByRole('button', { name: '保存连接设置' }).click();
  await expect(page.getByLabel('AI API Key')).toHaveValue('');
  await expect(dialog).toContainText('密钥已配置');
  await page.getByLabel('AI 生成描述').fill('画一个蓝色像素法师');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.getByAltText('蓝色法师')).toBeVisible();
  await expect.poll(() => page.getByAltText('蓝色法师').evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  expect(generationBodies[0].mode).toBe('agent_draw');
  expect(generationBodies[0].model).toBe('user-text-model');
  expect(generationBodies[0]).not.toHaveProperty('apiKey');
  await page.getByRole('button', { name: '图像模型生成', exact: true }).click();
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  expect(generationBodies[1].mode).toBe('image_model');
  expect(generationBodies[1].model).toBe('user-image-model');
  const privateBrowserData = await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`);
  expect(privateBrowserData).not.toContain('private-test-key');
  await page.screenshot({ path: '/tmp/pixelarting-ai-desktop.png', fullPage: true });

  const projectId = generationBodies[1].projectId;
  await page.route('**/api/ai/generations/generation-2/select', async route => {
    expect(route.request().postDataJSON()).toMatchObject({ candidateId: 'candidate-1', projectId });
    const response = await request.post(`/api/projects/${projectId}/assets/blank`, { data: { name: 'AI 候选导入', width: 2, height: 2 } });
    await route.fulfill({ json: { asset: await response.json() } });
  });
  await page.getByRole('button', { name: '选择并导入', exact: true }).click();
  await expect(dialog).toContainText('候选已导入为新素材');
  await page.getByRole('button', { name: '关闭 AI 生成' }).click();
  await expect(page.locator('.document-bar')).toContainText('AI 候选导入');
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  await page.locator('.ai-settings > summary').click();
  await page.getByRole('button', { name: '删除已保存 API Key', exact: true }).click();
  await expect(dialog).toContainText('密钥未配置');
  await expect(page.getByRole('button', { name: '开始生成', exact: true })).toBeDisabled();
});

test('AI failed tasks can retry and queued tasks can cancel on a mobile viewport', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/ai/config', route => route.fulfill({ json: configured }));
  await page.route('**/api/ai/generations*', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    calls += 1;
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { id: 'retry-task', mode: body.mode, projectId: body.projectId, request: body, status: calls === 1 ? 'failed' : 'queued', error: calls === 1 ? '服务暂时不可用' : undefined } });
  });
  await page.route('**/api/ai/generations/retry-task/cancel', route => route.fulfill({ json: { id: 'retry-task', mode: 'agent_draw', status: 'cancelled' } }));
  await page.route('**/api/ai/generations/retry-task/retry', route => route.fulfill({ json: { id: 'retry-task', mode: 'agent_draw', status: 'queued' } }));
  await page.route('**/api/ai/generations/retry-task', route => route.fulfill({ json: { id: 'retry-task', mode: 'agent_draw', status: 'running' } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'AI 生成', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  await page.getByLabel('AI 生成描述').fill('画一把剑');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.getByLabel('AI 生成状态')).toContainText('服务暂时不可用');
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(page.getByRole('button', { name: '像素工具绘制', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByLabel('AI 生成状态')).toContainText('已取消');
  await expect(page.getByRole('button', { name: '重新生成', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const bounds = await page.getByRole('dialog', { name: 'AI 素材生成' }).boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/pixelarting-ai-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '重试原任务', exact: true }).click();
  await expect(page.getByLabel('AI 生成状态')).toContainText('排队中');
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('AI polling recovers from a temporary error and candidate selection respects draft cancellation', async ({ page }) => {
  let polls = 0;
  let selections = 0;
  await page.route('**/api/ai/config', route => route.fulfill({ json: configured }));
  await page.route('**/api/ai/generations*', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    return route.fulfill({ json: { id: 'poll-task', mode: 'agent_draw', status: 'queued' } });
  });
  await page.route('**/api/ai/generations/poll-task', async route => {
    polls += 1;
    if (polls === 1) return route.fulfill({ status: 503, json: { detail: '临时连接错误' } });
    return route.fulfill({ json: { id: 'poll-task', mode: 'agent_draw', status: 'succeeded', result: { candidates: [{ id: 'pick-1', image, summary: '可导入候选' }] } } });
  });
  await page.route('**/api/ai/generations/poll-task/select', async route => { selections += 1; await route.fulfill({ json: {} }); });
  await page.goto('/');
  const canvas = page.getByLabel('像素编辑画布');
  await expect(canvas).toBeVisible();
  await page.getByLabel('图层名称').fill('未保存的测试图层');
  await expect(page.locator('.draft-badge')).toBeVisible();
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  await page.getByLabel('AI 生成描述').fill('画一个道具');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.getByAltText('可导入候选')).toBeVisible();
  expect(polls).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.ai-notice.error')).toHaveCount(0);
  await page.getByRole('button', { name: '选择并导入', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '尚有未保存的修改' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'AI 素材生成' })).toBeVisible();
  expect(selections).toBe(0);
  await page.getByRole('button', { name: '关闭 AI 生成' }).click();
  await expect(page.locator('.draft-badge')).toBeVisible();
});

test('a delayed history response preserves new tasks and reopening refreshes old task state', async ({ page }) => {
  let releaseHistory: () => void = () => {};
  let historyCalls = 0;
  const blockedHistory = new Promise<void>(resolve => { releaseHistory = resolve; });
  const oldTask = { id: 'old-generation', mode: 'agent_draw', status: 'failed', error: '旧任务失败' };
  const newTask = { id: 'new-generation', mode: 'agent_draw', status: 'succeeded', result: { candidates: [{ id: 'new-candidate', image, summary: '最新生成候选' }] } };
  await page.route('**/api/ai/config', route => route.fulfill({ json: configured }));
  await page.route('**/api/ai/generations*', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ json: newTask });
    historyCalls += 1;
    if (historyCalls === 1) {
      await blockedHistory;
      return route.fulfill({ json: [oldTask] });
    }
    return route.fulfill({ json: [{ ...newTask, status: 'failed', error: '服务器已更新任务状态', result: undefined }, oldTask] });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'AI 生成', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  await page.getByLabel('AI 生成描述').fill('画一个新道具');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.getByAltText('最新生成候选')).toBeVisible();
  releaseHistory();
  const history = page.getByLabel('AI 生成记录');
  await expect(history.locator('option')).toHaveCount(2);
  await expect(history).toHaveValue('new-generation');
  await expect(history.locator('option[value="new-generation"]')).toContainText('已完成');
  await expect(page.getByAltText('最新生成候选')).toBeVisible();
  await page.getByRole('button', { name: '关闭 AI 生成' }).click();
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  await expect(history).toHaveValue('new-generation');
  await expect(history.locator('option[value="new-generation"]')).toContainText('失败');
  await expect(page.getByLabel('AI 生成状态')).toContainText('服务器已更新任务状态');
  await expect(page.getByAltText('最新生成候选')).toHaveCount(0);
});
