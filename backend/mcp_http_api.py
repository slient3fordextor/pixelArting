"""Versioned HTTP routes and OpenAPI derived from the actual MCP tool catalog."""

import asyncio
import base64
from copy import deepcopy
from dataclasses import dataclass
import json
import math
import re
import time
from typing import Literal

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.routes import build_resource_metadata_url
from mcp.server.transport_security import TransportSecurityMiddleware
from pydantic import ValidationError
from pydantic_core import to_jsonable_python
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route

from .mcp_approval import ApprovalUnavailable, ConfirmationRequired
from .mcp_auth import READ
from .mcp_contract import ContractModel, SERVICE_VERSION, error_result
from .mcp_permissions import RESOURCE_RULES, match_resource
from .mcp_policy import AuditUnavailable, InsufficientScope, RateLimited, preauthorized
from .store import Conflict

API_BASE = '/api/v1'
OPENAPI_URI = 'pixelart://contract/openapi/v1'
MAX_BODY_BYTES = 4 * 1024 * 1024


class ConfirmationInfo(ContractModel):
    requestId: str
    digest: str


class APIFailure(ContractModel):
    ok: Literal[False] = False
    contractVersion: Literal['1'] = '1'
    error: str = 'HTTPError'
    code: Literal['permission_denied', 'not_found', 'version_conflict', 'idempotency_conflict',
                  'invalid_input', 'internal_error', 'not_configured', 'queue_full',
                  'invalid_token', 'insufficient_scope', 'access_denied', 'write_confirmation_required',
                  'rate_limited', 'security_unavailable', 'invalid_request', 'request_too_large',
                  'unsupported_media_type', 'method_not_allowed', 'invalid_host']
    message: str
    retryable: bool = False
    confirmation: ConfirmationInfo | None = None


ERRORS = {
    'permission_denied': (403, 'Workspace writes are disabled'),
    'not_found': (404, 'Requested workspace resource was not found'),
    'version_conflict': (409, 'State changed; re-read before retrying'),
    'idempotency_conflict': (409, 'Key belongs to another request or a deleted result'),
    'invalid_input': (422, 'Invalid input; check the operation schema'),
    'internal_error': (500, 'Operation could not complete; inspect state before retrying a write'),
    'not_configured': (409, 'Configure the required provider locally'),
    'queue_full': (429, 'Generation queue is full'),
    'invalid_token': (401, 'Authentication required'),
    'insufficient_scope': (403, 'Additional authorization scope required'),
    'access_denied': (403, 'Operation not permitted'),
    'write_confirmation_required': (409, 'Ask the local operator to review and approve, then retry the identical request'),
    'rate_limited': (429, 'Request rate limit exceeded'),
    'security_unavailable': (503, 'Security service unavailable; inspect state before retrying a write'),
    'invalid_request': (400, 'Expected one valid JSON object'),
    'request_too_large': (413, 'HTTP request exceeds 4 MiB'),
    'unsupported_media_type': (415, 'Use application/json for request bodies'),
    'method_not_allowed': (405, 'Method not allowed'),
    'invalid_host': (421, 'Host not allowed'),
}


@dataclass(frozen=True)
class Endpoint:
    tool: str
    method: str
    path: str
    query: tuple[str, ...] = ()

    @property
    def path_arguments(self):
        return tuple(re.findall(r'{([a-z_]+)}', self.path))


