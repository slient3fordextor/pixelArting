import { expect, test } from '@playwright/test';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8Dwn4GBgYGJAQoAHgQCAc8oUAAAAABJRU5ErkJggg==';
const configured = { baseUrl: 'https://ai.example.test/v1', textModel: 'text-example', imageModel: 'image-example', imageSize: '1024x1024', requestTimeoutSeconds: 120, hasApiKey: true };

async function mockLegacyProfiles(page: import('@playwright/test').Page) {
  await page.route('**/api/ai/profiles', route => route.fulfill({ status: 404, json: { detail: 'profiles unavailable' } }));
  await page.route('**/api/ai/profiles/**', route => route.fulfill({ status: 404, json: { detail: 'profiles unavailable' } }));
}

test('AI settings protect credentials and both modes display actual candidates', async ({ page, request }) => {
  await mockLegacyProfiles(page);
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
  const projectResponse = await request.post('/api/projects', { data: { name: 'AI 界面测试独立项目' } });
  expect(projectResponse.ok()).toBe(true);
  const isolatedProject = await projectResponse.json();
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(isolatedProject.id);
  await expect(page.getByLabel('项目', { exact: true })).toHaveValue(isolatedProject.id);
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
  await mockLegacyProfiles(page);
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
  await page.getByRole('button', { name: '重试原任务', exact: true }).click();
  await expect(page.getByLabel('AI 生成状态')).toContainText('排队中');
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('AI polling recovers from a temporary error and candidate selection respects draft cancellation', async ({ page }) => {
  await mockLegacyProfiles(page);
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
  await mockLegacyProfiles(page);
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

function profileFixture(id: string, name: string, textModel: string, imageModel: string, hasApiKey = true) {
  return { id, name, baseUrl: `https://${id}.example.test/v1`, textModel, imageModel, imageSize: '1024x1024', requestTimeoutSeconds: 120, maxOutputTokens: 8192, tokenLimitParameter: 'max_tokens', sendImageBackground: false, hasApiKey };
}

async function mockProfiles(page: import('@playwright/test').Page) {
  const profiles = [profileFixture('profile-a', 'OpenAI 主档案', 'text-a', 'image-a'), profileFixture('profile-b', '本地模型', 'text-b', 'image-b')];
  let activeId = profiles[0].id;
  let sequence = 0;
  await page.route('**/api/ai/profiles', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { profiles, activeId } });
    const body = route.request().postDataJSON();
    const next = profileFixture(`profile-new-${++sequence}`, body.name, body.textModel, body.imageModel, Boolean(body.apiKey));
    profiles.push({ ...next, ...body, hasApiKey: Boolean(body.apiKey) });
    delete (profiles.at(-1) as Record<string, unknown>).apiKey;
    return route.fulfill({ json: profiles.at(-1) });
  });
  await page.route('**/api/ai/profiles/**', async route => {
    const parts = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    if (parts.at(-1) === 'activate') {
      const activated = profiles.find(item => item.id === parts.at(-2));
      if (!activated) return route.fulfill({ status: 404, json: { detail: 'profile not found' } });
      activeId = activated!.id;
      return route.fulfill({ json: { activeId, profile: activated } });
    }
    const id = parts.at(-1)!;
    const profile = profiles.find(item => item.id === id);
    if (!profile) return route.fulfill({ status: 404, json: { detail: 'profile not found' } });
    if (route.request().method() === 'DELETE') {
      const index = profiles.findIndex(item => item.id === id);
      profiles.splice(index, 1);
      if (activeId === id) activeId = profiles[0].id;
      return route.fulfill({ json: { deleted: true, id, activeId, profile: profiles.find(item => item.id === activeId) } });
    }
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      Object.assign(profile, body);
      if (body.clearApiKey) profile.hasApiKey = false;
      if (body.apiKey) profile.hasApiKey = true;
      delete (profile as Record<string, unknown>).apiKey;
      return route.fulfill({ json: profile });
    }
    return route.fulfill({ status: 405, json: { detail: 'method not allowed' } });
  });
  return { profiles, get activeId() { return activeId; } };
}

async function selectProfile(page: import('@playwright/test').Page, profileName: string) {
  await page.getByRole('combobox', { name: 'AI 模型档案' }).click();
  await page.locator('[role="listbox"] [role="option"]', { hasText: profileName }).click();
}

