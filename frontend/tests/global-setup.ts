import { request } from '@playwright/test';
import type { FullConfig } from '@playwright/test';

export default async function setup(config: FullConfig) {
  const client = await request.newContext({ baseURL: config.projects[0].use.baseURL });
  try {
    const response = await client.post('/api/demo');
    if (!response.ok()) throw new Error(`初始化测试素材失败 (${response.status()})`);
  } finally { await client.dispose(); }
}
