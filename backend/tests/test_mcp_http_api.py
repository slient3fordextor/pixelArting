"""HTTP/OpenAPI parity, project security and actual independent server workflows."""

import asyncio
import base64
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import httpx
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate
from PIL import Image
import pytest

from backend.mcp_http_api import APIFailure, ENDPOINTS
from backend.mcp_auth import READ, WRITE, GENERATE, ADMIN
from backend.mcp_policy import AuditUnavailable
from backend.mcp_server import create_mcp_server
from backend.store import Store
from backend.tests.test_mcp_protocol import ai_workspace, http_server
from backend.tests.test_mcp_security import authenticated, call, environment, signing_key
from backend.tests.test_mcp_permissions import EXPECTED_SCOPES
from scripts.mcp_test_fixtures import project_backup_fixture

BASE = 'http://127.0.0.1:8765'
REPO = Path(__file__).resolve().parents[2]


def client_for(server, **options):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=server.streamable_http_app()), base_url=BASE, **options)


def validate_response(spec, operation_id, response):
    operation = next(operation for path in spec['paths'].values() for operation in path.values()
                     if operation['operationId'] == operation_id)
    content = operation['responses'][str(response.status_code)]['content']
    mime = response.headers['content-type'].split(';')[0]
    assert mime in content
    if mime == 'application/json':
        schema = {**content[mime]['schema'], 'components': spec['components']}
        Draft202012Validator(schema).validate(response.json())
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'


async def request(client, spec, operation, method, path, *, status=200, **options):
    response = await client.request(method, '/api/v1' + path, **options)
    assert response.status_code == status, response.text[:400]
    validate_response(spec, operation, response)
    return response.json() if response.headers['content-type'].startswith('application/json') else response.content


def test_openapi_covers_actual_routes_parameters_metadata_and_all_refs_without_store(tmp_path):
    server = create_mcp_server(tmp_path / 'unused')
    spec = asyncio.run(server.openapi())
    validate(spec)
    catalog = {tool.name: tool for tool in asyncio.run(server.list_tools())}
    operations = [operation for path in spec['paths'].values() for operation in path.values()]
    assert {operation['operationId'] for operation in operations} == set(catalog) | {'read_workspace_resource', 'get_workspace_openapi'}
    assert len(operations) == 34 and spec['security'] == []
    def refs(value):
        if isinstance(value, list):
            for item in value: refs(item)
        if isinstance(value, dict):
            if '$ref' in value:
                assert value['$ref'].startswith('#/components/schemas/')
                target = spec
                for part in value['$ref'][2:].split('/'):
                    target = target[part.replace('~1', '/').replace('~0', '~')]
            for item in value.values(): refs(item)
    refs(spec)
    for endpoint in ENDPOINTS:
        operation = spec['paths']['/api/v1' + endpoint.path][endpoint.method.lower()]
        assert operation['x-pixelarting-authorization'] == catalog[endpoint.tool].meta['pixelarting/authorization']
        if not catalog[endpoint.tool].annotations.readOnlyHint:
            assert endpoint.method != 'GET'
            assert operation['x-pixelarting-idempotency'] == catalog[endpoint.tool].meta['pixelarting/idempotency']
    assert not (tmp_path / 'unused').exists()
    env = {**os.environ, 'PYTHONPATH': str(REPO)}
    output = subprocess.run([sys.executable, '-m', 'backend.mcp_cli', '--openapi', '--data-dir', str(tmp_path / 'unused')],
                            cwd=tmp_path, env=env, check=True, capture_output=True, text=True, timeout=20)
    assert json.loads(output.stdout) == spec
    assert not (tmp_path / 'unused').exists()


