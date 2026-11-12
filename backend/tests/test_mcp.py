import asyncio
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

import pytest

from backend.mcp_contract import error_result
from backend.mcp_server import create_mcp_server


class LocalClient:
    """Exercise registered tools, including SDK validation and structured output."""

    def __init__(self, root, allow_write=False):
        self.server = create_mcp_server(root, allow_write=allow_write)

    def call(self, tool_name, **args):
        content, structured = asyncio.run(self.server.call_tool(tool_name, args))
        return structured.get('result', structured)


def test_mcp_is_read_only_by_default(tmp_path):
    client = LocalClient(tmp_path)
    assert client.call('pixelart_health')['writeEnabled'] is False
    result = client.call('create_project', name='blocked')
    assert result['ok'] is False
    assert result['error'] == 'PermissionError'
    assert result['code'] == 'permission_denied'
    assert client.call('list_projects') == []


def test_mcp_repair_preview_commit_and_png_preview(tmp_path):
    client = LocalClient(tmp_path, allow_write=True)
    project = client.call('create_project', name='MCP')
    asset = client.call('create_blank_asset', project_id=project['id'], name='sprite', width=8, height=8)
    asset = client.call('get_asset', asset_id=asset['id'], include_document=True)
    base = asset['currentVersionId']
    image = asyncio.run(client.server.call_tool('get_asset_preview', {'asset_id': asset['id']}))
    assert image[0].type == 'image'
    assert image[0].mimeType == 'image/png'
    preview = client.call('preview_asset_repair', asset_id=asset['id'], version_id=base, actions=[{'id': 'resize-nearest-v1'}])
    assert preview['ok'] is True
    assert preview['changes'][0]['after'] == [64, 64]
    assert preview['report']['findings'] == []
    committed = client.call('commit_asset_repair', asset_id=asset['id'], preview_id=preview['previewId'], expected_current_version_id=base)
    assert committed['ok'] is True
    assert committed['resultVersionId'] != base
    assert client.call('inspect_asset', asset_id=asset['id'])['report']['findings'] == []
    assert client.call('list_reports', asset_id=asset['id'])[0]['assetVersionId'] == committed['resultVersionId']
    duplicate = client.call('commit_asset_repair', asset_id=asset['id'], preview_id=preview['previewId'], expected_current_version_id=base)
    assert duplicate['resultVersionId'] == committed['resultVersionId']


def test_mcp_rejects_stale_document_update_and_preview(tmp_path):
    client = LocalClient(tmp_path, allow_write=True)
    project = client.call('create_project', name='MCP')
    asset = client.call('create_blank_asset', project_id=project['id'], name='sprite', width=8, height=8)
    asset = client.call('get_asset', asset_id=asset['id'], include_document=True)
    base = asset['currentVersionId']
    preview = client.call('preview_asset_repair', asset_id=asset['id'], version_id=base, actions=[{'id': 'resize-nearest-v1'}])
    document = asset['document']
    document['name'] = 'new name'
    first = client.call('update_asset_document', asset_id=asset['id'], expected_current_version_id=base, document=document)
    assert first['ok'] is True
    assert 'report' in client.call('inspect_asset', asset_id=asset['id'])
    stale = client.call('update_asset_document', asset_id=asset['id'], expected_current_version_id=base, document=document)
    assert stale['code'] == 'version_conflict'
    assert stale['retryable'] is False
    stale_preview = client.call('commit_asset_repair', asset_id=asset['id'], preview_id=preview['previewId'], expected_current_version_id=first['asset']['currentVersionId'])
    assert stale_preview['code'] == 'version_conflict'


def test_server_instances_have_isolated_workspaces_and_frozen_permissions(tmp_path, monkeypatch):
    first = LocalClient(tmp_path / 'one', allow_write=True)
    second = LocalClient(tmp_path / 'two')
    monkeypatch.setenv('PIXELART_MCP_ALLOW_WRITE', '1')
    monkeypatch.setenv('PIXELART_DATA_DIR', str(tmp_path / 'wrong'))
    first.call('create_project', name='private')
    assert second.call('list_projects') == []
    assert second.call('create_project', name='blocked')['code'] == 'permission_denied'
    assert not (tmp_path / 'wrong').exists()


@pytest.mark.parametrize('host', ['0.0.0.0', '::', 'example.test', '192.168.1.1'])
def test_unauthenticated_remote_bind_is_rejected(tmp_path, host):
    with pytest.raises(ValueError, match='loopback'):
        create_mcp_server(tmp_path, host=host)
    assert not (tmp_path / 'pixelart.sqlite3').exists()


def test_schema_and_discovery_do_not_open_database(tmp_path):
    client = LocalClient(tmp_path / 'unused')
    caps = client.call('get_capabilities')
    assert caps['contractVersion'] == '1'
    assert 'generation' in caps['features']
    assert 'multi-tenant' in caps['unavailable']
    assert caps['writeEnabled'] is False
    tools = {tool.name: tool for tool in asyncio.run(client.server.list_tools())}
    assert tools['export_asset'].inputSchema['required'] == ['asset_id', 'version_id']
    assert tools['export_asset'].outputSchema
    assert tools['export_asset'].annotations.readOnlyHint
    contract = asyncio.run(client.server.read_resource('pixelart://contract/v1'))
    assert json.loads(list(contract)[0].content)['capabilities'] == caps
    assert not (tmp_path / 'unused').exists()


