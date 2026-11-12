"""Real tool receipts: atomic rollback, concurrent processes and safe replays."""

import asyncio
from concurrent.futures import ProcessPoolExecutor
from copy import deepcopy
import json
import multiprocessing
import os

from jsonschema import Draft202012Validator
import pytest

from backend.generation_service import GenerationService
from backend.mcp_idempotency import GENERIC_WRITE_TOOLS, IDEMPOTENCY_META, IDEMPOTENCY_RULES, IDEMPOTENCY_URI
from backend.mcp_policy import WRITES
from backend.models import AiGenerationRequest
from backend.store import Store
from backend.tests.test_mcp import LocalClient
from backend.tests.test_mcp_security import authenticated, call, environment, signing_key
from backend.mcp_server import create_mcp_server


def prepare(root, name):
    client = LocalClient(root, allow_write=True)
    project = client.call('create_project', name='existing')
    asset = client.call('create_blank_asset', project_id=project['id'], name='sprite', width=8, height=8)
    base = asset['currentVersionId']
    args = {'asset_id': asset['id'], 'expected_current_version_id': base}
    if name == 'create_project':
        args = {'name': 'created once'}
    elif name == 'create_blank_asset':
        args = {'project_id': project['id'], 'name': 'created once', 'width': 8, 'height': 8}
    elif name == 'update_project_config':
        args = {'project_id': project['id'], 'config': {'targetWidth': 32}}
    elif name == 'update_asset_document':
        document = deepcopy(asset['document'])
        document['name'] = 'edited'
        args['document'] = document
    elif name == 'rename_asset':
        args['name'] = 'renamed'
    elif name in {'preview_asset_repair', 'commit_asset_repair'}:
        preview_args = {'asset_id': asset['id'], 'version_id': base, 'actions': [{'id': 'resize-nearest-v1'}]}
        if name == 'preview_asset_repair':
            args = preview_args
        else:
            preview = client.call('preview_asset_repair', **preview_args)
            args['preview_id'] = preview['previewId']
    elif name == 'restore_asset_version':
        newer = client.call('rename_asset', **args, name='newer')
        args.update(expected_current_version_id=newer['currentVersionId'], version_id=base)
    else:
        store = Store(root)
        task = store.create_generation(AiGenerationRequest(projectId=project['id'], mode='agent_draw', prompt='fixture only'))
        args = {'generation_id': task.id}
        if name != 'cancel_generation':
            store.update_generation(task.id, 'running')
            store.update_generation(task.id, 'succeeded', result={'candidates': [
                {'id': 'one', 'summary': 'fixture', 'document': asset['document']}], 'model': 'fixture'})
            args['candidate_id'] = 'one'
            if name == 'update_candidate_state':
                args['state'] = {'favorite': True}
    return client, args


def snapshot(root):
    with Store(root).connection() as connection:
        return {table: [tuple(row) for row in connection.execute(f'SELECT * FROM {table} ORDER BY rowid')]
                for table in ('projects', 'project_configs', 'assets', 'versions', 'previews', 'reports',
                              'ai_generations', 'ai_candidate_selections', 'mcp_write_requests')}


@pytest.mark.parametrize('name', sorted(GENERIC_WRITE_TOOLS))
def test_every_remaining_write_replays_original_schema_valid_response_after_restart(tmp_path, name):
    client, args = prepare(tmp_path, name)
    first = client.call(name, **args, idempotency_key='one-write')
    assert first.get('ok') is not False, first
    saved = snapshot(tmp_path)
    restarted = LocalClient(tmp_path, allow_write=True)
    again = restarted.call(name, **args, idempotency_key='one-write')
    assert again == first
    assert snapshot(tmp_path) == saved
    schema = next(tool.outputSchema for tool in asyncio.run(restarted.server.list_tools()) if tool.name == name)
    wire = {'result': again} if name in {'cancel_generation', 'update_candidate_state', 'import_generation_candidate'} else again
    Draft202012Validator(schema).validate(wire)


