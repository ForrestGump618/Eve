"""Actual bound Jupyter intake, pinned scripts and optional public database calls."""
import argparse
import asyncio
import gzip
import hashlib
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from omicslab.config import Settings
from omicslab.execution.local import LocalExecutionBackend
from omicslab.kernel.manager import KernelService
from omicslab.server.routes_harness import execute_backend
from omicslab.workspace import Workspace


def read_bundles(directory, families):
    index = json.loads((directory / "index.json").read_bytes())
    packed = (directory / "library.pack").read_bytes()
    assert hashlib.sha256(packed).hexdigest() == index["packSha256"]
    result = {}
    for skill in index["skills"]:
        if skill.get("bundle") not in families:
            continue
        bundle = {k: skill[k] for k in ["id", "name", "version", "sha256", "source", "runtime"]}
        bundle["files"] = []
        for path, sha in skill["files"].items():
            ref = index["objects"][sha]
            raw = gzip.decompress(packed[ref["offset"]:ref["offset"]+ref["length"]])
            assert hashlib.sha256(raw).hexdigest() == sha
            bundle["files"].append({"path": path, "sha256": sha, "content": raw.decode()})
        result[skill["name"]] = bundle
    return result


async def main(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    settings = Settings(home=output / "profile", workspace=output)
    settings.ensure_dirs()
    kernel = KernelService(settings, cwd=output)
    backend = LocalExecutionBackend(settings, Workspace("research_acceptance", "Research acceptance", local_path=str(output)), kernel)
    bundles = read_bundles(ROOT / "desktop/skill-library", {"bio-research", "bionemo"})
    if args.personal:
        bundles.update(read_bundles(args.personal, {"personal-research"}))
    report = {"kind": "real local Jupyter, immutable scripts, files and optional public APIs; no model-quality or live-SSH claim",
              "live": args.live, "checks": [], "failures": []}

    async def check(name, operation, arguments, verify=lambda r: None):
        start = time.perf_counter()
        result = None
        try:
            result = await execute_backend(backend, operation, arguments)
            verify(result)
            report["checks"].append({"name": name, "durationMs": round((time.perf_counter()-start)*1000), "result": result})
            print("PASS", name, flush=True)
        except Exception as exc:
            report["failures"].append({"name": name, "error": str(exc), "observed": result})
            print("FAIL", name, str(exc)[:500], flush=True)

    def require(value, message="Incorrect scientific output"):
        assert value, message

    def run(name, script, cli=None, stdin=None):
        return {"bundle": bundles[name], "input": {"script": script, "args": cli or [], **({"stdin": stdin} if stdin else {}),
                "allowDependencyInstall": args.live, "timeoutSeconds": 120}}

    (output / "reads_R1.fastq").write_bytes(b"@r1\nACGT\n+\nIIII\n@r2\nNNAA\n+\n!!!!\n")
    (output / "sequences.fa").write_bytes(b">gene1\nACGTNN\n>gene2\nAC-TNN\n")
    (output / "counts.csv").write_bytes(b"gene,sampleA,sampleB\nG1,1,0\nG2,2,3\n")
    (output / "codons.csv").write_bytes(b"id,ref_seq,value,split\ns1,ATGAAA,0.0,test\n")
    (output / "structure.pdb").write_bytes(b"ATOM      1  CA  ALA A   1      11.104  13.207   9.123  1.00 20.00           C  \n")
    asm = {"cell-counting-aggregate-document": {"device-system-document": {"device-identifier": "acceptance-instrument"},
            "cell-counting-document": [{"measurement-aggregate-document": {"measurement-document": [
                {"measurement-identifier": "sample-A", "cell-count": {"value": 42, "unit": "cell"}}]}}]}}
    (output / "instrument.json").write_text(json.dumps(asm), encoding="utf-8")
    await backend.start()
    try:
        for name, data in bundles.items():
            await check("prepare:" + name, "prepare_science_skill", {"bundle": data},
                        lambda r: require(r["status"] == "prepared" and not r["executed"]))
        await check("environment", "science_inspect", {"kind": "environment"},
                    lambda r: require(r["workspace"] == str(output) and not r["executedAnalysis"]))
        await check("fasta", "science_inspect", {"kind": "fasta", "path": "sequences.fa"},
                    lambda r: require(r["records"][1]["sequence"] == "AC-TNN"))
        await check("fastq", "science_inspect", {"kind": "fastq", "path": "reads_R1.fastq"},
                    lambda r: require(r["reads"] == 2 and r["q30Fraction"] == .5))
        await check("counts", "science_inspect", {"kind": "counts", "path": "counts.csv"},
                    lambda r: require(r["librarySizes"] == [3, 3]))
        await check("structure", "science_inspect", {"kind": "structure", "path": "structure.pdb"},
                    lambda r: require(r["atoms"][0]["xyz"] == [11.104, 13.207, 9.123]))
        await check("codon-input-validator", "run_science_skill",
                    run("science-bionemo-codonfm-embed", "scripts/validate_inputs.py", ["codons.csv"]),
                    lambda r: require(r["ok"] and json.loads(r["stdout"])["rows"][0]["verdict"] == "processes"))
        if args.live:
            await check("detect-sequencing-input", "run_science_skill",
                        run("science-bio-nextflow-development", "scripts/detect_data_type.py", [str(output), "--json"]),
                        lambda r: require(r["ok"] and "rnaseq" in r["stdout"]))
            await check("instrument-to-table", "run_science_skill",
                        run("science-bio-instrument-data-to-allotrope", "scripts/flatten_asm.py",
                            ["instrument.json", "--output", "instrument.csv"]),
                        lambda r: require(r["ok"] and "42" in (output / "instrument.csv").read_text()))
            if args.personal:
                await check("public-protein-json-stdin", "run_science_skill",
                            run("science-lab-uniprot-skill", "scripts/rest_request.py",
                                stdin={"base_url": "https://rest.uniprot.org", "path": "uniprotkb/search",
                                       "params": {"query": "accession:P04637", "fields": "accession,gene_names", "size": 1, "format": "json"},
                                       "max_items": 5, "max_depth": 6, "record_path": "results"}),
                            lambda r: require(r["ok"] and "P04637" in r["stdout"] and json.loads(r["stdout"])["ok"]))
                try:
                    await execute_backend(backend, "run_science_skill",
                        run("science-lab-ngs-fastq-qc", "scripts/ngs_preflight.py",
                            ["--pipeline", "fastq_qc", "--emit-install-plan"]))
                except ValueError as exc:
                    require("missing" in str(exc) and "fastqc" in str(exc).lower(),
                            "NGS failed without the expected missing-dependency diagnosis")
                    report["checks"].append({"name": "ngs-missing-dependencies-cannot-succeed",
                                             "negativeTest": True, "diagnosis": str(exc)})
                    report["blocked"] = [{"workflow": "Full FASTQ analysis", "reason": "FastQC/MultiQC/fastp and workflow runtimes missing; not accepted as passed"}]
                    print("PASS ngs-missing-dependencies-cannot-succeed", flush=True)
                else:
                    report["checks"].append({"name": "ngs-native-preflight", "note": "Dependency preflight only, not full analysis"})
        report.setdefault("blocked", []).append({"workflow": "Hosted/GPU model inference and full omics pipelines",
            "reason": "Requires external model credentials, weights, suitable compute and real datasets; not executed or accepted"})
    finally:
        await kernel.stop()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": len(report["checks"]), "failed": len(report["failures"])}))
    return bool(report["failures"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--personal", type=Path)
    parser.add_argument("--live", action="store_true")
    raise SystemExit(asyncio.run(main(parser.parse_args())))
