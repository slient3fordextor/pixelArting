const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const net = require('node:net');
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

test('desktop reuses its persisted backend port and starts safely if another service owns it', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'pixelart-desktop-port-'));
  const options = { root: path.resolve(__dirname, '..'), dataRoot };
  const unrelated = net.createServer(socket => socket.end());
  let backend;
  try {
    backend = await startBackend(options);
    const originalPort = backend.port;
    assert.equal(Number(await readFile(path.join(dataRoot, '.desktop-port'), 'utf8')), originalPort);
    await backend.stop();
    backend = await startBackend(options);
    assert.equal(backend.port, originalPort);
    await backend.stop();
    await new Promise((resolve, reject) => { unrelated.once('error', reject); unrelated.listen(originalPort, '127.0.0.1', resolve); });
    backend = await startBackend(options);
    assert.notEqual(backend.port, originalPort);
    assert.equal(unrelated.listening, true);
    assert.equal(Number(await readFile(path.join(dataRoot, '.desktop-port'), 'utf8')), backend.port);
  } finally {
    await backend?.stop();
    if (unrelated.listening) await new Promise(resolve => unrelated.close(resolve));
    await rm(dataRoot, { recursive: true, force: true });
  }
});
