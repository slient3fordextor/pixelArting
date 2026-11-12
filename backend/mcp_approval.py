"""Local operator approval of exact OAuth writes, never an MCP approval tool."""

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid


class ConfirmationRequired(PermissionError):
    def __init__(self, request_id, digest):
        super().__init__('Local operator confirmation required')
        self.request_id, self.digest = request_id, digest


class ApprovalUnavailable(RuntimeError):
    pass


class WriteApprovals:
    """A separate, bounded, short-lived store; arguments never enter the audit."""

    lifetime = 600

    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.path = self.root / 'security' / 'write-approvals.sqlite3'

    @contextmanager
    def connection(self):
        connection = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            connection = sqlite3.connect(self.path, timeout=5)
            self.path.chmod(0o600)
            connection.execute('''CREATE TABLE IF NOT EXISTS write_approvals (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL, subject TEXT NOT NULL,
                payload TEXT, expires REAL NOT NULL, state TEXT NOT NULL)''')
            with connection:
                connection.execute('BEGIN IMMEDIATE')
                # Erase reviewed arguments on expiry, then remove old receipts.
                connection.execute("UPDATE write_approvals SET payload=NULL,state='expired' WHERE expires<=? AND state IN ('pending','approved')", (time.time(),))
                connection.execute('DELETE FROM write_approvals WHERE expires<?', (time.time() - 86400,))
                yield connection
        except (OSError, sqlite3.Error):
            raise ApprovalUnavailable('Write confirmation storage unavailable') from None
        finally:
            if connection is not None:
                connection.close()

    def require(self, config, principal, name, arguments):
        payload = json.dumps({
            'issuer': config.issuer, 'resource': config.resource,
            'workspaceId': config.workspace_id, 'workspacePath': str(self.root),
            'subject': principal.subject, 'clientId': principal.client_id,
            'tool': name, 'arguments': arguments,
        }, sort_keys=True, separators=(',', ':'), allow_nan=False)
        if len(payload.encode()) > 4 * 1024 * 1024:
            raise ApprovalUnavailable('Write confirmation request too large')
        digest = hashlib.sha256(payload.encode()).hexdigest()
        consumed = False
        with self.connection() as connection:
            row = connection.execute("SELECT id,state FROM write_approvals WHERE digest=? AND state IN ('pending','approved') AND expires>?", (digest, time.time())).fetchone()
            if row is not None:
                request_id, state = row
                if state == 'approved':
                    connection.execute("UPDATE write_approvals SET state='consumed',payload=NULL WHERE id=?", (request_id,))
                    consumed = True
            else:
                pending = connection.execute("SELECT COUNT(*),COALESCE(SUM(subject=?),0) FROM write_approvals WHERE state IN ('pending','approved')", (principal.subject,)).fetchone()
                if pending[0] >= 1000 or pending[1] >= 64:
                    raise ApprovalUnavailable('Write confirmation queue full; wait for expiry')
                request_id = uuid.uuid4().hex
                connection.execute('INSERT INTO write_approvals VALUES(?,?,?,?,?,?)',
                                   (request_id, digest, principal.subject, payload, time.time() + self.lifetime, 'pending'))
        # Raise after commit, so the pending request survives the denial.
        if not consumed:
            raise ConfirmationRequired(request_id, digest)

    def review(self, request_id):
        if not re.fullmatch(r'[a-f0-9]{32}', request_id):
            raise ValueError('Invalid confirmation request ID')
        with self.connection() as connection:
            row = connection.execute('SELECT digest,payload,expires,state FROM write_approvals WHERE id=?', (request_id,)).fetchone()
        if row is None or row[1] is None or row[3] not in {'pending', 'approved'}:
            raise ValueError('Confirmation request unavailable or expired')
        return {'requestId': request_id, 'digest': row[0], 'expiresAt': row[2], 'state': row[3], 'intent': json.loads(row[1])}

    def approve(self, request_id, digest):
        if not re.fullmatch(r'[a-f0-9]{32}', request_id) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('Invalid confirmation ID or digest')
        with self.connection() as connection:
            changed = connection.execute("UPDATE write_approvals SET state='approved' WHERE id=? AND digest=? AND state='pending' AND expires>?",
                                         (request_id, digest, time.time())).rowcount
            if changed != 1:
                raise ValueError('Confirmation changed, expired or already approved; review again')

    def reject(self, request_id):
        if not re.fullmatch(r'[a-f0-9]{32}', request_id):
            raise ValueError('Invalid confirmation request ID')
        with self.connection() as connection:
            changed = connection.execute("UPDATE write_approvals SET state='rejected',payload=NULL WHERE id=? AND state IN ('pending','approved') AND expires>?",
                                         (request_id, time.time())).rowcount
            if changed != 1:
                raise ValueError('Confirmation request unavailable or expired')
