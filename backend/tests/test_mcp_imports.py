"""File workflow parity, bounded untrusted input and persistent atomic receipts."""

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import zipfile

from jsonschema import Draft202012Validator
from PIL import Image
import pytest

from backend.exchange import export_project
from backend.exports import export_bundle
from backend.images import decode_image, encode_image, png_bytes
from backend.mcp_imports import MAX_BASE64_CHARS, MAX_EXPANDED_BYTES, MAX_IMPORT_BYTES
from backend.mcp_server import create_mcp_server
from backend.models import CheckConfig, Document, Frame, Layer
from backend.store import Store
from backend.tests.test_imports import sheet


def encoded(data):
    return base64.b64encode(data).decode('ascii')


def call(server, tool, **arguments):
    _, structured = asyncio.run(server.call_tool(tool, arguments))
    schema = next(item.outputSchema for item in asyncio.run(server.list_tools()) if item.name == tool)
    Draft202012Validator(schema).validate(structured)
    return structured.get('result', structured)


@pytest.fixture
def workspace(tmp_path):
    store = Store(tmp_path / 'workspace')
    project = store.project('import tests')
    return store, project['id'], create_mcp_server(store.root, allow_write=True)


def test_read_only_preview_slices_and_checks_without_retaining_source(workspace):
    store, project, writer = workspace
    data, layout = sheet()
    reader = create_mcp_server(store.root)
    options = {'name': 'sheet', 'layout': layout, 'mapping': [
        {'frameIndex': 4, 'action': 'walk', 'direction': 'down', 'durationMs': 80},
        {'frameIndex': 3, 'action': 'walk', 'direction': 'down', 'durationMs': 120},
    ], 'mappingConfirmed': True}
    preview = call(reader, 'preview_file_import', project_id=project, data_base64=encoded(data), options=options)
    assert preview['ok'] and preview['sourceChecksum'] == hashlib.sha256(data).hexdigest()
    assert preview['layout'] == {**layout, 'offsetX': 0, 'offsetY': 0, 'cropMode': 'strict'}
    assert len(preview['frames']) == 6 and preview['frames'][0] == {'id': 'frame_0', 'width': 4, 'height': 3}
    assert preview['animations'][0]['frames'] == [{'frameId': 'frame_3', 'durationMs': 120}, {'frameId': 'frame_4', 'durationMs': 80}]
    assert preview['report']['findings']  # Findings are reviewable, not silently repaired.
    assert not (store.root / 'sources').exists() and store.list_assets(project) == []
    assert call(reader, 'import_asset_file', project_id=project, data_base64=encoded(data), idempotency_key='sheet', options=options)['code'] == 'permission_denied'
    result = call(writer, 'import_asset_file', project_id=project, data_base64=encoded(data), idempotency_key='sheet', options=options)
    assert result['ok'] and not result['replayed']
    document = store.document(result['assetId'], result['versionId'])
    assert document.animations[0].frames[0].frameId == 'frame_3'
    for index, frame in enumerate(document.frames):
        assert decode_image(frame.pixels['base']).tobytes() == bytes((index * 30, 100, 200, 255)) * 12
    assert (store.root / document.provenance['originalRef']).read_bytes() == data
    checked = call(writer, 'inspect_asset', asset_id=result['assetId'])
    assert checked['versionId'] == result['versionId']


def test_restart_replay_preserves_initial_version_and_uses_current_quality_config(workspace):
    store, project, writer = workspace
    data = encoded(png_bytes(Image.new('RGBA', (8, 8))))
    args = dict(project_id=project, data_base64=data, idempotency_key='retry')
    first = call(writer, 'import_asset_file', **args)
    current = call(writer, 'get_asset', asset_id=first['assetId'], include_document=True)
    changed = call(writer, 'rename_asset', asset_id=current['id'], expected_current_version_id=current['currentVersionId'], name='edited later')
    call(writer, 'inspect_asset', asset_id=current['id'])
    store.save_project_config(project, CheckConfig(targetWidth=8, targetHeight=8))
    again = call(create_mcp_server(store.root, allow_write=True), 'import_asset_file', **args, options={})
    assert again['replayed'] and again['assetId'] == first['assetId']
    assert again['versionId'] == first['versionId'] != changed['currentVersionId']
    assert again['name'] == first['name'] == 'import'
    assert again['report']['configHash'] != first['report']['configHash']
    assert again['report']['findings'] == []
    assert len(store.list_assets(project)) == 1
    assert store.asset(first['assetId'])['name'] == 'edited later'
    for changes in ({'options': {'name': 'different'}}, {'data_base64': encoded(png_bytes(Image.new('RGBA', (9, 8))))}):
        assert call(writer, 'import_asset_file', **{**args, **changes})['code'] == 'idempotency_conflict'
    other = store.project('other')
    assert call(writer, 'import_asset_file', **{**args, 'project_id': other['id']})['code'] == 'idempotency_conflict'
    store.delete_asset(changed['id'], changed['currentVersionId'])
    assert call(writer, 'import_asset_file', **args)['code'] == 'idempotency_conflict'
    assert store.list_assets(project) == []


def test_concurrent_retries_make_one_asset_and_receipt(workspace):
    store, project, writer = workspace
    data = encoded(png_bytes(Image.new('RGBA', (8, 8))))
    def run(_):
        server = create_mcp_server(store.root, allow_write=True)
        return call(server, 'import_asset_file', project_id=project, data_base64=data, idempotency_key='concurrent')
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(run, range(4)))
    assert all(result['ok'] for result in results), results
    assert len({result['assetId'] for result in results}) == 1
    assert sum(not result['replayed'] for result in results) == 1
    assert len(store.list_assets(project)) == 1
    with store.connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM file_import_requests').fetchone()[0] == 1


