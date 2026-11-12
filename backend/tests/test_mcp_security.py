"""Pinned OAuth access tokens, project/resource isolation, audits and shared budgets."""

import asyncio
from contextlib import contextmanager
from datetime import timedelta
import json
import sqlite3
import time

from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.auth.middleware.auth_context import auth_context_var
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.fastmcp.exceptions import ToolError, ResourceError
import pytest

from backend.images import encode_image
from backend.mcp_auth import OAuthConfig, PinnedJWTVerifier, READ, WRITE, GENERATE, ADMIN
from backend.mcp_policy import KNOWN_TOOLS
from backend.mcp_server import create_mcp_server
from backend.models import AiGenerationRequest, Document, Frame, Layer
from backend.store import Store
from PIL import Image


@pytest.fixture(scope='module')
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def environment(tmp_path, signing_key):
    root = tmp_path / 'workspace'
    store = Store(root)
    one = store.project('visible')
    two = store.project('private')
    document = Document(name='sprite', layers=[Layer(id='base', name='layer')], frames=[Frame(id='frame_0', width=8, height=8, pixels={'base': encode_image(Image.new('RGBA', (8, 8)))})])
    first = store.create_asset(one['id'], document)
    second = store.create_asset(two['id'], document)
    own_task = store.create_generation(AiGenerationRequest(projectId=one['id'], mode='agent_draw', prompt='visible prompt'))
    other_task = store.create_generation(AiGenerationRequest(projectId=two['id'], mode='agent_draw', prompt='private prompt'))
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(signing_key.public_key(), as_dict=True)
    jwk.update(kid='primary', alg='RS256', use='sig')
    (tmp_path / 'keys.json').write_text(json.dumps({'keys': [jwk]}))
    raw = {'issuer': 'https://identity.example/tenant', 'resource': 'https://assets.example/mcp', 'workspace_id': 'customer-one', 'jwks_file': 'keys.json', 'principals': {
        'reader': {'projects': [one['id']], 'scopes': [READ]},
        'writer': {'projects': [one['id']], 'scopes': [READ, WRITE]},
        'generator': {'projects': [one['id']], 'scopes': [READ, WRITE, GENERATE]},
        'admin': {'projects': [], 'scopes': [READ, WRITE, GENERATE, ADMIN]},
    }}
    config_path = tmp_path / 'oauth.json'
    config_path.write_text(json.dumps(raw))
    config = OAuthConfig.load(config_path)

    def token(subject='reader', **updates):
        now = int(time.time())
        claims = {'iss': config.issuer, 'aud': config.resource, 'workspace_id': config.workspace_id,
                  'sub': subject, 'client_id': 'test-client', 'scope': ' '.join([READ, WRITE, GENERATE, ADMIN]), 'iat': now, 'exp': now + 600}
        claims.update(updates)
        return jwt.encode(claims, signing_key, algorithm='RS256', headers={'kid': 'primary', 'typ': 'at+jwt'})
    return {'root': root, 'store': store, 'config': config, 'config_path': config_path, 'raw': raw,
            'one': one, 'two': two, 'first': first, 'second': second, 'own_task': own_task, 'other_task': other_task, 'token': token, 'key': signing_key}


@contextmanager
def authenticated(env, subject='reader', **claims):
    access = asyncio.run(PinnedJWTVerifier(env['config']).verify_token(env['token'](subject, **claims)))
    assert access is not None
    handle = auth_context_var.set(AuthenticatedUser(access))
    try:
        yield
    finally:
        auth_context_var.reset(handle)


def call(server, tool_name, **arguments):
    result = asyncio.run(server.call_tool(tool_name, arguments))
    if isinstance(result, tuple):
        return result[1].get('result', result[1])
    return result


def test_verified_token_intersects_operator_grants(environment):
    env = environment
    access = asyncio.run(PinnedJWTVerifier(env['config']).verify_token(env['token']()))
    assert access.scopes == [READ]
    assert access.subject == 'reader'
    assert access.resource == env['config'].resource


@pytest.mark.parametrize('claims', [
    {'aud': 'https://other.example/mcp'}, {'aud': ['https://assets.example/mcp']},
    {'iss': 'https://untrusted.example'}, {'workspace_id': 'other-workspace'},
    {'exp': 1}, {'iat': 1}, {'iat': int(time.time()) + 300},
    {'client_id': None}, {'sub': 'unlisted-user'}, {'scope': [READ]},
    {'exp': '9999999999'}, {'iat': True},
])
def test_wrong_audience_workspace_issuer_expiry_or_claims_are_rejected(environment, claims):
    env = environment
    assert asyncio.run(PinnedJWTVerifier(env['config']).verify_token(env['token'](**claims))) is None


@pytest.mark.parametrize('kind', ['wrong-key', 'id-token', 'unknown-kid', 'unsigned', 'symmetric', 'remote-key'])
def test_no_algorithm_or_key_substitution(environment, kind):
    env = environment
    claims = jwt.decode(env['token'](), options={'verify_signature': False})
    headers = {'kid': 'primary', 'typ': 'at+jwt'}
    key, alg = env['key'], 'RS256'
    if kind == 'wrong-key':
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    elif kind == 'id-token':
        headers['typ'] = 'JWT'
    elif kind == 'unknown-kid':
        headers['kid'] = 'other'
    elif kind == 'unsigned':
        key, alg = None, 'none'
    elif kind == 'symmetric':
        key, alg = 'test-only-symmetric-key-long-enough', 'HS256'
    else:
        headers['jku'] = 'https://attacker.example/keys'
    token = jwt.encode(claims, key, algorithm=alg, headers=headers)
    assert asyncio.run(PinnedJWTVerifier(env['config']).verify_token(token)) is None


