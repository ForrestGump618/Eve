"""Append-only runtime event store (SQLite WAL).

Facts are committed here *before* being broadcast over SSE: the same rows power
the run snapshot, the trace replay/subscription and the conversation history.
Nothing else is allowed to own a second, independently mutable copy of the run
state.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("omicslab.runtime.events")

SCHEMA_VERSION = 3

RUN_STATUSES = {
    "queued",
    "preparing",
    "running",
    "waiting_approval",
    "stopping",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "unknown",
}
TERMINAL_STATUSES = {"succeeded", "failed", "cancelled", "interrupted", "unknown"}
ACTIVE_STATUSES = {"queued", "preparing", "running", "waiting_approval", "stopping"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RuntimeStoreError(RuntimeError):
    """Base class for runtime store failures."""


class RunConflict(RuntimeStoreError):
    """A run is already active for the session, or the request id is taken."""

    def __init__(self, run_id: str, message: str = "已有运行正在进行") -> None:
        super().__init__(message)
        self.run_id = run_id


class RunNotFound(KeyError):
    pass


class TaskNotFound(KeyError):
    pass


_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_run_id TEXT,
    root_run_id TEXT NOT NULL,
    client_request_id TEXT,
    status TEXT NOT NULL,
    agent_id TEXT,
    workspace_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL,
    last_activity TEXT,
    finish_reason TEXT,
    error_json TEXT,
    usage_json TEXT,
    result_text TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_client_request
    ON runs(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_runs_session ON runs(session_id, created_at);
CREATE INDEX IF NOT EXISTS ix_runs_parent ON runs(parent_run_id, created_at);
CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    trace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 3,
    ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_trace ON events(trace_id, seq);
CREATE INDEX IF NOT EXISTS ix_events_run ON events(run_id, seq);
CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id TEXT PRIMARY KEY,
    parent_run_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    profile TEXT,
    status TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT,
    budget_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    error_json TEXT,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tasks_parent ON agent_tasks(parent_run_id, position);
CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    run_id TEXT,
    task_id TEXT,
    tool TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    target_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    decision TEXT
);
"""

_JSON_RUN_FIELDS = {
    "workspace_json": "workspace",
    "error_json": "error",
    "usage_json": "usage",
    "meta_json": "meta",
}


def _run_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    for column, key in _JSON_RUN_FIELDS.items():
        raw = data.pop(column, None)
        if raw in (None, ""):
            data[key] = {} if column != "error_json" else None
            continue
        try:
            data[key] = json.loads(raw)
        except Exception:
            data[key] = {} if column != "error_json" else {"raw": str(raw)}
    return data


def _event_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    raw = data.pop("payload_json", "{}")
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {"value": payload}
    return {
        "seq": int(data["seq"]),
        "event_id": data["event_id"],
        "trace_id": data["trace_id"],
        "run_id": data["run_id"],
        "type": data["type"],
        "data": payload,
        "schema_version": int(data["schema_version"]),
        "ts": data["ts"],
    }


