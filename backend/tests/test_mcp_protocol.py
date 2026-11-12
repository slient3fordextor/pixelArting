"""Real JSON-RPC clients: transport discovery, structured output and binary resources."""

import asyncio
import base64
from contextlib import contextmanager
from datetime import timedelta
import json
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

REPO = Path(__file__).resolve().parents[2]


def arguments(root, *extra):
    return ['-m', 'backend.mcp_cli', '--data-dir', str(root), *extra]


async def assert_workflow(session, writable):
    initialized = await session.initialize()
    assert initialized.serverInfo.name == 'pixelarting'
    tools = {tool.name: tool for tool in (await session.list_tools()).tools}
    assert tools['export_asset'].outputSchema
    caps = await session.call_tool('get_capabilities')
    assert caps.structuredContent['contractVersion'] == '1'
    assert caps.structuredContent['writeEnabled'] is writable
    permissions = (await session.call_tool('get_permissions')).structuredContent
    assert permissions['authentication'] == 'local-process-only'
    assert permissions['effectiveOAuthScopes'] == []
    assert permissions['processWriteEnabled'] is writable
    assert permissions['tools']['rename_asset']['writeGateAllowed'] is writable
    assert set(permissions['tools']) == set(tools)
    for name, tool in tools.items():
        assert tool.meta['pixelarting/authorization']['requiredOAuthScopes'] == permissions['tools'][name]['requiredOAuthScopes']
    permission_contract = await session.read_resource('pixelart://contract/permissions/v1')
    assert set(json.loads(permission_contract.contents[0].text)['tools']) == set(tools)
    contract = await session.read_resource('pixelart://contract/v1')
    assert json.loads(contract.contents[0].text)['capabilities'] == caps.structuredContent
    created = await session.call_tool('create_project', {'name': 'protocol test', 'idempotency_key': 'protocol-project'})
    if not writable:
        assert created.structuredContent['code'] == 'permission_denied'
        return
    project = created.structuredContent
    assert (await session.call_tool('create_project', {'name': 'protocol test', 'idempotency_key': 'protocol-project'})).structuredContent == project
    asset_args = {'project_id': project['id'], 'name': 'sprite', 'width': 8, 'height': 8, 'idempotency_key': 'protocol-asset'}
    asset = (await session.call_tool('create_blank_asset', asset_args)).structuredContent
    assert (await session.call_tool('create_blank_asset', asset_args)).structuredContent == asset
    asset = (await session.call_tool('get_asset', {'asset_id': asset['id'], 'include_document': True})).structuredContent
    rename_args = {'asset_id': asset['id'], 'expected_current_version_id': asset['currentVersionId'], 'name': 'renamed once', 'idempotency_key': 'protocol-rename'}
    asset = (await session.call_tool('rename_asset', rename_args)).structuredContent
    assert (await session.call_tool('rename_asset', rename_args)).structuredContent == asset
    report = (await session.call_tool('inspect_asset', {'asset_id': asset['id']})).structuredContent
    assert report['versionId'] == asset['currentVersionId']
    exported = await session.call_tool('export_asset', {'asset_id': asset['id'], 'version_id': asset['currentVersionId']})
    descriptor = exported.structuredContent['result']
    assert descriptor['ok'] is True
    result = await session.read_resource(descriptor['resourceUri'])
    assert result.contents[0].mimeType == 'image/png'
    png = base64.b64decode(result.contents[0].blob)
    assert png.startswith(b'\x89PNG\r\n\x1a\n')
    assert len(png) == descriptor['byteLength']
    imported_args = {'project_id': project['id'], 'data_base64': base64.b64encode(png).decode('ascii')}
    preview = (await session.call_tool('preview_file_import', imported_args)).structuredContent
    assert preview['ok'] and preview['frames'][0]['width'] == 8
    imported = (await session.call_tool('import_asset_file', {**imported_args, 'idempotency_key': 'protocol-file'})).structuredContent
    assert imported['ok'] and not imported['replayed']
    repeated = (await session.call_tool('import_asset_file', {**imported_args, 'idempotency_key': 'protocol-file'})).structuredContent
    assert repeated['replayed'] and repeated['assetId'] == imported['assetId']
    checked = (await session.call_tool('inspect_asset', {'asset_id': imported['assetId']})).structuredContent
    assert checked['versionId'] == imported['versionId']
    # Exercise the advertised transfer limit over the real transport rather
    # than only calling the Python adapter with tiny fixtures. Invalid PNG
    # bytes must reach sanitized business validation without killing the pipe.
    for byte_length in (caps.structuredContent['maxImportBytes'], caps.structuredContent['maxImportBytes'] + 1):
        invalid = await session.call_tool('import_asset_file', {
            'project_id': project['id'], 'data_base64': base64.b64encode(b'x' * byte_length).decode('ascii'),
            'idempotency_key': 'protocol-boundary',
        })
        assert invalid.structuredContent['code'] == 'invalid_input'
    from backend.exchange import export_project
    from backend.models import CheckConfig, Document
    original = (await session.call_tool('get_asset', {'asset_id': asset['id'], 'include_document': True})).structuredContent
    config = (await session.call_tool('get_project_config', {'project_id': project['id']})).structuredContent
    archive = export_project({'name': 'protocol backup', 'config': CheckConfig.model_validate(config),
                              'assets': [{'id': asset['id'], 'currentVersionId': asset['currentVersionId'], 'document': Document.model_validate(original['document'])}]})
    backup_args = {'data_base64': base64.b64encode(archive).decode('ascii')}
    backup_preview = (await session.call_tool('preview_project_import', backup_args)).structuredContent
    assert backup_preview['ok'] and len(backup_preview['assets']) == 1
    backup_args['idempotency_key'] = 'protocol-project'
    restored = (await session.call_tool('import_project_backup', backup_args)).structuredContent
    assert restored['ok'] and restored['project']['id'] != project['id']
    again = (await session.call_tool('import_project_backup', backup_args)).structuredContent
    assert again['replayed'] and again['project'] == restored['project']
    checked = (await session.call_tool('inspect_asset', {'asset_id': restored['assets'][0]['assetId']})).structuredContent
    assert checked['versionId'] == restored['assets'][0]['versionId']