def test_every_registered_tool_is_covered_by_fail_closed_policy(environment):
    from backend.mcp_policy import WRITES
    server = create_mcp_server(environment['root'], oauth=environment['config'])
    tools = asyncio.run(server.list_tools())
    assert {tool.name for tool in tools} == KNOWN_TOOLS
    assert {tool.name for tool in tools if not tool.annotations.readOnlyHint} == WRITES
    with pytest.raises(ToolError):
        call(server, 'get_capabilities')


def test_reader_lists_only_allowed_projects_and_tasks_and_cannot_write(environment):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    with authenticated(env):
        assert [item['id'] for item in call(server, 'list_projects')] == [env['one']['id']]
        tasks = call(server, 'list_generations', limit=1)['generations']
        assert [task['id'] for task in tasks] == [env['own_task'].id]
        assert 'private prompt' not in json.dumps(tasks)
        assert call(server, 'get_capabilities')['writeEnabled'] is False
        assert call(server, 'pixelart_health')['dataRoot'] is None
        with pytest.raises(ToolError):
            call(server, 'create_blank_asset', project_id=env['one']['id'], name='denied')
    assert len(env['store'].list_assets(env['one']['id'])) == 1


@pytest.mark.parametrize('name,args', [
    ('get_asset', 'asset'), ('get_asset_version', 'version'), ('get_asset_preview', 'asset'),
    ('inspect_asset', 'asset'), ('list_reports', 'asset'), ('export_asset', 'version'),
    ('rename_asset', 'rename'), ('restore_asset_version', 'restore'),
    ('list_assets', 'project'), ('get_project_config', 'project'),
    ('get_generation', 'task'), ('cancel_generation', 'task'), ('get_candidate_preview', 'candidate'),
])
def test_foreign_project_cannot_be_reached_by_direct_ids(environment, name, args):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    arguments = {'asset_id': env['second']['id']}
    if args in {'version', 'restore'}:
        arguments['version_id'] = env['second']['currentVersionId']
    if args in {'rename', 'restore'}:
        arguments['expected_current_version_id'] = env['second']['currentVersionId']
    if args == 'rename':
        arguments['name'] = 'attacker-change'
    if args == 'project':
        arguments = {'project_id': env['two']['id']}
    if args in {'task', 'candidate'}:
        arguments = {'generation_id': env['other_task'].id}
    if args == 'candidate':
        arguments['candidate_id'] = 'one'
    with authenticated(env, 'writer'), pytest.raises(ToolError):
        call(server, name, **arguments)
    assert env['store'].asset(env['second']['id'])['name'] == 'sprite'


def test_resource_uris_enforce_same_project_boundary(environment):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'])
    uri = f"pixelart://exports/{env['second']['id']}/{env['second']['currentVersionId']}/png/frame_0"
    with authenticated(env):
        for target in (uri, f"pixelart://generations/{env['other_task'].id}", f"pixelart://generations/{env['other_task'].id}/candidates/one/preview"):
            with pytest.raises(ResourceError):
                asyncio.run(server.read_resource(target))
        own = uri.replace(env['second']['id'], env['first']['id']).replace(env['second']['currentVersionId'], env['first']['currentVersionId'])
        content = list(asyncio.run(server.read_resource(own)))[0]
        assert content.content.startswith(b'\x89PNG')


def test_scope_isolation_admin_boundary_and_global_write_gate(environment):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    with authenticated(env, 'writer'):
        with pytest.raises(ToolError):
            call(server, 'create_project', name='denied')
        with pytest.raises(ToolError):
            call(server, 'start_generation', request={'projectId': env['one']['id'], 'mode': 'agent_draw', 'prompt': 'would cost money'}, idempotency_key='no-spend')
        changed = call(server, 'rename_asset', asset_id=env['first']['id'], expected_current_version_id=env['first']['currentVersionId'], name='allowed')
        assert changed['name'] == 'allowed'
        assert 'report' in call(server, 'inspect_asset', asset_id=env['first']['id'])
    with authenticated(env, 'admin'):
        assert len(call(server, 'list_projects')) == 2
    read_only = create_mcp_server(env['root'], oauth=env['config'], allow_write=False)
    with authenticated(env, 'admin'), pytest.raises(ToolError):
        call(read_only, 'create_project', name='blocked by process gate')


