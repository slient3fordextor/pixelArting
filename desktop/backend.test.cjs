const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startBackend } = require('./backend.cjs');

test('desktop owns a private backend and stops it without touching unrelated services', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'pixelart-desktop-test-'));
  let backend;
  try {
    backend = await startBackend({ root: path.resolve(__dirname, '..'), dataRoot });
    const health = await fetch(`${backend.url}/api/health`).then(response => response.json());
    assert.equal(health.status, 'ok');
    const response = await fetch(`${backend.url}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: backend.url }, body: JSON.stringify({ name: '桌面测试' }),
    });
    assert.equal(response.status, 201);
    const blocked = await fetch(`${backend.url}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' }, body: JSON.stringify({ name: '外部请求' }),
    });
    assert.equal(blocked.status, 403);
    await backend.stop();
    await assert.rejects(fetch(`${backend.url}/api/health`));
  } finally {
    await backend?.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('missing Python fails with installation guidance', async () => {
  await assert.rejects(startBackend({ root: os.tmpdir(), python: path.join(os.tmpdir(), 'missing-pixelart-python') }), /Python/);
});