def test_http_full_asset_import_repair_export_workflow_matches_openapi(tmp_path):
    async def run():
        server = create_mcp_server(tmp_path / 'workspace', allow_write=True)
        spec = await server.openapi()
        async with client_for(server) as client:
            await request(client, spec, 'get_workspace_openapi', 'GET', '/openapi.json')
            await request(client, spec, 'get_capabilities', 'GET', '/capabilities')
            await request(client, spec, 'get_permissions', 'GET', '/permissions')
            await request(client, spec, 'pixelart_health', 'GET', '/health')
            body = {'name': 'HTTP fixture', 'idempotency_key': 'project'}
            project = await request(client, spec, 'create_project', 'POST', '/projects', json=body)
            assert await request(client, spec, 'create_project', 'POST', '/projects', json=body) == project
            assert (await server.call_tool('create_project', body))[1] == project
            assert len((await request(client, spec, 'list_projects', 'GET', '/projects'))['result']) == 1
            project_path = '/projects/' + project['id']
            config = await request(client, spec, 'update_project_config', 'PUT', project_path + '/config',
                                   json={'config': {'targetWidth': 16, 'targetHeight': 16}, 'idempotency_key': 'config'})
            assert await request(client, spec, 'get_project_config', 'GET', project_path + '/config') == config
            asset = await request(client, spec, 'create_blank_asset', 'POST', project_path + '/assets/blank',
                                  json={'name': 'sprite', 'width': 8, 'height': 8, 'idempotency_key': 'blank'})
            assert (await server.call_tool('create_blank_asset', {'project_id': project['id'], 'name': 'sprite',
                         'width': 8, 'height': 8, 'idempotency_key': 'blank'}))[1] == asset
            original = asset['currentVersionId']
            path = '/assets/' + asset['id']
            assert len((await request(client, spec, 'list_assets', 'GET', project_path + '/assets'))['result']) == 1
            assert 'document' not in await request(client, spec, 'get_asset', 'GET', path, params={'include_document': 'false'})
            asset = await request(client, spec, 'get_asset', 'GET', path, params={'include_document': 'true'})
            doc = deepcopy(asset['document']); doc['name'] = 'edited'
            changed = await request(client, spec, 'update_asset_document', 'PUT', path + '/document',
                                    json={'document': doc, 'expected_current_version_id': original, 'idempotency_key': 'document'})
            rename = {'name': 'renamed', 'expected_current_version_id': changed['asset']['currentVersionId'], 'idempotency_key': 'rename'}
            asset = await request(client, spec, 'rename_asset', 'PATCH', path + '/name', json=rename)
            assert await request(client, spec, 'rename_asset', 'PATCH', path + '/name', json=rename) == asset
            conflict = await request(client, spec, 'rename_asset', 'PATCH', path + '/name', status=409,
                                     json={'name': 'stale', 'expected_current_version_id': original})
            assert conflict['code'] == 'version_conflict'
            await request(client, spec, 'get_asset_preview', 'GET', path + '/preview', params={'max_size': 64})
            preview = await request(client, spec, 'preview_asset_repair', 'POST', path + '/repair-previews',
                                    json={'version_id': asset['currentVersionId'], 'actions': [{'id': 'resize-nearest-v1'}], 'idempotency_key': 'preview'})
            assert preview['changes'][0]['after'] == [16, 16] and preview['report']['findings'] == []
            commit_args = {'expected_current_version_id': asset['currentVersionId'], 'idempotency_key': 'commit'}
            committed = await request(client, spec, 'commit_asset_repair', 'POST', path + '/repair-previews/' + preview['previewId'] + '/commit', json=commit_args)
            again = await request(client, spec, 'commit_asset_repair', 'POST', path + '/repair-previews/' + preview['previewId'] + '/commit', json=commit_args)
            assert again == committed
            checked = await request(client, spec, 'inspect_asset', 'GET', path + '/inspection')
            assert checked['report']['findings'] == []
            reports = await request(client, spec, 'list_reports', 'GET', path + '/reports', params={'limit': 1})
            assert reports['result'][0]['id'] == committed['report']['id']
            version = committed['resultVersionId']
            await request(client, spec, 'get_asset_version', 'GET', path + '/versions/' + version)
            await request(client, spec, 'restore_asset_version', 'POST', path + '/restore',
                          json={'version_id': original, 'expected_current_version_id': version, 'idempotency_key': 'restore'})
            assert (await request(client, spec, 'inspect_asset', 'GET', path + '/inspection'))['versionId'] == original
            exported = await request(client, spec, 'export_asset', 'GET', path + '/versions/' + version + '/export')
            png = await request(client, spec, 'read_workspace_resource', 'GET', '/resources', params={'uri': exported['result']['resourceUri']})
            assert Image.open(io.BytesIO(png)).size == (16, 16)
            exported = await request(client, spec, 'export_asset', 'GET', path + '/versions/' + version + '/export', params={'target': 'json'})
            bundle = await request(client, spec, 'read_workspace_resource', 'GET', '/resources', params={'uri': exported['result']['resourceUri']})
            assert bundle.startswith(b'PK')
            for index, (content, file_format) in enumerate([(png, 'png'), (bundle, 'layered-zip')]):
                args = {'data_base64': base64.b64encode(content).decode(), 'file_format': file_format}
                planned = await request(client, spec, 'preview_file_import', 'POST', project_path + '/import-preview', json=args)
                assert planned['report']['findings'] == []
                args['idempotency_key'] = 'file-' + str(index)
                imported = await request(client, spec, 'import_asset_file', 'POST', project_path + '/imports', json=args)
                repeated = await request(client, spec, 'import_asset_file', 'POST', project_path + '/imports', json=args)
                assert repeated['replayed'] and repeated['assetId'] == imported['assetId']
                assert (await request(client, spec, 'inspect_asset', 'GET', '/assets/' + imported['assetId'] + '/inspection'))['report']['findings'] == []
            archive = project_backup_fixture(bundle, asset['id'], version, config)
            backup = {'data_base64': base64.b64encode(archive).decode()}
            await request(client, spec, 'preview_project_import', 'POST', '/project-imports/preview', json=backup)
            backup['idempotency_key'] = 'backup'
            restored = await request(client, spec, 'import_project_backup', 'POST', '/project-imports', json=backup)
            repeated = await request(client, spec, 'import_project_backup', 'POST', '/project-imports', json=backup)
            assert repeated['replayed'] and repeated['project'] == restored['project']
            assert (await request(client, spec, 'inspect_asset', 'GET', '/assets/' + restored['assets'][0]['assetId'] + '/inspection'))['report']['findings'] == []
    asyncio.run(run())