@pytest.mark.parametrize('writable', [False, True])
def test_stdio_protocol(tmp_path, writable):
    async def run():
        params = StdioServerParameters(
            command=sys.executable,
            args=arguments(tmp_path / 'workspace', '--allow-write' if writable else '--read-only'),
            cwd=str(tmp_path),
            env={'PYTHONPATH': str(REPO)},
        )
        with (tmp_path / 'stdio.log').open('w') as log:
            async with stdio_client(params, errlog=log) as (read, write):
                async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=10)) as session:
                    await assert_workflow(session, writable)
    asyncio.run(run())


@contextmanager
def http_server(tmp_path, writable, extra_args=()):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    with (tmp_path / 'http.log').open('w+') as log:
        child = subprocess.Popen([
            sys.executable, *arguments(tmp_path / 'workspace', '--transport', 'streamable-http', '--port', str(port), '--allow-write' if writable else '--read-only', *extra_args),
        ], cwd=REPO, stdout=subprocess.DEVNULL, stderr=log)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    log.seek(0)
                    pytest.fail(log.read())
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                        break
                except OSError:
                    time.sleep(0.05)
            else:
                pytest.fail('MCP HTTP server startup timed out')
            yield f'http://127.0.0.1:{port}/mcp'
        finally:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)


@pytest.mark.parametrize('writable', [False, True])
def test_streamable_http_protocol(tmp_path, writable):
    with http_server(tmp_path, writable) as url:
        async def run():
            async with httpx.AsyncClient(trust_env=False) as http:
                async with streamable_http_client(url, http_client=http) as (read, write, _):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=10)) as session:
                        await assert_workflow(session, writable)
        asyncio.run(run())


