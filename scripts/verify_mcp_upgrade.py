"""Verify real installed versions against temporary data and an offline rollback.

Both interpreters must have their respective wheel installed. No source checkout
is added to PYTHONPATH, no worker is started and no external provider is called.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory


WORKFLOW = r'''
import asyncio
import hashlib
import json
from pathlib import Path
import sys
from PIL import Image
from backend.exports import export_png
from backend.images import checksum, encode_image
from backend.models import AiConfigUpdate, AiGenerationRequest, AiProviderConfig, CheckConfig, Document, Frame, Layer
from backend.store import Store

root, phase, manifest_path = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
store = Store(root)
fixture_key = 'fixture-only-not-a-provider-key'
if phase == 'seed':
    project = store.project('upgrade fixture')
    config = CheckConfig(maxColors=3, palette=['#FF0000'])
    store.save_project_config(project['id'], config)
    document = Document(name='before upgrade', layers=[Layer(id='base', name='base')], frames=[Frame(id='frame_0', width=64, height=64, pixels={'base': encode_image(Image.new('RGBA', (64, 64)))})])
    asset = store.create_asset(project['id'], document)
    before = asset['currentVersionId']
    store.save_report(asset['id'], before, {'findings': [], 'config': config.model_dump()})
    changed = document.model_copy(deep=True)
    image = Image.new('RGBA', (64, 64))
    image.putpixel((1,1), (255,0,0,255))
    changed.frames[0].pixels['base'] = encode_image(image)
    preview_id = store.preview(asset['id'], before, changed, [], config.model_dump())
    store.save_ai_config(AiConfigUpdate(apiKey=fixture_key, textModel='fixture-model'))
    task = store.create_generation(AiGenerationRequest(projectId=project['id'], mode='agent_draw', prompt='offline fixture'), AiProviderConfig(apiKey=fixture_key, textModel='snapshot-model'))
    store.update_generation(task.id, 'failed', error='offline fixture failure')
    manifest = {'projectId': project['id'], 'assetId': asset['id'], 'versionId': before, 'previewId': preview_id, 'taskId': task.id}
else:
    manifest = json.loads(manifest_path.read_text())

def snapshot():
    asset = store.asset(manifest['assetId'])
    document = store.document(manifest['assetId'], manifest['versionId'])
    task = store.generation(manifest['taskId'])
    return {
        'projects': store.list_projects(), 'asset': asset,
        'documentChecksum': checksum(document),
        'pngSha256': hashlib.sha256(export_png(document, 'frame_0')).hexdigest(),
        'config': store.project_config(manifest['projectId']).model_dump(),
        'reports': store.list_reports(manifest['assetId']),
        'task': {'id': task.id, 'status': task.status, 'prompt': task.request.prompt},
        'providerCredentialIntact': store.ai_config().apiKey == fixture_key,
        'taskCredentialIntact': store.generation_config(task.id).apiKey == fixture_key,
    }

baseline = snapshot()
if phase == 'upgrade':
    assert baseline == manifest['baseline'], 'Upgrading changed existing records or credentials'
    from backend.mcp_server import create_mcp_server
    server = create_mcp_server(root, allow_write=True)
    async def call(name, arguments):
        result = await server.call_tool(name, arguments)
        return result[1].get('result', result[1])
    async def verify():
        current = await call('get_asset', {'asset_id': manifest['assetId'], 'include_document': True})
        assert current['currentVersionId'] == manifest['versionId']
        committed = await call('commit_asset_repair', {'asset_id': manifest['assetId'], 'preview_id': manifest['previewId'], 'expected_current_version_id': current['currentVersionId']})
        assert committed['ok'] and committed['resultVersionId'] != manifest['versionId']
        checked = await call('inspect_asset', {'asset_id': manifest['assetId']})
        assert checked['versionId'] == committed['resultVersionId']
        assert checked['report']['findings'] == []
        stale = await call('rename_asset', {'asset_id': manifest['assetId'], 'expected_current_version_id': manifest['versionId'], 'name': 'stale overwrite'})
        assert stale['code'] == 'version_conflict'
        descriptor = await call('export_asset', {'asset_id': manifest['assetId'], 'version_id': manifest['versionId']})
        content = list(await server.read_resource(descriptor['resourceUri']))[0].content
        assert hashlib.sha256(content).hexdigest() == baseline['pngSha256']
    asyncio.run(verify())
    reopened = Store(root)
    assert reopened.asset(manifest['assetId'])['currentVersionId'] != manifest['versionId']
    assert reopened.secrets.service == store.secrets.service
elif phase == 'rollback':
    assert baseline == manifest['baseline'], 'Restoring the pre-upgrade backup changed records'
else:
    manifest['baseline'] = baseline
print(json.dumps(manifest))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-python', type=Path, required=True)
    parser.add_argument('--new-python', type=Path, required=True)
    args = parser.parse_args()
    old, new = args.old_python.absolute(), args.new_python.absolute()
    env = {key: value for key, value in os.environ.items() if key != 'PYTHONPATH'}
    # Fail backend exercises the documented SQLite credential fallback safely.
    env['PYTHON_KEYRING_BACKEND'] = 'keyring.backends.fail.Keyring'
    with TemporaryDirectory(prefix='pixelarting-upgrade-check-') as folder:
        root = Path(folder)
        versions = []
        for python in (old, new):
            result = subprocess.run([str(python), '-c', 'from importlib.metadata import version; print(version("pixelarting-mcp"))'],
                                    cwd=root, env=env, capture_output=True, text=True, timeout=15, check=True)
            versions.append(result.stdout.strip())
        if versions[0] == versions[1]:
            parser.error('Upgrade verification requires two different installed service versions')
        workspace, backup, restored = root / 'workspace', root / 'backup', root / 'restored'
        manifest = root / 'manifest.json'
        def run(python, directory, phase):
            result = subprocess.run([str(python), '-c', WORKFLOW, str(directory), phase, str(manifest)],
                                    cwd=root, env=env, capture_output=True, text=True, timeout=45)
            if result.returncode:
                raise RuntimeError(f'{phase} verification failed:\n{result.stderr}')
            return json.loads(result.stdout)
        manifest.write_text(json.dumps(run(old, workspace, 'seed')))
        # No worker or open connection remains; include the entire stopped workspace.
        shutil.copytree(workspace, backup)
        run(new, workspace, 'upgrade')
        shutil.copytree(backup, restored)
        run(old, restored, 'rollback')
    print(f'PASS: {versions[0]} -> {versions[1]} records/credentials, repair, inspection, conflict/export; offline backup restored with {versions[0]}')


if __name__ == '__main__':
    main()