def test_shared_rate_limit_and_argument_free_audit(environment, monkeypatch):
    env = environment
    from types import SimpleNamespace
    monkeypatch.setattr('backend.mcp_policy.time', SimpleNamespace(time=lambda: 1800000001))
    raw = env['raw']
    raw['principals']['writer']['calls_per_minute'] = 2
    raw['jwks_file'] = str(env['config'].jwks_file)
    config = OAuthConfig.model_validate(raw)
    first = create_mcp_server(env['root'], oauth=config, allow_write=True)
    second = create_mcp_server(env['root'], oauth=config, allow_write=True)
    private = 'sk-private-input-that-must-not-be-audited'
    with authenticated(env, 'writer'):
        call(first, 'get_capabilities')
        call(second, 'rename_asset', asset_id=env['first']['id'], expected_current_version_id=env['first']['currentVersionId'], name=private)
        with pytest.raises(ToolError, match='rate limit'):
            call(first, 'get_capabilities')
    with sqlite3.connect(env['root'] / 'security' / 'audit.sqlite3') as connection:
        events = connection.execute('SELECT request_id,subject,operation,outcome FROM audit_events').fetchall()
    assert private not in json.dumps(events)
    assert env['token']() not in json.dumps(events)
    assert any(row[-1] == 'rate_limited' for row in events)
    assert sum(row[-1] == 'attempt' for row in events) == 2
    assert sum(row[-1] == 'completed' for row in events) == 2


def test_audit_failure_prevents_mutation(environment, monkeypatch):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    from backend.mcp_policy import AuditUnavailable
    monkeypatch.setattr(server.security.journal, 'begin', lambda *args: (_ for _ in ()).throw(AuditUnavailable('unavailable')))
    with authenticated(env, 'writer'), pytest.raises(ToolError):
        call(server, 'rename_asset', asset_id=env['first']['id'], expected_current_version_id=env['first']['currentVersionId'], name='should not exist')
    assert env['store'].asset(env['first']['id'])['name'] == 'sprite'


@pytest.mark.parametrize('claims', [None, {'aud': 'https://other.example/mcp'}, {'exp': 1}])
def test_http_invalid_tokens_return_401_and_discovery_metadata(environment, claims):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'])

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.streamable_http_app()), base_url='https://assets.example', trust_env=False) as http:
            headers = {} if claims is None else {'Authorization': 'Bearer ' + env['token'](**claims)}
            denied = await http.post('/mcp', json={'jsonrpc': '2.0', 'method': 'initialize', 'id': 1, 'params': {}}, headers=headers)
            assert denied.status_code == 401
            assert 'resource_metadata="https://assets.example/.well-known/oauth-protected-resource/mcp"' in denied.headers['www-authenticate']
            assert env['token']() not in denied.text
            metadata = (await http.get('/.well-known/oauth-protected-resource/mcp')).json()
            assert metadata['resource'] == env['config'].resource
            assert metadata['authorization_servers'] == [env['config'].issuer]
            assert set(metadata['scopes_supported']) == {READ, WRITE, GENERATE, ADMIN}
    asyncio.run(run())


def test_http_scope_challenge_and_project_denial_precede_tool_execution(environment):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.streamable_http_app()), base_url='https://assets.example', trust_env=False) as http:
            headers = {'Authorization': 'Bearer ' + env['token']()}
            denied = await http.post('/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'rename_asset', 'arguments': {'asset_id': env['first']['id'], 'expected_current_version_id': env['first']['currentVersionId'], 'name': 'denied'}}}, headers=headers)
            assert denied.status_code == 403
            assert 'insufficient_scope' in denied.headers['www-authenticate']
            assert f'{READ} {WRITE}' in denied.headers['www-authenticate']
            headers['Authorization'] = 'Bearer ' + env['token']('writer')
            foreign = await http.post('/mcp', json={'jsonrpc': '2.0', 'id': 2, 'method': 'resources/read', 'params': {'uri': f"pixelart://exports/{env['second']['id']}/{env['second']['currentVersionId']}/png/frame_0"}}, headers=headers)
            assert foreign.status_code == 403
            assert 'private' not in foreign.text
    asyncio.run(run())
    assert env['store'].asset(env['first']['id'])['name'] == 'sprite'


def test_real_http_authenticated_workflow_rechecks_each_request(environment, tmp_path):
    from backend.tests.test_mcp_protocol import http_server
    import base64
    env = environment
    used_token = env['token']('writer')
    with http_server(tmp_path, True, extra_args=('--oauth-config', str(env['config_path']))) as url:
        async def run():
            headers = {'Authorization': 'Bearer ' + used_token}
            async with httpx.AsyncClient(trust_env=False, headers=headers) as http:
                async with streamable_http_client(url, http_client=http) as (read, write, _):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=10)) as session:
                        await session.initialize()
                        caps = await session.call_tool('get_capabilities')
                        assert caps.structuredContent['authentication'] == 'oauth-jwt'
                        assert caps.structuredContent['writeEnabled'] is True
                        permissions = (await session.call_tool('get_permissions')).structuredContent
                        assert permissions['effectiveOAuthScopes'] == [READ, WRITE]
                        assert permissions['projectIds'] == [env['one']['id']]
                        assert permissions['projectAccess'] == 'explicit-projects'
                        assert permissions['tools']['rename_asset']['scopeAllowed']
                        assert not permissions['tools']['start_generation']['scopeAllowed']
                        projects = (await session.call_tool('list_projects')).structuredContent['result']
                        assert [project['id'] for project in projects] == [env['one']['id']]
                        changed = await session.call_tool('rename_asset', {'asset_id': env['first']['id'], 'expected_current_version_id': env['first']['currentVersionId'], 'name': 'HTTP authorized'})
                        assert not changed.isError
                        version = changed.structuredContent['currentVersionId']
                        inspected = await session.call_tool('inspect_asset', {'asset_id': env['first']['id']})
                        assert inspected.structuredContent['versionId'] == version
                        exported = await session.call_tool('export_asset', {'asset_id': env['first']['id'], 'version_id': version})
                        resource = await session.read_resource(exported.structuredContent['result']['resourceUri'])
                        assert base64.b64decode(resource.contents[0].blob).startswith(b'\x89PNG')
                http.headers.pop('Authorization')
                assert (await http.post(url, json={'jsonrpc': '2.0', 'id': 8, 'method': 'tools/call', 'params': {'name': 'get_capabilities'}})).status_code == 401
        asyncio.run(run())
    with sqlite3.connect(env['root'] / 'security' / 'audit.sqlite3') as connection:
        operations = connection.execute("SELECT operation,COUNT(*) FROM audit_events WHERE outcome='attempt' GROUP BY operation").fetchall()
    # The HTTP preflight and MCP handler must not reserve/count the call twice.
    assert dict(operations)['rename_asset'] == 1
    assert dict(operations)['read_resource'] == 1
    text = (tmp_path / 'http.log').read_text()
    assert used_token not in text


