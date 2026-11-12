"""Keep workspace workers alive for the application, independent of MCP sessions."""

from contextlib import asynccontextmanager

from mcp.server.fastmcp import FastMCP
import asyncio
from mcp.server.fastmcp.exceptions import ToolError, ResourceError
from mcp.server.auth.routes import create_protected_resource_routes
from starlette.middleware import Middleware
from .mcp_auth import READ, WRITE, GENERATE, ADMIN
from .mcp_http_security import ScopedRequestMiddleware
from .mcp_policy import AuditUnavailable, RateLimited, successful_result
from .mcp_approval import ApprovalUnavailable, ConfirmationRequired
from .mcp_permissions import AUTHORIZATION_META, RESOURCE_BY_TEMPLATE, TOOL_RULES
from .mcp_idempotency import IDEMPOTENCY_META, describe_idempotency


class WorkspaceMCP(FastMCP):
    def __init__(self, *args, workspace_lifespan, security=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.workspace_lifespan = workspace_lifespan
        self.security = security

    async def list_tools(self):
        result = []
        for tool in await super().list_tools():
            rule = TOOL_RULES.get(tool.name)
            if rule is None:
                raise ValueError('Tool missing authorization contract')
            if tool.annotations is None or tool.annotations.readOnlyHint != (not rule.write):
                raise ValueError('Tool annotations disagree with authorization contract')
            metadata = {**(tool.meta or {}), AUTHORIZATION_META: rule.describe().model_dump()}
            if rule.write:
                metadata[IDEMPOTENCY_META] = describe_idempotency(tool.name)
            result.append(tool.model_copy(update={'meta': metadata}))
        return result

    @staticmethod
    def _resource_metadata(resource, template):
        rule = RESOURCE_BY_TEMPLATE.get(template)
        if rule is None:
            raise ValueError('Resource missing authorization contract')
        return resource.model_copy(update={'meta': {**(resource.meta or {}), AUTHORIZATION_META: rule.describe().model_dump()}})

    async def list_resources(self):
        return [self._resource_metadata(resource, str(resource.uri)) for resource in await super().list_resources()]

    async def list_resource_templates(self):
        return [self._resource_metadata(template, template.uriTemplate) for template in await super().list_resource_templates()]

    async def run_stdio_async(self):
        if self.security is not None:
            raise ValueError('OAuth requires Streamable HTTP')
        async with self.workspace_lifespan(self):
            await super().run_stdio_async()

    def _manage_workspace(self, app):
        transport_lifespan = app.router.lifespan_context

        @asynccontextmanager
        async def lifespan(application):
            # SDK stateless HTTP creates a low-level MCP lifespan per request.
            # Durable jobs must outlive requests and client disconnections.
            async with self.workspace_lifespan(self):
                async with transport_lifespan(application) as state:
                    yield state

        app.router.lifespan_context = lifespan
        return app

    def streamable_http_app(self):
        app = super().streamable_http_app()
        from .mcp_http_api import WorkspaceHTTPAPI
        app.router.routes.append(WorkspaceHTTPAPI(self).mount())
        if self.security is not None:
            app.user_middleware.append(Middleware(ScopedRequestMiddleware, security=self.security))
            path = '/.well-known/oauth-protected-resource/mcp'
            app.router.routes = [route for route in app.router.routes if getattr(route, 'path', None) != path]
            app.router.routes.extend(create_protected_resource_routes(
                resource_url=self.settings.auth.resource_server_url,
                authorization_servers=[self.settings.auth.issuer_url],
                scopes_supported=[READ, WRITE, GENERATE, ADMIN],
            ))
        return self._manage_workspace(app)

    async def openapi(self):
        from .mcp_http_api import build_openapi
        return await build_openapi(self)

    def sse_app(self, mount_path=None):
        if self.security is not None:
            raise ValueError('OAuth requires Streamable HTTP')
        return self._manage_workspace(super().sse_app(mount_path))

    async def call_tool(self, name, arguments):
        if self.security is None:
            return await super().call_tool(name, arguments)
        try:
            attempt = await asyncio.to_thread(self.security.begin_tool, name, arguments or {})
        except ConfirmationRequired as error:
            raise ToolError(f'write_confirmation_required requestId={error.request_id} digest={error.digest}; ask the local operator to review and approve, then retry the identical call') from None
        except RateLimited:
            raise ToolError('Request rate limit exceeded; wait before retrying') from None
        except (PermissionError, AuditUnavailable, ApprovalUnavailable):
            raise ToolError('Operation not permitted or security service unavailable') from None
        try:
            result = await super().call_tool(name, arguments)
        except Exception:
            await asyncio.to_thread(self.security.finish, attempt, False)
            raise ToolError('Tool could not complete this operation') from None
        try:
            await asyncio.to_thread(self.security.finish, attempt, successful_result(result))
        except AuditUnavailable:
            raise ToolError('Audit completion unavailable; inspect state before retrying a write') from None
        return result

    async def read_resource(self, uri):
        if self.security is None:
            return await super().read_resource(uri)
        try:
            attempt = await asyncio.to_thread(self.security.begin_resource, str(uri))
        except RateLimited:
            raise ResourceError('Request rate limit exceeded') from None
        except (PermissionError, AuditUnavailable):
            raise ResourceError('Resource unavailable or security service unavailable') from None
        try:
            result = await super().read_resource(uri)
        except Exception:
            await asyncio.to_thread(self.security.finish, attempt, False)
            raise ResourceError('Resource unavailable') from None
        await asyncio.to_thread(self.security.finish, attempt, True)
        return result
