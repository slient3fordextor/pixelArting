function trustedOrigin(value, devOrigin) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'pixelart:' && url.host === 'workbench') return true;
    return Boolean(devOrigin && url.origin === devOrigin);
  } catch { return false; }
}

function canReadClipboard(contents, permission, requestingOrigin, details, owner, devOrigin) {
  return permission === 'clipboard-read'
    && contents === owner && Boolean(owner) && !owner.isDestroyed()
    && details?.isMainFrame === true
    && trustedOrigin(requestingOrigin || details.requestingUrl, devOrigin)
    && trustedOrigin(owner.getURL(), devOrigin);
}

module.exports = { canReadClipboard };