def test_es256_public_keys_are_supported(environment, tmp_path):
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    public = jwt.algorithms.ECAlgorithm.to_jwk(key.public_key(), as_dict=True)
    public.update(kid='ec-primary', alg='ES256')
    path = tmp_path / 'ec.json'
    path.write_text(json.dumps({'keys': [public]}))
    config = environment['config'].model_copy(update={'jwks_file': path})
    claims = jwt.decode(environment['token'](), options={'verify_signature': False})
    token = jwt.encode(claims, key, algorithm='ES256', headers={'kid': 'ec-primary', 'typ': 'at+jwt'})
    assert asyncio.run(PinnedJWTVerifier(config).verify_token(token)).subject == 'reader'


@pytest.mark.parametrize('kind', ['private-key', 'weak-rsa', 'duplicate-kid', 'empty'])
def test_invalid_public_key_configuration_fails_closed(environment, tmp_path, kind):
    env = environment
    public = json.loads(env['config'].jwks_file.read_text())['keys'][0]
    keys = [public]
    if kind == 'private-key':
        private = jwt.algorithms.RSAAlgorithm.to_jwk(env['key'], as_dict=True)
        private.update(kid='primary', alg='RS256')
        keys = [private]
    elif kind == 'weak-rsa':
        weak = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        value = jwt.algorithms.RSAAlgorithm.to_jwk(weak.public_key(), as_dict=True)
        value.update(kid='weak', alg='RS256')
        keys = [value]
    elif kind == 'duplicate-kid':
        keys = [public, public]
    else:
        keys = []
    path = tmp_path / 'invalid-keys.json'
    path.write_text(json.dumps({'keys': keys}))
    with pytest.raises(ValueError, match='Invalid OAuth public signing keys'):
        PinnedJWTVerifier(env['config'].model_copy(update={'jwks_file': path}))


def test_restricted_generation_requires_a_project_and_checks_import_destination(environment):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    with authenticated(env, 'generator'):
        for project in (None, env['two']['id'], [env['one']['id']]):
            with pytest.raises(ToolError):
                call(server, 'start_generation', request={'mode': 'agent_draw', 'projectId': project, 'prompt': 'must not reach provider'}, idempotency_key='blocked')
        with pytest.raises(ToolError):
            call(server, 'import_generation_candidate', generation_id=env['own_task'].id, candidate_id='one', project_id=env['two']['id'])
    assert len(env['store'].list_generations()) == 2


def test_write_budget_is_separate_from_read_budget(environment, monkeypatch):
    from types import SimpleNamespace
    env = environment
    monkeypatch.setattr('backend.mcp_policy.time', SimpleNamespace(time=lambda: 1800000001))
    raw = env['raw']
    raw['principals']['writer']['writes_per_minute'] = 1
    raw['jwks_file'] = str(env['config'].jwks_file)
    config = OAuthConfig.model_validate(raw)
    server = create_mcp_server(env['root'], oauth=config, allow_write=True)
    with authenticated(env, 'writer'):
        changed = call(server, 'rename_asset', asset_id=env['first']['id'], expected_current_version_id=env['first']['currentVersionId'], name='first')
        with pytest.raises(ToolError, match='rate limit'):
            call(server, 'rename_asset', asset_id=changed['id'], expected_current_version_id=changed['currentVersionId'], name='second')
        assert call(server, 'get_asset', asset_id=changed['id'])['name'] == 'first'


def test_parallel_authenticated_requests_do_not_share_principals(environment):
    from concurrent.futures import ThreadPoolExecutor
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'])
    def query(subject):
        with authenticated(env, subject):
            return call(server, 'list_projects')
    with ThreadPoolExecutor(max_workers=4) as pool:
        values = list(pool.map(query, ['reader', 'admin', 'reader', 'admin']))
    assert [len(value) for value in values] == [1, 2, 1, 2]


