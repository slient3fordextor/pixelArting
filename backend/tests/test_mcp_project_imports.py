"""Project archive fidelity, atomic recovery, durable replay and untrusted input."""

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
from backend.images import encode_image
from backend.mcp_server import create_mcp_server
from backend.models import Animation, CheckConfig, Document, Frame, FrameRef, Layer, Point, Rect
from backend.store import Store


def encoded(data):
    return base64.b64encode(data).decode('ascii')


def call(server, tool, **arguments):
    content, structured = asyncio.run(server.call_tool(tool, arguments))
    schema = next(item.outputSchema for item in asyncio.run(server.list_tools()) if item.name == tool)
    Draft202012Validator(schema).validate(structured)
    assert json.loads(content[0].text) == structured
    return structured


def members(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def repack(files, rehash=True):
    files = dict(files)
    if rehash:
        manifest = json.loads(files['manifest.json'])
        manifest['files'] = {name: hashlib.sha256(value).hexdigest() for name, value in files.items() if name != 'manifest.json'}
        files['manifest.json'] = json.dumps(manifest).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return buffer.getvalue()


@pytest.fixture
def backup(tmp_path):
    source = Store(tmp_path / 'source')
    project = source.project('source project')
    config = CheckConfig(targetWidth=4, targetHeight=3, maxColors=7, baselineTolerancePx=2)
    source.save_project_config(project['id'], config)
    document = Document(
        name='first', type='character',
        layers=[Layer(id='base', name='body'), Layer(id='gear', name='equipment', visible=False, opacity=73, locked=True)],
        frames=[Frame(id=f'frame_{index}', width=4, height=3,
                      pixels={'base': encode_image(Image.new('RGBA', (4, 3), (200, index * 40, 50, 255))),
                              'gear': encode_image(Image.new('RGBA', (4, 3), (50, 100, index * 40, 128)))},
                      layerOverflow={'base': {'-1,2': '#c81432ff'}}, origin=Point(x=1, y=2), baselineY=2,
                      collisionRects=[Rect(x=1, y=0, width=2, height=3)]) for index in range(2)],
        animations=[Animation(action='idle', direction='down', loop=False,
                              frames=[FrameRef(frameId='frame_1', durationMs=350), FrameRef(frameId='frame_0', durationMs=100)])],
        provenance={'kind': 'original', 'licenseStatus': 'original'},
    )
    first = source.create_asset(project['id'], document)
    first = source.rename(first['id'], first['currentVersionId'], 'first current')
    second = source.create_asset(project['id'], document.model_copy(update={'name': 'second'}, deep=True))
    data = export_project(source.snapshot_project(project['id'], 64, 16 * 1024 * 1024))
    return {'source': source, 'project': project, 'assets': [first, second], 'config': config, 'data': data}


def test_preview_is_pure_and_restore_preserves_all_archived_current_documents(tmp_path, backup):
    root = tmp_path / 'destination'
    reader = create_mcp_server(root)
    preview = call(reader, 'preview_project_import', data_base64=encoded(backup['data']), name='  recovered  ')
    assert preview['ok'] and preview['name'] == 'recovered'
    assert preview['sourceChecksum'] == hashlib.sha256(backup['data']).hexdigest()
    assert preview['config'] == backup['config'].model_dump()
    assert {item['sourceAssetId'] for item in preview['assets']} == {item['id'] for item in backup['assets']}
    assert all(item['report']['config'] == preview['config'] and item['frameCount'] == 2 and item['layerCount'] == 2 for item in preview['assets'])
    assert not root.exists()
    args = {'data_base64': encoded(backup['data']), 'idempotency_key': 'restore', 'name': '  recovered  '}
    assert call(reader, 'import_project_backup', **args)['code'] == 'permission_denied'
    assert not root.exists()
    writer = create_mcp_server(root, allow_write=True)
    imported = call(writer, 'import_project_backup', **args)
    assert imported['ok'] and not imported['replayed'] and imported['project']['name'] == 'recovered'
    store = Store(root)
    assert imported['project']['id'] != backup['project']['id']
    assert store.project_config(imported['project']['id']) == backup['config']
    originals = {asset['id']: asset for asset in backup['assets']}
    for item in imported['assets']:
        original = originals[item['sourceAssetId']]
        assert item['assetId'] not in originals and item['versionId'] == store.asset(item['assetId'])['currentVersionId']
        assert item['sourceVersionId'] == original['currentVersionId']
        actual = store.document(item['assetId'], item['versionId'])
        expected = backup['source'].document(original['id'], original['currentVersionId'])
        for field in ('name', 'type', 'layers', 'frames', 'animations'):
            assert getattr(actual, field) == getattr(expected, field)
        assert actual.provenance['licenseStatus'] == 'original'
        assert len(store.asset(item['assetId'])['versions']) == 1  # No invented history.
        checked = call(writer, 'inspect_asset', asset_id=item['assetId'])
        assert checked['versionId'] == item['versionId']
    assert len(backup['source'].asset(backup['assets'][0]['id'])['versions']) == 2
    assert len(backup['source'].list_projects()) == 1 and not (root / 'sources').exists()


def test_restart_replay_returns_initial_identity_without_reverting_later_edits(tmp_path, backup):
    root = tmp_path / 'destination'
    writer = create_mcp_server(root, allow_write=True)
    args = {'data_base64': encoded(backup['data']), 'idempotency_key': 'persistent', 'name': ' recovered '}
    first = call(writer, 'import_project_backup', **args)
    store = Store(root)
    store.rename_project(first['project']['id'], 'recovered', 'edited project')
    initial = first['assets'][0]
    current = call(writer, 'get_asset', asset_id=initial['assetId'], include_document=True)
    changed = call(writer, 'rename_asset', asset_id=current['id'], expected_current_version_id=current['currentVersionId'], name='edited asset')
    call(writer, 'inspect_asset', asset_id=changed['id'])
    store.save_project_config(first['project']['id'], CheckConfig(targetWidth=8, targetHeight=8))
    replayed = call(create_mcp_server(root, allow_write=True), 'import_project_backup', **{**args, 'name': 'recovered'})
    assert replayed['replayed'] and replayed['project'] == first['project']
    assert [{key: asset[key] for key in ('assetId', 'versionId', 'name')} for asset in replayed['assets']] == [
        {key: asset[key] for key in ('assetId', 'versionId', 'name')} for asset in first['assets']]
    assert replayed['assets'][0]['report']['configHash'] != initial['report']['configHash']
    assert store.asset(changed['id'])['currentVersionId'] == changed['currentVersionId'] != initial['versionId']
    assert store.list_projects()[0]['name'] == 'edited project'
    assert len(store.list_assets(first['project']['id'])) == 2
    assert call(writer, 'import_project_backup', **{**args, 'name': 'different'})['code'] == 'idempotency_conflict'
    assert call(writer, 'import_project_backup', **{**args, 'data_base64': encoded(backup['data'] + b'x')})['code'] == 'idempotency_conflict'


@pytest.mark.parametrize('deleted', ['project', 'asset', 'initial-version'])
def test_deleted_results_leave_tombstones_and_cannot_be_recreated(tmp_path, backup, deleted):
    root = tmp_path / 'destination'
    writer = create_mcp_server(root, allow_write=True)
    args = {'data_base64': encoded(backup['data']), 'idempotency_key': 'deleted'}
    result = call(writer, 'import_project_backup', **args)
    store = Store(root)
    project, asset = result['project'], result['assets'][0]
    if deleted == 'project':
        store.delete_project(project['id'], project['name'], {item['assetId']: item['versionId'] for item in result['assets']})
    elif deleted == 'asset':
        store.delete_asset(asset['assetId'], asset['versionId'])
    else:
        changed = store.rename(asset['assetId'], asset['versionId'], 'later version')
        # Isolated fixture simulates initial-version pruning, not user data.
        with store.connection() as conn:
            conn.execute('DELETE FROM versions WHERE id=?', (asset['versionId'],))
        assert store.asset(asset['assetId'])['currentVersionId'] == changed['currentVersionId']
    before = store.list_projects()
    assert call(create_mcp_server(root, allow_write=True), 'import_project_backup', **args)['code'] == 'idempotency_conflict'
    assert store.list_projects() == before
    with store.connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM project_import_requests').fetchone()[0] == 1


def test_concurrent_imports_commit_one_project_and_all_its_assets(tmp_path, backup):
    root = tmp_path / 'destination'
    store = Store(root)
    def run(_):
        return call(create_mcp_server(root, allow_write=True), 'import_project_backup', data_base64=encoded(backup['data']), idempotency_key='concurrent')
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(run, range(4)))
    assert all(item['ok'] for item in results), results
    assert len({item['project']['id'] for item in results}) == 1 and sum(not item['replayed'] for item in results) == 1
    assert len(store.list_projects()) == 1 and len(store.list_assets(results[0]['project']['id'])) == 2


