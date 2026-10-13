import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .images import checksum, validate_images
from .models import Document


def uid() -> str:
    return uuid.uuid4().hex


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Conflict(Exception):
    pass


class Store:
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.db = root / "pixelart.sqlite3"
        with self.connection() as connection:
            connection.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, current_version TEXT, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), parent TEXT, operation TEXT NOT NULL, document TEXT NOT NULL, checksum TEXT NOT NULL, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), version_id TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), base_version TEXT NOT NULL, document TEXT NOT NULL, checksum TEXT NOT NULL, actions TEXT NOT NULL, config TEXT NOT NULL, result_version TEXT, created TEXT NOT NULL);
            """)

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.db, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def project(self, name: str) -> dict:
        project = {"id": uid(), "name": name, "created": now()}
        with self.connection() as conn:
            conn.execute("INSERT INTO projects VALUES (:id,:name,:created)", project)
        return project

    def list_projects(self):
        with self.connection() as conn:
            return [dict(row) for row in conn.execute("SELECT * FROM projects ORDER BY created")]

    def list_assets(self, project_id: str):
        with self.connection() as conn:
            rows = conn.execute("SELECT a.id,a.name,a.current_version AS currentVersionId,a.created,v.document FROM assets a JOIN versions v ON v.id=a.current_version WHERE a.project_id=? ORDER BY a.created DESC", (project_id,))
            result = []
            for row in rows:
                item = dict(row)
                document = json.loads(item.pop("document"))
                item.update(frameCount=len(document["frames"]), layerCount=len(document["layers"]), width=document["frames"][0]["width"], height=document["frames"][0]["height"])
                result.append(item)
            return result

    def delete_asset(self, asset_id: str, expected: str):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT current_version FROM assets WHERE id=?", (asset_id,)).fetchone()
            if not row:
                raise KeyError("素材不存在")
            if row["current_version"] != expected:
                raise Conflict("当前版本已变化，请刷新后再删除素材")
            for table in ("previews", "reports", "versions"):
                conn.execute(f"DELETE FROM {table} WHERE asset_id=?", (asset_id,))
            conn.execute("DELETE FROM assets WHERE id=?", (asset_id,))

    def create_asset(self, project_id: str, document: Document):
        validate_images(document)
        digest = checksum(document)
        asset_id, version_id = uid(), uid()
        with self.connection() as conn:
            if not conn.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
                raise KeyError("项目不存在")
            conn.execute("INSERT INTO assets VALUES (?,?,?,?,?)", (asset_id, project_id, document.name, version_id, now()))
            conn.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?)", (version_id, asset_id, None, "upload", document.model_dump_json(), digest, now()))
        return self.asset(asset_id)

    def _unique_name(self, conn, project_id: str, requested: str) -> str:
        base = requested.strip()[:100] or "未命名素材"
        names = {row["name"] for row in conn.execute("SELECT name FROM assets WHERE project_id=?", (project_id,))}
        if base not in names:
            return base
        for index in range(1, 10000):
            suffix = " 副本" if index == 1 else f" 副本 {index}"
            candidate = f"{base[:100 - len(suffix)]}{suffix}"
            if candidate not in names:
                return candidate
        raise Conflict("素材名称冲突，请先重命名已有素材")

    def copy_asset(self, project_id: str, document: Document, source_asset_id: str | None = None, source_version_id: str | None = None):
        validate_images(document)
        digest = checksum(document)
        asset_id, version_id = uid(), uid()
        with self.connection() as conn:
            if not conn.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
                raise KeyError("项目不存在")
            name = self._unique_name(conn, project_id, document.name)
            copied = document.model_copy(deep=True)
            copied.name = name
            provenance = dict(copied.provenance)
            provenance["copiedFrom"] = {"assetId": source_asset_id, "versionId": source_version_id}
            copied.provenance = provenance
            digest = checksum(copied)
            conn.execute("INSERT INTO assets VALUES (?,?,?,?,?)", (asset_id, project_id, name, version_id, now()))
            conn.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?)", (version_id, asset_id, None, "copy", copied.model_dump_json(), digest, now()))
        return self.asset(asset_id)

    def rename(self, asset_id: str, expected: str, name: str):
        name = name.strip()
        if not name:
            raise ValueError("素材名称不能为空")
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT project_id,current_version FROM assets WHERE id=?", (asset_id,)).fetchone()
            if not row:
                raise KeyError("素材不存在")
            if row["current_version"] != expected:
                raise Conflict("当前版本已变化，请刷新后再重命名")
            duplicate = conn.execute("SELECT id FROM assets WHERE project_id=? AND name=? AND id<>?", (row["project_id"], name, asset_id)).fetchone()
            if duplicate:
                raise Conflict("当前项目已有同名素材")
            current = conn.execute("SELECT document,checksum FROM versions WHERE id=? AND asset_id=?", (expected, asset_id)).fetchone()
            document = Document.model_validate_json(current["document"])
            document.name = name
            digest = checksum(document)
            if digest != current["checksum"]:
                version_id = uid()
                conn.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?)", (version_id, asset_id, expected, "rename", document.model_dump_json(), digest, now()))
                conn.execute("UPDATE assets SET current_version=?,name=? WHERE id=?", (version_id, name, asset_id))
            else:
                conn.execute("UPDATE assets SET name=? WHERE id=?", (name, asset_id))
        return self.asset(asset_id)

    def asset(self, asset_id: str):
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
            if not row:
                raise KeyError("素材不存在")
            versions = [dict(v) for v in conn.execute("SELECT id,parent,operation,checksum,created FROM versions WHERE asset_id=? ORDER BY created DESC", (asset_id,))]
        return {"id": asset_id, "projectId": row["project_id"], "name": row["name"], "currentVersionId": row["current_version"], "versions": versions, "document": self.document(asset_id, row["current_version"]).model_dump()}

    def document(self, asset_id: str, version_id: str) -> Document:
        with self.connection() as conn:
            row = conn.execute("SELECT document FROM versions WHERE asset_id=? AND id=?", (asset_id, version_id)).fetchone()
        if not row:
            raise KeyError("素材版本不存在")
        return Document.model_validate_json(row["document"])

    def save(self, asset_id: str, expected: str, document: Document, operation: str = "edit"):
        validate_images(document)
        digest = checksum(document)
        version_id = uid()
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT current_version FROM assets WHERE id=?", (asset_id,)).fetchone()
            if not row:
                raise KeyError("素材不存在")
            if row["current_version"] != expected:
                raise Conflict("当前版本已变化，请重新载入素材")
            old = conn.execute("SELECT checksum FROM versions WHERE id=?", (expected,)).fetchone()
            if old["checksum"] == digest:
                return expected
            conn.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?)", (version_id, asset_id, expected, operation, document.model_dump_json(), digest, now()))
            conn.execute("UPDATE assets SET current_version=?,name=? WHERE id=?", (version_id, document.name, asset_id))
        return version_id

    def restore(self, asset_id: str, expected: str, version_id: str):
        document = self.document(asset_id, version_id)
        with self.connection() as conn:
            cursor = conn.execute("UPDATE assets SET current_version=?,name=? WHERE id=? AND current_version=?", (version_id, document.name, asset_id, expected))
            if not cursor.rowcount:
                raise Conflict("当前版本已变化，无法恢复")
        return self.asset(asset_id)

    def save_report(self, asset_id: str, version_id: str, body: dict):
        report_id = uid()
        body.update(id=report_id, assetVersionId=version_id)
        with self.connection() as conn:
            conn.execute("INSERT INTO reports VALUES (?,?,?,?,?)", (report_id, asset_id, version_id, json.dumps(body, ensure_ascii=False), now()))
        return body

    def preview(self, asset_id: str, base: str, document: Document, actions: list, config: dict):
        preview_id = uid()
        digest = checksum(document)
        with self.connection() as conn:
            conn.execute("INSERT INTO previews VALUES (?,?,?,?,?,?,?,?,?)", (preview_id, asset_id, base, document.model_dump_json(), digest, json.dumps(actions), json.dumps(config), None, now()))
        return preview_id

    def commit(self, asset_id: str, preview_id: str, expected: str):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM previews WHERE id=? AND asset_id=?", (preview_id, asset_id)).fetchone()
            if not row:
                raise KeyError("修复预览不存在")
            if row["base_version"] != expected:
                raise Conflict("确认版本与预览基础版本不一致")
            if row["result_version"]:
                return row["result_version"], json.loads(row["config"])
            current = conn.execute("SELECT current_version FROM assets WHERE id=?", (asset_id,)).fetchone()
            if current["current_version"] != expected:
                raise Conflict("预览已过期，请基于当前版本重新预览")
            parent = conn.execute("SELECT checksum FROM versions WHERE id=?", (expected,)).fetchone()
            version_id = expected if parent["checksum"] == row["checksum"] else uid()
            if version_id != expected:
                conn.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?)", (version_id, asset_id, expected, "repair", row["document"], row["checksum"], now()))
                conn.execute("UPDATE assets SET current_version=? WHERE id=?", (version_id, asset_id))
            conn.execute("UPDATE previews SET result_version=? WHERE id=?", (version_id, preview_id))
        return version_id, json.loads(row["config"])
