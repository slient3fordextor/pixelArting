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

test('private backend shuts down when its owner pipe closes', { timeout: 20000 }, async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'pixelart-desktop-owner-'));
  let backend;
  try {
    backend = await startBackend({ root: path.resolve(__dirname, '..'), dataRoot });
    const exited = new Promise(resolve => backend.child.once('exit', resolve));
    backend.child.stdin.end();
    await exited;
    await assert.rejects(fetch(`${backend.url}/api/health`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    await backend?.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('killing the owner process cannot leave the private API listening', { timeout: 25000 }, async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { setTimeout: delay } = require('node:timers/promises');
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'pixelart-desktop-crash-'));
  const owner = spawn(process.execPath, ['-e', `
    const {startBackend} = require(process.argv[1]);
    startBackend({root:process.argv[2], dataRoot:process.argv[3]}).then(backend => {
      console.log(JSON.stringify({url:backend.url,pid:backend.child.pid}));
    }).catch(error => {console.error(error);process.exit(1)});
  `, path.resolve(__dirname, 'backend.cjs'), path.resolve(__dirname, '..'), dataRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  let backend;
  try {
    const line = await new Promise((resolve, reject) => {
      let output = '';
      owner.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) resolve(output.split('\n')[0]);
      });
      owner.once('error', reject);
      owner.once('exit', () => reject(new Error('Owner exited before reporting its backend')));
    });
    backend = JSON.parse(line);
    const exited = once(owner, 'exit');
    owner.kill('SIGKILL');
    await exited;
    let listening = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fetch(`${backend.url}/api/health`, { signal: AbortSignal.timeout(1000) }); }
      catch { listening = false; break; }
      await delay(100);
    }
    assert.equal(listening, false, 'backend survived its owner');
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    // Only the process explicitly created by this test may be cleaned up.
    if (backend) { try { process.kill(backend.pid, 'SIGKILL'); } catch {} }
    await rm(dataRoot, { recursive: true, force: true });
  }
});
