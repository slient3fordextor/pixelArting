const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canReadClipboard } = require('./permissions.cjs');

const owner = { getURL: () => 'pixelart://workbench/', isDestroyed: () => false };
const main = { isMainFrame: true, requestingUrl: 'pixelart://workbench/' };
test('only the workbench main frame can read system images', () => {
  assert.equal(canReadClipboard(owner, 'clipboard-read', 'pixelart://workbench', main, owner), true);
  for (const permission of ['media', 'fileSystem', 'clipboard-sanitized-write', 'unknown']) {
    assert.equal(canReadClipboard(owner, permission, 'pixelart://workbench', main, owner), false);
  }
  assert.equal(canReadClipboard(owner, 'clipboard-read', 'https://example.invalid', main, owner), false);
  assert.equal(canReadClipboard(owner, 'clipboard-read', 'pixelart://workbench', { ...main, isMainFrame: false }, owner), false);
  assert.equal(canReadClipboard(null, 'clipboard-read', 'pixelart://workbench', main, owner), false);
  assert.equal(canReadClipboard(owner, 'clipboard-read', 'pixelart://workbench.evil', main, owner), false);
  assert.equal(canReadClipboard(owner, 'clipboard-read', 'pixelart://evil@workbench', main, owner), false);
});
test('development clipboard permission is limited to the selected Vite origin', () => {
  const dev = { ...owner, getURL: () => 'http://127.0.0.1:12345/' };
  const details = { isMainFrame: true };
  assert.equal(canReadClipboard(dev, 'clipboard-read', dev.getURL(), details, dev, 'http://127.0.0.1:12345'), true);
  assert.equal(canReadClipboard(dev, 'clipboard-read', 'http://127.0.0.1:12346', details, dev, 'http://127.0.0.1:12345'), false);
  assert.equal(canReadClipboard(dev, 'clipboard-read', dev.getURL(), details, dev), false);
});
