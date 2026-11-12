"""Additive v1 discovery contract; asset documents retain schemaVersion 1.1."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

from .store import Conflict, GenerationQueueFull, IdempotencyConflict
from .generation_service import GenerationNotConfigured

from ._version import SERVICE_VERSION
CONTRACT_VERSION = "1"
EXPORT_TARGETS = ("png", "frames", "sheet", "json", "godot")


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolFailure(ContractModel):
    ok: Literal[False] = False
    contractVersion: Literal["1"] = "1"
    error: str
    code: Literal["permission_denied", "not_found", "version_conflict", "idempotency_conflict", "invalid_input", "internal_error", "not_configured", "queue_full"]
    message: str
    retryable: bool = False


def error_result(error: Exception) -> ToolFailure:
    # Do not serialize validation inputs, paths, raw adapter errors or secrets.
    if isinstance(error, PermissionError):
        code, message = "permission_denied", "Workspace writes are disabled"
    elif isinstance(error, KeyError):
        code, message = "not_found", "Requested workspace resource was not found"
    elif isinstance(error, IdempotencyConflict):
        code, message = "idempotency_conflict", "Idempotency key belongs to a different request or a deleted resource"
    elif isinstance(error, Conflict):
        code, message = "version_conflict", "State changed; re-read the resource before retrying"
    elif isinstance(error, ValueError):
        code, message = "invalid_input", "Invalid tool input; check the tool schema and resource constraints"
    elif isinstance(error, GenerationNotConfigured):
        code, message = "not_configured", "Configure an AI provider locally before starting generation"
    elif isinstance(error, GenerationQueueFull):
        code, message = "queue_full", "Generation queue is full; wait for existing tasks to finish"
    else:
        code, message = "internal_error", "PixelArting could not complete this operation"
    return ToolFailure(error=type(error).__name__, code=code, message=message)


class Capabilities(ContractModel):
    contractVersion: Literal["1"] = "1"
    serviceVersion: str = SERVICE_VERSION
    documentSchemaVersion: Literal["1.1"] = "1.1"
    mode: Literal["local-single-user", "authenticated-single-workspace"] = "local-single-user"
    writeEnabled: bool
    writeConfirmationRequired: bool = False
    authentication: Literal["local-process-only", "oauth-jwt"] = "local-process-only"
    transports: list[str] = ["stdio", "streamable-http"]
    exportTargets: list[str] = list(EXPORT_TARGETS)
    features: list[str] = ["projects", "assets", "versions", "preview", "quality", "repair", "export", "generation", "candidates", "candidate-import", "task-polling", "file-import", "file-import-preview", "project-backup-import", "project-backup-preview", "permissions", "write-idempotency", "workspace-http-v1"]
    unavailable: list[str] = ["oauth-authorization-server", "write-confirmation", "multi-tenant", "task-events"]
    importFormats: list[str] = ["png", "layered-zip"]
    projectImportFormats: list[str] = ["pixelart-project-v1"]
    maxImportBytes: int = 2 * 1024 * 1024
    maxImportExpandedBytes: int = 16 * 1024 * 1024
    maxImportPixels: int = 1_048_576
    maxExportBytes: int = 16 * 1024 * 1024


class ExportDescriptor(ContractModel):
    ok: Literal[True] = True
    contractVersion: Literal["1"] = "1"
    assetId: str
    versionId: str
    frameId: str | None = None
    target: Literal["png", "frames", "sheet", "json", "godot"]
    resourceUri: str
    mimeType: Literal["image/png", "application/zip"]
    filename: str
    byteLength: int
