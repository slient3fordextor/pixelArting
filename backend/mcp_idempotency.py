"""Durable, atomic receipts for database-only MCP writes, preserving v1 shapes."""

from functools import wraps
import hashlib
import inspect
import json
import re
from types import MappingProxyType
from typing import Annotated

from pydantic import TypeAdapter, ValidationError, WithJsonSchema
from pydantic.fields import FieldInfo
from pydantic_core import to_jsonable_python

from .mcp_contract import error_result

IDEMPOTENCY_META = 'pixelarting/idempotency'
IDEMPOTENCY_URI = 'pixelart://contract/idempotency/v1'
KEY_PATTERN = r'^[a-zA-Z0-9_.:-]+$'
OptionalIdempotencyKey = Annotated[str | None, WithJsonSchema({'anyOf': [
    {'type': 'string', 'minLength': 1, 'maxLength': 128, 'pattern': KEY_PATTERN}, {'type': 'null'}],
    'description': 'Optional durable write key. Reuse the same key and arguments after transport failure; omitted/null retains legacy semantics.'})]

GENERIC_WRITE_TOOLS = frozenset({
    'create_project', 'create_blank_asset', 'update_project_config', 'update_asset_document',
    'rename_asset', 'preview_asset_repair', 'commit_asset_repair', 'restore_asset_version',
    'cancel_generation', 'update_candidate_state', 'import_generation_candidate',
})
IDEMPOTENCY_RULES = MappingProxyType({
    **{name: ('mcp-writes', False, 'original-success-snapshot') for name in GENERIC_WRITE_TOOLS},
    'start_generation': ('generation-requests', True, 'current-task'),
    'retry_generation': ('generation-requests', True, 'current-task'),
    'import_asset_file': ('file-import-requests', True, 'initial-identity-current-report'),
    'import_project_backup': ('project-import-requests', True, 'initial-identity-current-report'),
})


def describe_idempotency(name):
    namespace, required, replay = IDEMPOTENCY_RULES[name]
    return {'argument': 'idempotency_key', 'required': required, 'namespace': namespace,
            'replay': replay, 'contractUri': IDEMPOTENCY_URI}


class RejectedWrite(Exception):
    """Force rollback when a legacy tool represents failure as a return value."""
    def __init__(self, result):
        self.result = result


def write_references(name, arguments, result):
    if name == 'create_project':
        return [('project', result['id'])]
    if name == 'update_project_config':
        return [('project', arguments['project_id'])]
    if name == 'preview_asset_repair':
        return [('asset', arguments['asset_id']), ('version', arguments['version_id']), ('preview', result['previewId'])]
    if name in {'cancel_generation', 'update_candidate_state'}:
        return [('generation', result['id'])]
    if name == 'import_generation_candidate':
        return [('generation', arguments['generation_id']), ('project', result['projectId']),
                ('asset', result['assetId']), ('version', result['currentVersionId'])]
    asset = result['asset'] if name in {'update_asset_document', 'commit_asset_repair'} else result
    references = [('project', asset['projectId']), ('asset', asset['id']), ('version', asset['currentVersionId'])]
    if name == 'commit_asset_repair':
        references.extend([('preview', arguments['preview_id']), ('report', result['report']['id'])])
    return references


def idempotent_write(workspace, require_writes, *, after_commit=None):
    """Wrap a registered synchronous tool; admission still runs outside it."""
    def decorate(function):
        if function.__name__ not in GENERIC_WRITE_TOOLS:
            raise ValueError('Unknown atomic MCP write')
        signature = inspect.signature(function, eval_str=True)
        response_adapter = TypeAdapter(signature.return_annotation)

        @wraps(function)
        def execute(*args, **kwargs):
            try:
                require_writes()
                bound = signature.bind(*args, **kwargs)
                bound.apply_defaults()
                for name, value in bound.arguments.items():
                    if isinstance(value, FieldInfo):
                        bound.arguments[name] = value.default
                key = bound.arguments['idempotency_key']
                if key is None:
                    return function(*bound.args, **bound.kwargs)
                if not isinstance(key, str) or not 1 <= len(key) <= 128 or re.fullmatch(KEY_PATTERN, key) is None:
                    raise ValueError('Invalid write idempotency key')
                arguments = to_jsonable_python({name: value for name, value in bound.arguments.items() if name != 'idempotency_key'})
                canonical = json.dumps({'version': '1', 'tool': function.__name__, 'arguments': arguments},
                                       ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
                fingerprint = hashlib.sha256(canonical.encode('utf-8')).hexdigest()

                def apply():
                    result = to_jsonable_python(function(*bound.args, **bound.kwargs))
                    if result.get('ok') is False:
                        raise RejectedWrite(result)
                    try:
                        response_adapter.validate_python(result)
                    except ValidationError:
                        raise RuntimeError('Write returned invalid output') from None
                    return result, write_references(function.__name__, arguments, result)

                result = workspace().mcp_write_once(function.__name__, key, fingerprint, apply)
                if after_commit is not None:
                    after_commit(arguments, result)
                return result
            except RejectedWrite as rejected:
                return rejected.result
            except Exception as error:
                return error_result(error).model_dump()

        # FastMCP evaluates annotations in the callable's module. Resolve the
        # original function's forward references before crossing this module.
        execute.__signature__ = signature
        return execute
    return decorate
