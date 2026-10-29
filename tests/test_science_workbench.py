"""Real scientific intake, workspace isolation and structured execution errors."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from omicslab.execution.science_workbench import inspect_scientific, runtime_source
from omicslab.execution.science_skills import execute_bundle
from omicslab.server.routes_harness import execute_backend
from omicslab.suwen.science_workbench import WORKFLOWS, catalog, task_prompt
from test_science_skill_runtime import bundle, payload
from test_suwen_platform import p, client_app


def inspect(tmp_path, kind, path=None):
    return inspect_scientific({"workspace": str(tmp_path), "kind": kind, "path": path})


def test_fasta_preserves_sequences_and_does_not_claim_alignment(tmp_path):
    raw = ">gene1\nACGTNN\n>gene2\nAC-TNN\n"
    (tmp_path / "seq.fa").write_bytes(raw.encode())
    result = inspect(tmp_path, "fasta", "seq.fa")
    assert result["records"][0]["gcFraction"] == pytest.approx(2/6)
    assert result["records"][1]["sequence"] == "AC-TNN"
    assert result["sha256"] == hashlib.sha256(raw.encode()).hexdigest()
    assert result["scientificStatus"] == "unverified"


def test_sequence_preview_budget_is_explicit(tmp_path):
    (tmp_path / "long.fa").write_text("".join(f">s{i}\n" + "A"*3000 + "\n" for i in range(10)))
    result = inspect(tmp_path, "fasta", "long.fa")
    assert sum(len(r["sequence"]) for r in result["records"]) == 8000
    assert all(r["previewTruncated"] for r in result["records"])
    assert len(json.dumps(result)) < 28000


def test_fastq_exact_metrics_and_invalid_record(tmp_path):
    path = tmp_path / "reads.fastq"
    path.write_text("@read1\nACGT\n+\nIIII\n@read2\nNNAA\n+\n!!!!\n")
    result = inspect(tmp_path, "fastq", path.name)
    assert (result["reads"], result["bases"]) == (2, 8)
    assert result["q30Fraction"] == .5 and result["meanPhred"] == 20
    assert result["nFraction"] == .25 and result["gcFraction"] == .25
    path.write_text("@read1\nACGT\n+\nII\n")
    with pytest.raises(ValueError, match="Malformed"):
        inspect(tmp_path, "fastq", path.name)


@pytest.mark.parametrize("text", ["", "ACGT\n", ">x\n!!!\n", ">x\n"])
def test_invalid_fasta_never_succeeds(tmp_path, text):
    (tmp_path / "bad.fa").write_text(text)
    with pytest.raises(ValueError):
        inspect(tmp_path, "fasta", "bad.fa")


def test_counts_rejects_normalized_negative_duplicate_and_nonfinite_values(tmp_path):
    path = tmp_path / "counts.tsv"
    path.write_text("gene\ta\tb\nG1\t1\t0\nG2\t2\t3\n")
    result = inspect(tmp_path, "counts", path.name)
    assert result["librarySizes"] == [3, 3] and result["zeroFraction"] == .25
    for text in ["gene\ta\tb\nG1\t1.5\t0\n", "gene\ta\tb\nG1\t-1\t0\n",
                 "gene\ta\tb\nG1\tnan\t0\n", "gene\ta\tb\nG1\t1\t0\nG1\t2\t0\n"]:
        path.write_text(text)
        with pytest.raises(ValueError):
            inspect(tmp_path, "counts", path.name)


def test_pdb_first_model_coordinates_and_bounded_result(tmp_path):
    atom = "ATOM      1  CA  ALA A   1      11.104  13.207   9.123  1.00 20.00           C  \n"
    (tmp_path / "s.pdb").write_text(atom * 200 + "ENDMDL\n" + atom)
    result = inspect(tmp_path, "structure", "s.pdb")
    assert result["atoms"][0]["xyz"] == [11.104, 13.207, 9.123]
    assert result["atomCount"] == 200 and len(result["atoms"]) == 180 and result["previewTruncated"]
    assert len(json.dumps(result)) < 28000


def test_input_containment_and_environment_probe(tmp_path):
    outside = tmp_path.parent / "outside-science.fa"
    outside.write_text(">outside\nACGT\n")
    with pytest.raises(ValueError, match="bound workspace"):
        inspect(tmp_path, "fasta", str(outside))
    result = inspect(tmp_path, "environment")
    assert result["executedAnalysis"] is False and isinstance(result["modules"]["numpy"], bool)
    proc = subprocess.run([sys.executable, "-c", runtime_source(str(tmp_path), {"kind": "environment"})],
                          capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["status"] == "inspected"


def test_scientific_json_stdin_and_business_error_are_observed(tmp_path):
    content = '# /// script\n# dependencies = []\n# ///\nimport sys,json\nx=json.load(sys.stdin)\nprint(json.dumps(x))\n'
    data = bundle(content)
    result = execute_bundle(payload(tmp_path, data, run=True, script="scripts/analyze.py", stdin={"value": 42}))
    assert result["ok"] and json.loads(result["stdout"]) == {"value": 42}
    result = execute_bundle(payload(tmp_path, data, run=True, script="scripts/analyze.py",
                                    stdin={"ok": False, "error": "Rejected input"}))
    assert result["ok"] is False and result["exitCode"] == 0 and result["status"] == "failed"
    with pytest.raises(ValueError, match="stdin"):
        execute_bundle(payload(tmp_path, data, run=True, script="scripts/analyze.py", stdin="not-an-object"))


def test_empty_scientific_process_is_not_verified_success(tmp_path):
    data = bundle('# /// script\n# dependencies = []\n# ///\npass\n')
    result = execute_bundle(payload(tmp_path, data, run=True, script="scripts/analyze.py"))
    assert not result["ok"] and result["exitCode"] == 0
    assert "No scientific output" in result["error"]


def test_catalog_and_task_prompt_require_enabled_skills():
    assert all(not s["installed"] for flow in catalog([]) for s in flow["skills"])
    with pytest.raises(ValueError, match="启用"):
        task_prompt("instrument", "Convert data", "", [])
    skill = {"id": "one", "name": "science-bio-instrument-data-to-allotrope", "enabled": True, "executable": True}
    flow, prompt = task_prompt("instrument", "Convert data", "samples.csv", [skill])
    assert flow["id"] == "instrument" and skill["name"] in prompt and "samples.csv" in prompt
    assert "不得转到本地" in prompt


def test_every_workbench_skill_exists_in_the_packaged_library():
    root = Path(__file__).resolve().parents[1]
    index = json.loads(
        (root / "desktop" / "skill-library" / "index.json").read_text(encoding="utf-8")
    )
    available = {skill["name"] for skill in index["skills"]}
    available |= {
        json.loads(path.read_text(encoding="utf-8"))["name"]
        for path in (root / "desktop" / "bundled-skills").glob("*/skill.json")
    }
    available |= {
        path.name for path in (root / "omicslab" / "skills").iterdir()
        if path.is_dir() and (path / "SKILL.md").is_file()
    }
    referenced = {name for flow in WORKFLOWS for name in flow["skills"]}
    assert referenced <= available, sorted(referenced - available)


@pytest.mark.asyncio
async def test_real_backend_intake_and_disconnection_never_fall_back(tmp_path):
    class Backend:
        root = tmp_path
        async def execute_python(self, source, timeout_s):
            proc = subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, timeout=timeout_s)
            return {"ok": proc.returncode == 0, "stdout": proc.stdout, "stderr": proc.stderr}
    (tmp_path / "reads.fq").write_text("@r\nACGT\n+\nIIII\n")
    result = await execute_backend(Backend(), "science_inspect", {"kind": "fastq", "path": "reads.fq"})
    assert result["reads"] == 1 and result["q30Fraction"] == 1
    class Offline(Backend):
        async def execute_python(self, source, timeout_s):
            raise RuntimeError("SSH unavailable")
    with pytest.raises(RuntimeError, match="SSH unavailable"):
        await execute_backend(Offline(), "science_inspect", {"kind": "environment"})


@pytest.mark.asyncio
async def test_scoped_api_catalog_and_bad_launch(p, client_app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client_app), base_url="http://test") as client:
        result = await client.get("/api/platform/science?scope=ws_main")
        assert result.status_code == 200 and len(result.json()["workflows"]) == 10
        assert not result.json()["workflows"][0]["skills"][0]["installed"]
        assert (await client.get("/api/platform/science?scope=missing")).status_code == 400
        response = await client.post("/api/platform/science/launch?scope=ws_main", json={"lane": "bad", "goal": "x"})
        assert response.status_code == 422
        missing = await client.post("/api/platform/science/launch?scope=ws_main", json={"lane": "instrument"})
        assert missing.status_code == 422 and "研究问题" in missing.text


@pytest.mark.asyncio
async def test_science_launch_removes_placeholder_when_submission_fails(p, client_app):
    class Adapter:
        async def rpc(self, method, **_):
            assert method == "skill.list"
            return {"skills": [{
                "id": "instrument",
                "name": "science-bio-instrument-data-to-allotrope",
                "enabled": True,
                "executable": True,
            }]}

    deleted = []

    def create(**_):
        return SimpleNamespace(id="science-submit-failed", meta={}, messages=[], agent="lead")

    async def submit(**_):
        raise RuntimeError("runtime unavailable")

    p.state.loop.desktop_harness = Adapter()
    p.state.store = SimpleNamespace(
        create=create,
        save=lambda conversation: conversation,
        delete=lambda session_id: deleted.append(session_id),
    )
    p.state.default_agent_info = lambda: {"agent_id": "lead"}
    p.state.runs = SimpleNamespace(submit=submit)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=client_app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/api/platform/science/launch?scope=ws_main",
            json={"lane": "instrument", "goal": "Convert the supplied instrument export"},
        )

    assert response.status_code == 503
    assert deleted == ["science-submit-failed"]