@pytest.mark.parametrize('path', ['/projects', '/permissions', '/openapi.json', '/resources?uri=pixelart://contract/v1', '/missing', '/projects/'])
def test_oauth_guard_covers_schema_resources_unknown_paths_and_redirects(environment, tmp_path, path):
    env = environment
    root = tmp_path / 'unused'
    server = create_mcp_server(root, oauth=env['config'])
    async def run():
        async with client_for(server) as client:
            for token in (None, 'invalid-token'):
                response = await client.get('/api/v1' + path, headers={} if token is None else {'Authorization': 'Bearer ' + token})
                assert response.status_code == 401 and response.json()['code'] == 'invalid_token'
                assert 'resource_metadata=' in response.headers['www-authenticate']
                APIFailure.model_validate(response.json())
    asyncio.run(run())
    assert not root.exists()


def test_oauth_project_scope_confirmation_replay_and_single_audit_count(environment):
    env = environment
    config = env['config'].model_copy(update={'require_write_confirmation': True})
    server = create_mcp_server(env['root'], allow_write=True, oauth=config)
    args = {'name': 'HTTP confirmed', 'expected_current_version_id': env['first']['currentVersionId'], 'idempotency_key': 'api-rename'}
    path = '/assets/' + env['first']['id']
    async def run():
        spec = await server.openapi()
        validate(spec)
        assert spec['security'] == [{'WorkspaceBearer': []}]
        text = json.dumps(spec)
        assert str(env['root']) not in text and env['one']['id'] not in text
        async with client_for(server, headers={'Authorization': 'Bearer ' + env['token']('reader')}) as client:
            projects = await request(client, spec, 'list_projects', 'GET', '/projects')
            assert [item['id'] for item in projects['result']] == [env['one']['id']]
            denied = await request(client, spec, 'rename_asset', 'PATCH', path + '/name', json=args, status=403)
            assert denied['code'] == 'insufficient_scope'
            assert (await client.patch('/api/v1' + path + '/name', json=args)).headers['www-authenticate'].find('pixelart:write') != -1
            for uri in ('pixelart://generations/' + env['other_task'].id,
                        f"pixelart://exports/{env['second']['id']}/{env['second']['currentVersionId']}/png/frame_0"):
                denied = await request(client, spec, 'read_workspace_resource', 'GET', '/resources', params={'uri': uri}, status=403)
                assert denied['code'] == 'access_denied'
            assert (await client.get('/api/v1/assets/' + env['second']['id'])).status_code == 403
            assert (await client.post('/api/v1/projects', json={'name': 'admin only'})).status_code == 403
            client.headers['Authorization'] = 'Bearer ' + env['token']('writer')
            pending = await request(client, spec, 'rename_asset', 'PATCH', path + '/name', json=args, status=409)
            assert pending['code'] == 'write_confirmation_required'
            confirmation = pending['confirmation']
            reviewed = server.security.approvals.review(confirmation['requestId'])
            assert reviewed['intent']['arguments'] == {'asset_id': env['first']['id'], **args}
            server.security.approvals.approve(confirmation['requestId'], confirmation['digest'])
            changed = await request(client, spec, 'rename_asset', 'PATCH', path + '/name', json=args)
            assert (await request(client, spec, 'inspect_asset', 'GET', path + '/inspection'))['versionId'] == changed['currentVersionId']
            pending_again = await request(client, spec, 'rename_asset', 'PATCH', path + '/name', json=args, status=409)
            new = pending_again['confirmation']
            assert new['requestId'] != confirmation['requestId']
            server.security.approvals.approve(new['requestId'], new['digest'])
            assert await request(client, spec, 'rename_asset', 'PATCH', path + '/name', json=args) == changed
            assert len(env['store'].asset(env['first']['id'])['versions']) == 2
    asyncio.run(run())
    with sqlite3.connect(server.security.journal.path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM audit_events WHERE operation='rename_asset' AND outcome='completed'").fetchone()[0] == 2
        assert 'HTTP confirmed' not in json.dumps(connection.execute('SELECT * FROM audit_events').fetchall())


def test_api_and_mcp_share_read_budget_and_security_failure_prevents_write(environment, monkeypatch):
    env = environment
    config = env['config'].model_copy(deep=True)
    config.principals['reader'] = config.principals['reader'].model_copy(update={'calls_per_minute': 2})
    server = create_mcp_server(env['root'], allow_write=True, oauth=config)
    with authenticated(env, 'reader'):
        call(server, 'get_capabilities')
    async def run():
        async with client_for(server, headers={'Authorization': 'Bearer ' + env['token']('reader')}) as client:
            assert (await client.get('/api/v1/capabilities')).status_code == 200
            limited = await client.get('/api/v1/permissions')
            assert limited.status_code == 429 and limited.json()['code'] == 'rate_limited'
            assert 1 <= int(limited.headers['retry-after']) <= 60
            client.headers['Authorization'] = 'Bearer ' + env['token']('writer')
            def unavailable(*args, **kwargs):
                raise AuditUnavailable('fixture only')
            monkeypatch.setattr(server.security.journal, 'begin', unavailable)
            failed = await client.patch('/api/v1/assets/' + env['first']['id'] + '/name', json={
                'name': 'must not change', 'expected_current_version_id': env['first']['currentVersionId'], 'idempotency_key': 'unavailable'})
            assert failed.status_code == 503 and failed.json()['code'] == 'security_unavailable'
    asyncio.run(run())
    assert env['store'].asset(env['first']['id'])['name'] == 'sprite'


@pytest.mark.parametrize('endpoint', ENDPOINTS, ids=lambda endpoint: endpoint.tool)
def test_every_http_operation_enforces_all_required_scopes_before_execution(environment, endpoint):
    env = environment
    server = create_mcp_server(env['root'], allow_write=True, oauth=env['config'])
    tool = server._tool_manager.get_tool(endpoint.tool)
    available = {'asset_id': env['first']['id'], 'project_id': env['one']['id'],
                 'generation_id': env['own_task'].id, 'candidate_id': 'fixture', 'preview_id': 'fixture',
                 'version_id': env['first']['currentVersionId'], 'expected_current_version_id': env['first']['currentVersionId'],
                 'name': 'must not execute', 'document': env['first']['document'], 'config': {}, 'actions': [],
                 'request': {'projectId': env['one']['id'], 'mode': 'agent_draw', 'prompt': 'fixture only'},
                 'state': {'favorite': True}, 'idempotency_key': 'denied', 'data_base64': 'AAAA'}
    arguments = {name: available[name] for name in tool.parameters.get('required', [])}
    path = endpoint.path
    for name in endpoint.path_arguments:
        path = path.replace('{' + name + '}', arguments.pop(name))
    query = {name: arguments.pop(name) for name in endpoint.query if name in arguments}
    async def run():
        async with client_for(server) as client:
            for missing in EXPECTED_SCOPES[endpoint.tool]:
                scope = ' '.join(value for value in (READ, WRITE, GENERATE, ADMIN) if value != missing)
                token = env['token']('admin', scope=scope)
                options = {'headers': {'Authorization': 'Bearer ' + token}, 'params': query}
                if endpoint.method != 'GET': options['json'] = arguments
                response = await client.request(endpoint.method, '/api/v1' + path, **options)
                assert response.status_code == 403, response.text
                assert response.json()['code'] == 'insufficient_scope'
                assert missing in response.headers['www-authenticate']
    asyncio.run(run())
    assert len(env['store'].list_projects()) == 2
    assert env['store'].asset(env['first']['id'])['currentVersionId'] == env['first']['currentVersionId']


@pytest.mark.parametrize('headers,status', [({'Host': 'attacker.example'}, 421), ({'Origin': 'https://attacker.example'}, 403)])
def test_host_and_origin_protection_applies_before_routing_and_metadata(tmp_path, headers, status):
    root = tmp_path / 'unused'
    server = create_mcp_server(root, allow_write=True)
    async def run():
        async with client_for(server) as client:
            for method, path in [('GET', '/openapi.json'), ('GET', '/missing'), ('GET', '/projects/'), ('POST', '/projects')]:
                response = await client.request(method, '/api/v1' + path, headers=headers, json={'name': 'never'})
                assert response.status_code == status
                APIFailure.model_validate(response.json())
    asyncio.run(run())
    assert not root.exists()


@pytest.mark.parametrize('body,content_type,status', [
    (b'{', 'application/json', 400), (b'[]', 'application/json', 400),
    (b'{"name":"private-marker-7821","name":"private-marker-4592"}', 'application/json', 400),
    (b'{"name":NaN}', 'application/json', 400),
    (b'{"name":1e309}', 'application/json', 400),
    (b'{"name":{"nested":[-1e309]}}', 'application/json', 400),
    (b'{"name":"private-marker-7821"}', 'text/plain', 415),
    (b'{"name":"private-marker-7821","asset_id":"override"}', 'application/json', 422),
    (b'{}', 'application/json', 422),
])
def test_malformed_extra_and_ambiguous_inputs_are_sanitized_without_store(tmp_path, body, content_type, status):
    root = tmp_path / 'unused'
    server = create_mcp_server(root, allow_write=True)
    async def run():
        async with client_for(server) as client:
            response = await client.post('/api/v1/projects', content=body, headers={'content-type': content_type})
            assert response.status_code == status
            APIFailure.model_validate(response.json())
            assert 'override' not in response.text and 'private-marker-' not in response.text
    asyncio.run(run())
    assert not root.exists()


def test_stream_limit_queries_method_not_found_and_readonly_gate(tmp_path):
    root = tmp_path / 'unused'
    server = create_mcp_server(root)
    async def run():
        async with client_for(server) as client:
            async def large():
                for _ in range(5): yield b'x' * (1024 * 1024)
            response = await client.post('/api/v1/projects', content=large(), headers={'content-type': 'application/json'})
            assert response.status_code == 413 and response.json()['code'] == 'request_too_large'
            assert (await client.get('/api/v1/projects?unknown=1')).status_code == 422
            assert (await client.get('/api/v1/assets/fake?include_document=true&include_document=false')).status_code == 422
            assert (await client.get('/api/v1/missing')).status_code == 404
            assert (await client.delete('/api/v1/projects')).status_code == 405
            assert (await client.get('/api/v1/resources', params={'uri': 'file:///etc/passwd'})).status_code == 404
            assert (await client.get('/api/v1/resources', params={'uri': 'https://provider.example/key'})).status_code == 404
            blocked = await client.post('/api/v1/projects', json={'name': 'blocked', 'idempotency_key': 'readonly'})
            assert blocked.status_code == 403 and blocked.json()['code'] == 'permission_denied'
    asyncio.run(run())
    assert not root.exists()


def test_binary_resource_and_preview_failures_have_sanitized_business_statuses(tmp_path):
    server = create_mcp_server(tmp_path, allow_write=True)
    async def run():
        spec = await server.openapi()
        async with client_for(server) as client:
            project = (await client.post('/api/v1/projects', json={'name': 'fixture'})).json()
            asset = (await client.post('/api/v1/projects/' + project['id'] + '/assets/blank', json={'name': 'sprite'})).json()
            missing = await request(client, spec, 'get_asset_preview', 'GET', '/assets/' + asset['id'] + '/preview', params={'frame_id': 'private-missing-frame'}, status=404)
            assert missing['code'] == 'not_found' and 'private-missing-frame' not in json.dumps(missing)
            for uri, status in [(f"pixelart://exports/{asset['id']}/{asset['currentVersionId']}/png/private-missing-frame", 404),
                                (f"pixelart://exports/{asset['id']}/{asset['currentVersionId']}/unsupported/bundle", 422),
                                (f"pixelart://exports/{asset['id']}/missing-version/png/frame_0", 404)]:
                result = await request(client, spec, 'read_workspace_resource', 'GET', '/resources', params={'uri': uri}, status=status)
                assert 'private-missing-frame' not in json.dumps(result) and str(tmp_path) not in json.dumps(result)
    asyncio.run(run())


def test_queued_generation_cancel_retry_and_poll_schema_without_provider_execution(ai_workspace):
    store, provider_calls, secret = ai_workspace
    project = store.project('queued API fixture')
    server = create_mcp_server(store.root, allow_write=True)
    async def run():
        spec = await server.openapi()
        async with client_for(server) as client:
            args = {'request': {'projectId': project['id'], 'mode': 'agent_draw', 'prompt': 'fixture'}, 'idempotency_key': 'start'}
            started = await request(client, spec, 'start_generation', 'POST', '/generations', json=args)
            task = started['result']; assert task['status'] == 'queued'
            assert (await request(client, spec, 'start_generation', 'POST', '/generations', json=args))['result']['id'] == task['id']
            path = '/generations/' + task['id']
            await request(client, spec, 'get_generation', 'GET', path)
            listed = await request(client, spec, 'list_generations', 'GET', '/generations', params={'project_id': project['id'], 'status': 'queued', 'limit': 2})
            assert listed['result']['generations'][0]['id'] == task['id']
            cancelled = await request(client, spec, 'cancel_generation', 'POST', path + '/cancel', json={'idempotency_key': 'cancel'})
            assert cancelled['result']['status'] == 'cancelled'
            retried = await request(client, spec, 'retry_generation', 'POST', path + '/retry', json={'idempotency_key': 'retry'})
            assert retried['result']['id'] != task['id'] and retried['result']['status'] == 'queued'
            assert secret not in json.dumps(retried)
    asyncio.run(run())
    assert provider_calls == []


def test_actual_http_generation_candidate_import_inspection_and_resource_lifecycle(ai_workspace, tmp_path):
    store, provider_calls, secret = ai_workspace
    with http_server(tmp_path, True) as url:
        async def run():
            async with httpx.AsyncClient(base_url=url.removesuffix('/mcp'), trust_env=False) as client:
                spec = (await client.get('/api/v1/openapi.json')).json()
                project = await request(client, spec, 'create_project', 'POST', '/projects', json={'name': 'real API', 'idempotency_key': 'project'})
                started = await request(client, spec, 'start_generation', 'POST', '/generations', json={'request': {
                    'projectId': project['id'], 'mode': 'agent_draw', 'prompt': 'red icon', 'width': 8, 'height': 8}, 'idempotency_key': 'generate'})
                path = '/generations/' + started['result']['id']
                for _ in range(150):
                    task = (await request(client, spec, 'get_generation', 'GET', path))['result']
                    if task['status'] not in {'queued', 'running'}: break
                    await asyncio.sleep(.02)
                assert task['status'] == 'succeeded'
                candidate = path + '/candidates/' + task['candidates'][0]['id']
                assert (await request(client, spec, 'get_candidate_preview', 'GET', candidate + '/preview')).startswith(b'\x89PNG')
                state = await request(client, spec, 'update_candidate_state', 'PATCH', candidate, json={'state': {'favorite': True}, 'idempotency_key': 'favorite'})
                assert state['result']['candidates'][0]['favorite']
                imported = (await request(client, spec, 'import_generation_candidate', 'POST', candidate + '/imports', json={'idempotency_key': 'candidate'}))['result']
                repeated = (await request(client, spec, 'import_generation_candidate', 'POST', candidate + '/imports', json={'idempotency_key': 'candidate'}))['result']
                assert imported == repeated
                checked = await request(client, spec, 'inspect_asset', 'GET', '/assets/' + imported['assetId'] + '/inspection')
                assert checked['versionId'] == imported['currentVersionId']
                resource = await request(client, spec, 'read_workspace_resource', 'GET', '/resources', params={'uri': task['resourceUri']})
                assert resource['id'] == task['id'] and secret not in json.dumps(resource)
        asyncio.run(run())
    assert len(provider_calls) == 1
