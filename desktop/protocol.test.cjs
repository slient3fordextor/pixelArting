const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DESKTOP_URL, DESKTOP_ORIGIN, createProtocolHandler } = require('./protocol.cjs');

test('stable desktop origin forwards relative resources and API writes to the private backend', async () => {
  let forwarded;
  const proxy = createProtocolHandler('http://127.0.0.1:12345', async (url, options) => {
    forwarded = { url, options };
    return new Response('saved', { status: 201 });
  });
  const request = new Request(`${DESKTOP_URL}api/projects?name=test`, {
    method: 'POST', headers: { Origin: DESKTOP_ORIGIN, 'Content-Type': 'application/json' }, body: '{"name":"desktop"}',
  });
  const response = await proxy(request);
  assert.equal(response.status, 201);
  assert.equal(forwarded.url, 'http://127.0.0.1:12345/api/projects?name=test');
  assert.equal(forwarded.options.headers.get('origin'), 'http://127.0.0.1:12345');
  assert.equal(new TextDecoder().decode(forwarded.options.body), '{"name":"desktop"}');
});

test('desktop protocol rejects other hosts and external write origins before forwarding', async () => {
  let calls = 0;
  const proxy = createProtocolHandler('http://127.0.0.1:12345', async () => { calls++; return new Response('ok'); });
  assert.equal((await proxy(new Request('pixelart://other/api/projects'))).status, 404);
  assert.equal((await proxy(new Request(`${DESKTOP_URL}api/projects`, { method: 'POST', headers: { Origin: 'https://example.invalid' } }))).status, 403);
  assert.equal((await proxy(new Request(`${DESKTOP_URL}api/projects`, { method: 'POST' }))).status, 403);
  assert.equal(calls, 0);
});
