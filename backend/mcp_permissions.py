"""One immutable authorization registry for enforcement and client discovery."""

from dataclasses import dataclass
from functools import cached_property
import re
from string import Formatter
from types import MappingProxyType
from typing import Literal

from .mcp_auth import ADMIN, GENERATE, READ, WRITE, ScopeName
from .mcp_contract import ContractModel

AUTHORIZATION_META = 'pixelarting/authorization'
PERMISSIONS_URI = 'pixelart://contract/permissions/v1'
ProjectPolicy = Literal['workspace', 'visible-projects', 'optional-project-filter', 'project-argument',
                        'asset-owner', 'generation-owner', 'generation-and-destination', 'request-project']
ResourcePolicy = Literal['workspace', 'asset-owner', 'generation-owner']

PROJECT_POLICIES = MappingProxyType({
    'workspace': ('No existing project target; admin scope is separately required where declared.', ()),
    'visible-projects': ('Results are filtered to allowed projects unless the effective token has admin scope.', ()),
    'optional-project-filter': ('An explicit project_id must be allowed; results are filtered before limiting. Unscoped jobs require admin.', ('project_id',)),
    'project-argument': ('project_id must be allowed by the effective principal.', ('project_id',)),
    'asset-owner': ('Resolve asset_id server-side and require access to its owning project.', ('asset_id',)),
    'generation-owner': ('Resolve generation_id server-side; its project must be allowed. Unscoped jobs require admin.', ('generation_id',)),
    'generation-and-destination': ('Both source generation and destination project must be allowed. Omitted destination uses the source project; unscoped source requires admin.', ('generation_id', 'project_id')),
    'request-project': ('request.projectId must be allowed; omission requires admin. Generate scope does not bypass project restrictions.', ('request.projectId',)),
})


class ToolAuthorization(ContractModel):
    requiredOAuthScopes: list[ScopeName]
    write: bool
    projectPolicy: ProjectPolicy
    projectPolicyDescription: str
    argumentPaths: list[str]


class EffectiveToolAuthorization(ToolAuthorization):
    scopeAllowed: bool
    writeGateAllowed: bool
    confirmationRequired: bool


class ResourceAuthorization(ContractModel):
    uriTemplate: str
    requiredOAuthScopes: list[ScopeName]
    projectPolicy: ResourcePolicy
    ownerParameter: str | None


class PermissionsView(ContractModel):
    ok: Literal[True] = True
    contractVersion: Literal['1'] = '1'
    authentication: Literal['local-process-only', 'oauth-jwt']
    effectiveOAuthScopes: list[ScopeName]
    projectAccess: Literal['workspace', 'explicit-projects']
    projectIds: list[str]
    processWriteEnabled: bool
    writeConfirmationRequired: bool
    tools: dict[str, EffectiveToolAuthorization]
    resources: list[ResourceAuthorization]


@dataclass(frozen=True)
class ToolRule:
    scopes: tuple[ScopeName, ...]
    project_policy: ProjectPolicy = 'workspace'

    def __post_init__(self):
        if READ not in self.scopes or not set(self.scopes) <= {READ, WRITE, GENERATE, ADMIN}:
            raise ValueError('Invalid authorization scopes')
        if GENERATE in self.scopes and WRITE not in self.scopes:
            raise ValueError('Generation requires write scope')
        if self.project_policy not in PROJECT_POLICIES:
            raise ValueError('Unknown project authorization policy')

    @property
    def write(self):
        return WRITE in self.scopes

    def describe(self) -> ToolAuthorization:
        description, paths = PROJECT_POLICIES[self.project_policy]
        return ToolAuthorization(requiredOAuthScopes=list(self.scopes), write=self.write,
                                 projectPolicy=self.project_policy, projectPolicyDescription=description,
                                 argumentPaths=list(paths))