ENDPOINTS = (
    Endpoint('get_capabilities', 'GET', '/capabilities'),
    Endpoint('get_permissions', 'GET', '/permissions'),
    Endpoint('pixelart_health', 'GET', '/health'),
    Endpoint('list_projects', 'GET', '/projects'),
    Endpoint('create_project', 'POST', '/projects'),
    Endpoint('list_assets', 'GET', '/projects/{project_id}/assets'),
    Endpoint('create_blank_asset', 'POST', '/projects/{project_id}/assets/blank'),
    Endpoint('get_project_config', 'GET', '/projects/{project_id}/config'),
    Endpoint('update_project_config', 'PUT', '/projects/{project_id}/config'),
    Endpoint('get_asset', 'GET', '/assets/{asset_id}', ('include_document',)),
    Endpoint('get_asset_version', 'GET', '/assets/{asset_id}/versions/{version_id}'),
    Endpoint('get_asset_preview', 'GET', '/assets/{asset_id}/preview', ('version_id', 'frame_id', 'max_size')),
    Endpoint('list_reports', 'GET', '/assets/{asset_id}/reports', ('version_id', 'limit', 'offset')),
    Endpoint('inspect_asset', 'GET', '/assets/{asset_id}/inspection', ('version_id',)),
    Endpoint('export_asset', 'GET', '/assets/{asset_id}/versions/{version_id}/export', ('target', 'frame_id')),
    Endpoint('update_asset_document', 'PUT', '/assets/{asset_id}/document'),
    Endpoint('rename_asset', 'PATCH', '/assets/{asset_id}/name'),
    Endpoint('preview_asset_repair', 'POST', '/assets/{asset_id}/repair-previews'),
    Endpoint('commit_asset_repair', 'POST', '/assets/{asset_id}/repair-previews/{preview_id}/commit'),
    Endpoint('restore_asset_version', 'POST', '/assets/{asset_id}/restore'),
    Endpoint('start_generation', 'POST', '/generations'),
    Endpoint('list_generations', 'GET', '/generations', ('project_id', 'status', 'limit')),
    Endpoint('get_generation', 'GET', '/generations/{generation_id}'),
    Endpoint('cancel_generation', 'POST', '/generations/{generation_id}/cancel'),
    Endpoint('retry_generation', 'POST', '/generations/{generation_id}/retry'),
    Endpoint('get_candidate_preview', 'GET', '/generations/{generation_id}/candidates/{candidate_id}/preview'),
    Endpoint('update_candidate_state', 'PATCH', '/generations/{generation_id}/candidates/{candidate_id}'),
    Endpoint('import_generation_candidate', 'POST', '/generations/{generation_id}/candidates/{candidate_id}/imports'),
    Endpoint('preview_file_import', 'POST', '/projects/{project_id}/import-preview'),
    Endpoint('import_asset_file', 'POST', '/projects/{project_id}/imports'),
    Endpoint('preview_project_import', 'POST', '/project-imports/preview'),
    Endpoint('import_project_backup', 'POST', '/project-imports'),
)


class APIReject(Exception):
    def __init__(self, code):
        self.code = code


def failure(code, *, security=None, scopes=None, confirmation=None, business=None):
    status, message = ERRORS[code]
    if business is not None:
        result = APIFailure.model_validate(business)
    else:
        result = APIFailure(code=code, message=message, confirmation=confirmation,
                            retryable=code in {'rate_limited', 'queue_full'})
    headers = {}
    if code in {'invalid_token', 'insufficient_scope'} and security is not None:
        challenge = f'Bearer error="{code}", resource_metadata="{build_resource_metadata_url(security.config.resource)}"'
        if scopes:
            challenge += f', scope="{" ".join(scopes)}"'
        headers['WWW-Authenticate'] = challenge
    if status == 429:
        headers['Retry-After'] = str(60 - int(time.time()) % 60)
    return JSONResponse(result.model_dump(exclude_none=True), status_code=status, headers=headers)


class APIGuard:
    """Protect the whole mount, including redirects and unknown routes."""
    def __init__(self, app, server):
        self.app, self.server = app, server
        self.transport = TransportSecurityMiddleware(server.settings.transport_security)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)

        async def guarded_send(message):
            if message['type'] == 'http.response.start':
                message = {**message, 'headers': [*message.get('headers', []),
                    (b'cache-control', b'no-store'), (b'x-content-type-options', b'nosniff')]}
            await send(message)

        denied = await self.transport.validate_request(HTTPConnection(scope))
        if denied is not None:
            response = failure('invalid_host' if denied.status_code == 421 else 'access_denied')
            return await response(scope, receive, guarded_send)
        if self.server.security is not None:
            token = get_access_token()
            if token is None:
                return await failure('invalid_token', security=self.server.security)(scope, receive, guarded_send)
            if READ not in token.scopes:
                return await failure('insufficient_scope', security=self.server.security, scopes=[READ])(scope, receive, guarded_send)
        await self.app(scope, receive, guarded_send)


