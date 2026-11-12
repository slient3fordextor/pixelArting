"""HTTP authorization challenges before MCP starts a stateless request task."""

import asyncio
import json
import time

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.routes import build_resource_metadata_url

from .mcp_policy import AuditUnavailable, InsufficientScope, PolicyDenied, RateLimited, preauthorized
from .mcp_approval import ApprovalUnavailable, ConfirmationRequired


class ScopedRequestMiddleware:
    def __init__(self, app, security):
        self.app, self.security = app, security

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('path') != '/mcp' or scope.get('method') != 'POST' or get_access_token() is None:
            return await self.app(scope, receive, send)
        messages, size = [], 0
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            messages.append(message)
            size += len(message.get('body', b''))
            if size > 4 * 1024 * 1024:
                return await self.reject(send, 413, 'request_too_large')
            if not message.get('more_body', False):
                break
        handle = None
        try:
            try:
                request = json.loads(b''.join(message.get('body', b'') for message in messages))
            except (ValueError, UnicodeError):
                request = None
            if isinstance(request, dict) and isinstance(request.get('params'), dict):
                params = request['params']
                if request.get('method') == 'tools/call' and isinstance(params.get('name'), str):
                    name, arguments = params['name'], params.get('arguments') or {}
                    if not isinstance(arguments, dict):
                        return await self.reject(send, 400, 'invalid_request')
                    attempt = await asyncio.to_thread(self.security.begin_tool, name, arguments)
                    handle = preauthorized.set((self.security.tool_key(name, arguments), attempt))
                elif request.get('method') == 'resources/read' and isinstance(params.get('uri'), str):
                    uri = params['uri']
                    attempt = await asyncio.to_thread(self.security.begin_resource, uri)
                    handle = preauthorized.set((self.security.resource_key(uri), attempt))
            index = 0

            async def replay():
                nonlocal index
                if index < len(messages):
                    message = messages[index]
                    index += 1
                    return message
                return await receive()

            await self.app(scope, replay, send)
        except ConfirmationRequired as error:
            # Standard MCP clients expose tool errors to the model, but often
            # hide a non-2xx HTTP response body containing the operator's ID.
            body = json.dumps({'jsonrpc': '2.0', 'id': request.get('id'), 'result': {
                'isError': True,
                'content': [{'type': 'text', 'text': f'write_confirmation_required requestId={error.request_id} digest={error.digest}; ask the local operator to review and approve, then retry the identical call'}],
                '_meta': {'pixelarting/writeConfirmation': {'requestId': error.request_id, 'digest': error.digest}},
            }}).encode()
            await send({'type': 'http.response.start', 'status': 200, 'headers': [(b'content-type', b'application/json'), (b'content-length', str(len(body)).encode())]})
            await send({'type': 'http.response.body', 'body': body})
        except InsufficientScope as error:
            await self.reject(send, 403, 'insufficient_scope', scopes=error.required)
        except RateLimited:
            await self.reject(send, 429, 'rate_limited')
        except PermissionError:
            await self.reject(send, 403, 'access_denied')
        except (AuditUnavailable, ApprovalUnavailable):
            await self.reject(send, 503, 'security_unavailable')
        finally:
            if handle is not None:
                preauthorized.reset(handle)

    async def reject(self, send, status, error, scopes=None):
        body = json.dumps({'error': error}).encode()
        headers = [(b'content-type', b'application/json'), (b'content-length', str(len(body)).encode())]
        if scopes:
            metadata = str(build_resource_metadata_url(self.security.config.resource))
            challenge = f'Bearer error="insufficient_scope", scope="{" ".join(scopes)}", resource_metadata="{metadata}"'
            headers.append((b'www-authenticate', challenge.encode()))
        if status == 429:
            headers.append((b'retry-after', str(60 - int(time.time()) % 60).encode()))
        await send({'type': 'http.response.start', 'status': status, 'headers': headers})
        await send({'type': 'http.response.body', 'body': body})
