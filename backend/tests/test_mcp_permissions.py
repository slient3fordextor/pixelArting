"""Independent scope matrix, owner boundaries and advisory discovery contracts."""

import asyncio
from dataclasses import FrozenInstanceError
import json

from jsonschema import Draft202012Validator
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
import pytest

from backend.mcp_auth import ADMIN, GENERATE, READ, WRITE
from backend.mcp_permissions import AUTHORIZATION_META, PERMISSIONS_URI, RESOURCE_RULES, TOOL_RULES
from backend.mcp_policy import InsufficientScope, PolicyDenied
from backend.mcp_server import create_mcp_server
from backend.models import AiGenerationRequest
from backend.tests.test_mcp_security import environment, signing_key, authenticated, call


# Keep expected requirements independent of the production registry.
READ_TOOLS = {'get_capabilities', 'get_permissions', 'pixelart_health', 'list_projects', 'list_assets',
              'get_project_config', 'get_asset', 'get_asset_version', 'get_asset_preview', 'list_reports',
              'inspect_asset', 'export_asset', 'get_generation', 'list_generations', 'get_candidate_preview', 'preview_file_import'}
WRITE_TOOLS = {'create_blank_asset', 'update_project_config', 'update_asset_document', 'rename_asset',
               'preview_asset_repair', 'commit_asset_repair', 'restore_asset_version', 'cancel_generation',
               'update_candidate_state', 'import_generation_candidate', 'import_asset_file'}
EXPECTED_SCOPES = {
    **{name: [READ] for name in READ_TOOLS},
    **{name: [READ, WRITE] for name in WRITE_TOOLS},
    'start_generation': [READ, WRITE, GENERATE], 'retry_generation': [READ, WRITE, GENERATE],
    'create_project': [READ, WRITE, ADMIN], 'preview_project_import': [READ, ADMIN],
    'import_project_backup': [READ, WRITE, ADMIN],
}


def test_discovery_covers_every_tool_resource_and_effective_schema_without_store(tmp_path):
    root = tmp_path / 'unused'
    server = create_mcp_server(root)
    tools = {tool.name: tool for tool in asyncio.run(server.list_tools())}
    assert set(tools) == set(EXPECTED_SCOPES) == set(TOOL_RULES)
    view = call(server, 'get_permissions')
    Draft202012Validator(tools['get_permissions'].outputSchema).validate(view)
    assert view['authentication'] == 'local-process-only' and view['effectiveOAuthScopes'] == []
    assert view['projectAccess'] == 'workspace' and view['projectIds'] == []
    assert view['processWriteEnabled'] is False and view['writeConfirmationRequired'] is False
    for name, expected in EXPECTED_SCOPES.items():
        metadata = tools[name].meta[AUTHORIZATION_META]
        assert metadata['requiredOAuthScopes'] == expected
        assert metadata['write'] is (WRITE in expected)
        assert metadata['write'] is not tools[name].annotations.readOnlyHint
        assert view['tools'][name]['scopeAllowed'] is True  # Local owner is not an OAuth principal.
        assert view['tools'][name]['writeGateAllowed'] is (WRITE not in expected)
        assert view['tools'][name]['confirmationRequired'] is False
    contract = json.loads(list(asyncio.run(server.read_resource(PERMISSIONS_URI)))[0].content)
    assert set(contract['tools']) == set(tools)
    resources = asyncio.run(server.list_resources())
    templates = asyncio.run(server.list_resource_templates())
    discovered = {str(resource.uri) for resource in resources} | {template.uriTemplate for template in templates}
    assert discovered == {rule.uri_template for rule in RESOURCE_RULES}
    for resource in resources + templates:
        metadata = resource.meta[AUTHORIZATION_META]
        assert metadata in contract['resources'] and metadata['requiredOAuthScopes'] == [READ]
    assert len(view['resources']) == len(discovered)
    assert not root.exists()


@pytest.mark.parametrize('name', sorted(EXPECTED_SCOPES))
def test_every_declared_required_scope_is_enforced_before_target_or_execution(environment, name):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    for missing in EXPECTED_SCOPES[name]:
        scopes = ' '.join(scope for scope in (READ, WRITE, GENERATE, ADMIN) if scope != missing)
        with authenticated(env, 'admin', scope=scopes), pytest.raises(InsufficientScope) as denied:
            server.security.begin_tool(name, {})
        assert denied.value.required == EXPECTED_SCOPES[name]


@pytest.mark.parametrize('name', sorted(name for name, scopes in EXPECTED_SCOPES.items() if WRITE in scopes))
def test_every_write_keeps_process_gate_independent_of_full_admin_scope(environment, name):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'])
    with authenticated(env, 'admin'), pytest.raises(PolicyDenied, match='Write access denied'):
        server.security.begin_tool(name, {})


@pytest.mark.parametrize('subject', ['reader', 'writer', 'generator', 'admin'])
def test_effective_flags_intersect_identity_and_process_settings(environment, subject):
    env = environment
    config = env['config'].model_copy(update={'require_write_confirmation': True})
    server = create_mcp_server(env['root'], oauth=config, allow_write=True)
    with authenticated(env, subject):
        view = call(server, 'get_permissions')
    effective = env['config'].principals[subject].scopes
    assert set(view['effectiveOAuthScopes']) == effective
    assert view['projectAccess'] == ('workspace' if ADMIN in effective else 'explicit-projects')
    assert view['projectIds'] == ([] if ADMIN in effective else [env['one']['id']])
    for name, expected in EXPECTED_SCOPES.items():
        access = view['tools'][name]
        assert access['scopeAllowed'] is (set(expected) <= effective)
        assert access['writeGateAllowed'] is True
        assert access['confirmationRequired'] is (WRITE in expected)
    assert str(env['root']) not in json.dumps(view) and env['token'](subject) not in json.dumps(view)