@pytest.fixture
def ai_workspace(tmp_path, monkeypatch):
    """An actual HTTP provider endpoint restricted to local, deterministic fixtures."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading
    from backend.models import AiConfigUpdate
    from backend.store import Store

    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        monkeypatch.delenv(name, raising=False)
    calls = []
    secret = 'sk-protocol-test-only'

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            assert self.headers['Authorization'] == 'Bearer ' + secret
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append(payload)
            content = {'candidates': [{'id': 'one', 'summary': 'red pixel', 'commands': [
                {'tool': 'create_canvas', 'args': {'width': 8, 'height': 8}},
                {'tool': 'draw_rect', 'args': {'x': 1, 'y': 1, 'width': 1, 'height': 1, 'color': '#FF0000'}},
            ]}]}
            data = json.dumps({'choices': [{'message': {'content': json.dumps(content)}}]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    store = Store(tmp_path / 'workspace')
    store.save_ai_config(AiConfigUpdate(apiKey=secret, baseUrl=f'http://127.0.0.1:{server.server_port}/v1'))
    try:
        yield store, calls, secret
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


async def assert_ai_workflow(session, secret):
    await session.initialize()

    async def call(name, arguments):
        result = await session.call_tool(name, arguments)
        assert not result.isError, result
        assert secret not in result.model_dump_json()
        return result.structuredContent.get('result', result.structuredContent)

    project = await call('create_project', {'name': 'AI MCP workflow'})
    arguments = {'request': {'projectId': project['id'], 'mode': 'agent_draw', 'prompt': 'red icon', 'width': 8, 'height': 8}, 'idempotency_key': 'generate-one'}
    started = await call('start_generation', arguments)
    assert started['ok'], started
    assert (await call('start_generation', arguments))['id'] == started['id']
    conflict = await call('start_generation', {**arguments, 'request': {**arguments['request'], 'prompt': 'different'}})
    assert conflict['code'] == 'idempotency_conflict'
    for _ in range(150):
        task = await call('get_generation', {'generation_id': started['id']})
        if task['status'] not in {'queued', 'running'}:
            break
        await asyncio.sleep(0.02)
    assert task['status'] == 'succeeded', task
    assert task['revision'] >= 2
    assert 'document' not in task['candidates'][0]
    snapshot = await session.read_resource(task['resourceUri'])
    assert json.loads(snapshot.contents[0].text) == task
    preview = await session.read_resource(task['candidates'][0]['previewResourceUri'])
    assert base64.b64decode(preview.contents[0].blob).startswith(b'\x89PNG')
    image = await session.call_tool('get_candidate_preview', {'generation_id': task['id'], 'candidate_id': 'one'})
    assert image.content[0].type == 'image'
    state = await call('update_candidate_state', {'generation_id': task['id'], 'candidate_id': 'one', 'state': {'discarded': True}})
    assert state['revision'] > task['revision']
    selection = {'generation_id': task['id'], 'candidate_id': 'one'}
    assert (await call('import_generation_candidate', selection))['code'] == 'version_conflict'
    await call('update_candidate_state', {'generation_id': task['id'], 'candidate_id': 'one', 'state': {'favorite': True}})
    imported = await call('import_generation_candidate', selection)
    assert imported['ok'], imported
    assert (await call('import_generation_candidate', selection))['assetId'] == imported['assetId']
    asset = await call('get_asset', {'asset_id': imported['assetId'], 'include_document': True})
    assert asset['document']['provenance']['generationId'] == task['id']
    report = await call('inspect_asset', {'asset_id': imported['assetId']})
    assert report['versionId'] == imported['currentVersionId']
    preview = await call('preview_asset_repair', {'asset_id': asset['id'], 'version_id': asset['currentVersionId'], 'actions': [{'id': 'resize-nearest-v1'}]})
    assert preview['changes'][0]['after'] == [64, 64]
    assert preview['report']['findings'] == []
    current = await call('get_asset', {'asset_id': asset['id'], 'include_document': True})
    repaired = await call('commit_asset_repair', {'asset_id': asset['id'], 'preview_id': preview['previewId'], 'expected_current_version_id': current['currentVersionId']})
    inspected = await call('inspect_asset', {'asset_id': asset['id']})
    assert inspected['report']['findings'] == []
    assert inspected['versionId'] == repaired['resultVersionId']
    exported = await call('export_asset', {'asset_id': imported['assetId'], 'version_id': repaired['resultVersionId']})
    result = await session.read_resource(exported['resourceUri'])
    assert len(base64.b64decode(result.contents[0].blob)) == exported['byteLength']
    assert (await call('retry_generation', {'generation_id': task['id'], 'idempotency_key': 'no-repeat-success'}))['code'] == 'version_conflict'


@pytest.mark.parametrize('transport', ['stdio', 'streamable-http'])
def test_ai_workflow_over_real_transport(tmp_path, ai_workspace, transport):
    store, calls, secret = ai_workspace

    async def stdio_run():
        params = StdioServerParameters(command=sys.executable, args=arguments(store.root, '--allow-write'), cwd=str(REPO))
        with (tmp_path / 'ai-stdio.log').open('w') as log:
            async with stdio_client(params, errlog=log) as (read, write):
                async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=10)) as session:
                    await assert_ai_workflow(session, secret)

    if transport == 'stdio':
        asyncio.run(stdio_run())
    else:
        with http_server(tmp_path, True) as url:
            async def http_run():
                async with httpx.AsyncClient(trust_env=False) as http:
                    async with streamable_http_client(url, http_client=http) as (read, write, _):
                        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=10)) as session:
                            await assert_ai_workflow(session, secret)
            asyncio.run(http_run())
    assert len(calls) == 1
    assert len(store.list_assets(store.list_projects()[0]['id'])) == 1
