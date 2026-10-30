import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .images import checksum, validate_images
from .models import AiConfigUpdate, AiGeneration, AiGenerationRequest, AiProfileCreate, AiProfileUpdate, AiProviderConfig, CheckConfig, Document
from .secrets import SecretStore


def _document_api_payload(document: Document) -> dict:
    """Omit default layer metadata for compatibility with older clients."""
    payload = document.model_dump()
    for layer in payload.get("layers", []):
        if layer.get("blendMode") == "normal":
            layer.pop("blendMode", None)
        if layer.get("pixelsLocked") is False:
            layer.pop("pixelsLocked", None)
        if layer.get("opacityLocked") is False:
            layer.pop("opacityLocked", None)
        if layer.get("groupId") is None:
            layer.pop("groupId", None)
    return payload


def uid() -> str:
    return uuid.uuid4().hex


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Conflict(Exception):
    pass


class GenerationQueueFull(Exception):
    pass


class Store:
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.db = root / "pixelart.sqlite3"
        self.secrets = SecretStore()
        with self.connection() as connection:
            connection.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, current_version TEXT, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), parent TEXT, operation TEXT NOT NULL, document TEXT NOT NULL, checksum TEXT NOT NULL, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), version_id TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), base_version TEXT NOT NULL, document TEXT NOT NULL, checksum TEXT NOT NULL, actions TEXT NOT NULL, config TEXT NOT NULL, result_version TEXT, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS project_configs (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, config TEXT NOT NULL, updated TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS library_entries (id TEXT PRIMARY KEY, source_asset_id TEXT NOT NULL, source_version_id TEXT NOT NULL, project_name TEXT NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL, checksum TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(source_asset_id, source_version_id));
                CREATE TABLE IF NOT EXISTS ai_provider_config (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, updated TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS ai_provider_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, config TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS ai_provider_state (id INTEGER PRIMARY KEY CHECK(id=1), active_id TEXT NOT NULL REFERENCES ai_provider_profiles(id));
                CREATE TABLE IF NOT EXISTS ai_generations (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, mode TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL, result TEXT, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, provider_config TEXT, provider_secret TEXT);
                CREATE TABLE IF NOT EXISTS ai_candidate_selections (generation_id TEXT NOT NULL REFERENCES ai_generations(id) ON DELETE CASCADE, candidate_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL, PRIMARY KEY(generation_id,candidate_id,project_id));
                CREATE INDEX IF NOT EXISTS reports_asset_created ON reports(asset_id, created DESC);
                CREATE INDEX IF NOT EXISTS ai_generations_project_created ON ai_generations(project_id, created DESC);
            """)
            # Backfill defaults without changing any existing project data.
            default_config = json.dumps(CheckConfig().model_dump(), ensure_ascii=False)
            connection.execute(
                "INSERT OR IGNORE INTO project_configs(project_id, config, updated) SELECT id, ?, created FROM projects",
                (default_config,),
            )
            generation_columns = {row["name"] for row in connection.execute("PRAGMA table_info(ai_generations)")}
            if "provider_config" not in generation_columns:
                connection.execute("ALTER TABLE ai_generations ADD COLUMN provider_config TEXT")
            if "provider_secret" not in generation_columns:
                connection.execute("ALTER TABLE ai_generations ADD COLUMN provider_secret TEXT")
            # The first release stored one provider config in ai_provider_config.
            # Keep that table for old clients, but migrate it into the profile
            # store exactly once and make the migrated profile active.
            self._migrate_ai_profiles(connection)
        self._migrate_ai_secrets()

    def _migrate_ai_profiles(self, connection):
        row = connection.execute("SELECT id FROM ai_provider_profiles ORDER BY created LIMIT 1").fetchone()
        if row:
            active = connection.execute("SELECT active_id FROM ai_provider_state WHERE id=1").fetchone()
            if not active or not connection.execute("SELECT id FROM ai_provider_profiles WHERE id=?", (active["active_id"],)).fetchone():
                connection.execute("INSERT INTO ai_provider_state(id,active_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET active_id=excluded.active_id", (row["id"],))
            return
        legacy = connection.execute("SELECT config FROM ai_provider_config WHERE id=1").fetchone()
        try:
            config = AiProviderConfig.model_validate_json(legacy["config"]) if legacy else AiProviderConfig()
        except ValueError:
            config = AiProviderConfig()
        created = now()
        profile_id = "default"
        connection.execute(
            "INSERT INTO ai_provider_profiles(id,name,config,created,updated) VALUES(?,?,?,?,?)",
            (profile_id, "默认配置", config.model_dump_json(), created, created),
        )
        connection.execute("INSERT INTO ai_provider_state(id,active_id) VALUES(1,?)", (profile_id,))
        # Ensure the legacy endpoint sees the migrated values on old databases.
        connection.execute(
            "INSERT INTO ai_provider_config(id,config,updated) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated=excluded.updated",
            (config.model_dump_json(), created),
        )

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

    @staticmethod
    def _secret_name(profile_id: str) -> str:
        return f"ai-profile:{profile_id}"

    def _profile_config(self, row) -> AiProviderConfig:
        try:
            config = AiProviderConfig.model_validate_json(row["config"])
        except ValueError as error:
            raise ValueError("AI 配置损坏，请重新保存配置") from error
        secret = self.secrets.get(self._secret_name(row["id"]))
        if secret:
            config = config.model_copy(update={"apiKey": secret})
        return config

    def _config_for_storage_name(self, secret_name: str, config: AiProviderConfig) -> AiProviderConfig:
        if config.apiKey and self.secrets.set(secret_name, config.apiKey):
            return config.model_copy(update={"apiKey": None})
        if not config.apiKey:
            self.secrets.delete(secret_name)
        return config

    def _config_for_storage(self, profile_id: str, config: AiProviderConfig) -> AiProviderConfig:
        return self._config_for_storage_name(self._secret_name(profile_id), config)

    def _migrate_ai_secrets(self):
        with self.connection() as conn:
            rows = conn.execute("SELECT id,config FROM ai_provider_profiles").fetchall()
            active = conn.execute("SELECT active_id FROM ai_provider_state WHERE id=1").fetchone()
            legacy = conn.execute("SELECT config FROM ai_provider_config WHERE id=1").fetchone()
            for row in rows:
                try:
                    config = AiProviderConfig.model_validate_json(row["config"])
                except ValueError:
                    continue
                stored = self._config_for_storage(row["id"], config) if config.apiKey else config
                if stored.model_dump_json() != row["config"]:
                    conn.execute("UPDATE ai_provider_profiles SET config=?,updated=? WHERE id=?", (stored.model_dump_json(), now(), row["id"]))
                if active and active["active_id"] == row["id"] and legacy:
                    conn.execute("UPDATE ai_provider_config SET config=?,updated=? WHERE id=1", (stored.model_dump_json(), now()))
                    legacy = None
            if legacy and active:
                try:
                    config = AiProviderConfig.model_validate_json(legacy["config"])
                except ValueError:
                    config = None
                if config is not None:
                    stored = self._config_for_storage(active["active_id"], config) if config.apiKey else config
                    conn.execute("UPDATE ai_provider_config SET config=?,updated=? WHERE id=1", (stored.model_dump_json(), now()))
            generations = conn.execute("SELECT id,provider_config,provider_secret FROM ai_generations WHERE provider_config IS NOT NULL").fetchall()
            for generation in generations:
                try:
                    config = AiProviderConfig.model_validate_json(generation["provider_config"])
                except ValueError:
                    continue
                if not config.apiKey:
                    continue
                secret_name = generation["provider_secret"] or f"ai-generation:{generation['id']}"
                stored = self._config_for_storage_name(secret_name, config)
                persisted_secret = secret_name if stored.apiKey is None else None
                conn.execute("UPDATE ai_generations SET provider_config=?,provider_secret=? WHERE id=?", (stored.model_dump_json(), persisted_secret, generation["id"]))

    def project(self, name: str) -> dict:
        project = {"id": uid(), "name": name, "created": now()}
        with self.connection() as conn:
            conn.execute("INSERT INTO projects VALUES (:id,:name,:created)", project)
            conn.execute(
                "INSERT INTO project_configs(project_id, config, updated) VALUES (?,?,?)",
                (project["id"], json.dumps(CheckConfig().model_dump(), ensure_ascii=False), project["created"]),
            )
        return project

    @staticmethod
    def _profile_public(profile_id: str, name: str, config: AiProviderConfig, created: str, updated: str) -> dict:
        return {
            "id": profile_id,
            "name": name,
            **Store.public_ai_config(config),
            "created": created,
            "updated": updated,
        }

    def _active_profile_row(self):
        with self.connection() as conn:
            row = conn.execute(
                "SELECT p.* FROM ai_provider_profiles p JOIN ai_provider_state s ON s.active_id=p.id WHERE s.id=1"
            ).fetchone()
        if not row:
            raise ValueError("AI 配置档案不存在，请重新保存配置")
        return row

    def ai_config(self) -> AiProviderConfig:
        """Return a copy of the currently active provider configuration."""
        row = self._active_profile_row()
        return self._profile_config(row)

    def ai_config_profile(self) -> dict:
        row = self._active_profile_row()
        config = self._profile_config(row)
        return self._profile_public(row["id"], row["name"], config, row["created"], row["updated"])

    @staticmethod
    def public_ai_config(config: AiProviderConfig) -> dict:
        return {**config.model_dump(exclude={"apiKey"}), "hasApiKey": bool(config.apiKey)}

    def save_ai_config(self, update: AiConfigUpdate) -> dict:
        current = self.ai_config()
        fields = update.model_dump(exclude_none=True, exclude={"clearApiKey"})
        # A blank key means "keep existing"; clearing is an explicit action.
        if not fields.get("apiKey"):
            fields.pop("apiKey", None)
        if update.clearApiKey:
            fields["apiKey"] = None
        config = AiProviderConfig.model_validate({**current.model_dump(), **fields})
        result = self._save_profile_config(self._active_profile_row()["id"], config)
        return result

    def _save_profile_config(self, profile_id: str, config: AiProviderConfig, name: str | None = None) -> dict:
        self.db.chmod(0o600)
        updated = now()
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM ai_provider_profiles WHERE id=?", (profile_id,)).fetchone()
            if not row:
                raise KeyError("AI 配置档案不存在")
            profile_name = name if name is not None else row["name"]
            if name is not None and not name.strip():
                raise ValueError("AI 配置名称不能为空")
            if name is not None and conn.execute("SELECT id FROM ai_provider_profiles WHERE name=? COLLATE NOCASE AND id<>?", (name.strip(), profile_id)).fetchone():
                raise Conflict("AI 配置名称已存在")
            stored_config = self._config_for_storage(profile_id, config)
            conn.execute(
                "UPDATE ai_provider_profiles SET name=?,config=?,updated=? WHERE id=?",
                (profile_name.strip(), stored_config.model_dump_json(), updated, profile_id),
            )
            # Keep the legacy single-profile row synchronized for old clients.
            active = conn.execute("SELECT active_id FROM ai_provider_state WHERE id=1").fetchone()
            if active and active["active_id"] == profile_id:
                conn.execute(
                    "INSERT INTO ai_provider_config(id,config,updated) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated=excluded.updated",
                    (stored_config.model_dump_json(), updated),
                )
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(self.db) + suffix)
            if sidecar.exists():
                sidecar.chmod(0o600)
        return self._profile_public(profile_id, profile_name.strip(), self._profile_config({"id": profile_id, "config": stored_config.model_dump_json()}), row["created"], updated)

    def list_ai_profiles(self) -> dict:
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM ai_provider_profiles ORDER BY created, id").fetchall()
            active = conn.execute("SELECT active_id FROM ai_provider_state WHERE id=1").fetchone()
        profiles = []
        for row in rows:
            try:
                config = self._profile_config(row)
            except ValueError as error:
                raise ValueError("AI 配置损坏，请重新保存配置") from error
            profiles.append(self._profile_public(row["id"], row["name"], config, row["created"], row["updated"]))
        return {"profiles": profiles, "activeId": active["active_id"] if active else None}

    def create_ai_profile(self, body: AiProfileCreate) -> dict:
        fields = body.model_dump(exclude_none=True, exclude={"name", "clearApiKey"})
        if not fields.get("apiKey"):
            fields.pop("apiKey", None)
        if body.clearApiKey:
            fields["apiKey"] = None
        config = AiProviderConfig.model_validate({**AiProviderConfig().model_dump(), **fields})
        profile_id, created = uid(), now()
        stored_config = self._config_for_storage(profile_id, config)
        name = body.name.strip()
        with self.connection() as conn:
            if conn.execute("SELECT id FROM ai_provider_profiles WHERE name=? COLLATE NOCASE", (name,)).fetchone():
                raise Conflict("AI 配置名称已存在")
            count = conn.execute("SELECT COUNT(*) FROM ai_provider_profiles").fetchone()[0]
            if count >= 32:
                raise Conflict("AI 配置档案数量已达到上限")
            conn.execute("INSERT INTO ai_provider_profiles VALUES(?,?,?,?,?)", (profile_id, name, stored_config.model_dump_json(), created, created))
        self.db.chmod(0o600)
        return self._profile_public(profile_id, name, self._profile_config({"id": profile_id, "config": stored_config.model_dump_json()}), created, created)

    def update_ai_profile(self, profile_id: str, body: AiProfileUpdate) -> dict:
        with self.connection() as conn:
            row = conn.execute("SELECT config FROM ai_provider_profiles WHERE id=?", (profile_id,)).fetchone()
        if not row:
            raise KeyError("AI 配置档案不存在")
        try:
            current = self._profile_config({"id": profile_id, "config": row["config"]})
        except ValueError as error:
            raise ValueError("AI 配置损坏，请重新保存配置") from error
        fields = body.model_dump(exclude_none=True, exclude={"name", "clearApiKey"})
        if not fields.get("apiKey"):
            fields.pop("apiKey", None)
        if body.clearApiKey:
            fields["apiKey"] = None
        config = AiProviderConfig.model_validate({**current.model_dump(), **fields})
        return self._save_profile_config(profile_id, config, body.name)

    def activate_ai_profile(self, profile_id: str) -> dict:
        with self.connection() as conn:
            row = conn.execute("SELECT id FROM ai_provider_profiles WHERE id=?", (profile_id,)).fetchone()
            if not row:
                raise KeyError("AI 配置档案不存在")
            conn.execute("INSERT INTO ai_provider_state(id,active_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET active_id=excluded.active_id", (profile_id,))
            profile = conn.execute("SELECT * FROM ai_provider_profiles WHERE id=?", (profile_id,)).fetchone()
            config = self._profile_config(profile)
            stored_config = self._config_for_storage(profile_id, config)
            conn.execute("UPDATE ai_provider_profiles SET config=? WHERE id=?", (stored_config.model_dump_json(), profile_id))
            conn.execute("INSERT INTO ai_provider_config(id,config,updated) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated=excluded.updated", (stored_config.model_dump_json(), now()))
        return {"activeId": profile_id, "profile": self._profile_public(profile_id, profile["name"], self._profile_config({"id": profile_id, "config": stored_config.model_dump_json()}), profile["created"], profile["updated"])}

    def delete_ai_profile(self, profile_id: str):
        with self.connection() as conn:
            row = conn.execute("SELECT id FROM ai_provider_profiles WHERE id=?", (profile_id,)).fetchone()
            if not row:
                raise KeyError("AI 配置档案不存在")
            active = conn.execute("SELECT active_id FROM ai_provider_state WHERE id=1").fetchone()
            count = conn.execute("SELECT COUNT(*) FROM ai_provider_profiles").fetchone()[0]
            if count <= 1:
                raise Conflict("至少保留一个 AI 配置档案")
            next_profile = None
            if active and active["active_id"] == profile_id:
                next_profile = conn.execute(
                    "SELECT * FROM ai_provider_profiles WHERE id<>? ORDER BY created,id LIMIT 1", (profile_id,)
                ).fetchone()
            if next_profile is not None:
                conn.execute(
                    "INSERT INTO ai_provider_state(id,active_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET active_id=excluded.active_id",
                    (next_profile["id"],),
                )
                conn.execute(
                    "INSERT INTO ai_provider_config(id,config,updated) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated=excluded.updated",
                    (next_profile["config"], now()),
                )
            conn.execute("DELETE FROM ai_provider_profiles WHERE id=?", (profile_id,))
        self.secrets.delete(self._secret_name(profile_id))
        result = {"deleted": True, "id": profile_id}
        if next_profile is not None:
            config = self._profile_config(next_profile)
            result.update({
                "activeId": next_profile["id"],
                "profile": self._profile_public(next_profile["id"], next_profile["name"], config, next_profile["created"], next_profile["updated"]),
            })
        return result

    def create_generation(self, request: AiGenerationRequest, provider_config: AiProviderConfig | None = None) -> AiGeneration:
        generation_id, created = uid(), now()
        requested_secret = f"ai-generation:{generation_id}" if provider_config is not None and provider_config.apiKey else None
        stored_config = self._config_for_storage_name(requested_secret, provider_config) if provider_config is not None and requested_secret else provider_config
        provider_secret = requested_secret if stored_config is not None and stored_config.apiKey is None else None
        provider_json = stored_config.model_dump_json() if stored_config is not None else None
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            count = conn.execute("SELECT COUNT(*) FROM ai_generations WHERE status IN ('queued','running')").fetchone()[0]
            if count >= 32:
                raise GenerationQueueFull("等待中的 AI 任务过多，请稍后重试")
            if request.projectId is not None and not conn.execute("SELECT id FROM projects WHERE id=?", (request.projectId,)).fetchone():
                raise KeyError("项目不存在")
            conn.execute(
                "INSERT INTO ai_generations (id,project_id,mode,status,request,result,error,created,updated,provider_config,provider_secret) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (generation_id, request.projectId, request.mode, "queued", request.model_dump_json(), None, None, created, created, provider_json, provider_secret),
            )
        return self.generation(generation_id)

    def generation_config(self, generation_id: str) -> AiProviderConfig | None:
        with self.connection() as conn:
            row = conn.execute("SELECT provider_config,provider_secret FROM ai_generations WHERE id=?", (generation_id,)).fetchone()
        if not row or not row["provider_config"]:
            return None
        try:
            config = AiProviderConfig.model_validate_json(row["provider_config"])
        except ValueError as error:
            raise ValueError("AI 任务配置损坏，请重新生成") from error
        if row["provider_secret"]:
            config = config.model_copy(update={"apiKey": self.secrets.get(row["provider_secret"])})
        return config

    def select_ai_candidate(self, generation_id: str, candidate_id: str, project_id: str, document: Document):
        validate_images(document)
        asset_id, version_id = uid(), uid()
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            selected = conn.execute(
                "SELECT asset_id FROM ai_candidate_selections WHERE generation_id=? AND candidate_id=? AND project_id=?",
                (generation_id, candidate_id, project_id),
            ).fetchone()
            if selected:
                if selected["asset_id"] is None:
                    raise Conflict("已导入的候选素材已删除，请重新生成")
                asset_id = selected["asset_id"]
            else:
                if not conn.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
                    raise KeyError("项目不存在")
                if not conn.execute("SELECT id FROM ai_generations WHERE id=? AND status='succeeded'", (generation_id,)).fetchone():
                    raise Conflict("AI 任务无法导入")
                imported = document.model_copy(deep=True)
                imported.name = self._unique_name(conn, project_id, imported.name)
                created = now()
                conn.execute("INSERT INTO assets VALUES (?,?,?,?,?)", (asset_id, project_id, imported.name, version_id, created))
                conn.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?)", (version_id, asset_id, None, "ai-import", imported.model_dump_json(), checksum(imported), created))
                conn.execute("INSERT INTO ai_candidate_selections VALUES (?,?,?,?)", (generation_id, candidate_id, project_id, asset_id))
        return self.asset(asset_id)

    @staticmethod
    def _generation(row) -> AiGeneration:
        return AiGeneration(
            id=row["id"], projectId=row["project_id"], mode=row["mode"], status=row["status"],
            request=AiGenerationRequest.model_validate_json(row["request"]),
            result=json.loads(row["result"]) if row["result"] is not None else None,
            error=row["error"], created=row["created"], updated=row["updated"],
        )

    def generation(self, generation_id: str) -> AiGeneration:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM ai_generations WHERE id=?", (generation_id,)).fetchone()
        if not row:
            raise KeyError("AI 生成任务不存在")
        return self._generation(row)

    def list_generations(self, project_id: str | None = None, status: str | None = None, limit: int = 50):
        clauses, values = [], []
        if project_id is not None:
            clauses.append("project_id=?")
            values.append(project_id)
        if status is not None:
            clauses.append("status=?")
            values.append(status)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM ai_generations" + where + " ORDER BY created DESC,rowid DESC LIMIT ?", (*values, limit))
            return [self._generation(row) for row in rows]

    def update_generation(self, generation_id: str, status: str, result: dict | None = None, error: str | None = None) -> AiGeneration:
        if status not in {"running", "succeeded", "failed", "cancelled"}:
            raise ValueError("无效的 AI 任务状态")
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status FROM ai_generations WHERE id=?", (generation_id,)).fetchone()
            if not row:
                raise KeyError("AI 生成任务不存在")
            allowed = {"queued": {"running", "failed", "cancelled"}, "running": {"succeeded", "failed", "cancelled"}}
            if status not in allowed.get(row["status"], set()):
                if row["status"] == "cancelled":
                    return self.generation(generation_id)
                raise Conflict("AI 任务已结束，无法改变状态")
            conn.execute(
                "UPDATE ai_generations SET status=?,result=?,error=?,updated=? WHERE id=?",
                (status, json.dumps(result, ensure_ascii=False) if result is not None else None, error, now(), generation_id),
            )
        return self.generation(generation_id)

    def recover_generations(self):
        """Put interrupted work back into the durable queue for the executor."""
        with self.connection() as conn:
            rows = conn.execute("SELECT id FROM ai_generations WHERE status IN ('queued','running') ORDER BY created,rowid").fetchall()
            if rows:
                conn.execute(
                    "UPDATE ai_generations SET status='queued',error=NULL,updated=? WHERE status IN ('queued','running')",
                    (now(),),
                )
            return [row["id"] for row in rows]

    def list_projects(self):
        with self.connection() as conn:
            return [dict(row) for row in conn.execute("SELECT * FROM projects ORDER BY created")]

    def rename_project(self, project_id: str, expected_name: str, name: str):
        name = name.strip()
        if not name or len(name) > 80:
            raise ValueError("项目名称必须为 1 到 80 个字符")
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if not row:
                raise KeyError("项目不存在")
            if row["name"] != expected_name:
                raise Conflict("项目名称已变化，请刷新后再重命名")
            conn.execute("UPDATE projects SET name=? WHERE id=?", (name, project_id))
            return {**dict(row), "name": name}

    def delete_project(self, project_id: str, expected_name: str, expected_versions: dict[str, str]):
        generation_secrets = []
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            project = conn.execute("SELECT name FROM projects WHERE id=?", (project_id,)).fetchone()
            if not project:
                raise KeyError("项目不存在")
            if project["name"] != expected_name:
                raise Conflict("项目名称已变化，请刷新后再删除")
            current_versions = {row["id"]: row["current_version"] for row in conn.execute("SELECT id,current_version FROM assets WHERE project_id=?", (project_id,))}
            if current_versions != expected_versions:
                raise Conflict("项目素材或版本已变化，请刷新后重新确认删除")
            for table in ("previews", "reports", "versions"):
                conn.execute(f"DELETE FROM {table} WHERE asset_id IN (SELECT id FROM assets WHERE project_id=?)", (project_id,))
            generation_secrets = [row["provider_secret"] for row in conn.execute("SELECT provider_secret FROM ai_generations WHERE project_id=? AND provider_secret IS NOT NULL", (project_id,))]
            conn.execute("DELETE FROM assets WHERE project_id=?", (project_id,))
            conn.execute("DELETE FROM project_configs WHERE project_id=?", (project_id,))
            conn.execute("DELETE FROM ai_generations WHERE project_id=?", (project_id,))
            conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
        for secret_name in generation_secrets:
            self.secrets.delete(secret_name)

    def project_config(self, project_id: str) -> CheckConfig:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT config FROM projects p LEFT JOIN project_configs c ON c.project_id=p.id WHERE p.id=?",
                (project_id,),
            ).fetchone()
            if not row:
                raise KeyError("项目不存在")
            if row["config"] is not None:
                return CheckConfig.model_validate_json(row["config"])
            config = CheckConfig()
            conn.execute(
                "INSERT OR IGNORE INTO project_configs(project_id, config, updated) VALUES (?,?,?)",
                (project_id, config.model_dump_json(), now()),
            )
            return config

    def save_project_config(self, project_id: str, config: CheckConfig) -> CheckConfig:
        with self.connection() as conn:
            if not conn.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
                raise KeyError("项目不存在")
            conn.execute(
                "INSERT INTO project_configs(project_id, config, updated) VALUES (?,?,?) "
                "ON CONFLICT(project_id) DO UPDATE SET config=excluded.config, updated=excluded.updated",
                (project_id, config.model_dump_json(), now()),
            )
        return config

    def asset_config(self, asset_id: str) -> CheckConfig:
        with self.connection() as conn:
            row = conn.execute("SELECT project_id FROM assets WHERE id=?", (asset_id,)).fetchone()
        if not row:
            raise KeyError("素材不存在")
        return self.project_config(row["project_id"])

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

    def list_library_assets(self):
        """List only explicitly collected snapshots, independent of projects."""
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT id,name,source_asset_id AS sourceAssetId,source_version_id AS versionId,"
                "project_name AS projectName,checksum,created,document FROM library_entries ORDER BY created DESC,id"
            )
            result = []
            for row in rows:
                item = dict(row)
                document = json.loads(item.pop("document"))
                item.update(
                    frameCount=len(document["frames"]),
                    layerCount=len(document["layers"]),
                    width=document["frames"][0]["width"],
                    height=document["frames"][0]["height"],
                )
                result.append(item)
            return result

    def collect_asset(self, asset_id: str, expected: str):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT a.current_version,a.name,p.name AS project_name,v.document,v.checksum "
                "FROM assets a JOIN projects p ON p.id=a.project_id "
                "JOIN versions v ON v.id=a.current_version AND v.asset_id=a.id WHERE a.id=?", (asset_id,),
            ).fetchone()
            if not row:
                raise KeyError("素材不存在")
            if row["current_version"] != expected:
                raise Conflict("当前版本已变化，请刷新后再加入素材库")
            existing = conn.execute("SELECT id FROM library_entries WHERE source_asset_id=? AND source_version_id=?", (asset_id, expected)).fetchone()
            entry_id = existing["id"] if existing else uid()
            if not existing:
                conn.execute("INSERT INTO library_entries VALUES (?,?,?,?,?,?,?,?)", (entry_id, asset_id, expected, row["project_name"], row["name"], row["document"], row["checksum"], now()))
        return {"id": entry_id, "sourceAssetId": asset_id, "versionId": expected}

    def library_entry(self, entry_id: str):
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM library_entries WHERE id=?", (entry_id,)).fetchone()
        if not row:
            raise KeyError("素材库条目不存在")
        return dict(row)

    def remove_library_entry(self, entry_id: str, expected: str):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT source_version_id FROM library_entries WHERE id=?", (entry_id,)).fetchone()
            if not row:
                raise KeyError("素材库条目不存在")
            if row["source_version_id"] != expected:
                raise Conflict("素材库版本不匹配，请刷新后重试")
            conn.execute("DELETE FROM library_entries WHERE id=?", (entry_id,))

    def reuse_library_entry(self, project_id: str, entry_id: str):
        entry = self.library_entry(entry_id)
        document = Document.model_validate_json(entry["document"])
        document.provenance["libraryEntryId"] = entry_id
        return self.copy_asset(project_id, document, entry["source_asset_id"], entry["source_version_id"])

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

    def import_asset(self, project_id: str, document: Document):
        validate_images(document)
        asset_id, version_id = uid(), uid()
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if not conn.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
                raise KeyError("项目不存在")
            imported = document.model_copy(deep=True)
            imported.name = self._unique_name(conn, project_id, imported.name)
            digest = checksum(imported)
            created = now()
            conn.execute("INSERT INTO assets VALUES (?,?,?,?,?)", (asset_id, project_id, imported.name, version_id, created))
            conn.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?)", (version_id, asset_id, None, "import", imported.model_dump_json(), digest, created))
        return self.asset(asset_id)

    def snapshot_project(self, project_id: str, max_assets: int, max_document_bytes: int):
        with self.connection() as conn:
            conn.execute("BEGIN")
            project = conn.execute("SELECT name FROM projects WHERE id=?", (project_id,)).fetchone()
            if not project:
                raise KeyError("项目不存在")
            row = conn.execute("SELECT config FROM project_configs WHERE project_id=?", (project_id,)).fetchone()
            config = CheckConfig.model_validate_json(row["config"]) if row else CheckConfig()
            size = conn.execute(
                "SELECT COUNT(*) AS assets,SUM(LENGTH(CAST(v.document AS BLOB))) AS bytes FROM assets a LEFT JOIN versions v ON v.id=a.current_version AND v.asset_id=a.id WHERE a.project_id=?",
                (project_id,),
            ).fetchone()
            if size["assets"] > max_assets or (size["bytes"] or 0) > max_document_bytes:
                raise ValueError("项目备份超过素材数量或数据大小上限")
            rows = conn.execute(
                "SELECT a.id,a.current_version,v.document FROM assets a LEFT JOIN versions v ON v.id=a.current_version AND v.asset_id=a.id WHERE a.project_id=? ORDER BY a.created,a.id",
                (project_id,),
            )
            assets = []
            for asset in rows:
                if asset["document"] is None:
                    raise ValueError("项目包含缺少当前版本的素材，无法备份")
                assets.append({"id": asset["id"], "currentVersionId": asset["current_version"], "document": Document.model_validate_json(asset["document"])})
        return {"name": project["name"], "config": config, "assets": assets}

    def restore_project(self, name: str, config: CheckConfig, documents: list[Document]):
        prepared = []
        for document in documents:
            validate_images(document)
            prepared.append((uid(), uid(), document, checksum(document)))
        project = {"id": uid(), "name": name, "created": now()}
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT INTO projects VALUES (:id,:name,:created)", project)
            conn.execute("INSERT INTO project_configs(project_id, config, updated) VALUES (?,?,?)", (project["id"], config.model_dump_json(), project["created"]))
            for asset_id, version_id, document, digest in prepared:
                conn.execute("INSERT INTO assets VALUES (?,?,?,?,?)", (asset_id, project["id"], document.name, version_id, project["created"]))
                conn.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?)", (version_id, asset_id, None, "import", document.model_dump_json(), digest, project["created"]))
        return project

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
        return {"id": asset_id, "projectId": row["project_id"], "name": row["name"], "currentVersionId": row["current_version"], "versions": versions, "document": _document_api_payload(self.document(asset_id, row["current_version"]))}

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
        created = now()
        body = dict(body)
        body.update(id=report_id, assetVersionId=version_id, created=created)
        with self.connection() as conn:
            if not conn.execute("SELECT id FROM versions WHERE id=? AND asset_id=?", (version_id, asset_id)).fetchone():
                raise KeyError("素材版本不存在")
            conn.execute("INSERT INTO reports VALUES (?,?,?,?,?)", (report_id, asset_id, version_id, json.dumps(body, ensure_ascii=False), created))
        return body

    def list_reports(self, asset_id: str, version_id: str | None = None, limit: int = 50, offset: int = 0):
        if limit < 1 or limit > 100:
            raise ValueError("报告数量必须在 1 到 100 之间")
        if offset < 0:
            raise ValueError("报告偏移量不能为负数")
        with self.connection() as conn:
            if not conn.execute("SELECT id FROM assets WHERE id=?", (asset_id,)).fetchone():
                raise KeyError("素材不存在")
            if version_id is None:
                rows = conn.execute(
                    "SELECT id, version_id, body, created FROM reports WHERE asset_id=? ORDER BY created DESC, rowid DESC LIMIT ? OFFSET ?",
                    (asset_id, limit, offset),
                )
            else:
                rows = conn.execute(
                    "SELECT id, version_id, body, created FROM reports WHERE asset_id=? AND version_id=? ORDER BY created DESC, rowid DESC LIMIT ? OFFSET ?",
                    (asset_id, version_id, limit, offset),
                )
            reports = []
            for row in rows:
                body = json.loads(row["body"])
                body.update(id=row["id"], assetVersionId=row["version_id"], created=row["created"])
                reports.append(body)
            return reports

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
