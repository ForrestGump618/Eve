"""Append Eve's reviewed experiment tools as lazy, content-addressed resources."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = 'eve-science-supplement'
TOOLS = [
    ('primer-design', 'science-primer-reference-check', 'primer_check.py',
     'Design or check primers against an explicit versioned FASTA; real Primer3 thermodynamics are optional.',
     '引物 PCR qPCR primer3 specificity 基因 序列'),
    ('vector-design', 'science-construct-validation', 'validate_construct.py',
     'Check a declared linear/circular construct, reference segments, junctions and reading frame.',
     '载体 克隆 reading frame vector cloning construct'),
]


def build(output: Path):
    index_path, pack_path = output / 'index.json', output / 'library.pack'
    index = json.loads(index_path.read_text(encoding='utf-8'))
    pack = bytearray(pack_path.read_bytes())
    if hashlib.sha256(pack).hexdigest() != index['packSha256']:
        raise ValueError('Existing library checksum mismatch')
    def add(data):
        sha = hashlib.sha256(data).hexdigest()
        if sha not in index['objects']:
            compressed = gzip.compress(data, compresslevel=9, mtime=0)
            index['objects'][sha] = {'offset': len(pack), 'length': len(compressed), 'bytes': len(data)}
            pack.extend(compressed)
        return sha
    imported = []
    for directory, name, script_name, description, keywords in TOOLS:
        source = ROOT / 'omicslab' / 'skills' / directory
        instructions = source.joinpath('SKILL.md').read_bytes()
        entry = 'scripts/' + script_name
        resources = {'SKILL.md': instructions, entry: source.joinpath(entry).read_bytes(),
                     'LICENSE.txt': ROOT.joinpath('LICENSE').read_bytes()}
        dependencies = {entry: []}
        scripts = [entry]
        if directory == 'primer-design':
            design = 'scripts/primer_design.py'
            resources[design] = ("from primer_check import main\nimport sys\n"
                                 "raise SystemExit(main(['design', *sys.argv[1:]]))\n").encode()
            scripts.append(design)
            dependencies[design] = ['primer3-py==2.3.0']
            resources['SKILL.md'] += (b'\n\nEve execution entries: skill_run with scripts/primer_check.py '
                b'and args ["check", "--reference", "reference.fa", "--config", "primers.json"] performs '
                b'local exact checks without dependencies. For real Primer3 design use scripts/primer_design.py '
                b'and args ["--reference", "reference.fa", "--config", "primers.json"]. '
                b'The design entry requires explicitly authorized dependency resolution; it never substitutes a guessed Tm.\n')
        digest = hashlib.sha256(resources['SKILL.md']).hexdigest()
        imported.append({'id': f'builtin:{name}:{digest[:12]}', 'name': name, 'description': description,
                         'keywords': keywords, 'bundle': BUNDLE, 'version': '1.0.0',
                         'source': f'eve-local:omicslab/skills/{directory}', 'license': 'Apache-2.0',
                         'sha256': digest, 'files': {path: add(data) for path, data in sorted(resources.items())},
                         'omittedResources': [],
                         'runtime': {'manager': 'uv', 'project': False, 'scripts': scripts,
                                     'requiredCredentials': [], 'optionalCredentials': [],
                                     'scriptDependencies': dependencies,
                                     'externalRequirements': ['Genome-wide specificity and wet-lab validation remain separate']}})
    index['skills'] = [skill for skill in index['skills'] if skill.get('bundle') != BUNDLE] + imported
    index['packSha256'] = hashlib.sha256(pack).hexdigest()
    # Write the pack before publishing its matching metadata.
    if pack_path.read_bytes() != pack:
        pack_path.write_bytes(pack)
    encoded = json.dumps(index, ensure_ascii=False, separators=(',', ':')) + '\n'
    index_path.write_text(encoded, encoding='utf-8')
    print(json.dumps({'skills': len(imported), 'scripts': sum(len(s['runtime']['scripts']) for s in imported),
                      'packBytes': len(pack), 'mainJavascriptBytesAdded': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'desktop' / 'skill-library')
    build(parser.parse_args().output)