@pytest.mark.parametrize('name', sorted(GENERIC_WRITE_TOOLS))
def test_receipt_failure_rolls_back_every_business_effect_and_does_not_reserve_key(tmp_path, name):
    client, args = prepare(tmp_path, name)
    before = snapshot(tmp_path)
    with Store(tmp_path).connection() as connection:
        connection.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON mcp_write_requests BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END")
    failure = client.call(name, **args, idempotency_key='atomic')
    assert failure['code'] == 'internal_error'
    assert snapshot(tmp_path) == before
    with Store(tmp_path).connection() as connection:
        connection.execute('DROP TRIGGER fail_receipt')
    assert client.call(name, **args, idempotency_key='atomic').get('ok') is not False


@pytest.mark.parametrize('kind', ['project', 'asset', 'version', 'preview', 'report', 'generation'])
def test_missing_original_result_is_a_persistent_conflict_not_recreation(tmp_path, kind):
    name = {'project': 'create_project', 'asset': 'create_blank_asset', 'version': 'rename_asset',
            'preview': 'preview_asset_repair', 'report': 'commit_asset_repair', 'generation': 'cancel_generation'}[kind]
    client, args = prepare(tmp_path, name)
    result = client.call(name, **args, idempotency_key='deleted')
    assert result.get('ok') is not False
    store = Store(tmp_path)
    with store.connection() as connection:
        refs = json.loads(connection.execute('SELECT resource_refs FROM mcp_write_requests').fetchone()[0])
        resource_id = next(resource_id for ref_kind, resource_id in refs if kind == ref_kind)
    if kind == 'asset':
        store.delete_asset(resource_id, result['currentVersionId'])
    else:
        table = {'project': 'projects', 'version': 'versions', 'preview': 'previews', 'report': 'reports', 'generation': 'ai_generations'}[kind]
        with store.connection() as connection:
            connection.execute(f'DELETE FROM {table} WHERE id=?', (resource_id,))
    deleted = snapshot(tmp_path)
    assert client.call(name, **args, idempotency_key='deleted')['code'] == 'idempotency_conflict'
    assert LocalClient(tmp_path, allow_write=True).call(name, **args, idempotency_key='deleted')['code'] == 'idempotency_conflict'
    assert snapshot(tmp_path) == deleted


def test_replay_does_not_undo_later_document_config_or_candidate_state(tmp_path):
    client, args = prepare(tmp_path, 'rename_asset')
    first = client.call('rename_asset', **args, idempotency_key='rename')
    latest = client.call('rename_asset', asset_id=first['id'], expected_current_version_id=first['currentVersionId'], name='later')
    assert client.call('rename_asset', **args, idempotency_key='rename') == first
    assert client.call('get_asset', asset_id=first['id'])['currentVersionId'] == latest['currentVersionId']
    config_args = {'project_id': first['projectId'], 'config': {'targetWidth': 32}}
    saved = client.call('update_project_config', **config_args, idempotency_key='config')
    client.call('update_project_config', **{**config_args, 'config': {'targetWidth': 16}})
    assert client.call('update_project_config', **config_args, idempotency_key='config') == saved
    assert client.call('get_project_config', project_id=first['projectId'])['targetWidth'] == 16
    candidate_client, state_args = prepare(tmp_path / 'candidates', 'update_candidate_state')
    state = candidate_client.call('update_candidate_state', **state_args, idempotency_key='state')
    candidate_client.call('update_candidate_state', **{**state_args, 'state': {'discarded': True}})
    assert candidate_client.call('update_candidate_state', **state_args, idempotency_key='state') == state
    assert candidate_client.call('get_generation', generation_id=state_args['generation_id'])['candidates'][0]['discarded']


