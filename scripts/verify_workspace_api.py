"""Verify an installed Workspace API with disposable data and a fixture issuer.

Run with the test extra installed: python scripts/verify_workspace_api.py
  --server /absolute/path/to/pixelarting-mcp
No repository backend imports, customer data or provider requests are used.
"""

import argparse
import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import subprocess
from tempfile import TemporaryDirectory
import time

from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from openapi_spec_validator import validate


class APICheck:
    def __init__(self, server, root):
        self.server, self.root = server, root
        self.workspace = root / 'workspace'
        self.env = {key: value for key, value in os.environ.items() if key != 'PYTHONPATH'}

    def cli(self, *args):
        result = subprocess.run([str(self.server), '--data-dir', str(self.workspace), *args],
                                cwd=self.root, env=self.env, check=True, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout)

    @contextmanager
    def running(self, writable, *args):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        with (self.root / 'http.log').open('w+') as log:
            child = subprocess.Popen([str(self.server), '--data-dir', str(self.workspace), '--transport', 'streamable-http',
                '--host', '127.0.0.1', '--port', str(port), '--allow-write' if writable else '--read-only', *args],
                cwd=self.root, env=self.env, stdout=subprocess.DEVNULL, stderr=log)
            try:
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if child.poll() is not None:
                        log.seek(0)
                        raise RuntimeError('Installed API exited: ' + log.read())
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=.1): break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise TimeoutError('Installed API did not start')
                yield f'http://127.0.0.1:{port}'
            finally:
                child.terminate()
                try: child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)

    @staticmethod
    async def mcp_call(url, name, arguments):
        async with httpx.AsyncClient(trust_env=False) as http:
            async with streamable_http_client(url + '/mcp', http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(name, arguments)
                    assert not result.isError
                    return result.structuredContent

    def local(self):
        spec = self.cli('--openapi')
        validate(spec)
        assert spec['info']['version'] == '1.0.0' and len(spec['paths']) == 31
        assert not self.workspace.exists(), 'Offline discovery opened a workspace'
        project_args = {'name': 'API installation fixture', 'idempotency_key': 'api-project'}
        with self.running(True) as url, httpx.Client(base_url=url + '/api/v1', trust_env=False) as http:
            live = http.get('/openapi.json')
            assert live.status_code == 200 and live.json() == spec
            assert 'workspace-http-v1' in http.get('/capabilities').json()['features']
            project = http.post('/projects', json=project_args).json()
            assert asyncio.run(self.mcp_call(url, 'create_project', project_args)) == project
            blank = {'project_id': project['id'], 'name': 'sprite', 'width': 64, 'height': 64, 'idempotency_key': 'api-blank'}
            asset = asyncio.run(self.mcp_call(url, 'create_blank_asset', blank))
            body = {key: value for key, value in blank.items() if key != 'project_id'}
            assert http.post('/projects/' + project['id'] + '/assets/blank', json=body).json() == asset
            path = '/assets/' + asset['id']
            current = http.get(path, params={'include_document': True}).json()
            assert current['currentVersionId'] == asset['currentVersionId'] and current['document']
            assert http.get(path + '/inspection').json()['report']['findings'] == []
            descriptor = http.get(path + '/versions/' + asset['currentVersionId'] + '/export').json()['result']
            png = http.get('/resources', params={'uri': descriptor['resourceUri']})
            assert png.status_code == 200 and png.headers['content-type'] == 'image/png'
            assert png.content.startswith(b'\x89PNG\r\n\x1a\n')
            assert http.get('/resources', params={'uri': 'file:///etc/passwd'}).status_code == 404
        with self.running(False) as url, httpx.Client(base_url=url + '/api/v1', trust_env=False) as http:
            assert http.post('/projects', json=project_args).status_code == 403
            assert http.get(path).json()['currentVersionId'] == asset['currentVersionId']
        print('PASS: installed OpenAPI, API/MCP cross-protocol replay, quality, PNG, read-only restart', flush=True)
        return asset

    def oauth(self, asset):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
        public.update(kid='fixture', alg='RS256', use='sig')
        jwks = self.root / 'keys.json'
        jwks.write_text(json.dumps({'keys': [public]}))
        config = {'issuer': 'https://identity.example', 'resource': 'https://assets.example/mcp', 'workspace_id': 'api-fixture',
                  'jwks_file': str(jwks), 'require_write_confirmation': True,
                  'principals': {subject: {'projects': [asset['projectId']], 'scopes': scopes} for subject, scopes in
                                 [('reader', ['pixelart:read']), ('writer', ['pixelart:read', 'pixelart:write'])]}}
        config_path = self.root / 'oauth.json'
        config_path.write_text(json.dumps(config))
        def authorization(subject):
            now = int(time.time())
            token = jwt.encode({'iss': config['issuer'], 'aud': config['resource'], 'workspace_id': config['workspace_id'],
                'sub': subject, 'client_id': 'api-check', 'scope': 'pixelart:read pixelart:write', 'iat': now, 'exp': now + 600},
                key, algorithm='RS256', headers={'kid': 'fixture', 'typ': 'at+jwt'})
            return 'Bearer ' + token
        with self.running(True, '--oauth-config', str(config_path)) as url, httpx.Client(base_url=url + '/api/v1', trust_env=False) as http:
            for path in ['/openapi.json', '/missing', '/projects']:
                response = http.get(path)
                assert response.status_code == 401 and 'resource_metadata' in response.headers['www-authenticate']
            http.headers['Authorization'] = authorization('reader')
            spec = http.get('/openapi.json').json()
            validate(spec)
            assert spec['security'] == [{'WorkspaceBearer': []}]
            assert str(self.root) not in json.dumps(spec)
            path = '/assets/' + asset['id']
            current = http.get(path, params={'include_document': True}).json()
            body = {'name': 'confirmed fixture', 'expected_current_version_id': current['currentVersionId'], 'idempotency_key': 'api-confirmed'}
            assert http.patch(path + '/name', json=body).status_code == 403
            http.headers['Authorization'] = authorization('writer')
            first = None
            for _ in range(2):
                pending = http.patch(path + '/name', json=body)
                assert pending.status_code == 409 and pending.json()['code'] == 'write_confirmation_required'
                confirmation = pending.json()['confirmation']
                review = self.cli('--review-write', confirmation['requestId'])
                assert review['intent']['arguments'] == {'asset_id': asset['id'], **body}
                assert self.cli('--approve-write', confirmation['requestId'], '--approval-digest', review['digest'])['executed'] is False
                changed = http.patch(path + '/name', json=body)
                assert changed.status_code == 200
                if first is None: first = changed.json()
                else: assert changed.json() == first
                checked = http.get(path + '/inspection').json()
                assert checked['versionId'] == first['currentVersionId'] and checked['report']['findings'] == []
            stale = http.patch(path + '/name', json={**body, 'idempotency_key': 'stale', 'name': 'other'})
            assert stale.status_code == 409 and stale.json()['code'] == 'write_confirmation_required'
            confirmation = stale.json()['confirmation']
            review = self.cli('--review-write', confirmation['requestId'])
            self.cli('--approve-write', confirmation['requestId'], '--approval-digest', review['digest'])
            conflict = http.patch(path + '/name', json={**body, 'idempotency_key': 'stale', 'name': 'other'})
            assert conflict.status_code == 409 and conflict.json()['code'] == 'version_conflict'
        print('PASS: installed OAuth API, scopes, local review, one-use approval and replay reconfirmation', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', type=Path, required=True)
    args = parser.parse_args()
    with TemporaryDirectory(prefix='pixelarting-api-check-') as directory:
        check = APICheck(args.server.resolve(strict=True), Path(directory))
        check.oauth(check.local())


if __name__ == '__main__':
    main()
