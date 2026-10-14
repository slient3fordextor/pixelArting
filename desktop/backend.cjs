const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function readPersistedPort(portFile) {
  if (!portFile) return null;
  try { return validPort(readFileSync(portFile, 'utf8').trim()); } catch { return null; }
}

function persistPort(portFile, port) {
  if (!portFile) return;
  mkdirSync(path.dirname(portFile), { recursive: true });
  writeFileSync(portFile, `${port}\n`, 'utf8');
}

async function portAvailable(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise(resolve => server.close(() => resolve()));
  }
}

async function startBackend({ root, python, dataRoot, portFile, onExit = () => {} }) {
  python ||= process.env.PIXELART_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) throw new Error('找不到 Python 虚拟环境，请先按 README 安装后端依赖，或设置 PIXELART_PYTHON。');
  const persistedPortFile = portFile || (dataRoot ? path.join(dataRoot, '.desktop-port') : null);
  let port = readPersistedPort(persistedPortFile);
  if (!port || !(await portAvailable(port))) port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(python, ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, PIXELART_DESKTOP_PORT: String(port), ...(dataRoot ? { PIXELART_DATA_DIR: dataRoot } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '', stopped = false, ready = false, spawnError;
  const log = chunk => { logs = (logs + chunk.toString()).slice(-8192); };
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  child.on('error', error => { spawnError = error; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    resolve();
    if (ready && !stopped) onExit(new Error(`本地服务已退出 (${code ?? signal})\n${logs}`));
  }));
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null || spawnError) return;
    child.kill();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`启动本地服务失败\n${logs}`);
      let response, body;
      try {
        response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
        body = await response.json();
      } catch { /* The service may still be importing Python modules. */ }
      if (response?.ok && body?.mode === 'local-single-user' && body.schemaVersion === '1.1') {
        persistPort(persistedPortFile, port);
        ready = true;
        return { url, port, child, stop };
      }
      await delay(100);
    }
    throw new Error(`等待本地服务启动超时\n${logs}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

module.exports = { startBackend };
