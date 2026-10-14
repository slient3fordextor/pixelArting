const DESKTOP_SCHEME = 'pixelart';
const DESKTOP_ORIGIN = `${DESKTOP_SCHEME}://workbench`;
const DESKTOP_URL = `${DESKTOP_ORIGIN}/`;

function createProtocolHandler(backendUrl, fetchRequest = fetch) {
  return async request => {
    const url = new URL(request.url);
    if (url.protocol !== `${DESKTOP_SCHEME}:` || url.host !== 'workbench') {
      return new Response('Not found', { status: 404 });
    }
    const headers = new Headers(request.headers);
    const origin = request.initiatorOrigin || headers.get('origin');
    if ((origin && origin !== DESKTOP_ORIGIN) || (!origin && !['GET', 'HEAD'].includes(request.method))) {
      return new Response('Forbidden', { status: 403 });
    }
    headers.delete('host');
    if (headers.has('origin')) headers.set('origin', backendUrl);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    return fetchRequest(`${backendUrl}${url.pathname}${url.search}`, { method: request.method, headers, body });
  };
}

module.exports = { DESKTOP_SCHEME, DESKTOP_ORIGIN, DESKTOP_URL, createProtocolHandler };