def test_scope_challenge_uses_shared_http_rate_budget(environment):
    env = environment
    raw = env['raw']
    raw['principals']['reader']['calls_per_minute'] = 1
    raw['jwks_file'] = str(env['config'].jwks_file)
    server = create_mcp_server(env['root'], oauth=OAuthConfig.model_validate(raw), allow_write=True)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.streamable_http_app()), base_url='https://assets.example', trust_env=False) as http:
            request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'create_project', 'arguments': {'name': 'blocked'}}}
            headers = {'Authorization': 'Bearer ' + env['token']()}
            assert (await http.post('/mcp', json=request, headers=headers)).status_code == 403
            limited = await http.post('/mcp', json=request, headers=headers)
            assert limited.status_code == 429
            assert 1 <= int(limited.headers['retry-after']) <= 60
    asyncio.run(run())


def test_legacy_image_tool_failure_is_audited_as_failed(environment):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'])
    with authenticated(env):
        call(server, 'get_asset_preview', asset_id=env['first']['id'], frame_id='missing-frame')
    with sqlite3.connect(env['root'] / 'security' / 'audit.sqlite3') as connection:
        outcomes = connection.execute("SELECT outcome FROM audit_events WHERE operation='get_asset_preview' ORDER BY sequence").fetchall()
    assert outcomes == [('attempt',), ('failed',)]


def test_authorization_context_and_preflight_are_bound_to_one_workspace(environment, tmp_path):
    from backend.mcp_policy import preauthorized
    env = environment
    first = create_mcp_server(env['root'], oauth=env['config'])
    other_root = tmp_path / 'other-workspace'
    second = create_mcp_server(other_root, oauth=env['config'].model_copy(update={'workspace_id': 'customer-two'}))
    with authenticated(env):
        attempt = first.security.begin_tool('get_capabilities', {})
        handle = preauthorized.set((first.security.tool_key('get_capabilities', {}), attempt))
        try:
            with pytest.raises(ToolError):
                call(second, 'get_capabilities')
        finally:
            preauthorized.reset(handle)
    assert not other_root.exists()


@pytest.fixture
def memory_keyring(monkeypatch):
    import backend.secrets as secret_module
    class MemoryKeyring:
        def __init__(self): self.values = {}
        def get_password(self, service, username): return self.values.get((service, username))
        def set_password(self, service, username, password): self.values[(service, username)] = password
        def delete_password(self, service, username): self.values.pop((service, username), None)
    fake = MemoryKeyring()
    monkeypatch.setattr(secret_module, '_keyring', fake)
    return fake


def test_provider_credentials_are_isolated_between_workspace_databases(tmp_path, memory_keyring):
    from backend.models import AiConfigUpdate
    memory_keyring.values[('PixelArting', 'ai-profile:default')] = 'ambiguous-old-global-secret'
    one = Store(tmp_path / 'one')
    two = Store(tmp_path / 'two')
    assert one.ai_config().apiKey is None
    assert two.ai_config().apiKey is None
    one.save_ai_config(AiConfigUpdate(apiKey='workspace-one-secret'))
    assert two.ai_config().apiKey is None
    two.save_ai_config(AiConfigUpdate(apiKey='workspace-two-secret'))
    assert Store(one.root).ai_config().apiKey == 'workspace-one-secret'
    assert Store(two.root).ai_config().apiKey == 'workspace-two-secret'
    assert one.secrets.service != two.secrets.service
    one.save_ai_config(AiConfigUpdate(clearApiKey=True))
    assert Store(one.root).ai_config().apiKey is None
    assert Store(two.root).ai_config().apiKey == 'workspace-two-secret'
    assert memory_keyring.values[('PixelArting', 'ai-profile:default')] == 'ambiguous-old-global-secret'


def test_unique_legacy_task_credentials_migrate_once_without_resurrection(tmp_path, memory_keyring):
    from backend.models import AiProviderConfig
    store = Store(tmp_path)
    task = store.create_generation(AiGenerationRequest(mode='agent_draw', prompt='resume'), AiProviderConfig(apiKey='snapshot-secret'))
    reference = f'ai-generation:{task.id}'
    memory_keyring.values[('PixelArting', reference)] = memory_keyring.values.pop((store.secrets.service, reference))
    with store.connection() as connection:
        connection.execute("DELETE FROM workspace_metadata WHERE key='legacy_keyring_migrated'")
    restored = Store(tmp_path)
    assert restored.generation_config(task.id).apiKey == 'snapshot-secret'
    restored.secrets.delete(reference)
    assert Store(tmp_path).generation_config(task.id).apiKey is None


def confirmation_server(env):
    config = env['config'].model_copy(update={'require_write_confirmation': True})
    return create_mcp_server(env['root'], oauth=config, allow_write=True)


def rename_arguments(env, name='confirmed rename'):
    return {'asset_id': env['first']['id'], 'expected_current_version_id': env['first']['currentVersionId'], 'name': name}


def pending_write(env, server, **arguments):
    from backend.mcp_approval import ConfirmationRequired
    with authenticated(env, 'writer'), pytest.raises(ConfirmationRequired) as error:
        server.security.begin_tool('rename_asset', arguments or rename_arguments(env))
    return error.value