def test_keys_bind_operation_arguments_and_defaulted_parameters(tmp_path):
    client = LocalClient(tmp_path, allow_write=True)
    project = client.call('create_project', name='project', idempotency_key='workspace-key')
    assert client.call('create_project', name='different', idempotency_key='workspace-key')['code'] == 'idempotency_conflict'
    assert client.call('create_blank_asset', project_id=project['id'], name='asset', idempotency_key='workspace-key')['code'] == 'idempotency_conflict'
    asset = client.call('create_blank_asset', project_id=project['id'], name='asset', idempotency_key='asset')
    assert client.call('create_blank_asset', name='asset', height=64, width=64, project_id=project['id'], idempotency_key='asset') == asset
    assert len(client.call('list_projects')) == 1
    assert len(client.call('list_assets', project_id=project['id'])) == 1


@pytest.mark.parametrize('key', ['', 'x' * 129, '../escape', '中文', 'space key'])
def test_invalid_keys_and_write_gate_do_not_open_workspace(tmp_path, key):
    root = tmp_path / 'unused'
    assert LocalClient(root, allow_write=True).call('create_project', name='bad', idempotency_key=key)['code'] == 'invalid_input'
    assert not root.exists()
    assert LocalClient(root).call('create_project', name='bad', idempotency_key='valid')['code'] == 'permission_denied'
    assert not root.exists()


def test_failure_return_after_partial_commit_step_rolls_back_and_key_can_retry(tmp_path, monkeypatch):
    client, args = prepare(tmp_path, 'commit_asset_repair')
    before = snapshot(tmp_path)
    with monkeypatch.context() as scoped:
        def fail(*args, **kwargs):
            raise RuntimeError('fixture report failure')
        scoped.setattr(Store, 'save_report', fail)
        assert client.call('commit_asset_repair', **args, idempotency_key='repair')['code'] == 'internal_error'
    assert snapshot(tmp_path) == before
    committed = client.call('commit_asset_repair', **args, idempotency_key='repair')
    assert committed['ok']
    assert client.call('inspect_asset', asset_id=args['asset_id'])['versionId'] == committed['resultVersionId']


def test_invalid_success_output_rolls_back_before_creating_a_receipt(tmp_path, monkeypatch):
    client = LocalClient(tmp_path, allow_write=True)
    original = Store.project
    def invalid_output(self, name):
        project = original(self, name)
        project.pop('created')
        return project
    with monkeypatch.context() as scoped:
        scoped.setattr(Store, 'project', invalid_output)
        assert client.call('create_project', name='invalid output', idempotency_key='schema')['code'] == 'internal_error'
    assert Store(tmp_path).list_projects() == []
    assert snapshot(tmp_path)['mcp_write_requests'] == []
    assert client.call('create_project', name='valid output', idempotency_key='schema')['id']


def test_cancellation_notifies_only_after_durable_commit_and_replay_can_notify(tmp_path, monkeypatch):
    client, args = prepare(tmp_path, 'cancel_generation')
    notified = []
    monkeypatch.setattr(GenerationService, 'signal_cancel', lambda self, generation_id: notified.append(generation_id))
    with Store(tmp_path).connection() as connection:
        connection.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON mcp_write_requests BEGIN SELECT RAISE(ABORT, 'fixture'); END")
    assert client.call('cancel_generation', **args, idempotency_key='cancel')['code'] == 'internal_error'
    assert notified == []
    assert Store(tmp_path).generation(args['generation_id']).status == 'queued'
    with Store(tmp_path).connection() as connection:
        connection.execute('DROP TRIGGER fail_receipt')
    first = client.call('cancel_generation', **args, idempotency_key='cancel')
    assert client.call('cancel_generation', **args, idempotency_key='cancel') == first
    assert notified == [args['generation_id'], args['generation_id']]


def _process_write(root):
    from pathlib import Path
    return LocalClient(Path(root), allow_write=True).call('create_project', name='concurrent', idempotency_key='cross-process')


def test_concurrent_processes_commit_one_project_and_survive_restart(tmp_path):
    Store(tmp_path)
    with ProcessPoolExecutor(max_workers=3, mp_context=multiprocessing.get_context('spawn')) as pool:
        results = list(pool.map(_process_write, [str(tmp_path)] * 3))
    assert all(result == results[0] for result in results)
    assert len(Store(tmp_path).list_projects()) == 1
    assert _process_write(str(tmp_path)) == results[0]


