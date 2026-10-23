"""Tests for the scientific function registry index."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from omicslab.config import Settings
from omicslab.registry.index import RegistryError, RegistryIndex


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    result = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    result.kernel_python = sys.executable
    result.ensure_dirs()
    return result


def test_refresh_builds_searchable_index(settings: Settings) -> None:
    index = RegistryIndex(settings)
    assert index.exists() is False
    stats = index.refresh(["json", "not_a_real_package_omicslab"])
    assert stats["items"] > 0
    assert "not_a_real_package_omicslab" in stats["missing_packages"]
    assert index.exists()

    hits = index.search("dumps", limit=5)
    assert hits, "json.dumps must be discoverable"
    assert any(hit["qualname"] == "json.dumps" for hit in hits)
    item = index.get("json.dumps")
    assert item is not None and item["kind"] == "function"
    assert "signature" in item
    modules = {module["name"] for module in index.modules()}
    assert "json" in modules


def test_ensure_is_idempotent(settings: Settings) -> None:
    index = RegistryIndex(settings)
    index.refresh(["json"])
    before = index.stats()["generated_at"]
    index.ensure(["json"])
    assert index.stats()["generated_at"] == before


def test_missing_interpreter_raises(settings: Settings) -> None:
    index = RegistryIndex(settings)
    settings.kernel_python = str(settings.home / "no-such-python.exe")
    with pytest.raises(RegistryError):
        index.refresh(["json"])