def test_write_confirmation_is_reviewable_once_and_audit_stays_argument_free(environment):
    env = environment
    server = confirmation_server(env)
    pending = pending_write(env, server)
    assert pending_write(env, server).request_id == pending.request_id
    review = server.security.approvals.review(pending.request_id)
    assert review['intent']['arguments'] == rename_arguments(env)
    assert review['intent']['subject'] == 'writer'
    assert review['intent']['clientId'] == 'test-client'
    assert review['digest'] == pending.digest
    assert env['store'].asset(env['first']['id'])['name'] == 'sprite'
    with pytest.raises(ValueError):
        server.security.approvals.approve(pending.request_id, '0' * 64)
    server.security.approvals.approve(pending.request_id, pending.digest)
    with authenticated(env, 'writer'):
        caps = call(server, 'get_capabilities')
        assert caps['writeConfirmationRequired']
        assert 'write-confirmation' in caps['features']
        assert 'write-confirmation' not in caps['unavailable']
        changed = call(server, 'rename_asset', **rename_arguments(env))
        assert changed['name'] == 'confirmed rename'
        assert call(server, 'inspect_asset', asset_id=changed['id'])['versionId'] == changed['currentVersionId']
    # Lost responses never grant an unrestricted replay, even for identical input.
    assert pending_write(env, server).request_id != pending.request_id
    with sqlite3.connect(server.security.approvals.path) as connection:
        assert connection.execute('SELECT state,payload FROM write_approvals WHERE id=?', (pending.request_id,)).fetchone() == ('consumed', None)
    with sqlite3.connect(server.security.journal.path) as connection:
        events = connection.execute('SELECT * FROM audit_events').fetchall()
    assert 'confirmed rename' not in json.dumps(events)
    assert 'confirmation_required' in json.dumps(events)


@pytest.mark.parametrize('change', ['arguments', 'version', 'subject', 'client', 'issuer', 'resource', 'workspace', 'directory', 'tool'])
def test_confirmation_cannot_authorize_another_intent(environment, tmp_path, change):
    from backend.mcp_auth import Principal
    from backend.mcp_approval import ConfirmationRequired, WriteApprovals
    env = environment
    server = confirmation_server(env)
    pending = pending_write(env, server)
    approvals = server.security.approvals
    approvals.approve(pending.request_id, pending.digest)
    config = server.security.config
    principal = Principal('writer', 'test-client', frozenset({READ, WRITE}), config.principals['writer'])
    args, name = rename_arguments(env), 'rename_asset'
    if change == 'arguments': args['name'] = 'other'
    elif change == 'version': args['expected_current_version_id'] = 'other-version'
    elif change == 'subject': principal.subject = 'generator'
    elif change == 'client': principal.client_id = 'other-client'
    elif change == 'issuer': config = config.model_copy(update={'issuer': 'https://other.example'})
    elif change == 'resource': config = config.model_copy(update={'resource': 'https://other.example/mcp'})
    elif change == 'workspace': config = config.model_copy(update={'workspace_id': 'other'})
    elif change == 'directory':
        import shutil
        other_root = tmp_path / 'copied-workspace'
        shutil.copytree(env['root'], other_root)
        approvals = WriteApprovals(other_root)
    else: name = 'update_asset_document'
    with pytest.raises(ConfirmationRequired) as error:
        approvals.require(config, principal, name, args)
    assert error.value.digest != pending.digest


def test_confirmation_expiry_and_queue_limit_fail_closed(environment, monkeypatch):
    from backend.mcp_approval import ApprovalUnavailable
    env = environment
    server = confirmation_server(env)
    monkeypatch.setattr(server.security.approvals, 'lifetime', -1)
    expired = pending_write(env, server)
    with pytest.raises(ValueError, match='expired'):
        server.security.approvals.review(expired.request_id)
    with pytest.raises(ValueError):
        server.security.approvals.approve(expired.request_id, expired.digest)
    monkeypatch.setattr(server.security.approvals, 'lifetime', 600)
    # Populate the bounded approval store directly, avoiding the separate rate budget.
    from backend.mcp_auth import Principal
    from backend.mcp_approval import ConfirmationRequired
    principal = Principal('writer', 'test-client', frozenset({READ, WRITE}), env['config'].principals['writer'])
    for index in range(64):
        with pytest.raises(ConfirmationRequired):
            server.security.approvals.require(server.security.config, principal, 'rename_asset', rename_arguments(env, str(index)))
    with pytest.raises(ApprovalUnavailable, match='queue full'):
        server.security.approvals.require(server.security.config, principal, 'rename_asset', rename_arguments(env, 'overflow'))
    assert env['store'].asset(env['first']['id'])['name'] == 'sprite'


def test_shared_confirmation_is_consumed_atomically_and_versions_still_conflict(environment):
    from concurrent.futures import ThreadPoolExecutor
    env = environment
    first, second = confirmation_server(env), confirmation_server(env)
    pending = pending_write(env, first)
    first.security.approvals.approve(pending.request_id, pending.digest)
    def execute(server):
        with authenticated(env, 'writer'):
            try:
                return call(server, 'rename_asset', **rename_arguments(env))
            except ToolError:
                return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(execute, [first, second]))
    assert sum(result is not None for result in results) == 1
    stale = pending_write(env, first)
    first.security.approvals.approve(stale.request_id, stale.digest)
    with authenticated(env, 'writer'):
        assert call(first, 'rename_asset', **rename_arguments(env))['code'] == 'version_conflict'
    # A failed execution consumes approval, too; the operator must review anew.
    with pytest.raises(ValueError):
        first.security.approvals.review(stale.request_id)


