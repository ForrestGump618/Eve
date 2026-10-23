"""Tests for trajectory recording (turn audit / replay)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from omicslab.agent.types import AgentEvent
from omicslab.config import Settings
from omicslab.trajectories import (
    TrajectoryRecorder,
    delete_trajectory,
    list_trajectories,
    load_trajectory,
)


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    result = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    result.kernel_python = sys.executable
    result.ensure_dirs()
    return result


def test_recorder_writes_meta_events_and_done(settings: Settings) -> None:
    recorder = TrajectoryRecorder(
        settings, "c_test", agent="lead", provider="mock", model="mock-model"
    )
    recorder.start()
    recorder.record(AgentEvent(type="status", data={"text": "running"}))
    recorder.record(AgentEvent(type="text", data={"delta": "hello"}))
    recorder.finish("done", usage={"total_tokens": 12})

    path = recorder.path
    assert path.is_file() and path.name.endswith(".jsonl")
    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    assert lines[0]["type"] == "meta"
    assert lines[0]["conversation_id"] == "c_test"
    assert lines[1]["type"] == "event" and lines[1]["event"]["type"] == "status"
    assert lines[-1]["type"] == "done" and lines[-1]["finish_reason"] == "done"


def test_list_and_load_roundtrip(settings: Settings) -> None:
    recorder = TrajectoryRecorder(settings, "c_abc")
    recorder.start().finish("done")
    items = list_trajectories(settings)
    assert len(items) == 1
    assert items[0]["turn_id"] == recorder.turn_id
    assert items[0]["finish_reason"] == "done"
    payload = load_trajectory(settings, "c_abc", recorder.turn_id)
    assert payload is not None
    assert payload["turn_id"] == recorder.turn_id
    assert payload["events"] == []
    assert load_trajectory(settings, "c_abc", "turn_missing") is None


def test_invalid_ids_are_rejected(settings: Settings) -> None:
    with pytest.raises(ValueError):
        TrajectoryRecorder(settings, "../escape")
    assert load_trajectory(settings, "c_abc", "../x") is None
    assert delete_trajectory(settings, "c_abc", "turn_missing") is False


def test_delete_removes_turn(settings: Settings) -> None:
    recorder = TrajectoryRecorder(settings, "c_del")
    recorder.start().finish("done")
    assert delete_trajectory(settings, "c_del", recorder.turn_id) is True
    assert list_trajectories(settings, "c_del") == []