def test_errors_do_not_echo_sensitive_exception_or_validation_input(tmp_path):
    secret = 'sk-not-a-real-key'
    for error in (RuntimeError(secret), ValueError(secret), PermissionError(secret), KeyError(secret)):
        assert secret not in error_result(error).model_dump_json()
    client = LocalClient(tmp_path, allow_write=True)
    failure = client.call('update_asset_document', asset_id='missing', expected_current_version_id='missing', document={'name': secret})
    assert failure['code'] == 'invalid_input'
    assert secret not in json.dumps(failure)


@pytest.mark.parametrize('target', ['png', 'frames', 'sheet', 'json', 'godot'])
def test_export_resource_returns_saved_version_without_writes(tmp_path, target):
    client = LocalClient(tmp_path, allow_write=True)
    project = client.call('create_project', name='export')
    asset = client.call('create_blank_asset', project_id=project['id'], name='before', width=8, height=8)
    asset = client.call('get_asset', asset_id=asset['id'], include_document=True)
    if target == 'godot':
        document = asset['document']
        document['animations'] = [{'action': 'idle', 'direction': 'down', 'frames': [{'frameId': 'frame_0', 'durationMs': 200}]}]
        asset = client.call('update_asset_document', asset_id=asset['id'], expected_current_version_id=asset['currentVersionId'], document=document)['asset']
        client.call('inspect_asset', asset_id=asset['id'])
    base = asset['currentVersionId']
    client.call('rename_asset', asset_id=asset['id'], expected_current_version_id=base, name='after')
    client.call('inspect_asset', asset_id=asset['id'])
    reader = LocalClient(tmp_path)
    descriptor = reader.call('export_asset', asset_id=asset['id'], version_id=base, target=target)
    assert descriptor['ok'] is True, descriptor
    assert descriptor['versionId'] == base
    assert str(tmp_path) not in json.dumps(descriptor)
    resource = list(asyncio.run(reader.server.read_resource(descriptor['resourceUri'])))[0]
    assert resource.mime_type == descriptor['mimeType']
    assert len(resource.content) == descriptor['byteLength']
    if target == 'png':
        assert resource.content.startswith(b'\x89PNG\r\n\x1a\n')
    else:
        with zipfile.ZipFile(io.BytesIO(resource.content)) as archive:
            assert any(name.endswith('manifest.json') for name in archive.namelist())
    assert reader.call('get_asset', asset_id=asset['id'])['name'] == 'after'


def test_export_rejects_foreign_versions_and_invalid_frame_selection(tmp_path):
    client = LocalClient(tmp_path, allow_write=True)
    project = client.call('create_project', name='export')
    one = client.call('create_blank_asset', project_id=project['id'], name='one')
    two = client.call('create_blank_asset', project_id=project['id'], name='two')
    assert client.call('export_asset', asset_id=one['id'], version_id=two['currentVersionId'])['code'] == 'not_found'
    assert client.call('export_asset', asset_id=one['id'], version_id=one['currentVersionId'], target='json', frame_id='frame_0')['code'] == 'invalid_input'


def test_cli_from_another_directory_and_schema_is_pure(tmp_path):
    env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[2])}
    root = tmp_path / 'unused'
    result = subprocess.run([sys.executable, '-m', 'backend.mcp_cli', '--schema', '--data-dir', str(root)], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    schema = json.loads(result.stdout)
    assert schema['contractVersion'] == '1'
    assert 'export_asset' in {tool['name'] for tool in schema['tools']}
    catalog = {tool['name']: tool for tool in schema['tools']}
    assert catalog['rename_asset']['_meta']['pixelarting/authorization']['requiredOAuthScopes'] == ['pixelart:read', 'pixelart:write']
    assert all('meta' not in tool for tool in schema['tools'])
    assert all('_meta' in item for item in schema['resources'] + schema['resourceTemplates'])
    assert not root.exists()


@pytest.mark.parametrize('tool,args', [
    ('start_generation', {'request': {'mode': 'agent_draw', 'prompt': 'sprite'}, 'idempotency_key': 'one'}),
    ('retry_generation', {'generation_id': 'absent', 'idempotency_key': 'retry'}),
    ('cancel_generation', {'generation_id': 'absent'}),
    ('update_candidate_state', {'generation_id': 'absent', 'candidate_id': 'one', 'state': {'favorite': True}}),
    ('import_generation_candidate', {'generation_id': 'absent', 'candidate_id': 'one'}),
])
def test_generation_write_tools_respect_gate_without_opening_workspace(tmp_path, tool, args):
    root = tmp_path / 'unused'
    client = LocalClient(root)
    assert client.call(tool, **args)['code'] == 'permission_denied'
    assert not root.exists()


def test_generation_contract_and_unconfigured_provider(tmp_path):
    client = LocalClient(tmp_path, allow_write=True)
    contract = list(asyncio.run(client.server.read_resource('pixelart://contract/tasks/v1')))[0]
    assert json.loads(contract.content)['taskSchema']['properties']['revision']
    result = client.call('start_generation', request={'mode': 'agent_draw', 'prompt': 'sprite'}, idempotency_key='one')
    assert result['code'] == 'not_configured'
    assert client.call('list_generations')['generations'] == []
