"""Fail-closed project authorization, shared rate budgets and an argument-free audit."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid

from .mcp_auth import READ, current_principal
from .mcp_approval import WriteApprovals, ConfirmationRequired, ApprovalUnavailable
from .mcp_permissions import TOOL_RULES, match_resource

KNOWN_TOOLS = frozenset(TOOL_RULES)
WRITES = frozenset(name for name, rule in TOOL_RULES.items() if rule.write)


class PolicyDenied(PermissionError):
    pass


class RateLimited(PolicyDenied):
    pass


class InsufficientScope(PolicyDenied):
    def __init__(self, required):
        super().__init__('Additional authorization scope required')
        self.required = required


class AuditUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class AuditAttempt:
    id: str
    subject: str
    operation: str
    project_id: str | None
    issuer: str
    workspace_id: str
    client_id: str


preauthorized = ContextVar('pixelart_authorized_operation', default=None)


class SecurityJournal:
    """One SQLite journal per workspace, not per HTTP worker or access token."""
    def __init__(self, root: Path):
        self.path = root / 'security' / 'audit.sqlite3'

    @contextmanager
    def connection(self):
        connection = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            connection = sqlite3.connect(self.path, timeout=5)
            self.path.chmod(0o600)
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS audit_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
                    occurred REAL NOT NULL, subject TEXT NOT NULL, operation TEXT NOT NULL,
                    project_id TEXT, outcome TEXT NOT NULL, issuer TEXT NOT NULL,
                    workspace_id TEXT NOT NULL, client_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS rate_buckets (
                    subject TEXT NOT NULL, minute INTEGER NOT NULL, calls INTEGER NOT NULL,
                    writes INTEGER NOT NULL, PRIMARY KEY(subject,minute));
            ''')
            with connection:
                yield connection
        except (OSError, sqlite3.Error):
            raise AuditUnavailable('Security journal unavailable') from None
        finally:
            if connection is not None:
                connection.close()

    def append(self, attempt: AuditAttempt, outcome: str):
        with self.connection() as connection:
            self._insert(connection, attempt, outcome)

    @staticmethod
    def _insert(connection, attempt, outcome):
        connection.execute('INSERT INTO audit_events(request_id,occurred,subject,operation,project_id,outcome,issuer,workspace_id,client_id) VALUES(?,?,?,?,?,?,?,?,?)',
                           (attempt.id, time.time(), attempt.subject, attempt.operation, attempt.project_id, outcome, attempt.issuer, attempt.workspace_id, attempt.client_id))

    def begin(self, attempt: AuditAttempt, grant, write: bool):
        minute = int(time.time()) // 60
        limited = False
        with self.connection() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('SELECT calls,writes FROM rate_buckets WHERE subject=? AND minute=?', (attempt.subject, minute)).fetchone()
            calls, writes = row if row else (0, 0)
            limited = calls >= grant.calls_per_minute or (write and writes >= grant.writes_per_minute)
            self._insert(connection, attempt, 'rate_limited' if limited else 'attempt')
            if not limited:
                connection.execute('INSERT INTO rate_buckets VALUES(?,?,?,?) ON CONFLICT(subject,minute) DO UPDATE SET calls=excluded.calls,writes=excluded.writes',
                                   (attempt.subject, minute, calls + 1, writes + int(write)))
            connection.execute('DELETE FROM rate_buckets WHERE minute < ?', (minute - 2,))
        if limited:
            raise RateLimited('Request rate limit exceeded')


class MCPPolicy:
    def __init__(self, config, workspace, root, allow_write):
        self.config, self.workspace, self.allow_write = config, workspace, allow_write
        self.journal = SecurityJournal(root)
        self.approvals = WriteApprovals(root)

    @staticmethod
    def _id(value):
        if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', value):
            raise PolicyDenied('Resource unavailable')
        return value

    def project_for_asset(self, value):
        try:
            return self.workspace().asset_project_id(self._id(value))
        except KeyError:
            raise PolicyDenied('Resource unavailable') from None

    def project_for_task(self, value):
        try:
            return self.workspace().generation_project_id(self._id(value))
        except KeyError:
            raise PolicyDenied('Resource unavailable') from None

    def _permit(self, principal, project_id):
        if project_id is not None:
            self._id(project_id)
        if not principal.allows_project(project_id):
            raise PolicyDenied('Resource unavailable')
        return project_id

    def _attempt(self, principal, operation, project_id=None, request_id=None):
        return AuditAttempt(request_id or uuid.uuid4().hex, principal.subject, operation, project_id,
                            self.config.issuer, self.config.workspace_id, principal.client_id)

    def _tool_project(self, principal, rule, arguments):
        policy = rule.project_policy
        if policy in {'workspace', 'visible-projects'}:
            return None
        if policy == 'project-argument':
            return self._permit(principal, self._id(arguments.get('project_id')))
        if policy == 'asset-owner':
            return self._permit(principal, self.project_for_asset(arguments.get('asset_id')))
        if policy in {'generation-owner', 'generation-and-destination'}:
            project = self._permit(principal, self.project_for_task(arguments.get('generation_id')))
            if policy == 'generation-and-destination':
                self._permit(principal, arguments.get('project_id') or project)
            return project
        if policy == 'request-project':
            request = arguments.get('request')
            if not isinstance(request, dict):
                raise PolicyDenied('Invalid generation request')
            return self._permit(principal, request.get('projectId'))
        if policy == 'optional-project-filter':
            if arguments.get('project_id') is not None:
                return self._permit(principal, self._id(arguments['project_id']))
            return None
        raise PolicyDenied('Operation not permitted')

    def begin_tool(self, name, arguments):
        existing = preauthorized.get()
        if existing is not None and existing[0] == self.tool_key(name, arguments):
            return existing[1]
        principal = current_principal(self.config)
        attempt = self._attempt(principal, name if name in KNOWN_TOOLS else 'unknown_tool')
        try:
            rule = TOOL_RULES.get(name)
            write = rule.write if rule is not None else False
            # Persist attempt and reserve the budget before any workspace access.
            self.journal.begin(attempt, principal.grant, write)
            if rule is None:
                raise PolicyDenied('Operation not permitted')
            if not set(rule.scopes) <= principal.scopes:
                raise InsufficientScope(list(rule.scopes))
            if write and not self.allow_write:
                raise PolicyDenied('Write access denied')
            project = self._tool_project(principal, rule, arguments)
            attempt = self._attempt(principal, attempt.operation, project, attempt.id)
            if write and self.config.require_write_confirmation:
                self.approvals.require(self.config, principal, name, arguments)
            return attempt
        except ConfirmationRequired:
            self.journal.append(attempt, 'confirmation_required')
            raise
        except ApprovalUnavailable:
            self.journal.append(attempt, 'confirmation_unavailable')
            raise
        except RateLimited:
            raise
        except PolicyDenied:
            self.journal.append(attempt, 'denied')
            raise
        except PermissionError:
            self.journal.append(attempt, 'denied')
            raise PolicyDenied('Authentication required') from None

    def begin_resource(self, uri):
        existing = preauthorized.get()
        if existing is not None and existing[0] == self.resource_key(uri):
            return existing[1]
        principal = current_principal(self.config)
        attempt = self._attempt(principal, 'read_resource')
        self.journal.begin(attempt, principal.grant, False)
        try:
            if READ not in principal.scopes:
                raise PolicyDenied('Read access denied')
            matched = match_resource(uri)
            if matched is None:
                raise PolicyDenied('Resource unavailable')
            rule, parameters = matched
            if rule.project_policy == 'workspace':
                return attempt
            if rule.project_policy == 'asset-owner':
                project = self.project_for_asset(parameters[rule.owner_parameter])
            elif rule.project_policy == 'generation-owner':
                project = self.project_for_task(parameters[rule.owner_parameter])
            else:
                raise PolicyDenied('Resource unavailable')
            self._permit(principal, project)
            return self._attempt(principal, attempt.operation, project, attempt.id)
        except PolicyDenied:
            self.journal.append(attempt, 'denied')
            raise

    def finish(self, attempt, success):
        self.journal.append(attempt, 'completed' if success else 'failed')

    def tool_key(self, name, arguments):
        return (id(self), 'tool', name, json.dumps(arguments, sort_keys=True, separators=(',', ':')))

    def resource_key(self, uri):
        return (id(self), 'resource', uri)


def successful_result(result):
    if isinstance(result, tuple) and len(result) == 2 and isinstance(result[1], dict):
        payload = result[1].get('result', result[1])
        if isinstance(payload, list):
            return not any(isinstance(item, dict) and item.get('ok') is False for item in payload)
        return not (isinstance(payload, dict) and payload.get('ok') is False)
    if isinstance(result, (list, tuple)):
        # Untyped legacy preview tools encode failures as text content instead
        # of structuredContent. Do not call those successful audit outcomes.
        for block in result:
            text = getattr(block, 'text', None)
            if isinstance(text, str) and len(text) <= 4096:
                try:
                    payload = json.loads(text)
                except ValueError:
                    continue
                if isinstance(payload, dict) and payload.get('ok') is False:
                    return False
    return True