def test_token_dropping_admin_cannot_inherit_workspace_access_from_grant(environment):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    with authenticated(env, 'admin', scope=f'{READ} {WRITE}'):
        view = call(server, 'get_permissions')
        assert view['effectiveOAuthScopes'] == [READ, WRITE]
        assert view['projectAccess'] == 'explicit-projects' and view['projectIds'] == []
        assert not view['tools']['create_project']['scopeAllowed']
        with pytest.raises(ToolError):
            call(server, 'get_asset', asset_id=env['first']['id'])


OWNER_TARGETS = {
    **{name: 'project' for name in ('list_assets', 'get_project_config', 'preview_file_import', 'create_blank_asset', 'update_project_config', 'import_asset_file')},
    **{name: 'asset' for name in ('get_asset', 'get_asset_version', 'get_asset_preview', 'list_reports', 'inspect_asset', 'export_asset', 'update_asset_document', 'rename_asset', 'preview_asset_repair', 'commit_asset_repair', 'restore_asset_version')},
    **{name: 'generation' for name in ('get_generation', 'get_candidate_preview', 'cancel_generation', 'retry_generation', 'update_candidate_state', 'import_generation_candidate')},
    'start_generation': 'request', 'list_generations': 'filter',
}


@pytest.mark.parametrize('name,target', OWNER_TARGETS.items())
def test_every_owner_policy_rejects_foreign_project_before_domain_execution(environment, name, target):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    arguments = {'project_id': env['two']['id']} if target in {'project', 'filter'} else (
        {'asset_id': env['second']['id']} if target == 'asset' else (
            {'generation_id': env['other_task'].id} if target == 'generation' else {'request': {'projectId': env['two']['id']}}))
    with authenticated(env, 'generator'), pytest.raises(PolicyDenied, match='Resource unavailable'):
        server.security.begin_tool(name, arguments)


def test_candidate_destination_and_unscoped_jobs_keep_independent_project_checks(environment):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    unscoped = env['store'].create_generation(AiGenerationRequest(mode='agent_draw', prompt='fixture only'))
    with authenticated(env, 'generator'):
        with pytest.raises(PolicyDenied):
            server.security.begin_tool('import_generation_candidate', {'generation_id': env['own_task'].id, 'project_id': env['two']['id']})
        for name in ('get_generation', 'retry_generation', 'import_generation_candidate'):
            with pytest.raises(PolicyDenied):
                server.security.begin_tool(name, {'generation_id': unscoped.id, 'project_id': env['one']['id']})
        with pytest.raises(PolicyDenied):
            server.security.begin_tool('start_generation', {'request': {}})


def test_advisory_metadata_cannot_grant_access_and_registry_is_immutable(environment):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    tools = asyncio.run(server.list_tools())
    next(tool for tool in tools if tool.name == 'rename_asset').meta[AUTHORIZATION_META]['requiredOAuthScopes'] = [READ]
    with authenticated(env, 'reader'):
        view = call(server, 'get_permissions')
        view['tools']['rename_asset']['scopeAllowed'] = True
        with pytest.raises(ToolError):
            call(server, 'rename_asset', asset_id=env['first']['id'], expected_current_version_id=env['first']['currentVersionId'], name='never applied')
    assert env['store'].asset(env['first']['id'])['name'] == 'sprite'
    assert not next(tool for tool in asyncio.run(server.list_tools()) if tool.name == 'rename_asset').meta[AUTHORIZATION_META]['requiredOAuthScopes'] == [READ]
    with pytest.raises(TypeError):
        TOOL_RULES['rename_asset'] = TOOL_RULES['get_asset']
    with pytest.raises(FrozenInstanceError):
        TOOL_RULES['rename_asset'].scopes = (READ,)


def test_unregistered_tools_resources_and_annotation_drift_fail_closed(environment, monkeypatch):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'], allow_write=True)
    executed = []
    @server.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def future_tool() -> str:
        executed.append(True)
        return 'should not run'
    with pytest.raises(ValueError, match='missing authorization'):
        asyncio.run(server.list_tools())
    with authenticated(env, 'admin'), pytest.raises(ToolError):
        call(server, 'future_tool')
    assert not executed
    @server.resource('pixelart://future/config')
    def future_resource() -> str:
        executed.append(True)
        return 'private'
    with pytest.raises(ValueError, match='missing authorization'):
        asyncio.run(server.list_resources())
    with authenticated(env, 'admin'), pytest.raises(PolicyDenied):
        server.security.begin_resource('pixelart://future/config')
    clean = create_mcp_server(env['root'])
    monkeypatch.setattr(clean._tool_manager.get_tool('rename_asset').annotations, 'readOnlyHint', True)
    with pytest.raises(ValueError, match='disagree'):
        asyncio.run(clean.list_tools())


@pytest.mark.parametrize('suffix', ['', '?download=1', '#fragment', '/extra'])
def test_resource_registry_requires_known_templates_and_owner_access(environment, suffix):
    env = environment
    server = create_mcp_server(env['root'], oauth=env['config'])
    with authenticated(env, 'reader'):
        for uri in (f"pixelart://exports/{env['second']['id']}/{env['second']['currentVersionId']}/png/frame_0",
                    f"pixelart://generations/{env['other_task'].id}",
                    f"pixelart://generations/{env['other_task'].id}/candidates/one/preview"):
            with pytest.raises(PolicyDenied):
                server.security.begin_resource(uri + suffix)