test('AI model profiles switch text and image model requests', async ({ page, request }) => {
  await mockProfiles(page);
  const generationBodies: Record<string, unknown>[] = [];
  await page.route('**/api/ai/generations*', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    const body = route.request().postDataJSON(); generationBodies.push(body);
    return route.fulfill({ json: { id: `profile-generation-${generationBodies.length}`, mode: body.mode, status: 'succeeded', request: body, result: { model: body.model, candidates: [{ id: 'candidate', image, summary: '候选' }] } } });
  });
  const projectResponse = await request.post('/api/projects', { data: { name: 'AI 档案切换项目' } });
  const project = await projectResponse.json();
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  await page.locator('.ai-settings > summary').click();
  await expect(page.getByRole('combobox', { name: 'AI 模型档案' })).toContainText('OpenAI 主档案');
  await page.getByLabel('AI 生成描述').fill('档案 A 的像素角色');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  expect(generationBodies.at(-1)?.model).toBe('text-a');
  await selectProfile(page, '本地模型');
  await expect(page.getByLabel('AI 文本模型')).toHaveValue('text-b');
  await expect(page.getByLabel('AI 图像模型')).toHaveValue('image-b');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  expect(generationBodies.at(-1)?.model).toBe('text-b');
  await page.getByRole('button', { name: '图像模型生成', exact: true }).click();
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  expect(generationBodies.at(-1)?.model).toBe('image-b');
});

test('AI model profiles create and delete the current profile', async ({ page, request }) => {
  await mockProfiles(page);
  await page.route('**/api/ai/generations*', route => route.fulfill({ json: [] }));
  page.on('dialog', dialog => dialog.accept());
  const projectResponse = await request.post('/api/projects', { data: { name: 'AI 档案保护项目' } });
  const project = await projectResponse.json();
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  await page.locator('.ai-settings > summary').click();
  await page.getByLabel('AI 档案名称').fill('备用服务');
  await page.getByRole('button', { name: '新建模型档案' }).click();
  await page.getByRole('combobox', { name: 'AI 模型档案' }).click();
  await expect(page.locator('[role="listbox"] [role="option"]')).toHaveCount(3);
  await page.keyboard.press('Escape');
  const deleteCurrent = page.getByRole('button', { name: '删除当前模型档案“OpenAI 主档案”' });
  await expect(deleteCurrent).toBeVisible();
  await expect(deleteCurrent).toBeEnabled();
  await deleteCurrent.click();
  await expect(page.getByRole('combobox', { name: 'AI 模型档案' })).toContainText('本地模型');
  await page.getByRole('combobox', { name: 'AI 模型档案' }).click();
  await expect(page.locator('[role="listbox"] [role="option"]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  const deleteSecond = page.getByRole('button', { name: '删除当前模型档案“本地模型”' });
  await expect(deleteSecond).toBeEnabled();
  await deleteSecond.click();
  await page.getByRole('combobox', { name: 'AI 模型档案' }).click();
  await expect(page.locator('[role="listbox"] [role="option"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '删除当前模型档案（至少保留一个，暂不可删除）' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除当前模型档案（至少保留一个，暂不可删除）' })).toHaveAttribute('title', '至少保留一个模型档案，当前档案不可删除');
});

test('AI model profile API key clearing stays scoped to the active profile', async ({ page, request }) => {
  const fixture = await mockProfiles(page);
  await page.route('**/api/ai/generations*', route => route.fulfill({ json: [] }));
  const projectResponse = await request.post('/api/projects', { data: { name: 'AI 档案密钥项目' } });
  const project = await projectResponse.json();
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  await page.locator('.ai-settings > summary').click();
  await page.getByRole('button', { name: '删除已保存 API Key' }).click();
  await expect(page.locator('.ai-settings')).toContainText('密钥未配置');
  await selectProfile(page, '本地模型');
  await expect(page.locator('.ai-settings')).toContainText('密钥已配置');
  expect(fixture.profiles.find(profile => profile.id === 'profile-a')?.hasApiKey).toBe(false);
  expect(fixture.profiles.find(profile => profile.id === 'profile-b')?.hasApiKey).toBe(true);
});

test('AI model profile controls remain within a mobile viewport', async ({ page, request }) => {
  await mockProfiles(page);
  await page.route('**/api/ai/generations*', route => route.fulfill({ json: [] }));
  const projectResponse = await request.post('/api/projects', { data: { name: 'AI 档案移动端项目' } });
  const project = await projectResponse.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('项目', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
  await page.locator('.ai-settings > summary').click();
  await expect(page.getByLabel('AI 模型档案')).toBeVisible();
  expect(await page.locator('.ai-modal').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect((await page.getByRole('dialog', { name: 'AI 素材生成' }).boundingBox())!.width).toBeLessThanOrEqual(390);
});
