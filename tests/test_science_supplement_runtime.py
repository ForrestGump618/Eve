"""Execute the actual compressed catalog entry, rather than the source CLI."""
import json
from pathlib import Path

from omicslab.execution.science_audit import ScienceCatalog
from omicslab.execution.science_skills import execute_bundle


def test_packed_primer_entry_runs_in_native_adapter(tmp_path):
    catalog = ScienceCatalog(Path(__file__).resolve().parents[1] / 'desktop/skill-library')
    name = 'science-primer-reference-check'
    skill = catalog.by_name[name]
    bundle = {**skill, 'files': [{'path': p, 'sha256': sha, 'content': catalog.read_resource(name, p)}
                                for p, sha in skill['files'].items()]}
    (tmp_path / 'reference.fa').write_text('>synthetic\nACGTCAGTGGAACCTCCGATGA\n')
    config = {'reference': {'accession': 'SYNTHETIC.1', 'source': 'synthetic test'},
              'minProduct': 22, 'maxProduct': 22,
              'pairs': [{'id': 'fixture', 'forward': 'ACGTCAGT', 'reverse': 'TCATCGGA',
                         'expected': {'start': 0, 'end': 22, 'strand': '+'}}]}
    (tmp_path / 'assay.json').write_text(json.dumps(config))
    result = execute_bundle({'workspace': str(tmp_path), 'bundle': bundle, 'operation': 'run',
                             'input': {'script': 'scripts/primer_check.py',
                                       'args': ['check', '--reference', 'reference.fa', '--config', 'assay.json']}})
    assert result['ok'], result
    output = json.loads(result['stdout'])
    assert output['pairs'][0]['products'][0]['templateLength'] == 22
    assert output['pairs'][0]['forward']['tmCelsius'] is None
    assert result['skillId'] == skill['id'] and result['resourceDigest']
