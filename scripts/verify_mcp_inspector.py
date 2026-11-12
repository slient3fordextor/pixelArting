"""Inspector CLI acceptance against an installed server and a temporary workspace.

No browser or paid provider is used. --server must be the installed absolute
pixelarting-mcp executable, not a repository module wrapper.
"""

import argparse
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
from tempfile import TemporaryDirectory
import time

from cryptography.hazmat.primitives.asymmetric import rsa
import jwt

from mcp_test_fixtures import project_backup_fixture


class InspectorCheck:
    def __init__(self, args, root):
        self.args, self.root = args, root
        self.config_path = root / 'clients.json'
        self.environment = {key: value for key, value in os.environ.items() if key != 'PYTHONPATH'}
        self.environment['MCP_INSPECTOR_SECRET_STORE'] = 'memory'
        self.workspace = root / 'workspace'
        self.config = {'mcpServers': {
            'read': {'command': str(args.server), 'args': ['--data-dir', str(self.workspace), '--read-only']},
            'write': {'command': str(args.server), 'args': ['--data-dir', str(self.workspace), '--allow-write']},
        }}
        self.save_config()

    def save_config(self):
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(0o600)

    def invoke(self, server, method, *args):
        return subprocess.run([str(self.args.node), str(self.args.inspector), '--cli', '--config', str(self.config_path),
                                 '--server', server, '--stored-auth-only', '--method', method, '--format', 'json', *args],
                                cwd=self.root, env=self.environment, capture_output=True, text=True, timeout=45)

    def run(self, server, method, *args, tool_error=False):
        result = self.invoke(server, method, *args)
        if result.returncode and not (tool_error and result.returncode == 5 and result.stdout.strip()):
            raise RuntimeError(f'Inspector {server} {method} exited {result.returncode}: {result.stderr}')
        return json.loads(result.stdout)['result']

    def call(self, server, tool, **arguments):
        result = self.run(server, 'tools/call', '--tool-name', tool, '--tool-args-json', json.dumps(arguments))
        assert not result.get('isError'), result
        structured = result['structuredContent']
        return structured.get('result', structured)

    def check(self):
        initialized = self.run('read', 'initialize')
        print('Negotiated protocol:', initialized['protocolVersion'])
        tools = self.run('read', 'tools/list', '--strict')['tools']
        catalog = {tool['name']: tool for tool in tools}
        assert catalog['get_asset']['outputSchema']
        assert catalog['rename_asset']['annotations']['readOnlyHint'] is False
        assert catalog['rename_asset']['_meta']['pixelarting/authorization']['requiredOAuthScopes'] == ['pixelart:read', 'pixelart:write']
        assert catalog['rename_asset']['_meta']['pixelarting/idempotency']['namespace'] == 'mcp-writes'
        permissions = self.call('read', 'get_permissions')
        assert permissions['authentication'] == 'local-process-only'
        assert permissions['effectiveOAuthScopes'] == []
        assert not permissions['tools']['rename_asset']['writeGateAllowed']
        assert set(permissions['tools']) == set(catalog)
        assert self.call('read', 'get_capabilities')['writeEnabled'] is False
        assert self.call('read', 'create_project', name='forbidden')['code'] == 'permission_denied'
        assert self.call('read', 'list_projects') == []
        resources = self.run('read', 'resources/list')['resources']
        assert 'pixelart://contract/v1' in {item['uri'] for item in resources}
        self.run('read', 'resources/read', '--uri', 'pixelart://contract/v1')
        contract = self.run('read', 'resources/read', '--uri', 'pixelart://contract/openapi/v1')
        openapi = json.loads(contract['contents'][0]['text'])
        assert openapi['openapi'] == '3.1.1'
        assert {operation['operationId'] for path in openapi['paths'].values() for operation in path.values()} == set(catalog) | {'get_workspace_openapi', 'read_workspace_resource'}
        contract = self.run('read', 'resources/read', '--uri', 'pixelart://contract/permissions/v1')
        assert set(json.loads(contract['contents'][0]['text'])['tools']) == set(catalog)
        project = self.call('write', 'create_project', name='Inspector temporary fixture', idempotency_key='inspector-project-create')
        assert self.call('write', 'create_project', name='Inspector temporary fixture', idempotency_key='inspector-project-create') == project
        asset = self.call('write', 'create_blank_asset', project_id=project['id'], name='sprite', width=8, height=8, idempotency_key='inspector-blank')
        assert self.call('write', 'create_blank_asset', project_id=project['id'], name='sprite', width=8, height=8, idempotency_key='inspector-blank') == asset
        current = self.call('read', 'get_asset', asset_id=asset['id'], include_document=True)
        base = current['currentVersionId']
        preview = self.call('write', 'preview_asset_repair', asset_id=asset['id'], version_id=base, actions=[{'id': 'resize-nearest-v1'}])
        assert preview['changes'][0]['after'] == [64, 64]
        assert preview['report']['findings'] == []
        result = self.call('write', 'commit_asset_repair', asset_id=asset['id'], preview_id=preview['previewId'], expected_current_version_id=base, idempotency_key='inspector-repair')
        assert result['ok']
        checked = self.call('read', 'inspect_asset', asset_id=asset['id'])
        assert checked['versionId'] == result['resultVersionId']
        assert checked['report']['findings'] == []
        repeated = self.call('write', 'commit_asset_repair', asset_id=asset['id'], preview_id=preview['previewId'], expected_current_version_id=base, idempotency_key='inspector-repair')
        assert repeated == result
        assert repeated['resultVersionId'] == result['resultVersionId']
        assert self.call('write', 'rename_asset', asset_id=asset['id'], expected_current_version_id=base, name='stale')['code'] == 'version_conflict'
        image = self.run('read', 'tools/call', '--tool-name', 'get_asset_preview', '--tool-args-json', json.dumps({'asset_id': asset['id']}))
        assert image['content'][0]['type'] == 'image'
        exported = self.call('read', 'export_asset', asset_id=asset['id'], version_id=result['resultVersionId'])
        resource = self.run('read', 'resources/read', '--uri', exported['resourceUri'])
        assert base64.b64decode(resource['contents'][0]['blob']).startswith(b'\x89PNG\r\n\x1a\n')
        self.run('read', 'resources/read', '--uri', 'pixelart://contract/imports/v1')
        for file_format, target in [('png', 'png'), ('layered-zip', 'json')]:
            descriptor = self.call('read', 'export_asset', asset_id=asset['id'], version_id=result['resultVersionId'], target=target)
            payload = self.run('read', 'resources/read', '--uri', descriptor['resourceUri'])['contents'][0]['blob']
            arguments = {'project_id': project['id'], 'data_base64': payload, 'file_format': file_format}
            assert self.call('read', 'preview_file_import', **arguments)['report']['findings'] == []
            arguments['idempotency_key'] = 'inspector-file-' + file_format
            assert self.call('read', 'import_asset_file', **arguments)['code'] == 'permission_denied'
            imported = self.call('write', 'import_asset_file', **arguments)
            assert imported['ok'] and not imported['replayed']
            replayed = self.call('write', 'import_asset_file', **arguments)
            assert replayed['replayed'] and replayed['versionId'] == imported['versionId']
            assert self.call('read', 'inspect_asset', asset_id=imported['assetId'])['report']['findings'] == []
        config = self.call('read', 'get_project_config', project_id=project['id'])
        self.project_backup_args = {'data_base64': base64.b64encode(project_backup_fixture(
            base64.b64decode(payload), asset['id'], result['resultVersionId'], config,
        )).decode('ascii'), 'idempotency_key': 'inspector-project'}
        self.run('read', 'resources/read', '--uri', 'pixelart://contract/project-imports/v1')
        assert len(self.call('read', 'preview_project_import', data_base64=self.project_backup_args['data_base64'])['assets']) == 1
        assert self.call('read', 'import_project_backup', **self.project_backup_args)['code'] == 'permission_denied'
        restored = self.call('write', 'import_project_backup', **self.project_backup_args)
        assert restored['ok'] and not restored['replayed']
        repeated = self.call('write', 'import_project_backup', **self.project_backup_args)
        assert repeated['replayed'] and repeated['project'] == restored['project']
        assert self.call('read', 'inspect_asset', asset_id=restored['assets'][0]['assetId'])['report']['findings'] == []
        self.check_http(asset, result['resultVersionId'])

    def confirmed_http_call(self, role, tool, arguments):
        blocked = self.run(role, 'tools/call', '--tool-name', tool, '--tool-args-json', json.dumps(arguments), tool_error=True)
        assert blocked['isError'] and 'structuredContent' not in blocked
        confirmation = blocked['_meta']['pixelarting/writeConfirmation']
        operator = [str(self.args.server), '--data-dir', str(self.workspace)]
        review = subprocess.run([*operator, '--review-write', confirmation['requestId']], cwd=self.root, env=self.environment,
                                capture_output=True, text=True, timeout=15, check=True)
        assert json.loads(review.stdout)['intent']['arguments'] == arguments
        subprocess.run([*operator, '--approve-write', confirmation['requestId'], '--approval-digest', confirmation['digest']],
                       cwd=self.root, env=self.environment, capture_output=True, text=True, timeout=15, check=True)
        return self.call(role, tool, **arguments)

    def check_http(self, asset, version):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
        public.update(kid='fixture', alg='RS256')
        keys_path = self.root / 'public.json'
        keys_path.write_text(json.dumps({'keys': [public]}))
        config = {'issuer': 'https://identity.example', 'resource': 'https://assets.example/mcp', 'workspace_id': 'inspector-check',
                  'jwks_file': str(keys_path), 'require_write_confirmation': True,
                  'principals': {subject: {'projects': [asset['projectId']], 'scopes': scopes} for subject, scopes in
                                 [('reader', ['pixelart:read']), ('writer', ['pixelart:read', 'pixelart:write']),
                                  ('admin', ['pixelart:read', 'pixelart:write', 'pixelart:admin'])]}}
        oauth_path = self.root / 'oauth.json'
        oauth_path.write_text(json.dumps(config))
        endpoint = {'url': f'http://127.0.0.1:{port}/mcp', 'type': 'streamable-http'}
        self.config['mcpServers']['http-anonymous'] = endpoint
        for subject in ('reader', 'writer', 'admin'):
            now = int(time.time())
            token = jwt.encode({'iss': config['issuer'], 'aud': config['resource'], 'workspace_id': config['workspace_id'], 'sub': subject,
                                'client_id': 'inspector', 'scope': ' '.join(config['principals'][subject]['scopes']), 'iat': now, 'exp': now + 600},
                               key, algorithm='RS256', headers={'kid': 'fixture', 'typ': 'at+jwt'})
            self.config['mcpServers']['http-' + subject] = {**endpoint, 'headers': {'Authorization': 'Bearer ' + token}}
        self.save_config()
        with (self.root / 'http.log').open('w') as log:
            child = subprocess.Popen([str(self.args.server), '--data-dir', str(self.workspace), '--transport', 'streamable-http',
                                      '--port', str(port), '--oauth-config', str(oauth_path), '--allow-write'], cwd=self.root, env=self.environment, stdout=subprocess.DEVNULL, stderr=log)
            try:
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if child.poll() is not None:
                        raise RuntimeError('Temporary HTTP server exited; inspect its startup configuration')
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=.1):
                            break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise TimeoutError('Temporary HTTP server startup timed out')
                self.run('http-reader', 'initialize')
                self.run('http-reader', 'tools/list', '--strict')
                assert self.call('http-reader', 'get_capabilities')['writeEnabled'] is False
                for role, scopes in [('reader', ['pixelart:read']), ('writer', ['pixelart:read', 'pixelart:write']), ('admin', ['pixelart:read', 'pixelart:write', 'pixelart:admin'])]:
                    permissions = self.call('http-' + role, 'get_permissions')
                    assert permissions['effectiveOAuthScopes'] == scopes
                    assert permissions['processWriteEnabled']
                    assert permissions['writeConfirmationRequired']
                    assert permissions['tools']['rename_asset']['scopeAllowed'] is (role != 'reader')
                    assert permissions['tools']['rename_asset']['confirmationRequired']
                    assert permissions['projectAccess'] == ('workspace' if role == 'admin' else 'explicit-projects')
                    assert permissions['projectIds'] == ([] if role == 'admin' else [asset['projectId']])
                current = self.call('http-reader', 'get_asset', asset_id=asset['id'], include_document=True)
                assert current['currentVersionId'] == version
                arguments = {'asset_id': asset['id'], 'expected_current_version_id': current['currentVersionId'], 'name': 'HTTP confirmed', 'idempotency_key': 'inspector-http-rename'}
                tool_args = ['--tool-name', 'rename_asset', '--tool-args-json', json.dumps(arguments)]
                assert self.invoke('http-reader', 'tools/call', *tool_args).returncode != 0
                assert self.call('http-reader', 'get_asset', asset_id=asset['id'])['currentVersionId'] == version
                changed = self.confirmed_http_call('http-writer', 'rename_asset', arguments)
                assert changed['name'] == 'HTTP confirmed'
                assert self.confirmed_http_call('http-writer', 'rename_asset', arguments) == changed
                assert self.call('http-reader', 'inspect_asset', asset_id=asset['id'])['versionId'] == changed['currentVersionId']
                backup_arguments = {**self.project_backup_args, 'idempotency_key': 'inspector-project-http', 'name': 'HTTP restored project'}
                backup_tool_args = ['--tool-name', 'import_project_backup', '--tool-args-json', json.dumps(backup_arguments)]
                assert self.invoke('http-writer', 'tools/call', *backup_tool_args).returncode != 0  # No admin scope.
                assert self.call('http-admin', 'preview_project_import', data_base64=backup_arguments['data_base64'])['ok']
                restored = self.confirmed_http_call('http-admin', 'import_project_backup', backup_arguments)
                assert restored['ok'] and not restored['replayed']
                again = self.confirmed_http_call('http-admin', 'import_project_backup', backup_arguments)
                assert again['replayed'] and again['project'] == restored['project']
                assert self.call('http-admin', 'inspect_asset', asset_id=restored['assets'][0]['assetId'])['report']['findings'] == []
                assert self.invoke('http-anonymous', 'initialize').returncode != 0
            finally:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--inspector', type=Path, required=True, help='Inspector launcher JS file')
    parser.add_argument('--server', type=Path, required=True, help='Installed pixelarting-mcp executable')
    args = parser.parse_args()
    args.node, args.inspector, args.server = args.node.absolute(), args.inspector.absolute(), args.server.absolute()
    with TemporaryDirectory(prefix='pixelarting-inspector-check-') as folder:
        InspectorCheck(args, Path(folder)).check()
    print('PASS: Inspector stdio/OAuth HTTP, strict discovery, permissions contract/current identity, read-only/scope gates, confirmation, repair preview/commit/replay, file/project import/replay, admin confirmation, version conflicts, inspection and PNG resources')


if __name__ == '__main__':
    main()
