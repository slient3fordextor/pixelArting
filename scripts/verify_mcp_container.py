"""Exercise an installed image with temporary data, never the desktop workspace.

Run with the project Python (MCP SDK installed), on Linux:
  python scripts/verify_mcp_container.py --engine podman --keep-id --image IMAGE
"""

import argparse
import asyncio
import base64
from contextlib import contextmanager
from datetime import timedelta
import json
import os
from pathlib import Path
import socket
import subprocess
from tempfile import TemporaryDirectory
import time
import uuid

from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from mcp_test_fixtures import project_backup_fixture


class ImageCheck:
    def __init__(self, args, root):
        self.args, self.root = args, root
        self.workspace = root / 'workspace'
        self.workspace.mkdir(mode=0o700)
        self.common = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                       '--tmpfs=/tmp:rw,size=64m,mode=1777', '--user', f'{os.getuid()}:{os.getgid()}',
                       '--volume', f'{self.workspace}:/data']
        if args.keep_id:
            self.common.append('--userns=keep-id')

    def command(self, *args, **kwargs):
        return subprocess.run([self.args.engine, *args], check=True, capture_output=True, text=True, timeout=30, **kwargs)

    def remove(self, name):
        subprocess.run([self.args.engine, 'rm', '--force', name], capture_output=True, timeout=30)

    async def stdio(self, writable, asset=None, replay_only=False):
        name = 'pixelarting-check-' + uuid.uuid4().hex
        params = StdioServerParameters(command=self.args.engine, args=[
            'run', '--rm', '--interactive', '--init', '--name', name, '--network=none',
            *self.common, self.args.image, '--allow-write' if writable else '--read-only',
        ])
        try:
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=30)) as session:
                    await session.initialize()
                    caps = (await session.call_tool('get_capabilities')).structuredContent
                    assert caps['writeEnabled'] is writable
                    permissions = (await session.call_tool('get_permissions')).structuredContent
                    assert permissions['authentication'] == 'local-process-only'
                    assert permissions['effectiveOAuthScopes'] == []
                    assert permissions['tools']['rename_asset']['writeGateAllowed'] is writable
                    tools = (await session.list_tools()).tools
                    assert all(tool.meta['pixelarting/authorization']['write'] is (not tool.annotations.readOnlyHint) for tool in tools)
                    if replay_only:
                        assert (await session.call_tool('create_project', self.create_arguments)).structuredContent == self.created_project
                        assert (await session.call_tool('create_blank_asset', self.blank_arguments)).structuredContent == asset
                        await self.inspect_export(session, asset)
                        return asset
                    if writable:
                        self.create_arguments = {'name': 'image check', 'idempotency_key': 'container-create-project'}
                        project = (await session.call_tool('create_project', self.create_arguments)).structuredContent
                        assert (await session.call_tool('create_project', self.create_arguments)).structuredContent == project
                        self.created_project = project
                        self.blank_arguments = {'project_id': project['id'], 'name': 'persisted', 'width': 64, 'height': 64, 'idempotency_key': 'container-blank'}
                        asset = (await session.call_tool('create_blank_asset', self.blank_arguments)).structuredContent
                        assert (await session.call_tool('create_blank_asset', self.blank_arguments)).structuredContent == asset
                        exported = (await session.call_tool('export_asset', {'asset_id': asset['id'], 'version_id': asset['currentVersionId']})).structuredContent['result']
                        png = await session.read_resource(exported['resourceUri'])
                        self.import_arguments = {'project_id': project['id'], 'data_base64': png.contents[0].blob}
                        preview = (await session.call_tool('preview_file_import', self.import_arguments)).structuredContent
                        assert preview['ok'] and preview['report']['findings'] == []
                        self.import_arguments['idempotency_key'] = 'container-import'
                        self.imported = (await session.call_tool('import_asset_file', self.import_arguments)).structuredContent
                        assert self.imported['ok'] and not self.imported['replayed']
                        replayed = (await session.call_tool('import_asset_file', self.import_arguments)).structuredContent
                        assert replayed['replayed'] and replayed['versionId'] == self.imported['versionId']
                        checked = (await session.call_tool('inspect_asset', {'asset_id': self.imported['assetId']})).structuredContent
                        assert checked['versionId'] == self.imported['versionId'] and checked['report']['findings'] == []
                        exported = (await session.call_tool('export_asset', {'asset_id': asset['id'], 'version_id': asset['currentVersionId'], 'target': 'json'})).structuredContent['result']
                        bundle = await session.read_resource(exported['resourceUri'])
                        config = (await session.call_tool('get_project_config', {'project_id': project['id']})).structuredContent
                        data = project_backup_fixture(base64.b64decode(bundle.contents[0].blob), asset['id'], asset['currentVersionId'], config)
                        self.project_arguments = {'data_base64': base64.b64encode(data).decode('ascii'), 'idempotency_key': 'container-project'}
                        assert (await session.call_tool('preview_project_import', {'data_base64': self.project_arguments['data_base64']})).structuredContent['ok']
                        self.restored = (await session.call_tool('import_project_backup', self.project_arguments)).structuredContent
                        assert self.restored['ok'] and not self.restored['replayed']
                        replayed = (await session.call_tool('import_project_backup', self.project_arguments)).structuredContent
                        assert replayed['replayed'] and replayed['project'] == self.restored['project']
                        checked = (await session.call_tool('inspect_asset', {'asset_id': self.restored['assets'][0]['assetId']})).structuredContent
                        assert checked['report']['findings'] == []
                    else:
                        reread = (await session.call_tool('get_asset', {'asset_id': asset['id'], 'include_document': True})).structuredContent
                        assert reread['currentVersionId'] == asset['currentVersionId']
                        denied = (await session.call_tool('create_project', {'name': 'must not be created'})).structuredContent
                        assert denied['code'] == 'permission_denied'
                        denied = (await session.call_tool('create_project', self.create_arguments)).structuredContent
                        assert denied['code'] == 'permission_denied'
                        imported = (await session.call_tool('get_asset', {'asset_id': self.imported['assetId']})).structuredContent
                        assert imported['currentVersionId'] == self.imported['versionId']
                        denied = (await session.call_tool('import_asset_file', self.import_arguments)).structuredContent
                        assert denied['code'] == 'permission_denied'
                        restored = (await session.call_tool('list_assets', {'project_id': self.restored['project']['id']})).structuredContent['result']
                        assert restored[0]['id'] == self.restored['assets'][0]['assetId']
                        denied = (await session.call_tool('import_project_backup', self.project_arguments)).structuredContent
                        assert denied['code'] == 'permission_denied'
                    await self.inspect_export(session, asset)
                    return asset
        finally:
            self.remove(name)

    @staticmethod
    async def inspect_export(session, asset):
        checked = (await session.call_tool('inspect_asset', {'asset_id': asset['id']})).structuredContent
        assert checked['versionId'] == asset['currentVersionId']
        exported = (await session.call_tool('export_asset', {'asset_id': asset['id'], 'version_id': asset['currentVersionId']})).structuredContent['result']
        resource = await session.read_resource(exported['resourceUri'])
        assert base64.b64decode(resource.contents[0].blob).startswith(b'\x89PNG\r\n\x1a\n')
        print('Quality findings:', len(checked['report']['findings']))

    @contextmanager
    def http_server(self, port, config_dir):
        name = 'pixelarting-http-check-' + uuid.uuid4().hex
        try:
            self.command('run', '--detach', '--init', '--name', name, '--network=host',
                         *self.common, '--volume', f'{config_dir}:/config:ro', self.args.image,
                         '--transport', 'streamable-http', '--port', str(port), '--oauth-config', '/config/oauth.json', '--allow-write')
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.2):
                        break
                except OSError:
                    state = json.loads(self.command('inspect', name).stdout)[0]['State']
                    if not state['Running']:
                        raise RuntimeError('Container exited: ' + self.command('logs', name).stderr)
                    time.sleep(.1)
            else:
                raise TimeoutError('HTTP container did not become ready')
            yield name
        finally:
            self.remove(name)

    def verify_http(self, asset):
        config_dir = self.root / 'config'
        config_dir.mkdir(mode=0o700)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
        public.update(kid='test', alg='RS256', use='sig')
        (config_dir / 'keys.json').write_text(json.dumps({'keys': [public]}))
        config = {'issuer': 'https://identity.example', 'resource': 'https://assets.example/mcp', 'workspace_id': 'image-check',
                  'jwks_file': '/config/keys.json', 'require_write_confirmation': True,
                  'principals': {'operator': {'projects': [asset['projectId']], 'scopes': ['pixelart:read', 'pixelart:write']}}}
        (config_dir / 'oauth.json').write_text(json.dumps(config))
        now = int(time.time())
        token = jwt.encode({'iss': config['issuer'], 'aud': config['resource'], 'workspace_id': config['workspace_id'], 'sub': 'operator',
                            'client_id': 'container-check', 'scope': 'pixelart:read pixelart:write', 'iat': now, 'exp': now + 600},
                           key, algorithm='RS256', headers={'kid': 'test', 'typ': 'at+jwt'})
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        arguments = {'asset_id': asset['id'], 'expected_current_version_id': asset['currentVersionId'], 'name': 'HTTP confirmed', 'idempotency_key': 'container-http-rename'}

        async def request(name, approve):
            url = f'http://127.0.0.1:{port}/mcp'
            async with httpx.AsyncClient(headers={'Authorization': 'Bearer ' + token}, trust_env=False) as http:
                api = f'http://127.0.0.1:{port}/api/v1'
                schema = await http.get(api + '/openapi.json')
                assert schema.status_code == 200 and schema.json()['openapi'] == '3.1.1'
                assert len(schema.json()['paths']) == 31
                assert 'workspace-http-v1' in (await http.get(api + '/capabilities')).json()['features']
                async with streamable_http_client(url, http_client=http) as (read, write, _):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=30)) as session:
                        await session.initialize()
                        permissions = (await session.call_tool('get_permissions')).structuredContent
                        assert permissions['effectiveOAuthScopes'] == ['pixelart:read', 'pixelart:write']
                        assert permissions['projectIds'] == [asset['projectId']]
                        assert permissions['tools']['rename_asset']['confirmationRequired']
                        assert not permissions['tools']['start_generation']['scopeAllowed']
                        current = (await session.call_tool('get_asset', {'asset_id': asset['id'], 'include_document': True})).structuredContent
                        assert current['currentVersionId'] == asset['currentVersionId']
                        result = await session.call_tool('rename_asset', arguments)
                        if approve:
                            assert result.isError
                            assert result.structuredContent is None
                            confirmation = result.meta['pixelarting/writeConfirmation']
                            cli = ['exec', name, 'pixelarting-mcp', '--data-dir', '/data']
                            reviewed = json.loads(self.command(*cli, '--review-write', confirmation['requestId']).stdout)
                            assert reviewed['intent']['arguments'] == arguments
                            self.command(*cli, '--approve-write', confirmation['requestId'], '--approval-digest', reviewed['digest'])
                        else:
                            assert not result.isError
                            await self.inspect_export(session, result.structuredContent)
                            pending = await session.call_tool('rename_asset', arguments)
                            assert pending.isError
                            confirmation = pending.meta['pixelarting/writeConfirmation']
                            reviewed = json.loads(self.command('exec', name, 'pixelarting-mcp', '--data-dir', '/data', '--review-write', confirmation['requestId']).stdout)
                            assert reviewed['intent']['arguments'] == arguments
                            self.command('exec', name, 'pixelarting-mcp', '--data-dir', '/data', '--approve-write', confirmation['requestId'], '--approval-digest', confirmation['digest'])
                            replay = await session.call_tool('rename_asset', arguments)
                            assert replay.structuredContent == result.structuredContent
                            # A REST replay must use the same MCP receipt, but a fresh approval.
                            body = {key: value for key, value in arguments.items() if key != 'asset_id'}
                            pending = await http.patch(api + '/assets/' + asset['id'] + '/name', json=body)
                            assert pending.status_code == 409 and pending.json()['code'] == 'write_confirmation_required'
                            confirmation = pending.json()['confirmation']
                            reviewed = json.loads(self.command('exec', name, 'pixelarting-mcp', '--data-dir', '/data', '--review-write', confirmation['requestId']).stdout)
                            assert reviewed['intent']['arguments'] == arguments
                            self.command('exec', name, 'pixelarting-mcp', '--data-dir', '/data', '--approve-write', confirmation['requestId'], '--approval-digest', reviewed['digest'])
                            replay = await http.patch(api + '/assets/' + asset['id'] + '/name', json=body)
                            assert replay.status_code == 200 and replay.json() == result.structuredContent
                            checked = (await http.get(api + '/assets/' + asset['id'] + '/inspection')).json()
                            assert checked['versionId'] == replay.json()['currentVersionId'] and checked['report']['findings'] == []
                            print('API quality findings:', len(checked['report']['findings']))
                http.headers.pop('Authorization')
                assert (await http.post(url, json={'jsonrpc': '2.0', 'id': 99, 'method': 'tools/call', 'params': {'name': 'get_capabilities'}})).status_code == 401
                assert (await http.get(api + '/openapi.json')).status_code == 401

        with self.http_server(port, config_dir) as name:
            asyncio.run(request(name, True))
        # Recreate the container: the data volume must retain the unused approval.
        with self.http_server(port, config_dir) as name:
            asyncio.run(request(name, False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', default='docker')
    parser.add_argument('--keep-id', action='store_true', help='Use Podman rootless keep-id user namespace')
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    with TemporaryDirectory(prefix='pixelarting-image-check-') as folder:
        check = ImageCheck(args, Path(folder))
        asset = asyncio.run(check.stdio(True))
        asyncio.run(check.stdio(True, asset, replay_only=True))
        asyncio.run(check.stdio(False, asset))
        check.verify_http(asset)
    print('PASS: stdio, permissions metadata/current identity, file/project import/replay, read-only restart, persistent assets/approval, OAuth HTTP, confirmation, inspection and PNG export')


if __name__ == '__main__':
    main()
