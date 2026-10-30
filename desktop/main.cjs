const { app, BrowserWindow, dialog, Menu, net, protocol, screen } = require('electron');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { freePort, startBackend } = require('./backend.cjs');
const { DESKTOP_SCHEME, DESKTOP_URL, createProtocolHandler } = require('./protocol.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: DESKTOP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

app.setName('PixelArting');
if (process.env.PIXELART_DESKTOP_USER_DATA) app.setPath('userData', process.env.PIXELART_DESKTOP_USER_DATA);
const root = path.resolve(__dirname, '..');
let backend, frontendDev, mainWindow, closing = false, checkingClose = false;

async function startFrontendDev(root, backendUrl, port) {
  const command = path.join(root, 'frontend', 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
  const child = spawn(command, ['--host', '127.0.0.1', '--port', String(port)], {
    cwd: path.join(root, 'frontend'),
    windowsHide: true,
    env: { ...process.env, PIXELART_VITE_BACKEND_URL: backendUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const log = chunk => { logs = (logs + chunk.toString()).slice(-8192); };
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await delay(100).catch(() => {});
  };
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`启动前端开发服务器失败\n${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) return { child, port, origin: `http://127.0.0.1:${port}`, stop };
      } catch { /* Vite may still be starting. */ }
      await delay(100);
    }
    throw new Error(`等待前端开发服务器启动超时\n${logs}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

function command(name) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const dispatch = () => mainWindow.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('pixelart-command', { detail: ${JSON.stringify(name)} }))`).catch(() => {});
    if (name === 'copy' || name === 'cut' || name === 'paste') {
      mainWindow.webContents.executeJavaScript('Boolean(document.activeElement?.matches(\'input, textarea, select, [contenteditable="true"]\'))')
        .then(textEditing => {
          if (!textEditing) { dispatch(); return; }
          if (name === 'copy') mainWindow.webContents.copy();
          if (name === 'cut') mainWindow.webContents.cut();
          if (name === 'paste') mainWindow.webContents.paste();
        })
        .catch(dispatch);
      return;
    }
    dispatch();
  }
}

function menu() {
  return Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '新建项目', accelerator: 'CmdOrCtrl+Shift+N', click: () => command('new-project') },
      { label: '切换项目…', click: () => command('project-switcher') },
      { label: '项目设置', click: () => command('project-settings') },
      { type: 'separator' },
      { label: '素材库', accelerator: 'CmdOrCtrl+Shift+O', click: () => command('asset-library') },
      { label: '新建素材', accelerator: 'CmdOrCtrl+N', click: () => command('new-asset') },
      { label: '导入素材', accelerator: 'CmdOrCtrl+O', click: () => command('open') },
      { label: '保存版本', accelerator: 'CmdOrCtrl+S', click: () => command('save') },
      { type: 'separator' }, { label: '关闭窗口', accelerator: 'Alt+F4', click: () => mainWindow?.close() },
    ] },
    { label: '编辑', submenu: [
      { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => command('undo') },
      { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => command('redo') },
      { label: '重做（替代快捷键）', accelerator: 'CmdOrCtrl+Y', click: () => command('redo') }, { type: 'separator' },
      // Let the renderer route these keys between native text editing and canvas selection.
      { label: '剪切', accelerator: 'CmdOrCtrl+X', registerAccelerator: false, click: () => command('cut') },
      { label: '复制', accelerator: 'CmdOrCtrl+C', registerAccelerator: false, click: () => command('copy') },
      { label: '粘贴', accelerator: 'CmdOrCtrl+V', registerAccelerator: false, click: () => command('paste') },
      { role: 'selectAll', label: '全选', registerAccelerator: false },
    ] },
    { label: '工具', submenu: [
      { label: '铅笔', accelerator: 'B', registerAccelerator: false, click: () => command('tool:pencil') },
      { label: '橡皮', accelerator: 'E', registerAccelerator: false, click: () => command('tool:eraser') },
      { label: '取色器', accelerator: 'I', registerAccelerator: false, click: () => command('tool:eyedropper') },
      { label: '填充', accelerator: 'G', registerAccelerator: false, click: () => command('tool:fill') },
      { label: '直线', accelerator: 'L', registerAccelerator: false, click: () => command('tool:line') },
      { label: '矩形', accelerator: 'R', registerAccelerator: false, click: () => command('tool:rectangle') },
      { label: '椭圆', accelerator: 'O', registerAccelerator: false, click: () => command('tool:ellipse') },
      { label: '矩形选区', accelerator: 'M', registerAccelerator: false, click: () => command('tool:select') },
      { label: '移动画布', accelerator: 'H', registerAccelerator: false, click: () => command('tool:pan') },
      { label: '移动图层', accelerator: 'V', registerAccelerator: false, click: () => command('tool:move-layer') },
    ] },
    { label: '窗口', submenu: [
      ...Object.entries({ library: '素材', inspector: '检查器', tools: '工具栏', palette: '调色板', timeline: '时间轴' })
        .map(([id, label]) => ({ label, click: () => command(`panel:${id}`) })),
      { type: 'separator' }, { label: '恢复默认工作区', click: () => command('workspace:reset') },
      { type: 'separator' }, { role: 'minimize', label: '最小化' }, { role: 'togglefullscreen', label: '全屏' },
    ] },
  ]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    const devMode = process.env.PIXELART_DESKTOP_DEV === '1';
    if (!devMode && !existsSync(path.join(root, 'frontend/dist/index.html'))) throw new Error('请先运行 npm --prefix frontend run build。');
    const frontendPort = devMode ? await freePort() : undefined;
    backend = await startBackend({ root, frontendPort, dataRoot: process.env.PIXELART_DATA_DIR, portFile: path.join(app.getPath('userData'), 'backend-port'), onExit: error => {
      if (!closing) { dialog.showErrorBox('PixelArting 本地服务', error.message); mainWindow?.destroy(); }
    } });
    if (devMode) frontendDev = await startFrontendDev(root, backend.url, frontendPort);
    if (!devMode) protocol.handle(DESKTOP_SCHEME, createProtocolHandler(backend.url, (url, options) => net.fetch(url, options)));
    const area = screen.getPrimaryDisplay().workAreaSize;
    mainWindow = new BrowserWindow({
      title: 'PixelArting', width: Math.min(1440, area.width), height: Math.min(1000, area.height),
      minWidth: Math.min(1000, area.width), minHeight: Math.min(740, area.height),
      backgroundColor: '#f6f7f8', show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    Menu.setApplicationMenu(menu());
    mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    mainWindow.webContents.session.setPermissionCheckHandler(() => false);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('context-menu', (_event, params) => {
      if (!params.isEditable) return;
      Menu.buildFromTemplate([
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ]).popup({ window: mainWindow });
    });
    mainWindow.webContents.session.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: '导出素材', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      const target = new URL(url);
      const allowedDesktop = target.protocol === `${DESKTOP_SCHEME}:` && target.host === 'workbench';
      const allowedDev = devMode && target.origin === frontendDev.origin;
      if (!allowedDesktop && !allowedDev) event.preventDefault();
    });
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [devMode
          ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
          : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"],
      } });
    });
    mainWindow.webContents.on('will-prevent-unload', () => {
      if (checkingClose) return;
      const result = dialog.showMessageBoxSync(mainWindow, {
        type: 'question', title: '未保存的修改', message: '素材或项目配置尚未保存',
        buttons: ['继续编辑', '保存并关闭', '放弃并关闭'], defaultId: 0, cancelId: 0,
      });
      if (result !== 1 && result !== 2) return;
      checkingClose = true;
      const action = result === 1 ? 'save' : 'discard';
      mainWindow.webContents.executeJavaScript(`new Promise(resolve => window.dispatchEvent(new CustomEvent('pixelart-save-before-close', { detail: { action: ${JSON.stringify(action)}, resolve } })))`)
        .then(allowed => { if (allowed && !mainWindow.isDestroyed()) mainWindow.destroy(); })
        .catch(error => { if (!mainWindow.isDestroyed()) dialog.showErrorBox('保存失败', error.message); })
        .finally(() => { checkingClose = false; });
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    await mainWindow.loadURL(devMode ? frontendDev.origin : DESKTOP_URL);
  }).catch(async error => {
    dialog.showErrorBox('PixelArting 启动失败', error.message);
    closing = true;
    await frontendDev?.stop();
    await backend?.stop();
    app.quit();
  });

  app.on('window-all-closed', async () => {
    closing = true;
    await frontendDev?.stop();
    await backend?.stop();
    app.quit();
  });
  process.on('exit', () => backend?.child.kill());
}
