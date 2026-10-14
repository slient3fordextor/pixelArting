import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.images import png_bytes


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def create_asset(client, image, fields=None):
    project = client.post('/api/projects', json={'name': '版本修复测试'}).json()
    response = client.post(f'/api/projects/{project["id"]}/assets', files={'file': ('source.png', png_bytes(image), 'image/png')}, data=fields or {})
    assert response.status_code == 201
    return response.json()


def test_repair_preview_tracks_canvas_metadata_and_exact_changed_bounds(client):
    image = Image.new('RGBA', (4, 4))
    image.putpixel((2, 2), (255, 0, 0, 255))
    asset = create_asset(client, image)
    path = f'/api/assets/{asset["id"]}'
    asset['document']['frames'][0].update(origin={'x': 1, 'y': 1}, baselineY=2, collisionRects=[{'x': 1, 'y': 1, 'width': 2, 'height': 2}])
    asset = client.post(path + '/save', json={'expectedCurrentVersionId': asset['currentVersionId'], 'document': asset['document']}).json()
    response = client.post(path + '/preview', json={
        'versionId': asset['currentVersionId'], 'config': {'targetWidth': 8, 'targetHeight': 8},
        'actions': [{'id': 'pad-canvas-v1', 'offsetX': 1, 'offsetY': 2}],
    })
    assert response.status_code == 200
    preview = response.json()
    assert preview['baseVersionId'] == asset['currentVersionId']
    assert preview['actions'] == [{'id': 'pad-canvas-v1', 'alphaThreshold': 128, 'offsetX': 1, 'offsetY': 2}]
    change = preview['changes'][0]
    assert change['before'] == [4, 4]
    assert change['after'] == [8, 8]
    assert change['changedPixels'] == 2
    assert change['changedBounds'] == {'x': 2, 'y': 2, 'width': 2, 'height': 3}
    assert change['metadataBefore'] == {'origin': {'x': 1, 'y': 1}, 'baselineY': 2, 'collisionRects': [{'x': 1, 'y': 1, 'width': 2, 'height': 2}]}
    assert change['metadataAfter'] == {'origin': {'x': 2, 'y': 3}, 'baselineY': 4, 'collisionRects': [{'x': 2, 'y': 3, 'width': 2, 'height': 2}]}
    assert change['metadataChanged'] is True
    assert client.get(path).json()['document'] == asset['document']


def test_per_frame_repair_diff_distinguishes_unchanged_frames(client):
    sheet = Image.new('RGBA', (8, 4))
    sheet.putpixel((1, 1), (255, 0, 0, 255))
    sheet.putpixel((6, 1), (0, 0, 255, 120))
    asset = create_asset(client, sheet, {'cellWidth': 4, 'cellHeight': 4})
    preview = client.post(f'/api/assets/{asset["id"]}/preview', json={'versionId': asset['currentVersionId'], 'actions': [{'id': 'remove-halo-v1', 'alphaThreshold': 160}]}).json()
    first, second = preview['changes']
    assert first['frameId'] == 'frame_0'
    assert first['changedPixels'] == 0
    assert first['changedBounds'] is None
    assert first['metadataChanged'] is False
    assert second['frameId'] == 'frame_1'
    assert second['changedPixels'] == 1
    assert second['changedBounds'] == {'x': 2, 'y': 1, 'width': 1, 'height': 1}


def test_history_report_and_exports_remain_bound_to_requested_version(client):
    image = Image.new('RGBA', (4, 4), (200, 20, 0, 100))
    asset = create_asset(client, image)
    path = f'/api/assets/{asset["id"]}'
    old_version = asset['currentVersionId']
    old_report = client.post(path + '/check', json={'versionId': old_version}).json()
    preview = client.post(path + '/preview', json={'versionId': old_version, 'actions': [{'id': 'remove-halo-v1'}]}).json()
    repaired = client.post(path + '/commit', json={'previewId': preview['previewId'], 'expectedCurrentVersionId': old_version}).json()
    latest_version = repaired['asset']['currentVersionId']
    assert latest_version != old_version
    assert client.get(path + '/reports', params={'versionId': old_version}).json()[0]['id'] == old_report['id']
    assert all(report['assetVersionId'] == old_version for report in client.get(path + '/reports', params={'versionId': old_version}).json())
    assert Image.open(io.BytesIO(client.get(path + '/export', params={'versionId': old_version, 'target': 'png', 'frameId': 'frame_0'}).content)).getpixel((0, 0)) == (200, 20, 0, 100)
    assert Image.open(io.BytesIO(client.get(path + '/export', params={'versionId': latest_version, 'target': 'png', 'frameId': 'frame_0'}).content)).getbbox() is None
    assert client.get(path).json()['currentVersionId'] == latest_version


def test_transparent_padding_changes_size_without_inventing_pixel_changes(client):
    asset = create_asset(client, Image.new('RGBA', (4, 4)))
    preview = client.post(f'/api/assets/{asset["id"]}/preview', json={'versionId': asset['currentVersionId'], 'config': {'targetWidth': 8, 'targetHeight': 8}, 'actions': [{'id': 'pad-canvas-v1'}]}).json()
    change = preview['changes'][0]
    assert change['before'] != change['after']
    assert change['changedPixels'] == 0
    assert change['changedBounds'] is None
    assert change['metadataChanged'] is False