R, W, G, A, RA = (READ,), (READ, WRITE), (READ, WRITE, GENERATE), (READ, WRITE, ADMIN), (READ, ADMIN)
TOOL_RULES = MappingProxyType({
    'get_capabilities': ToolRule(R),
    'get_permissions': ToolRule(R),
    'pixelart_health': ToolRule(R),
    'list_projects': ToolRule(R, 'visible-projects'),
    'list_assets': ToolRule(R, 'project-argument'),
    'get_project_config': ToolRule(R, 'project-argument'),
    'get_asset': ToolRule(R, 'asset-owner'),
    'get_asset_version': ToolRule(R, 'asset-owner'),
    'get_asset_preview': ToolRule(R, 'asset-owner'),
    'list_reports': ToolRule(R, 'asset-owner'),
    'inspect_asset': ToolRule(R, 'asset-owner'),
    'export_asset': ToolRule(R, 'asset-owner'),
    'create_project': ToolRule(A),
    'create_blank_asset': ToolRule(W, 'project-argument'),
    'update_project_config': ToolRule(W, 'project-argument'),
    'update_asset_document': ToolRule(W, 'asset-owner'),
    'rename_asset': ToolRule(W, 'asset-owner'),
    'preview_asset_repair': ToolRule(W, 'asset-owner'),
    'commit_asset_repair': ToolRule(W, 'asset-owner'),
    'restore_asset_version': ToolRule(W, 'asset-owner'),
    'start_generation': ToolRule(G, 'request-project'),
    'get_generation': ToolRule(R, 'generation-owner'),
    'list_generations': ToolRule(R, 'optional-project-filter'),
    'cancel_generation': ToolRule(W, 'generation-owner'),
    'retry_generation': ToolRule(G, 'generation-owner'),
    'get_candidate_preview': ToolRule(R, 'generation-owner'),
    'update_candidate_state': ToolRule(W, 'generation-owner'),
    'import_generation_candidate': ToolRule(W, 'generation-and-destination'),
    'preview_file_import': ToolRule(R, 'project-argument'),
    'import_asset_file': ToolRule(W, 'project-argument'),
    'preview_project_import': ToolRule(RA),
    'import_project_backup': ToolRule(A),
})


@dataclass(frozen=True)
class ResourceRule:
    uri_template: str
    project_policy: ResourcePolicy = 'workspace'
    owner_parameter: str | None = None

    @cached_property
    def pattern(self):
        parts = []
        for literal, field, spec, conversion in Formatter().parse(self.uri_template):
            parts.append(re.escape(literal))
            if field is not None:
                parts.append(f'(?P<{field}>[^/?#]+)')
        return re.compile(''.join(parts))

    def describe(self) -> ResourceAuthorization:
        return ResourceAuthorization(uriTemplate=self.uri_template, requiredOAuthScopes=[READ],
                                     projectPolicy=self.project_policy, ownerParameter=self.owner_parameter)


RESOURCE_RULES = tuple(ResourceRule(uri) for uri in (
    'pixelart://contract/v1', 'pixelart://contract/security/v1', 'pixelart://contract/tasks/v1',
    'pixelart://contract/imports/v1', 'pixelart://contract/project-imports/v1', PERMISSIONS_URI,
    'pixelart://contract/idempotency/v1',
    'pixelart://contract/openapi/v1',
)) + (
    ResourceRule('pixelart://exports/{asset_id}/{version_id}/png/{frame_id}', 'asset-owner', 'asset_id'),
    ResourceRule('pixelart://exports/{asset_id}/{version_id}/{target}/bundle', 'asset-owner', 'asset_id'),
    ResourceRule('pixelart://generations/{generation_id}', 'generation-owner', 'generation_id'),
    ResourceRule('pixelart://generations/{generation_id}/candidates/{candidate_id}/preview', 'generation-owner', 'generation_id'),
)
RESOURCE_BY_TEMPLATE = MappingProxyType({rule.uri_template: rule for rule in RESOURCE_RULES})


def match_resource(uri: str):
    for rule in RESOURCE_RULES:
        match = rule.pattern.fullmatch(uri)
        if match is not None:
            return rule, match.groupdict()
    return None


def permissions_view(principal, *, allow_write: bool, confirmation_required: bool) -> PermissionsView:
    tools = {}
    for name, rule in TOOL_RULES.items():
        tools[name] = EffectiveToolAuthorization(**rule.describe().model_dump(),
            scopeAllowed=principal is None or set(rule.scopes) <= principal.scopes,
            writeGateAllowed=not rule.write or allow_write,
            confirmationRequired=rule.write and confirmation_required,
        )
    workspace_access = principal is None or principal.admin
    return PermissionsView(authentication='local-process-only' if principal is None else 'oauth-jwt',
        effectiveOAuthScopes=[scope for scope in (READ, WRITE, GENERATE, ADMIN) if principal is not None and scope in principal.scopes],
        projectAccess='workspace' if workspace_access else 'explicit-projects',
        projectIds=[] if workspace_access else sorted(principal.projects),
        processWriteEnabled=allow_write, writeConfirmationRequired=confirmation_required,
        tools=tools, resources=[rule.describe() for rule in RESOURCE_RULES],
    )