def _business_failure(payload):
    if isinstance(payload, dict):
        if payload.get('ok') is False:
            return payload
        if 'result' in payload:
            return _business_failure(payload['result'])
    if isinstance(payload, list):
        return next((item for value in payload if (item := _business_failure(value)) is not None), None)
    return None


def _nested_exception(error, kinds):
    # SDK tool/resource errors wrap the originating exception. Classify trusted
    # exception types only; never inspect or return their raw message/arguments.
    seen, match = set(), None
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        if isinstance(error, kinds):
            match = error
        error = error.__cause__ or error.__context__
    return match


def _json_object(body):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate key')
            result[key] = value
        return result
    def constant(value):
        raise ValueError('Nonfinite JSON number')
    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('Nonfinite JSON number')
        return number
    result = json.loads(body.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant,
                        parse_float=finite_float)
    if not isinstance(result, dict):
        raise ValueError('Expected object')
    return result


class WorkspaceHTTPAPI:
    def __init__(self, server):
        self.server = server
        self.tools = {tool.name: tool for tool in server._tool_manager.list_tools()}
        if set(self.tools) != {endpoint.tool for endpoint in ENDPOINTS} or len(ENDPOINTS) != len(self.tools):
            raise ValueError('HTTP v1 routes must cover the actual tool catalog exactly once')
        for endpoint in ENDPOINTS:
            properties = set(self.tools[endpoint.tool].parameters['properties'])
            located = set(endpoint.path_arguments) | set(endpoint.query)
            if not located <= properties or (endpoint.method == 'GET' and properties != located):
                raise ValueError('HTTP v1 parameter mapping disagrees with the tool')

    @staticmethod
    async def body(request):
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BODY_BYTES:
                raise APIReject('request_too_large')
            chunks.append(chunk)
        return b''.join(chunks)

    async def arguments(self, request, endpoint):
        tool = self.tools[endpoint.tool]
        properties = tool.parameters['properties']
        body_fields = set(properties) - set(endpoint.path_arguments) - set(endpoint.query)
        query = request.query_params
        if set(query) - set(endpoint.query) or any(len(query.getlist(name)) != 1 for name in query):
            raise APIReject('invalid_input')
        body = await self.body(request)
        payload = {}
        if body:
            if not body_fields:
                raise APIReject('invalid_input')
            if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
                raise APIReject('unsupported_media_type')
            try:
                payload = _json_object(body)
            except (ValueError, UnicodeError, RecursionError):
                raise APIReject('invalid_request') from None
            if set(payload) - body_fields:
                raise APIReject('invalid_input')
        values = {**payload, **request.path_params, **dict(query)}
        try:
            parsed = tool.fn_metadata.arg_model.model_validate(values).model_dump_one_level()
            return to_jsonable_python({name: parsed[name] for name in values})
        except (ValidationError, ValueError):
            raise APIReject('invalid_input') from None

    async def _admitted(self, name, arguments, *, resource=False):
        handle = None
        try:
            if self.server.security is not None:
                policy = self.server.security
                if resource:
                    attempt = await asyncio.to_thread(policy.begin_resource, name)
                    key = policy.resource_key(name)
                else:
                    attempt = await asyncio.to_thread(policy.begin_tool, name, arguments)
                    key = policy.tool_key(name, arguments)
                handle = preauthorized.set((key, attempt))
            if resource:
                items = list(await self.server.read_resource(name))
                if len(items) != 1 or items[0].mime_type not in {'application/json', 'image/png', 'application/zip'}:
                    raise RuntimeError('Unexpected resource representation')
                return Response(items[0].content, media_type=items[0].mime_type)
            result = await self.server.call_tool(name, arguments)
            if isinstance(result, tuple):
                payload = result[1]
                rejected = _business_failure(payload)
                return failure(rejected['code'], business=rejected) if rejected else JSONResponse(payload)
            if len(result) == 1 and result[0].type == 'image' and result[0].mimeType == 'image/png':
                return Response(base64.b64decode(result[0].data, validate=True), media_type='image/png')
            if len(result) == 1 and result[0].type == 'text':
                rejected = _business_failure(json.loads(result[0].text))
                if rejected:
                    return failure(rejected['code'], business=rejected)
            raise RuntimeError('Unexpected tool representation')
        except ConfirmationRequired as error:
            return failure('write_confirmation_required', confirmation=ConfirmationInfo(requestId=error.request_id, digest=error.digest))
        except InsufficientScope as error:
            return failure('insufficient_scope', security=self.server.security, scopes=error.required)
        except RateLimited:
            return failure('rate_limited')
        except PermissionError:
            return failure('access_denied')
        except (AuditUnavailable, ApprovalUnavailable):
            return failure('security_unavailable')
        except Exception as error:
            if _nested_exception(error, (AuditUnavailable, ApprovalUnavailable)) is not None:
                return failure('security_unavailable')
            if resource and not name.startswith('pixelart://contract/'):
                domain_error = _nested_exception(error, (KeyError, ValueError, Conflict))
                if domain_error is not None:
                    rejected = error_result(domain_error).model_dump()
                    return failure(rejected['code'], business=rejected)
            return failure('internal_error')
        finally:
            if handle is not None:
                preauthorized.reset(handle)

    def route(self, endpoint):
        async def invoke(request):
            try:
                arguments = await self.arguments(request, endpoint)
            except APIReject as rejected:
                return failure(rejected.code)
            return await self._admitted(endpoint.tool, arguments)
        return Route(endpoint.path, invoke, methods=[endpoint.method], name=endpoint.tool)

    async def resource(self, request):
        try:
            if await self.body(request):
                return failure('invalid_input')
        except APIReject as rejected:
            return failure(rejected.code)
        if set(request.query_params) != {'uri'} or len(request.query_params.getlist('uri')) != 1:
            return failure('invalid_input')
        uri = request.query_params['uri']
        if len(uri) > 2048 or match_resource(uri) is None:
            return failure('not_found')
        return await self._admitted(uri, None, resource=True)

    async def schema(self, request):
        try:
            if await self.body(request):
                return failure('invalid_input')
        except APIReject as rejected:
            return failure(rejected.code)
        if request.query_params:
            return failure('invalid_input')
        return await self._admitted(OPENAPI_URI, None, resource=True)

    def mount(self):
        async def http_error(request, error):
            response = failure('method_not_allowed' if error.status_code == 405 else 'not_found')
            response.headers.update(error.headers or {})
            return response
        app = Starlette(routes=[Route('/openapi.json', self.schema, methods=['GET']),
                                Route('/resources', self.resource, methods=['GET']),
                                *[self.route(endpoint) for endpoint in ENDPOINTS]],
                        middleware=[Middleware(APIGuard, server=self.server)],
                        exception_handlers={HTTPException: http_error})
        app.router.redirect_slashes = False
        return Mount(API_BASE, app=app)


