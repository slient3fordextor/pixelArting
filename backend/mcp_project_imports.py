"""Atomic project-backup imports, sharing the desktop archive and Store pipeline."""

import hashlib
import json
from typing import Annotated, Literal

from mcp.types import ToolAnnotations
from pydantic import WithJsonSchema

from .exchange import MAX_PROJECT_ASSETS, import_project
from .mcp_asset_contract import ProjectInfo, QualityReport, WireObject
from .mcp_contract import ContractModel, ToolFailure, error_result
from .mcp_imports import FileData, RequestKey, MAX_IMPORT_BYTES, MAX_EXPANDED_BYTES, MAX_IMPORT_PIXELS, decode_file
from .models import CheckConfig, ProjectCreate
from .quality import inspect

ProjectName = Annotated[str, WithJsonSchema({'type': 'string', 'minLength': 1, 'maxLength': 80})]


class BackupAssetPreview(ContractModel):
    sourceAssetId: str
    sourceVersionId: str
    name: str
    frameCount: int
    layerCount: int
    report: QualityReport


class ProjectImportPreview(ContractModel):
    ok: Literal[True] = True
    contractVersion: Literal['1'] = '1'
    format: Literal['pixelart-project-v1'] = 'pixelart-project-v1'
    sourceChecksum: str
    byteLength: int
    name: str
    config: CheckConfig
    assets: list[BackupAssetPreview]


class RestoredAsset(ContractModel):
    assetId: str
    versionId: str
    name: str
    sourceAssetId: str
    sourceVersionId: str
    report: QualityReport


class ProjectBackupImport(ContractModel):
    ok: Literal[True] = True
    contractVersion: Literal['1'] = '1'
    project: ProjectInfo
    sourceChecksum: str
    replayed: bool
    assets: list[RestoredAsset]


PreviewOutput = WireObject[ProjectImportPreview | ToolFailure]
ImportOutput = WireObject[ProjectBackupImport | ToolFailure]


def requested_name(name: str | None) -> str | None:
    if name is not None and len(name) > 80:
        raise ValueError('Project name exceeds 80 characters')
    return ProjectCreate(name=name.strip()).name if name is not None else None


def parse_backup(data: bytes, name: str | None):
    original_name, config, documents = import_project(
        data, max_expanded_bytes=MAX_EXPANDED_BYTES, pixel_budget=MAX_IMPORT_PIXELS,
    )
    return name if name is not None else original_name, config, documents


def register_project_import_tools(mcp, workspace, require_writes):
    @mcp.resource('pixelart://contract/project-imports/v1', mime_type='application/json')
    def project_import_contract() -> str:
        return json.dumps({
            'contractVersion': '1', 'format': 'pixelart-project-v1',
            'maxBytes': MAX_IMPORT_BYTES, 'maxExpandedBytes': MAX_EXPANDED_BYTES,
            'maxPixels': MAX_IMPORT_PIXELS, 'maxAssets': MAX_PROJECT_ASSETS,
            'preview': PreviewOutput.model_json_schema(), 'import': ImportOutput.model_json_schema(),
            'scope': 'Creates a new project with configuration and all archived current-version documents; new project/asset/version IDs. No overwrite, old history, jobs, credentials or source file recovery.',
            'authorization': 'Preview requires read+admin; import additionally requires write scope, process write gate and configured one-use confirmation. No dynamic grants are added for the new project.',
            'transfer': 'Strict base64, same limits as asset imports; ZIP expansion and pixel budgets are cumulative across the whole project.',
            'previewPolicy': 'Read-only validation and reports using archive config; no project or source files created; advisory, not a commit token.',
            'idempotency': 'Required workspace-scoped project-import key, separate from file/generation keys. Binds original byte SHA-256 and trimmed optional name. New project, configuration, all assets/versions and immutable receipt commit in one transaction. Same request replays initial IDs/name; changed request or deleted project/initial asset/version conflicts. Receipts do not expire automatically.',
            'reportPolicy': 'Import/replay inspects initial versions using the currently read restored-project config. Reports can change; read currentVersionId before later edits and inspect afterwards.',
        }, ensure_ascii=False)

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def preview_project_import(data_base64: FileData, name: ProjectName | None = None) -> PreviewOutput:
        """Validate a PixelArting project backup and review every asset's quality without creating anything.

        Supply strict base64 (max 2 MiB). name optionally overrides the project
        name. Requires read+admin in OAuth mode. Budgets apply to the entire
        archive. Only archived current documents/config are recoverable.
        """
        try:
            data, digest = decode_file(data_base64)
            project_name, config, documents = parse_backup(data, requested_name(name))
            assets = []
            for document in documents:
                source = document.provenance['importedFrom']
                assets.append(BackupAssetPreview(
                    sourceAssetId=source['assetId'], sourceVersionId=source['versionId'],
                    name=document.name, frameCount=len(document.frames), layerCount=len(document.layers),
                    report=QualityReport.model_validate(inspect(document, config)),
                ))
            return ProjectImportPreview(sourceChecksum=digest, byteLength=len(data), name=project_name,
                                        config=config, assets=assets).model_dump()
        except Exception as error:
            return error_result(error).model_dump()

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def import_project_backup(data_base64: FileData, idempotency_key: RequestKey, name: ProjectName | None = None) -> ImportOutput:
        """Restore a project backup into a new project, with atomic persistent retry protection.

        Review preview_project_import first. Requires read+write+admin in OAuth
        mode and the process write gate. Same key/data/name replays initial
        project/assets/versions; changed inputs or deleted results conflict.
        Never overwrites existing projects or adds authorization grants.
        """
        try:
            require_writes()
            data, digest = decode_file(data_base64)
            normalized_name = requested_name(name)
            fingerprint = hashlib.sha256(json.dumps({'sourceChecksum': digest, 'name': normalized_name},
                                                    sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            store = workspace()
            receipt = store.project_import_for_request(idempotency_key, fingerprint)
            if receipt is None:
                project_name, config, documents = parse_backup(data, normalized_name)
                receipt = store.restore_project_once(project_name, config, documents, idempotency_key, fingerprint)
            config = store.project_config(receipt['project']['id'])
            assets = []
            for asset in receipt['assets']:
                document = store.document(asset['assetId'], asset['versionId'])
                source = document.provenance['importedFrom']
                assets.append(RestoredAsset(**asset, sourceAssetId=source['assetId'], sourceVersionId=source['versionId'],
                                           report=QualityReport.model_validate(inspect(document, config))))
            return ProjectBackupImport(project=receipt['project'], sourceChecksum=digest,
                                       replayed=receipt['replayed'], assets=assets).model_dump()
        except Exception as error:
            return error_result(error).model_dump()
