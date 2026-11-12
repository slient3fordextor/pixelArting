"""Field-level legacy contracts that preserve existing MCP JSON wire shapes."""

from typing import Annotated, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, JsonValue, RootModel, TypeAdapter, WithJsonSchema, model_serializer

from .mcp_contract import ContractModel, ToolFailure
from .models import CheckConfig, Document, Point, Rect, RepairAction

T = TypeVar('T')


class WireObject(RootModel[T]):
    # FastMCP recognizes BaseModel outputs as direct objects, avoiding the
    # {result: ...} envelope that it normally adds to union return types.
    model_config = ConfigDict(json_schema_extra={'type': 'object'})

    @model_serializer(mode='wrap')
    def preserve_supplied_fields(self, handler, info):
        if isinstance(self.root, BaseModel):
            # Preserve omitted document/layer defaults and partial old reports.
            return self.root.model_dump(mode=info.mode, exclude_unset=True)
        return handler(self)


class ProjectInfo(ContractModel):
    id: str
    name: str
    created: str


class VersionInfo(ContractModel):
    id: str
    parent: str | None
    operation: str
    checksum: str
    created: str


class AssetInfo(ContractModel):
    id: str
    projectId: str
    name: str
    currentVersionId: str
    versions: list[VersionInfo]
    document: Document | None = None


class AssetSummary(ContractModel):
    id: str
    name: str
    currentVersionId: str
    created: str
    frameCount: int = Field(ge=1)
    layerCount: int = Field(ge=1)
    width: int = Field(ge=1, le=512)
    height: int = Field(ge=1, le=512)


class HealthInfo(ContractModel):
    ok: Literal[True]
    service: Literal['PixelArting']
    mode: Literal['local-single-user', 'authenticated-single-workspace']
    dataRoot: str | None
    writeEnabled: bool
    contractVersion: Literal['1']
    serviceVersion: str


class Finding(ContractModel):
    id: str
    ruleId: str
    ruleVersion: str
    severity: Literal['error', 'warning', 'blocking']
    frameId: str | None
    region: Rect | None
    message: str
    canAutoFix: bool
    fixIds: list[str]


class RuleResult(ContractModel):
    ruleId: str
    status: Literal['disabled', 'skipped', 'findings', 'passed']
    reason: str | None


class QualityReport(ContractModel):
    config: CheckConfig
    configHash: str
    executorVersion: str
    ruleVersions: dict[str, str]
    rules: list[RuleResult]
    findings: list[Finding]
    colorCount: int = Field(ge=0)
    frameCount: int = Field(ge=1)


class StoredReport(ContractModel):
    """Historical rows can predate the current quality executor's full report."""
    id: str
    assetVersionId: str
    created: str
    config: dict[str, JsonValue] | None = None
    configHash: str | None = None
    executorVersion: str | None = None
    ruleVersions: dict[str, str] | None = None
    rules: list[RuleResult] | None = None
    findings: list[Finding] | None = None
    colorCount: int | None = Field(default=None, ge=0)
    frameCount: int | None = Field(default=None, ge=1)


class Inspection(ContractModel):
    assetId: str
    versionId: str
    report: QualityReport


class FrameMetadata(ContractModel):
    origin: Point | None
    baselineY: int | None
    collisionRects: list[Rect]


class RepairChange(ContractModel):
    frameId: str
    changedPixels: int = Field(ge=0)
    before: tuple[int, int]
    after: tuple[int, int]
    changedBounds: Rect | None
    metadataBefore: FrameMetadata
    metadataAfter: FrameMetadata
    metadataChanged: bool


class RepairPreview(ContractModel):
    ok: Literal[True]
    previewId: str
    baseVersionId: str
    actions: list[RepairAction]
    changes: list[RepairChange]
    report: QualityReport


class RepairCommit(ContractModel):
    ok: Literal[True]
    asset: AssetInfo
    report: StoredReport
    resultVersionId: str


class AssetSave(ContractModel):
    ok: Literal[True]
    asset: AssetInfo


def inline_schema(schema):
    """Inline local definitions for schemas embedded in argument properties.

    WithJsonSchema does not hoist nested $defs; leaving their #/$defs refs would
    incorrectly point at the enclosing tool input schema. Domain models here
    are finite/nonrecursive.
    """
    definitions = schema.get('$defs', {})
    def expand(value):
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, dict):
            if '$ref' in value:
                name = value['$ref'].removeprefix('#/$defs/')
                return {**expand(definitions[name]), **{key: expand(item) for key, item in value.items() if key != '$ref'}}
            return {key: expand(item) for key, item in value.items() if key != '$defs'}
        return value
    return expand(schema)


# Keep validation inside each tool's sanitized error boundary. Publishing the
# precise schema does not make SDK validation echo rejected pixel/config inputs.
DocumentInput = Annotated[dict, WithJsonSchema(inline_schema(Document.model_json_schema()))]
ConfigInput = Annotated[dict, WithJsonSchema(inline_schema(CheckConfig.model_json_schema()))]
ActionsInput = Annotated[list[dict], WithJsonSchema({**inline_schema(TypeAdapter(list[RepairAction]).json_schema()), 'minItems': 1, 'maxItems': 5})]

HealthOutput = WireObject[HealthInfo]
AssetOutput = WireObject[AssetInfo | ToolFailure]
DocumentOutput = WireObject[Document | ToolFailure]
ConfigOutput = WireObject[CheckConfig | ToolFailure]
InspectionOutput = WireObject[Inspection | ToolFailure]
PreviewOutput = WireObject[RepairPreview | ToolFailure]
CommitOutput = WireObject[RepairCommit | ToolFailure]
SaveOutput = WireObject[AssetSave | ToolFailure]
ProjectOutput = WireObject[ProjectInfo | ToolFailure]
ReportOutput = WireObject[StoredReport | ToolFailure]