@pytest.mark.parametrize('failure', ['second-asset', 'receipt'])
def test_database_failure_rolls_back_project_config_assets_versions_and_key(tmp_path, backup, failure):
    store = Store(tmp_path / 'destination')
    with store.connection() as conn:
        conn.execute("CREATE TRIGGER fail_import BEFORE INSERT ON assets WHEN NEW.name='second' BEGIN SELECT RAISE(ABORT,'private database failure'); END"
                     if failure == 'second-asset' else "CREATE TRIGGER fail_import BEFORE INSERT ON project_import_requests BEGIN SELECT RAISE(ABORT,'private database failure'); END")
    writer = create_mcp_server(store.root, allow_write=True)
    args = {'data_base64': encoded(backup['data']), 'idempotency_key': 'rollback'}
    failed = call(writer, 'import_project_backup', **args)
    assert failed['code'] == 'internal_error' and 'private database failure' not in json.dumps(failed)
    with store.connection() as conn:
        for table in ('projects', 'project_configs', 'assets', 'versions', 'project_import_requests'):
            assert conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == 0
        conn.execute('DROP TRIGGER fail_import')
    assert not call(writer, 'import_project_backup', **args)['replayed']


@pytest.mark.parametrize('invalid', ['config', 'format', 'scope', 'duplicate-asset', 'extra-file', 'checksum', 'second-asset', 'source-id'])
def test_invalid_archive_never_creates_a_partial_project(tmp_path, backup, invalid):
    files = members(backup['data'])
    metadata = json.loads(files['project.json'])
    if invalid == 'config': metadata['config']['palette'] = ['sk-private-input']
    elif invalid == 'format': metadata['formatVersion'] = 2
    elif invalid == 'scope': metadata['scope'] = 'full-history'
    elif invalid == 'duplicate-asset': metadata['assets'].append(metadata['assets'][0])
    elif invalid == 'extra-file': files['unlisted/secret'] = b'private'
    elif invalid == 'source-id': metadata['assets'][0]['sourceAssetId'] = 'other'
    elif invalid == 'second-asset':
        path = metadata['assets'][1]['path']
        content = json.loads(files[path])
        content['frames'][0]['pixels']['base'] = '../escape.png'
        files[path] = json.dumps(content).encode()
        prefix = path[:-len('asset.json')]
        inner = {name[len(prefix):]: value for name, value in files.items() if name.startswith(prefix)}
        files[prefix + 'manifest.json'] = members(repack(inner))['manifest.json']
    files['project.json'] = json.dumps(metadata).encode()
    data = repack(files, rehash=invalid != 'checksum')
    if invalid == 'checksum':
        data = repack({**files, 'project.json': files['project.json'] + b' '}, rehash=False)
    root = tmp_path / 'destination'
    writer = create_mcp_server(root, allow_write=True)
    failed = call(writer, 'import_project_backup', data_base64=encoded(data), idempotency_key='bad-archive')
    assert failed['code'] == 'invalid_input' and 'sk-private-input' not in json.dumps(failed)
    assert Store(root).list_projects() == [] and not (root / 'sources').exists()