def test_approval_does_not_override_revoked_permission_or_read_only(environment):
    env = environment
    first = confirmation_server(env)
    pending = pending_write(env, first)
    first.security.approvals.approve(pending.request_id, pending.digest)
    readonly = create_mcp_server(env['root'], oauth=first.security.config, allow_write=False)
    with authenticated(env, 'writer'), pytest.raises(ToolError):
        call(readonly, 'rename_asset', **rename_arguments(env))
    with authenticated(env, 'writer', scope=READ), pytest.raises(ToolError):
        call(first, 'rename_asset', **rename_arguments(env))
    assert first.security.approvals.review(pending.request_id)['state'] == 'approved'
    assert env['store'].asset(env['first']['id'])['name'] == 'sprite'


def test_real_http_confirmation_roundtrip_with_local_cli(environment, tmp_path):
    from backend.tests.test_mcp_protocol import http_server, REPO
    import subprocess
    import sys
    env = environment
    arguments = {**rename_arguments(env), 'idempotency_key': 'http-confirmed-write'}
    raw = json.loads(env['config_path'].read_text())
    raw['require_write_confirmation'] = True
    env['config_path'].write_text(json.dumps(raw))
    with http_server(tmp_path, True, extra_args=('--oauth-config', str(env['config_path']))) as url:
        async def run():
            async with httpx.AsyncClient(trust_env=False, headers={'Authorization': 'Bearer ' + env['token']('writer')}) as http:
                async with streamable_http_client(url, http_client=http) as (read, write, _):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=10)) as session:
                        await session.initialize()
                        denied = await session.call_tool('rename_asset', arguments)
                        assert denied.isError
                        assert denied.structuredContent is None
                        confirmation = denied.meta['pixelarting/writeConfirmation']
                        command = [sys.executable, '-m', 'backend.mcp_cli', '--data-dir', str(env['root'])]
                        review = subprocess.run([*command, '--review-write', confirmation['requestId']], cwd=REPO, text=True, capture_output=True, check=True)
                        assert json.loads(review.stdout)['intent']['arguments'] == arguments
                        approved = subprocess.run([*command, '--approve-write', confirmation['requestId'], '--approval-digest', confirmation['digest']], cwd=REPO, text=True, capture_output=True, check=True)
                        assert json.loads(approved.stdout)['executed'] is False
                        assert env['store'].asset(env['first']['id'])['name'] == 'sprite'
                        changed = await session.call_tool('rename_asset', arguments)
                        assert not changed.isError
                        version = changed.structuredContent['currentVersionId']
                        inspected = await session.call_tool('inspect_asset', {'asset_id': env['first']['id']})
                        assert inspected.structuredContent['versionId'] == version
                        replay_pending = await session.call_tool('rename_asset', arguments)
                        assert replay_pending.isError
                        again = replay_pending.meta['pixelarting/writeConfirmation']
                        assert again['requestId'] != confirmation['requestId']
                        subprocess.run([*command, '--approve-write', again['requestId'], '--approval-digest', again['digest']], cwd=REPO, text=True, capture_output=True, check=True)
                        replay = await session.call_tool('rename_asset', arguments)
                        assert replay.structuredContent == changed.structuredContent
                        assert len(env['store'].asset(env['first']['id'])['versions']) == 2
                        assert (await session.call_tool('rename_asset', arguments)).isError
        asyncio.run(run())
    with sqlite3.connect(env['root'] / 'security' / 'audit.sqlite3') as connection:
        # HTTP preflight consumes approval exactly once; handler reuses its guard.
        assert connection.execute("SELECT COUNT(*) FROM audit_events WHERE operation='rename_asset' AND outcome='completed'").fetchone()[0] == 2


def test_operator_can_reject_pending_and_revoke_unused_approval(environment):
    env = environment
    server = confirmation_server(env)
    for approve in (False, True):
        pending = pending_write(env, server)
        if approve:
            server.security.approvals.approve(pending.request_id, pending.digest)
        server.security.approvals.reject(pending.request_id)
        with pytest.raises(ValueError):
            server.security.approvals.approve(pending.request_id, pending.digest)
        with pytest.raises(ValueError):
            server.security.approvals.review(pending.request_id)
    assert env['store'].asset(env['first']['id'])['name'] == 'sprite'


def test_confirmation_store_failure_prevents_mutation(environment, monkeypatch):
    from backend.mcp_approval import ApprovalUnavailable
    env = environment
    server = confirmation_server(env)
    def unavailable(*args):
        raise ApprovalUnavailable('unavailable')
    monkeypatch.setattr(server.security.approvals, 'require', unavailable)
    with authenticated(env, 'writer'), pytest.raises(ToolError):
        call(server, 'rename_asset', **rename_arguments(env))
    assert env['store'].asset(env['first']['id'])['name'] == 'sprite'
    with sqlite3.connect(server.security.journal.path) as connection:
        assert connection.execute("SELECT outcome FROM audit_events ORDER BY sequence DESC LIMIT 1").fetchone()[0] == 'confirmation_unavailable'