class EventStore:
    """Thread-safe SQLite-backed runtime store."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(
            str(self.path), check_same_thread=False, timeout=30.0, isolation_level=None
        )
        self._conn.row_factory = sqlite3.Row
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(_SCHEMA)
            self._conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
            self._conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        except sqlite3.Error:
            logger.exception("初始化运行时数据库失败：%s", self.path)
            raise

    # -- lifecycle ---------------------------------------------------------
    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:  # pragma: no cover - defensive
                pass

    @property
    def schema_version(self) -> int:
        with self._lock:
            row = self._conn.execute("PRAGMA user_version").fetchone()
        return int(row[0]) if row else 0

    def _execute(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    # -- runs --------------------------------------------------------------
    def create_run(self, run: dict[str, Any]) -> dict[str, Any]:
        fields = {
            "run_id": run["run_id"],
            "trace_id": run["trace_id"],
            "session_id": run["session_id"],
            "parent_run_id": run.get("parent_run_id"),
            "root_run_id": run.get("root_run_id") or run["run_id"],
            "client_request_id": run.get("client_request_id"),
            "status": run.get("status") or "preparing",
            "agent_id": run.get("agent_id"),
            "workspace_json": json.dumps(run.get("workspace") or {}, ensure_ascii=False),
            "created_at": run.get("created_at") or utc_now(),
            "started_at": run.get("started_at"),
            "ended_at": run.get("ended_at"),
            "updated_at": run.get("updated_at") or utc_now(),
            "last_activity": run.get("last_activity"),
            "finish_reason": run.get("finish_reason"),
            "error_json": json.dumps(run.get("error"), ensure_ascii=False) if run.get("error") else None,
            "usage_json": json.dumps(run.get("usage") or {}, ensure_ascii=False),
            "result_text": run.get("result_text"),
            "meta_json": json.dumps(run.get("meta") or {}, ensure_ascii=False),
        }
        columns = ", ".join(fields)
        placeholders = ", ".join("?" for _ in fields)
        try:
            self._execute(f"INSERT INTO runs ({columns}) VALUES ({placeholders})", tuple(fields.values()))
        except sqlite3.IntegrityError as exc:
            existing = self.find_by_client_request(run.get("client_request_id") or "")
            if existing:
                raise RunConflict(existing["run_id"], "client_request_id 已存在") from exc
            raise
        return self.get_run(fields["run_id"]) or fields

    _RUN_UPDATE_FIELDS = {
        "status",
        "started_at",
        "ended_at",
        "finish_reason",
        "result_text",
        "parent_run_id",
        "root_run_id",
        "last_activity",
    }

    def update_run(self, run_id: str, **fields: Any) -> dict[str, Any] | None:
        updates: dict[str, Any] = {}
        for key, value in fields.items():
            if key in self._RUN_UPDATE_FIELDS:
                updates[key] = value
            elif key == "error":
                updates["error_json"] = json.dumps(value, ensure_ascii=False) if value else None
            elif key == "usage":
                updates["usage_json"] = json.dumps(value or {}, ensure_ascii=False)
            elif key == "meta":
                updates["meta_json"] = json.dumps(value or {}, ensure_ascii=False)
            elif key == "workspace":
                updates["workspace_json"] = json.dumps(value or {}, ensure_ascii=False)
            elif key == "agent_id":
                updates["agent_id"] = value
        if not updates:
            return self.get_run(run_id)
        updates["updated_at"] = utc_now()
        assignments = ", ".join(f"{column} = ?" for column in updates)
        self._execute(
            f"UPDATE runs SET {assignments} WHERE run_id = ?",
            tuple(updates.values()) + (run_id,),
        )
        return self.get_run(run_id)

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        row = self._execute("SELECT * FROM runs WHERE run_id = ?", (str(run_id),)).fetchone()
        return _run_row_to_dict(row) if row else None

    def list_runs(
        self,
        *,
        session_id: str | None = None,
        parent_run_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if parent_run_id:
            clauses.append("parent_run_id = ?")
            params.append(parent_run_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._execute(
            f"SELECT * FROM runs {where} ORDER BY created_at DESC LIMIT ?",
            tuple(params) + (max(1, min(int(limit), 500)),),
        ).fetchall()
        return [_run_row_to_dict(row) for row in rows]

    def find_by_client_request(self, client_request_id: str) -> dict[str, Any] | None:
        if not client_request_id:
            return None
        row = self._execute(
            "SELECT * FROM runs WHERE client_request_id = ?", (str(client_request_id),)
        ).fetchone()
        return _run_row_to_dict(row) if row else None

    def active_run_for_session(self, session_id: str) -> dict[str, Any] | None:
        placeholders = ", ".join("?" for _ in ACTIVE_STATUSES)
        row = self._execute(
            f"SELECT * FROM runs WHERE session_id = ? AND status IN ({placeholders}) "
            "AND parent_run_id IS NULL "
            "ORDER BY created_at DESC LIMIT 1",
            (session_id, *sorted(ACTIVE_STATUSES)),
        ).fetchone()
        return _run_row_to_dict(row) if row else None

    def recover_runs(self) -> list[dict[str, Any]]:
        """Mark leftover active runs as interrupted after a crash/restart."""
        placeholders = ", ".join("?" for _ in ACTIVE_STATUSES)
        rows = self._execute(
            f"SELECT * FROM runs WHERE status IN ({placeholders})", tuple(sorted(ACTIVE_STATUSES))
        ).fetchall()
        recovered: list[dict[str, Any]] = []
        for row in rows:
            run = _run_row_to_dict(row)
            meta = dict(run.get("meta") or {})
            meta["recovered"] = True
            self.update_run(
                run["run_id"],
                status="interrupted",
                ended_at=utc_now(),
                finish_reason="interrupted",
                meta=meta,
                last_activity=utc_now(),
            )
            self.append_event(
                run["trace_id"],
                run["run_id"],
                "run_status",
                {"run_id": run["run_id"], "status": "interrupted", "recovered": True},
            )
            recovered.append(run)
        return recovered

    # -- events ------------------------------------------------------------
    def append_event(
        self,
        trace_id: str,
        run_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        *,
        event_id: str | None = None,
        ts: str | None = None,
    ) -> dict[str, Any]:
        events = self.append_events_bulk(
            [
                {
                    "trace_id": trace_id,
                    "run_id": run_id,
                    "type": event_type,
                    "payload": payload or {},
                    "event_id": event_id,
                    "ts": ts,
                }
            ]
        )
        return events[0]

    def append_events_bulk(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not items:
            return []
        out: list[dict[str, Any]] = []
        rows: list[tuple[Any, ...]] = []
        for item in items:
            event_id = str(item.get("event_id") or f"ev_{uuid.uuid4().hex[:12]}")
            payload = item.get("payload") or {}
            rows.append(
                (
                    event_id,
                    str(item["trace_id"]),
                    str(item["run_id"]),
                    str(item["type"]),
                    json.dumps(payload, ensure_ascii=False, default=str),
                    SCHEMA_VERSION,
                    str(item.get("ts") or utc_now()),
                )
            )
            out.append({"event_id": event_id})
        try:
            with self._lock:
                self._conn.execute("BEGIN")
                try:
                    for row in rows:
                        self._conn.execute(
                            "INSERT OR IGNORE INTO events"
                            "(event_id, trace_id, run_id, type, payload_json, schema_version, ts)"
                            " VALUES (?, ?, ?, ?, ?, ?, ?)",
                            row,
                        )
                    self._conn.execute("COMMIT")
                except Exception:
                    self._conn.execute("ROLLBACK")
                    raise
        except sqlite3.Error:
            logger.exception("写入运行事件失败（执行继续）")
            for idx, item in enumerate(out):
                item.setdefault("seq", -1 - idx)
                item.setdefault("ts", utc_now())
                item.setdefault("type", str(items[idx].get("type")))
            return [
                {
                    **item,
                    "trace_id": str(items[idx]["trace_id"]),
                    "run_id": str(items[idx]["run_id"]),
                    "data": items[idx].get("payload") or {},
                    "schema_version": SCHEMA_VERSION,
                }
                for idx, item in enumerate(out)
            ]
        # fetch assigned seqs in insertion order
        for idx, event in enumerate(out):
            row = self._execute(
                "SELECT seq, ts FROM events WHERE event_id = ?", (event["event_id"],)
            ).fetchone()
            if row:
                out[idx] = {
                    "seq": int(row["seq"]),
                    "event_id": event["event_id"],
                    "trace_id": str(items[idx]["trace_id"]),
                    "run_id": str(items[idx]["run_id"]),
                    "type": str(items[idx]["type"]),
                    "data": items[idx].get("payload") or {},
                    "schema_version": SCHEMA_VERSION,
                    "ts": row["ts"],
                }
        return out

    def list_events(self, trace_id: str, after_seq: int = 0, limit: int = 500) -> list[dict[str, Any]]:
        rows = self._execute(
            "SELECT * FROM events WHERE trace_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            (str(trace_id), int(after_seq), max(1, min(int(limit), 5000))),
        ).fetchall()
        return [_event_row_to_dict(row) for row in rows]

    def max_seq(self, trace_id: str) -> int:
        row = self._execute(
            "SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE trace_id = ?", (str(trace_id),)
        ).fetchone()
        return int(row["m"]) if row else 0

    def run_for_trace(self, trace_id: str) -> dict[str, Any] | None:
        row = self._execute(
            "SELECT * FROM runs WHERE trace_id = ? ORDER BY created_at LIMIT 1", (str(trace_id),)
        ).fetchone()
        return _run_row_to_dict(row) if row else None

    # -- child tasks -------------------------------------------------------
    def create_agent_task(self, task: dict[str, Any]) -> dict[str, Any]:
        self._execute(
            "INSERT INTO agent_tasks(task_id, parent_run_id, run_id, session_id, profile, status,"
            " goal, created_at, updated_at, ended_at, budget_json, result_json, error_json, position)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                task["task_id"],
                task["parent_run_id"],
                task["run_id"],
                task["session_id"],
                task.get("profile"),
                task.get("status") or "queued",
                task.get("goal") or "",
                task.get("created_at") or utc_now(),
                task.get("updated_at") or utc_now(),
                task.get("ended_at"),
                json.dumps(task.get("budget") or {}, ensure_ascii=False),
                json.dumps(task.get("result"), ensure_ascii=False) if task.get("result") else None,
                json.dumps(task.get("error"), ensure_ascii=False) if task.get("error") else None,
                int(task.get("position") or 0),
            ),
        )
        return self.get_agent_task(task["task_id"]) or task

    def update_agent_task(self, task_id: str, **fields: Any) -> dict[str, Any] | None:
        updates: dict[str, Any] = {}
        for key, value in fields.items():
            if key in {"status", "ended_at", "profile"}:
                updates[key] = value
            elif key == "result":
                updates["result_json"] = json.dumps(value, ensure_ascii=False) if value else None
            elif key == "error":
                updates["error_json"] = json.dumps(value, ensure_ascii=False) if value else None
            elif key in {"budget"}:
                updates[key + "_json"] = json.dumps(value or {}, ensure_ascii=False)
        if updates:
            updates["updated_at"] = utc_now()
            assignments = ", ".join(f"{column} = ?" for column in updates)
            self._execute(
                f"UPDATE agent_tasks SET {assignments} WHERE task_id = ?",
                tuple(updates.values()) + (task_id,),
            )
        return self.get_agent_task(task_id)

    @staticmethod
    def _task_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        for column, key in (
            ("budget_json", "budget"),
            ("result_json", "result"),
            ("error_json", "error"),
        ):
            raw = data.pop(column, None)
            try:
                data[key] = json.loads(raw) if raw else ({} if key == "budget" else None)
            except Exception:
                data[key] = None
        return data

    def get_agent_task(self, task_id: str) -> dict[str, Any] | None:
        row = self._execute("SELECT * FROM agent_tasks WHERE task_id = ?", (str(task_id),)).fetchone()
        return self._task_row_to_dict(row) if row else None

    def list_agent_tasks(self, parent_run_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        if parent_run_id:
            rows = self._execute(
                "SELECT * FROM agent_tasks WHERE parent_run_id = ? ORDER BY position, created_at LIMIT ?",
                (str(parent_run_id), max(1, min(int(limit), 500))),
            ).fetchall()
        else:
            rows = self._execute(
                "SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT ?",
                (max(1, min(int(limit), 500)),),
            ).fetchall()
        return [self._task_row_to_dict(row) for row in rows]

    # -- approvals ---------------------------------------------------------
    def create_approval(self, approval: dict[str, Any]) -> dict[str, Any]:
        self._execute(
            "INSERT OR REPLACE INTO approvals(approval_id, run_id, task_id, tool, arguments_json,"
            " reason, target_json, status, created_at, resolved_at, decision)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                approval["approval_id"],
                approval.get("run_id"),
                approval.get("task_id"),
                approval.get("tool") or "",
                json.dumps(approval.get("arguments") or {}, ensure_ascii=False),
                approval.get("reason") or "",
                json.dumps(approval.get("target") or {}, ensure_ascii=False),
                approval.get("status") or "pending",
                approval.get("created_at") or utc_now(),
                approval.get("resolved_at"),
                approval.get("decision"),
            ),
        )
        return self.get_approval(approval["approval_id"]) or approval

    def get_approval(self, approval_id: str) -> dict[str, Any] | None:
        row = self._execute(
            "SELECT * FROM approvals WHERE approval_id = ?", (str(approval_id),)
        ).fetchone()
        if not row:
            return None
        data = dict(row)
        for column, key in (("arguments_json", "arguments"), ("target_json", "target")):
            raw = data.pop(column, None)
            try:
                data[key] = json.loads(raw) if raw else {}
            except Exception:
                data[key] = {}
        return data

    def update_approval(self, approval_id: str, status: str, decision: str = "") -> None:
        self._execute(
            "UPDATE approvals SET status = ?, decision = ?, resolved_at = ? WHERE approval_id = ?",
            (status, decision, utc_now(), approval_id),
        )

    def list_approvals(self, run_id: str | None = None, status: str | None = None) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if run_id:
            clauses.append("run_id = ?")
            params.append(run_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._execute(
            f"SELECT approval_id FROM approvals {where} ORDER BY created_at DESC", tuple(params)
        ).fetchall()
        items = [self.get_approval(row["approval_id"]) for row in rows]
        return [item for item in items if item]
