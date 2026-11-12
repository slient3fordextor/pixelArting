"""Synthetic archives for installed-client acceptance, using only the standard library."""

import hashlib
import io
import json
import zipfile


def project_backup_fixture(bundle: bytes, asset_id: str, version_id: str, config: dict) -> bytes:
    """Wrap an actual exported asset ZIP in a current-version project archive."""
    prefix = f'assets/{asset_id}/'
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        files = {prefix + name: archive.read(name) for name in archive.namelist()}
    files['project.json'] = json.dumps({
        'format': 'pixelart-project', 'formatVersion': 1, 'scope': 'current-versions',
        'project': {'name': 'acceptance fixture'}, 'config': config,
        'assets': [{'path': prefix + 'asset.json', 'sourceAssetId': asset_id, 'sourceVersionId': version_id}],
    }).encode()
    files['manifest.json'] = json.dumps({
        'schemaVersion': '1.1', 'files': {name: hashlib.sha256(value).hexdigest() for name, value in files.items()},
    }).encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()