def test_file_import_project_scopes_confirmation_and_argument_free_audit(environment):
    import base64
    from backend.images import png_bytes
    from backend.mcp_approval import ConfirmationRequired
    env = environment
    server = confirmation_server(env)
    data = base64.b64encode(png_bytes(Image.new('RGBA', (8, 8), (1, 2, 3, 255)))).decode('ascii')
    args = {'project_id': env['one']['id'], 'data_base64': data, 'idempotency_key': 'confirmed-import'}
    with authenticated(env, 'reader'):
        assert call(server, 'preview_file_import', project_id=env['one']['id'], data_base64=data)['ok']
        contract = list(asyncio.run(server.read_resource('pixelart://contract/imports/v1')))[0]
        assert json.loads(contract.content)['formats'] == ['png', 'layered-zip']
        with pytest.raises(ToolError):
            call(server, 'import_asset_file', **args)
        with pytest.raises(ToolError):
            call(server, 'preview_file_import', project_id=env['two']['id'], data_base64=data)
    with authenticated(env, 'writer'):
        with pytest.raises(ToolError):
            call(server, 'import_asset_file', **{**args, 'project_id': env['two']['id']})
        with pytest.raises(ConfirmationRequired) as error:
            server.security.begin_tool('import_asset_file', args)
    pending = error.value
    assert len(env['store'].list_assets(env['one']['id'])) == 1
    reviewed = server.security.approvals.review(pending.request_id)
    assert reviewed['intent']['arguments'] == args
    server.security.approvals.approve(pending.request_id, pending.digest)
    with authenticated(env, 'writer'):
        imported = call(server, 'import_asset_file', **args)
        assert imported['ok'] and not imported['replayed']
        assert call(server, 'inspect_asset', asset_id=imported['assetId'])['versionId'] == imported['versionId']
        with pytest.raises(ConfirmationRequired) as repeated:
            server.security.begin_tool('import_asset_file', args)
    # Idempotency cannot bypass mandatory confirmation: replay needs new consent.
    server.security.approvals.approve(repeated.value.request_id, repeated.value.digest)
    with authenticated(env, 'writer'):
        assert call(server, 'import_asset_file', **args)['replayed']
    assert len(env['store'].list_assets(env['one']['id'])) == 2
    with sqlite3.connect(server.security.journal.path) as conn:
        events = conn.execute('SELECT * FROM audit_events').fetchall()
    assert data not in json.dumps(events) and args['idempotency_key'] not in json.dumps(events)


def test_project_backup_requires_admin_separate_write_scope_and_confirmation(environment):
    import base64
    from backend.exchange import export_project
    from backend.mcp_approval import ConfirmationRequired
    env = environment
    data = export_project(env['store'].snapshot_project(env['one']['id'], 64, 16 * 1024 * 1024))
    args = {'data_base64': base64.b64encode(data).decode('ascii'), 'idempotency_key': 'confirmed-project', 'name': 'restored private name'}
    server = confirmation_server(env)
    with authenticated(env, 'writer'):
        with pytest.raises(ToolError):
            call(server, 'preview_project_import', data_base64=args['data_base64'])
        with pytest.raises(ToolError):
            call(server, 'import_project_backup', **args)
        contract = list(asyncio.run(server.read_resource('pixelart://contract/project-imports/v1')))[0]
        assert json.loads(contract.content)['format'] == 'pixelart-project-v1'
    with authenticated(env, 'admin', scope=f'{READ} {ADMIN}'):
        assert not call(server, 'get_capabilities')['writeEnabled']
        assert call(server, 'preview_project_import', data_base64=args['data_base64'])['ok']
        with pytest.raises(ToolError):
            call(server, 'import_project_backup', **args)
    reader = create_mcp_server(env['root'], oauth=server.security.config)
    with authenticated(env, 'admin'):
        assert call(reader, 'preview_project_import', data_base64=args['data_base64'])['ok']
        with pytest.raises(ToolError):
            call(reader, 'import_project_backup', **args)
        with pytest.raises(ConfirmationRequired) as error:
            server.security.begin_tool('import_project_backup', args)
    pending = error.value
    assert len(env['store'].list_projects()) == 2
    assert server.security.approvals.review(pending.request_id)['intent']['arguments'] == args
    server.security.approvals.approve(pending.request_id, pending.digest)
    with authenticated(env, 'admin'):
        result = call(server, 'import_project_backup', **args)
        assert result['ok'] and not result['replayed']
        for asset in result['assets']:
            assert call(server, 'inspect_asset', asset_id=asset['assetId'])['versionId'] == asset['versionId']
        with pytest.raises(ConfirmationRequired) as replay:
            server.security.begin_tool('import_project_backup', args)
    server.security.approvals.approve(replay.value.request_id, replay.value.digest)
    with authenticated(env, 'admin'):
        assert call(server, 'import_project_backup', **args)['replayed']
    with authenticated(env, 'writer'):
        assert len(call(server, 'list_projects')) == 1
        with pytest.raises(ToolError):
            call(server, 'get_asset', asset_id=result['assets'][0]['assetId'])
    assert env['config'].principals['writer'].projects == frozenset({env['one']['id']})
    assert len(env['store'].list_projects()) == 3
    with sqlite3.connect(server.security.journal.path) as conn:
        events = conn.execute('SELECT * FROM audit_events').fetchall()
    assert args['data_base64'] not in json.dumps(events) and args['name'] not in json.dumps(events)