@pytest.mark.parametrize('change', [{'name': ''}, {'name': '   '}, {'name': 'x' * 81}, {'idempotency_key': '../outside'}, {'data_base64': 'file:///etc/passwd'}, {'data_base64': 'AAAA\n'}])
def test_invalid_arguments_are_sanitized(tmp_path, backup, change):
    writer = create_mcp_server(tmp_path / 'destination', allow_write=True)
    args = {'data_base64': encoded(backup['data']), 'idempotency_key': 'invalid'}
    assert call(writer, 'import_project_backup', **{**args, **change})['code'] == 'invalid_input'


def test_project_pixel_budget_is_cumulative_not_per_asset(tmp_path):
    source = Store(tmp_path / 'source')
    project = source.project('pixel budget')
    pixels = encode_image(Image.new('RGBA', (512, 512)))
    document = Document(name='one', layers=[Layer(id=f'layer_{index}', name=str(index)) for index in range(3)],
                        frames=[Frame(id='frame_0', width=512, height=512, pixels={f'layer_{index}': pixels for index in range(3)})])
    source.create_asset(project['id'], document)
    source.create_asset(project['id'], document.model_copy(update={'name': 'two'}, deep=True))
    data = export_project(source.snapshot_project(project['id'], 64, 16 * 1024 * 1024))
    writer = create_mcp_server(tmp_path / 'destination', allow_write=True)
    assert call(writer, 'import_project_backup', data_base64=encoded(data), idempotency_key='pixel-budget')['code'] == 'invalid_input'
    assert Store(tmp_path / 'destination').list_projects() == []


def test_empty_project_restores_configuration_and_replays(tmp_path):
    config = CheckConfig(targetWidth=13, targetHeight=17, maxColors=5)
    data = export_project({'name': 'empty', 'config': config, 'assets': []})
    writer = create_mcp_server(tmp_path / 'destination', allow_write=True)
    args = {'data_base64': encoded(data), 'idempotency_key': 'empty'}
    assert call(writer, 'preview_project_import', data_base64=args['data_base64'])['assets'] == []
    result = call(writer, 'import_project_backup', **args)
    assert result['ok'] and result['assets'] == []
    assert Store(tmp_path / 'destination').project_config(result['project']['id']) == config
    assert call(writer, 'import_project_backup', **args)['replayed']