def _crash_during_write(root, after_commit):
    from pathlib import Path
    if not after_commit:
        original = Store.project
        def die_before_receipt(self, name):
            original(self, name)
            os._exit(23)
        Store.project = die_before_receipt
    _process_write(root)
    os._exit(24)


@pytest.mark.parametrize('after_commit', [False, True])
def test_process_crash_before_commit_rolls_back_and_lost_committed_response_replays(tmp_path, after_commit):
    Store(tmp_path)
    process = multiprocessing.get_context('spawn').Process(target=_crash_during_write, args=(str(tmp_path), after_commit))
    process.start()
    process.join(timeout=30)
    if process.is_alive():
        process.kill()
        process.join(timeout=5)
        pytest.fail('Isolated write process failed to reach its crash point')
    assert process.exitcode == (24 if after_commit else 23)
    assert len(Store(tmp_path).list_projects()) == int(after_commit)
    with Store(tmp_path).connection() as connection:
        receipt = connection.execute('SELECT response FROM mcp_write_requests').fetchone()
    assert (receipt is not None) is after_commit
    result = _process_write(str(tmp_path))
    if after_commit:
        assert result == json.loads(receipt[0])
    assert len(Store(tmp_path).list_projects()) == 1


def test_business_conflict_reserves_no_key_and_null_key_keeps_legacy_semantics(tmp_path):
    client, args = prepare(tmp_path, 'rename_asset')
    assert client.call('rename_asset', **{**args, 'expected_current_version_id': 'stale'}, idempotency_key='retry-valid')['code'] == 'version_conflict'
    assert snapshot(tmp_path)['mcp_write_requests'] == []
    assert client.call('rename_asset', **args, idempotency_key='retry-valid')['name'] == 'renamed'
    first = client.call('create_project', name='legacy', idempotency_key=None)
    second = client.call('create_project', name='legacy')
    assert first['id'] != second['id']


def test_receipt_replay_rechecks_oauth_scope_project_and_gate(environment):
    env = environment
    args = {'asset_id': env['first']['id'], 'expected_current_version_id': env['first']['currentVersionId'], 'name': 'authorized', 'idempotency_key': 'protected'}
    server = create_mcp_server(env['root'], allow_write=True, oauth=env['config'])
    with authenticated(env, 'writer'):
        first = call(server, 'rename_asset', **args)
        assert call(server, 'rename_asset', **args) == first
    from mcp.server.fastmcp.exceptions import ToolError
    with authenticated(env, 'reader'), pytest.raises(ToolError):
        call(server, 'rename_asset', **args)
    with authenticated(env, 'writer'), pytest.raises(ToolError):
        call(create_mcp_server(env['root'], oauth=env['config']), 'rename_asset', **args)
    restricted = env['config'].model_copy(deep=True)
    restricted.principals['writer'] = restricted.principals['writer'].model_copy(update={'projects': frozenset()})
    env['config'] = restricted
    with authenticated(env, 'writer'), pytest.raises(ToolError):
        call(create_mcp_server(env['root'], allow_write=True, oauth=restricted), 'rename_asset', **args)


def test_all_writes_disclose_keys_and_readonly_discovery_is_pure(tmp_path):
    root = tmp_path / 'unused'
    client = LocalClient(root)
    catalog = {tool.name: tool for tool in asyncio.run(client.server.list_tools())}
    assert set(IDEMPOTENCY_RULES) == WRITES
    contract = json.loads(list(asyncio.run(client.server.read_resource(IDEMPOTENCY_URI)))[0].content)
    assert set(contract['tools']) == WRITES
    for name in WRITES:
        tool = catalog[name]
        assert tool.meta[IDEMPOTENCY_META] == contract['tools'][name]
        assert 'idempotency_key' in tool.inputSchema['properties']
        assert ('idempotency_key' in tool.inputSchema.get('required', [])) is (name not in GENERIC_WRITE_TOOLS)
    assert not root.exists()
