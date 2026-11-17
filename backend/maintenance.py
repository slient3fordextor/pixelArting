"""Explicit workspace size reporting and lossless security-audit archival.

This command never deletes assets, versions, sources, or idempotency receipts.
Run outside MCP; paths and audit contents are local administrator data.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import uuid


@contextmanager
def _database(path: Path, writable=False):
    connection = sqlite3.connect(path.resolve().as_uri() + ('?mode=rw' if writable else '?mode=ro'), uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _bytes(path):
    return path.stat().st_size if path.is_file() else 0


def workspace_usage(root: Path) -> dict:
    """Return sizes and counts only: no document, credential or audit payloads."""
    database = root / 'pixelart.sqlite3'
    result = {'databaseBytes': _bytes(database), 'walBytes': _bytes(Path(str(database) + '-wal')), 'tables': {}}
    columns = {
        'versions': 'document', 'previews': 'document', 'reports': 'body',
        'library_entries': 'document', 'ai_generations': 'result',
        'mcp_write_requests': 'response', 'file_import_requests': None,
        'project_import_requests': 'receipt', 'ai_generation_requests': None,
    }
    if database.is_file():
        with _database(database) as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table, column in columns.items():
                if table not in tables:
                    continue
                size = f'COALESCE(SUM(LENGTH(CAST({column} AS BLOB))),0)' if column else '0'
                row = connection.execute(f'SELECT COUNT(*),{size} FROM {table}').fetchone()
                result['tables'][table] = {'rows': row[0], 'payloadBytes': row[1]}
    sources = root / 'sources'
    source_files = [p for p in sources.glob('*.png') if p.is_file() and not p.is_symlink()]
    result['sources'] = {'files': len(source_files), 'bytes': sum(p.stat().st_size for p in source_files)}
    audit = root / 'security' / 'audit.sqlite3'
    result['audit'] = {'databaseBytes': _bytes(audit), 'rows': 0}
    if audit.is_file():
        with _database(audit) as connection:
            result['audit']['rows'] = connection.execute('SELECT COUNT(*) FROM audit_events').fetchone()[0]
    return result


def audit_archive(root: Path, before: datetime, destination: Path | None = None, *, apply=False, vacuum=False):
    if before.tzinfo is None:
        raise ValueError('Archive cutoff requires a timezone')
    path = root / 'security' / 'audit.sqlite3'
    if not path.is_file():
        return {'eligibleRows': 0, 'archivedRows': 0}
    if apply and destination is None:
        raise ValueError('An archive directory is required when applying')
    timestamp = before.timestamp()
    archive = None
    with _database(path, writable=apply) as connection:
        # Freeze the eligible rows until the durable archive is complete. A crash
        # before commit may leave a duplicate archive, never missing audit events.
        connection.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        row = connection.execute('SELECT COUNT(*),MAX(sequence) FROM audit_events WHERE occurred < ?', (timestamp,)).fetchone()
        result = {'eligibleRows': row[0], 'archivedRows': 0}
        if not apply or row[0] == 0:
            return result
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        archive = destination / f'audit-{before.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex}.jsonl.gz'
        # Exclusive creation and restrictive permissions also apply to the first
        # bytes written, before any potentially sensitive subjects enter the file.
        descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        digest = hashlib.sha256()
        count = 0
        try:
            with os.fdopen(descriptor, 'wb') as raw:
                with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as compressed:
                    for event in connection.execute('SELECT * FROM audit_events WHERE occurred < ? AND sequence <= ? ORDER BY sequence', (timestamp, row[1])):
                        encoded = (json.dumps(dict(event), ensure_ascii=True, separators=(',', ':')) + '\n').encode()
                        compressed.write(encoded)
                        digest.update(encoded)
                        count += 1
                raw.flush()
                os.fsync(raw.fileno())
            if os.name != 'nt':
                directory_fd = os.open(destination, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            # Verify the file before removing its source records. Streaming avoids
            # loading the audit log into memory even after years of operation.
            verification = hashlib.sha256()
            with gzip.open(archive, 'rb') as saved:
                for chunk in iter(lambda: saved.read(1024 * 1024), b''):
                    verification.update(chunk)
            if count != row[0] or verification.digest() != digest.digest():
                raise OSError('Audit archive verification failed')
            deleted = connection.execute('DELETE FROM audit_events WHERE occurred < ? AND sequence <= ?', (timestamp, row[1])).rowcount
            if deleted != count:
                raise RuntimeError('Audit rows changed during archive')
            result.update(archivedRows=count, archive=str(archive), contentSha256=digest.hexdigest())
        except BaseException:
            # Keep a possibly complete archive for recovery/inspection. The DB
            # context rolls back, and the original records remain authoritative.
            raise
    if vacuum:
        with _database(path, writable=True) as connection:
            connection.execute('VACUUM')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description='Report workspace size; optionally archive old security audit records')
    parser.add_argument('--data-dir', required=True, type=Path)
    parser.add_argument('--archive-audit-before', metavar='YYYY-MM-DD', help='UTC cutoff; reports eligible rows unless --apply is supplied')
    parser.add_argument('--archive-dir', type=Path)
    parser.add_argument('--apply', action='store_true', help='Archive, verify and remove only the archived security-audit rows')
    parser.add_argument('--vacuum-audit', action='store_true', help='Reclaim audit database space after archival; stop services first')
    args = parser.parse_args(argv)
    if args.apply and not (args.archive_audit_before and args.archive_dir):
        parser.error('--apply requires --archive-audit-before and --archive-dir')
    if args.vacuum_audit and not args.apply:
        parser.error('--vacuum-audit requires --apply')
    try:
        result = workspace_usage(args.data_dir)
        if args.archive_audit_before:
            before = datetime.strptime(args.archive_audit_before, '%Y-%m-%d').replace(tzinfo=timezone.utc)
            result['archivePlan'] = audit_archive(args.data_dir, before, args.archive_dir, apply=args.apply, vacuum=args.vacuum_audit)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, sqlite3.Error) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