def test_receipt_failure_rolls_back_new_asset_and_version(workspace, monkeypatch):
    store, project, _ = workspace
    from backend.mcp_imports import ImportOptions, parse_file
    data = png_bytes(Image.new('RGBA', (8, 8)))
    document = parse_file(data, hashlib.sha256(data).hexdigest(), 'png', ImportOptions())
    original = store._insert_import
    def fail(*args):
        original(*args)
        raise RuntimeError('simulated crash before receipt')
    monkeypatch.setattr(store, '_insert_import', fail)
    with pytest.raises(RuntimeError):
        store.import_asset_once(project, document, 'rollback', 'a' * 64)
    with store.connection() as conn:
        for table in ('assets', 'versions', 'file_import_requests'):
            assert conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == 0
    monkeypatch.setattr(store, '_insert_import', original)
    assert not store.import_asset_once(project, document, 'rollback', 'a' * 64)['replayed']


def test_layered_bundle_round_trip_and_duplicate_names(workspace):
    store, project, writer = workspace
    first = call(writer, 'create_blank_asset', project_id=project, name='source', width=8, height=8)
    document = first['document']
    document['layers'].append({'id': 'overlay', 'name': 'overlay', 'visible': True, 'opacity': 128})
    document['frames'][0]['pixels']['overlay'] = document['frames'][0]['pixels']['base']
    saved = call(writer, 'update_asset_document', asset_id=first['id'], expected_current_version_id=first['currentVersionId'], document=document)['asset']
    call(writer, 'inspect_asset', asset_id=saved['id'])
    source = store.document(saved['id'], saved['currentVersionId'])
    data = export_bundle(source, saved['id'], saved['currentVersionId'], 'json')
    args = dict(project_id=project, data_base64=encoded(data), file_format='layered-zip')
    preview = call(writer, 'preview_file_import', **args)
    assert preview['ok'] and len(preview['layers']) == 2 and preview['layout'] is None
    imported = call(writer, 'import_asset_file', **args, idempotency_key='bundle')
    assert imported['ok'] and imported['name'] == 'source 副本'
    actual = store.document(imported['assetId'], imported['versionId'])
    assert actual.layers == source.layers and actual.frames == source.frames
    assert actual.provenance['importedFrom']['versionId'] == saved['currentVersionId']
    assert call(writer, 'preview_file_import', **args, options={'layout': {'cellWidth': 4}})['code'] == 'invalid_input'
    backup = export_project(store.snapshot_project(project, 64, 160 * 1024 * 1024))
    assert call(writer, 'preview_file_import', **{**args, 'data_base64': encoded(backup)})['code'] == 'invalid_input'


@pytest.mark.parametrize('change', [
    {'data_base64': 'https://private.example/secret'}, {'data_base64': 'data:image/png;base64,AAAA'},
    {'data_base64': 'AAAA\n'}, {'data_base64': 'A' * (MAX_BASE64_CHARS + 1)},
    {'data_base64': encoded(b'x' * (MAX_IMPORT_BYTES + 1))}, {'data_base64': encoded(b'not png')},
    {'options': {'layout': {'cellWidth': 1, 'cellHeight': 0}}},
    {'options': {'mapping': [{'frameIndex': 0, 'action': 'idle', 'direction': 'down'}]}},
    {'options': {'name': 'x' * 101}}, {'options': {'secret': 'sk-private-input'}},
    {'idempotency_key': ''}, {'idempotency_key': '../outside'},
])
def test_invalid_payloads_are_sanitized_without_creating_sources_or_assets(workspace, change):
    store, project, writer = workspace
    args = dict(project_id=project, data_base64=encoded(png_bytes(Image.new('RGBA', (8, 8)))), idempotency_key='invalid')
    result = call(writer, 'import_asset_file', **{**args, **change})
    assert result['code'] == 'invalid_input', result
    assert 'sk-private-input' not in json.dumps(result) and 'private.example' not in json.dumps(result)
    assert store.list_assets(project) == [] and not (store.root / 'sources').exists()


@pytest.mark.parametrize('kind', ['traversal', 'expanded-budget', 'png-pixels'])
def test_untrusted_archives_and_images_obey_mcp_budgets(workspace, kind):
    store, project, writer = workspace
    file_format = 'layered-zip'
    if kind == 'png-pixels':
        data = png_bytes(Image.new('RGBA', (1025, 1024)))
        file_format = 'png'
    else:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('../escape' if kind == 'traversal' else 'large', b'x' if kind == 'traversal' else b'x' * (MAX_EXPANDED_BYTES + 1))
        data = buffer.getvalue()
    assert call(writer, 'import_asset_file', project_id=project, data_base64=encoded(data), file_format=file_format, idempotency_key=kind)['code'] == 'invalid_input'
    assert store.list_assets(project) == [] and not (store.root / 'sources').exists()


def test_layered_bundle_pixel_budget_counts_all_layers_before_decoding(workspace):
    store, project, writer = workspace
    pixels = encode_image(Image.new('RGBA', (512, 512)))
    document = Document(name='over-budget', layers=[Layer(id=f'layer_{index}', name=str(index)) for index in range(5)],
                        frames=[Frame(id='frame_0', width=512, height=512, pixels={f'layer_{index}': pixels for index in range(5)})])
    source = store.create_asset(project, document)
    data = export_bundle(document, source['id'], source['currentVersionId'], 'json')
    assert len(data) < MAX_IMPORT_BYTES  # Compressed byte limits alone cannot protect this case.
    result = call(writer, 'import_asset_file', project_id=project, data_base64=encoded(data), file_format='layered-zip', idempotency_key='layer-budget')
    assert result['code'] == 'invalid_input'
    assert len(store.list_assets(project)) == 1
