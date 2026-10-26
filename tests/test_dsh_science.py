"""Regression tests for the stdlib-only science backend used by the DSH plugin.

The transport is exercised end to end through ``python -m omicslab.integrations.science``
so the tests cover framing, validation and error mapping exactly as DSH sees them.
No LLM request is made; only explicit, tiny user code reaches the kernel.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import queue
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ENTRY = [sys.executable, "-m", "omicslab.integrations.science", "--stdio"]


class ScienceSession:
    """Minimal NDJSON client for one backend process."""

    def __init__(self, workspace: Path, home: Path):
        self.workspace = workspace
        self.home = home
        self.frames: queue.Queue = queue.Queue()
        self.stderr = None
        env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
        self.proc = subprocess.Popen(
            [*ENTRY, "--workspace", str(workspace), "--home", str(home)],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self._reader = threading.Thread(target=self._pump_stdout, daemon=True)
        self._reader.start()
        self._stderr_reader = threading.Thread(target=self._pump_stderr, daemon=True)
        self._stderr_reader.start()
        self.stderr_lines: list[str] = []
        self._counter = 0

    def _pump_stdout(self) -> None:
        assert self.proc.stdout is not None
        for raw in iter(self.proc.stdout.readline, b""):
            self.frames.put(raw)
        self.frames.put(None)

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in iter(self.proc.stderr.readline, b""):
            self.stderr_lines.append(raw.decode("utf-8", "replace"))

    def call(self, op: str, params: dict | None = None) -> dict:
        self._counter += 1
        frame = {"id": f"r{self._counter}", "op": op, "params": {} if params is None else params}
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        raw = self.frames.get(timeout=180)
        if raw is None:
            raise AssertionError(f"backend closed stdout before answering {op}: {self.stderr_lines[-5:]}")
        payload = json.loads(raw.decode("utf-8"))
        assert payload["id"] == frame["id"], payload
        return payload

    def ok(self, op: str, params: dict | None = None) -> dict:
        payload = self.call(op, params)
        assert payload["ok"] is True, payload
        return payload["result"]

    def error(self, op: str, params: dict | None = None) -> dict:
        payload = self.call(op, params)
        assert payload["ok"] is False, payload
        return payload["error"]

    def write_raw(self, text: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(text.encode("utf-8"))
        self.proc.stdin.flush()

    def close(self) -> int:
        try:
            self.call("shutdown", {})
        finally:
            if self.proc.stdin and not self.proc.stdin.closed:
                try:
                    self.proc.stdin.close()
                except OSError:
                    pass
        return self.proc.wait(timeout=60)


@pytest.fixture()
def session(tmp_path):
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    client = ScienceSession(workspace, home)
    try:
        yield client
    finally:
        if client.proc.poll() is None:
            client.proc.kill()
        client.proc.wait(timeout=30)


def test_status_describes_environment_without_loading_a_kernel(session):
    status = session.ok("status")
    assert status["workspace"] == str(session.workspace)
    assert status["scope"].startswith("ws_") and len(status["scope"]) == 27
    assert status["llm"] is False and status["embedding"] is False
    assert status["kernel"]["running"] is False
    assert "python.execute" in status["ops"] and "shutdown" in status["ops"]
    assert "skills.list" in status["ops"]


def test_skills_are_read_from_the_bundled_registry(session):
    listing = session.ok("skills.list")
    names = [item["name"] for item in listing["items"]]
    assert names == sorted(names) and len(names) >= 20
    assert "single-cell-downstream" in names
    detail = session.ok("skills.read", {"name": "single-cell-downstream"})
    assert detail["skill"]["name"] == "single-cell-downstream"
    assert detail["skill"]["body"].strip()
    assert session.error("skills.read", {"name": "no-such-skill"})["code"] == "not_found"


def test_unknown_op_and_schema_validation_are_reported_without_dying(session):
    assert session.error("frobnicate")["code"] == "unknown_op"
    assert session.error("sequence.check", {"sequence": "ACGT", "extra": 1})["code"] == "invalid_params"
    assert session.error("sequence.check", {})["code"] == "invalid_params"
    # The session keeps serving after protocol-level errors.
    assert session.ok("status")["workspace"] == str(session.workspace)


def test_malformed_frame_is_rejected_and_session_survives(session):
    session.write_raw("{not json}\n")
    raw = session.frames.get(timeout=30)
    assert raw is not None
    payload = json.loads(raw.decode("utf-8"))
    assert payload["ok"] is False
    assert payload["error"]["code"] == "invalid_params"
    # The session keeps serving after a malformed frame.
    assert session.ok("status")["scope"].startswith("ws_")


def test_sequence_check_reports_composition_without_network(session):
    result = session.ok("sequence.check", {"sequence": "acgt ACGT AC"})
    assert result["length"] == 10
    assert result["invalid"] == [] and result["valid"] is True
    assert result["gc_fraction"] == 0.5
    assert result["reverse_complement"] == "GTACGTACGT"
    bad = session.ok("sequence.check", {"sequence": "ACGTX"})
    assert bad["invalid"] == ["X"] and bad["valid"] is False


def test_python_execution_persists_provenance_and_variables(session):
    executed = session.ok("python.execute", {"code": "total = 2 + 3\nprint(total)", "timeout_s": 120})
    assert executed["ok"] is True
    assert "5" in json.dumps(executed, ensure_ascii=False)
    assert executed["provenance_id"].startswith("execution_")
    variables = session.ok("python.variables")
    assert any(item.get("name") == "total" for item in variables["items"])


def test_python_execution_records_failures_and_keeps_serving(session):
    failed = session.ok("python.execute", {"code": "raise SystemExit('boom')", "timeout_s": 120})
    assert failed["ok"] is False
    assert session.ok("status")["workspace"] == str(session.workspace)


def test_knowledge_add_search_and_list_round_trip(session):
    added = session.ok("knowledge.add", {"title": "小鼠体重", "text": "第 3 组平均体重 26.4 g，标准差 1.8 g。"})
    assert added["id"].startswith("mem_") and added["title"] == "小鼠体重"
    found = session.ok("knowledge.search", {"query": "体重"})
    assert any(item["id"] == added["id"] for item in found["items"])
    listed = session.ok("knowledge.list")
    assert any(item["id"] == added["id"] for item in listed["items"])


def test_claim_requires_supported_kind_and_stays_unverified(session):
    error = session.error("claim.record", {"statement": "结论", "kind": "empirical"})
    assert error["code"] == "invalid_params"
    created = session.ok("claim.record", {"statement": "第 3 组体重高于对照组", "kind": "inference"})
    assert created["validation_status"] == "unverified"
    listed = session.ok("claim.list")
    assert any(item["id"] == created["id"] for item in listed["items"])


def test_experiment_record_compare_and_notebook_export(session):
    metrics = session.workspace / "metrics.json"
    metrics.write_text(json.dumps({"accuracy": 0.87}), encoding="utf-8")
    first = session.ok("experiment.record", {
        "name": "基线", "dataset": "demo", "protocol": "p1", "metric": "accuracy",
        "path": "metrics.json", "direction": "max",
    })
    assert first["scientific_status"] == "unverified"
    assert session.error("experiment.record", {
        "name": "越界", "dataset": "demo", "protocol": "p1", "metric": "accuracy",
        "path": "../escape.json", "direction": "max",
    })["code"] == "path_outside_workspace"
    second = session.ok("experiment.record", {
        "name": "改进", "dataset": "demo", "protocol": "p1", "metric": "accuracy",
        "path": "metrics.json", "direction": "max",
    })
    compared = session.ok("experiment.compare", {"ids": [first["id"], second["id"]]})
    assert first["id"] in compared["best"] or second["id"] in compared["best"]
    assert compared["scientific_status"] == "unverified"
    assert [row["id"] for row in compared["ranking"]] == [first["id"], second["id"]]
    exported = session.ok("notebook.export")
    assert exported["notebook"]["nbformat"] == 4
    written = session.ok("notebook.export", {"path": "analysis.ipynb"})
    assert (session.workspace / "analysis.ipynb").exists()
    assert written["path"].endswith("analysis.ipynb")


def test_shutdown_closes_the_transport_with_exit_code_zero(tmp_path):
    workspace = tmp_path / "ws"
    home = tmp_path / "hm"
    workspace.mkdir()
    home.mkdir()
    client = ScienceSession(workspace, home)
    try:
        assert client.ok("status")["scope"].startswith("ws_")
        assert client.ok("shutdown", {}) == {"shutdown": True}
        assert client.proc.wait(timeout=60) == 0
        errors = [line for line in client.stderr_lines if "Traceback" in line]
        assert not errors, client.stderr_lines[-20:]
    finally:
        if client.proc.poll() is None:
            client.proc.kill()
            client.proc.wait(timeout=30)
