"""Bounded file transfers using the desktop PNG/sheet and layered ZIP parsers."""

import base64
import hashlib
import json
from typing import Annotated, Literal

from mcp.types import ToolAnnotations
from pydantic import Field, WithJsonSchema

from .exchange import import_bundle
from .images import decode_png
from .imports import ImportMapping, SheetLayout, imported_document, retain_png
from .mcp_asset_contract import QualityReport, WireObject, inline_schema
from .mcp_contract import Capabilities, ContractModel, ToolFailure, error_result
from .models import Animation, Document, Layer
from .quality import inspect

MAX_IMPORT_BYTES = Capabilities.model_fields['maxImportBytes'].default
MAX_EXPANDED_BYTES = Capabilities.model_fields['maxImportExpandedBytes'].default
MAX_IMPORT_PIXELS = Capabilities.model_fields['maxImportPixels'].default
MAX_BASE64_CHARS = ((MAX_IMPORT_BYTES + 2) // 3) * 4


class ImportOptions(ContractModel):
    name: str = Field(default='', max_length=100)
    layout: SheetLayout = Field(default_factory=SheetLayout)
    mapping: list[ImportMapping] = Field(default_factory=list, max_length=64)
    mappingConfirmed: bool = False


# Validate inside the sanitized tool boundary, avoiding rejected payloads in SDK
# validation errors. The published schema still provides precise nested fields.
OptionsInput = Annotated[dict, WithJsonSchema(inline_schema(ImportOptions.model_json_schema()))]
FileData = Annotated[str, WithJsonSchema({'type': 'string', 'minLength': 4, 'maxLength': MAX_BASE64_CHARS, 'contentEncoding': 'base64'})]
RequestKey = Annotated[str, WithJsonSchema({'type': 'string', 'pattern': '^[a-zA-Z0-9_.:-]{1,128}$'})]
FileFormat = Literal['png', 'layered-zip']


class ImportFrame(ContractModel):
    id: str
    width: int
    height: int


class ImportPreview(ContractModel):
    ok: Literal[True] = True
    contractVersion: Literal['1'] = '1'
    projectId: str
    format: FileFormat
    sourceChecksum: str
    byteLength: int
    name: str
    type: Literal['image', 'character']
    layers: list[Layer]
    frames: list[ImportFrame]
    animations: list[Animation]
    layout: SheetLayout | None
    report: QualityReport


class FileImport(ContractModel):
    ok: Literal[True] = True
    contractVersion: Literal['1'] = '1'
    assetId: str
    projectId: str
    versionId: str
    name: str
    sourceChecksum: str
    replayed: bool
    report: QualityReport


PreviewOutput = WireObject[ImportPreview | ToolFailure]
ImportOutput = WireObject[FileImport | ToolFailure]


def decode_file(data_base64: str) -> tuple[bytes, str]:
    if not 4 <= len(data_base64) <= MAX_BASE64_CHARS:
        raise ValueError('File must contain at most 2 MiB')
    try:
        data = base64.b64decode(data_base64, validate=True)
    except (ValueError, base64.binascii.Error):
        raise ValueError('File must be strict base64, without a data URL prefix') from None
    if not data or len(data) > MAX_IMPORT_BYTES:
        raise ValueError('File must contain at most 2 MiB')
    return data, hashlib.sha256(data).hexdigest()


def parse_file(data: bytes, digest: str, file_format: FileFormat, options: ImportOptions) -> Document:
    if file_format == 'png':
        image = decode_png(data, max_side=2048)
        if image.width * image.height > MAX_IMPORT_PIXELS:
            raise ValueError('Import pixel budget exceeded')
        return imported_document(image, options.layout, digest, 'import.png', options.name,
                                 json.dumps([item.model_dump() for item in options.mapping]), options.mappingConfirmed)
    if file_format != 'layered-zip':
        raise ValueError('Unsupported file format')
    if options.layout != SheetLayout() or options.mapping or options.mappingConfirmed:
        raise ValueError('Sheet options only apply to PNG')
    document = import_bundle(data, max_expanded_bytes=MAX_EXPANDED_BYTES, pixel_budget=MAX_IMPORT_PIXELS)
    if options.name.strip():
        document.name = options.name.strip()
    return document


def register_import_tools(mcp, workspace, require_writes):
    @mcp.resource('pixelart://contract/imports/v1', mime_type='application/json')
    def import_contract() -> str:
        return json.dumps({
            'contractVersion': '1', 'formats': ['png', 'layered-zip'],
            'maxBytes': MAX_IMPORT_BYTES, 'maxExpandedBytes': MAX_EXPANDED_BYTES,
            'maxPixels': MAX_IMPORT_PIXELS, 'options': ImportOptions.model_json_schema(),
            'preview': PreviewOutput.model_json_schema(), 'import': ImportOutput.model_json_schema(),
            'transfer': 'Strict base64 bytes; no file paths, URLs, data URLs, APNG or arbitrary ZIP formats',
            'previewPolicy': 'Read-only validation and quality report; no asset or source file is created; not a commit token',
            'idempotency': 'Required workspace-scoped file-import key (separate from generation keys), 1..128 ASCII letters/digits/_.:-. Canonical validated options, format, project and original byte SHA-256 are bound atomically to one initial asset/version. Same request replays; changed request or deleted asset/version conflicts. Receipts persist without automatic expiry.',
            'reportPolicy': 'Import/replay checks the immutable initial version against the current project config. Findings and configHash can change; get_asset before subsequent edits and inspect_asset afterwards.',
            'sourcePolicy': 'PNG source retained under its SHA-256 before database commit; failed/crashed imports may leave an unreferenced source. ZIP stays in memory; embedded source references do not authorize filesystem access.',
            'projectImportContractUri': 'pixelart://contract/project-imports/v1',
            'unsupported': ['aseprite', 'remote-url', 'chunked-upload'],
        }, ensure_ascii=False)

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def preview_file_import(project_id: str, data_base64: FileData, file_format: FileFormat = 'png', options: OptionsInput | None = None) -> PreviewOutput:
        """Validate PNG/sprite-sheet or PixelArting layered ZIP and inspect quality, without creating files/assets.

        Supply strict base64 bytes (max 2 MiB), never a path or URL. Sheet layout
        and confirmed animation mappings go in options. Preview is advisory;
        import_asset_file repeats validation using current project configuration.
        """
        try:
            config = workspace().project_config(project_id)
            data, digest = decode_file(data_base64)
            parsed_options = ImportOptions.model_validate(options or {})
            document = parse_file(data, digest, file_format, parsed_options)
            return ImportPreview(
                projectId=project_id, format=file_format, sourceChecksum=digest, byteLength=len(data),
                name=document.name, type=document.type, layers=document.layers,
                frames=[ImportFrame(id=frame.id, width=frame.width, height=frame.height) for frame in document.frames],
                animations=document.animations,
                layout=SheetLayout.model_validate(document.provenance['sheetLayout']) if file_format == 'png' else None,
                report=QualityReport.model_validate(inspect(document, config)),
            ).model_dump()
        except Exception as error:
            return error_result(error).model_dump()

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def import_asset_file(project_id: str, data_base64: FileData, idempotency_key: RequestKey, file_format: FileFormat = 'png', options: OptionsInput | None = None) -> ImportOutput:
        """Create one asset from PNG/sprite-sheet or PixelArting layered ZIP, with a required persistent retry key.

        Review preview_file_import first. Same key and validated arguments replay
        the original asset/version even after restart or subsequent edits. A
        changed request/deleted result conflicts. Creates a new asset; never
        replaces an existing version. Read get_asset before later edits.
        """
        try:
            require_writes()
            store = workspace()
            config = store.project_config(project_id)
            data, digest = decode_file(data_base64)
            parsed_options = ImportOptions.model_validate(options or {})
            fingerprint = hashlib.sha256(json.dumps({
                'projectId': project_id, 'format': file_format, 'sourceChecksum': digest,
                'options': parsed_options.model_dump(),
            }, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            receipt = store.file_import_for_request(project_id, idempotency_key, fingerprint)
            if receipt is None:
                document = parse_file(data, digest, file_format, parsed_options)
                if file_format == 'png':
                    retain_png(store.root, data)
                receipt = store.import_asset_once(project_id, document, idempotency_key, fingerprint)
            document = store.document(receipt['assetId'], receipt['versionId'])
            return FileImport(**receipt, sourceChecksum=digest, report=QualityReport.model_validate(inspect(document, config))).model_dump()
        except Exception as error:
            return error_result(error).model_dump()