def _schema_component(name, schema, components):
    source = deepcopy(schema)
    definitions = source.pop('$defs', {})
    def rewrite(value):
        if isinstance(value, list):
            return [rewrite(item) for item in value]
        if isinstance(value, dict):
            return {key: f'#/components/schemas/{name}__{item[8:]}' if key == '$ref' and isinstance(item, str) and item.startswith('#/$defs/')
                    else rewrite(item) for key, item in value.items()}
        return value
    for key, value in definitions.items():
        components[f'{name}__{key}'] = rewrite(value)
    components[name] = rewrite(source)
    return components[name]


async def build_openapi(server):
    WorkspaceHTTPAPI(server)  # Validate route coverage before publishing a spec.
    catalog = {tool.name: tool for tool in await server.list_tools()}
    components = {}
    _schema_component('APIFailure', APIFailure.model_json_schema(), components)
    errors = {str(status): {'description': 'Sanitized failure; inspect code and confirmation when present',
                            'content': {'application/json': {'schema': {'$ref': '#/components/schemas/APIFailure'}}}}
              for status in sorted({status for status, message in ERRORS.values()})}
    paths = {}
    for endpoint in ENDPOINTS:
        tool = catalog[endpoint.tool]
        input_name, output_name = f'{tool.name}_Input', f'{tool.name}_Output'
        input_schema = _schema_component(input_name, tool.inputSchema, components)
        properties = input_schema['properties']
        parameters = [{'name': name, 'in': location, 'required': location == 'path' or name in input_schema.get('required', []),
                       'schema': deepcopy(properties[name])}
                      for location, names in [('path', endpoint.path_arguments), ('query', endpoint.query)] for name in names]
        body_fields = set(properties) - set(endpoint.path_arguments) - set(endpoint.query)
        operation = {'operationId': tool.name, 'summary': tool.description.split('\n', 1)[0], 'description': tool.description,
                     'parameters': parameters, 'responses': deepcopy(errors),
                     'x-pixelarting-authorization': deepcopy(tool.meta['pixelarting/authorization'])}
        if 'pixelarting/idempotency' in (tool.meta or {}):
            operation['x-pixelarting-idempotency'] = deepcopy(tool.meta['pixelarting/idempotency'])
        if body_fields:
            body_schema = {'type': 'object', 'properties': {name: deepcopy(value) for name, value in properties.items() if name in body_fields},
                           'additionalProperties': False}
            required = [name for name in input_schema.get('required', []) if name in body_fields]
            if required:
                body_schema['required'] = required
            components[f'{tool.name}_Body'] = body_schema
            operation['requestBody'] = {'required': bool(required), 'content': {'application/json': {
                'schema': {'$ref': f'#/components/schemas/{tool.name}_Body'}}}}
        if tool.outputSchema:
            _schema_component(output_name, tool.outputSchema, components)
            success = {'application/json': {'schema': {'$ref': f'#/components/schemas/{output_name}'}}}
        else:
            success = {'image/png': {}}
        operation['responses']['200'] = {'description': 'Successful tool representation; JSON keeps its MCP structuredContent shape', 'content': success}
        paths.setdefault(API_BASE + endpoint.path, {})[endpoint.method.lower()] = operation
    paths[API_BASE + '/resources'] = {'get': {
        'operationId': 'read_workspace_resource', 'summary': 'Read an allowed immutable export, task, preview or contract resource',
        'parameters': [{'name': 'uri', 'in': 'query', 'required': True, 'schema': {'type': 'string', 'maxLength': 2048, 'pattern': '^pixelart://'}}],
        'responses': {**deepcopy(errors), '200': {'description': 'Raw resource content; no local paths or remote fetch',
            'content': {'application/json': {'schema': {}}, 'image/png': {}, 'application/zip': {}}}},
        'x-pixelarting-resources': [rule.describe().model_dump() for rule in RESOURCE_RULES],
    }}
    paths[API_BASE + '/openapi.json'] = {'get': {
        'operationId': 'get_workspace_openapi', 'summary': 'Read the versioned OpenAPI description',
        'responses': {**deepcopy(errors), '200': {'description': 'OpenAPI 3.1.1 document', 'content': {'application/json': {'schema': {'type': 'object'}}}}},
    }}
    document = {'openapi': '3.1.1', 'info': {'title': 'PixelArting Workspace API', 'version': '1.0.0',
        'description': 'HTTP v1 shares MCP tools, scopes, project ownership, write gate, confirmation and idempotency. No desktop/provider settings API.'},
        'jsonSchemaDialect': 'https://json-schema.org/draft/2020-12/schema', 'servers': [{'url': '/'}],
        'paths': paths, 'components': {'schemas': components}, 'security': [],
        'x-pixelarting-service-version': SERVICE_VERSION, 'x-pixelarting-contract-version': '1',
        'x-pixelarting-openapi-resource': OPENAPI_URI}
    if server.security is not None:
        document['components']['securitySchemes'] = {'WorkspaceBearer': {'type': 'http', 'scheme': 'bearer', 'bearerFormat': 'JWT',
            'description': 'Existing workspace resource audience and external issuer; per-operation scopes are in x-pixelarting-authorization.'}}
        document['security'] = [{'WorkspaceBearer': []}]
    return document
