"""Validate published schemas against legacy wire shapes and historical records."""

import asyncio
import json

from jsonschema import Draft202012Validator
import pytest

from backend.mcp_server import create_mcp_server
from backend.store import Store


def test_every_json_tool_has_a_field_contract_and_resolvable_schema(tmp_path):
    server = create_mcp_server(tmp_path / 'unused')
    tools = asyncio.run(server.list_tools())
    for tool in tools:
        Draft202012Validator.check_schema(tool.inputSchema)
        if tool.name in {'get_asset_preview', 'get_candidate_preview'}:
            assert tool.outputSchema is None  # Native MCP image content.
            continue
        assert tool.outputSchema and tool.outputSchema['type'] == 'object', tool.name
        Draft202012Validator.check_schema(tool.outputSchema)
        assert '"additionalProperties": true' not in json.dumps(tool.outputSchema).replace('"provenance": {"additionalProperties": true', '"provenance": {"allowed": true'), tool.name
    assert not (tmp_path / 'unused').exists()


def test_published_schemas_preserve_objects_lists_documents_and_old_reports(tmp_path):
    server = create_mcp_server(tmp_path, allow_write=True)
    schemas = {tool.name: tool.outputSchema for tool in asyncio.run(server.list_tools())}
    def call(tool_name, **arguments):
        content, structured = asyncio.run(server.call_tool(tool_name, arguments))
        Draft202012Validator(schemas[tool_name]).validate(structured)
        # SDK text and structured output must describe the same wire object.
        payload = structured.get('result', structured)
        text = [json.loads(item.text) for item in content] if isinstance(payload, list) else json.loads(content[0].text)
        assert text == payload
        return structured.get('result', structured)
    assert call('pixelart_health')['ok']
    project = call('create_project', name='contracts')
    assert call('list_projects') == [project]
    asset = call('create_blank_asset', project_id=project['id'], name='sprite', width=64, height=64)
    store = Store(tmp_path)
    assert asset == store.asset(asset['id'])
    assert 'document' not in call('get_asset', asset_id=asset['id'])
    assert call('get_asset', asset_id=asset['id'], include_document=True) == asset
    assert 'blendMode' not in asset['document']['layers'][0]
    call('get_asset_version', asset_id=asset['id'], version_id=asset['currentVersionId'])
    assert call('list_assets', project_id=project['id']) == store.list_assets(project['id'])
    call('get_project_config', project_id=project['id'])
    call('inspect_asset', asset_id=asset['id'])
    # Older report rows do not have every current executor/config field.
    old = store.save_report(asset['id'], asset['currentVersionId'], {
        'findings': [], 'config': {'retiredOption': {'threshold': .25}, 'godotVersion': 'historical'},
    })
    assert call('list_reports', asset_id=asset['id']) == [old]
    preview = call('preview_asset_repair', asset_id=asset['id'], version_id=asset['currentVersionId'], actions=[{'id': 'resize-nearest-v1'}])
    result = call('commit_asset_repair', asset_id=asset['id'], preview_id=preview['previewId'], expected_current_version_id=asset['currentVersionId'])
    call('inspect_asset', asset_id=asset['id'])
    assert result['report']['ruleVersions']
    assert call('get_asset', asset_id='missing')['code'] == 'not_found'
    assert call('list_assets', project_id='missing') == []
    assert call('list_reports', asset_id='missing')[0]['code'] == 'not_found'


@pytest.mark.parametrize('name,argument,valid,invalid', [
    ('update_asset_document', 'document', {'name': 'sprite', 'layers': [{'id': 'base', 'name': 'base'}], 'frames': [{'id': 'frame_0', 'width': 8, 'height': 8, 'pixels': {'base': 'png'}}]}, {'name': 'sprite'}),
    ('update_project_config', 'config', {'maxColors': 4}, {'maxColors': 0}),
    ('preview_asset_repair', 'actions', [{'id': 'resize-nearest-v1'}], [{'id': 'unknown-repair'}]),
    ('preview_file_import', 'options', {'layout': {'cellWidth': 8, 'cellHeight': 8}, 'mapping': [{'frameIndex': 0, 'action': 'idle', 'direction': 'down'}]}, {'mapping': [{'frameIndex': 0, 'action': 'unknown', 'direction': 'down'}]}),
])
def test_domain_input_schemas_resolve_nested_types_and_reject_invalid_fields(tmp_path, name, argument, valid, invalid):
    server = create_mcp_server(tmp_path)
    tool = next(tool for tool in asyncio.run(server.list_tools()) if tool.name == name)
    validator = Draft202012Validator(tool.inputSchema['properties'][argument])
    validator.validate(valid)
    assert not validator.is_valid(invalid)
