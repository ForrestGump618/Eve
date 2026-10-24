// Verify that the hashes recorded in desktop/release/SHA256SUMS are quoted consistently in the
// release documentation and that no stale full-length spelling remains. Cheap guard against
// docs/artefact drift after a rebuild; reads committed files only (no build artifacts required).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repoRoot = resolve(root, '..');
const allowMissingRelease = process.argv.includes('--allow-missing-release');
let sumsPath = join(root, 'release', 'SHA256SUMS');
let docsOnly = false;
if (!existsSync(sumsPath)) {
  const mirror = join(repoRoot, 'docs', 'release', 'SHA256SUMS.txt');
  if (allowMissingRelease && existsSync(mirror)) {
    sumsPath = mirror;
    docsOnly = true;
    console.log('verify-doc-hashes: release/SHA256SUMS absent (fresh checkout); verifying the committed docs mirror only');
  } else {
    console.error('verify-doc-hashes: release/SHA256SUMS is missing (build locally, or pass --allow-missing-release in a fresh checkout)');
    process.exit(1);
  }
}
const entries = readFileSync(sumsPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => {
    const [hash, name] = line.trim().split(/\s+/);
    return { hash: hash.toLowerCase(), name };
  });
const docs = [
  'docs/release/windows-installer-verification.md',
  'docs/release/final-acceptance-report.md',
  'docs/release/release-gates.md',
  'docs/release/CHANGELOG.md',
  'docs/release/release-notes-v3.2.0.md',
  'docs/release/SHA256SUMS.txt',
  'docs/requirements/master-requirements.csv',
  'docs/requirements/traceability.md',
  'docs/requirements/conflicts.md',
  'docs/migration/feature-parity-matrix.csv',
  'docs/migration/feature-parity-matrix.md',
  'docs/progress.md',
  'desktop/README.md',
  'desktop/acceptance-matrix.md',
];
const mustQuote = {
  'SuWen-Setup-3.2.0-win-x64.exe': ['docs/release/windows-installer-verification.md', 'docs/release/final-acceptance-report.md', 'docs/release/release-notes-v3.2.0.md'],
  'win-unpacked/SuWen.exe': ['docs/release/windows-installer-verification.md'],
  'SuWen-Setup-3.2.0-win-x64.exe.blockmap': ['docs/release/windows-installer-verification.md'],
};
const failures = [];
for (const [name, requiredDocs] of Object.entries(mustQuote)) {
  const entry = entries.find(e => e.name === name);
  if (!entry) {
    failures.push(`SHA256SUMS has no entry for ${name}`);
    continue;
  }
  for (const rel of requiredDocs) {
    const path = join(repoRoot, rel);
    if (!existsSync(path)) {
      failures.push(`${rel}: missing`);
      continue;
    }
    if (!readFileSync(path, 'utf8').toLowerCase().includes(entry.hash)) {
      failures.push(`${rel}: missing current SHA-256 for ${name} (${entry.hash})`);
    }
  }
}
const known = new Set(entries.map(e => e.hash));
for (const rel of docs) {
  const path = join(repoRoot, rel);
  if (!existsSync(path)) {
    failures.push(`${rel}: missing`);
    continue;
  }
  const text = readFileSync(path, 'utf8');
  for (const run of text.match(/\b[0-9a-fA-F]{64}\b/g) ?? []) {
    const lower = run.toLowerCase();
    if (known.has(lower)) continue;
    // Only flag runs that look like a spelling of one of our current hashes (same 8-char prefix).
    if (entries.some(e => e.hash.startsWith(lower.slice(0, 8)))) {
      failures.push(`${rel}: stale full hash ${run} (current prefix matches ${entries.find(e => e.hash.startsWith(lower.slice(0, 8))).name})`);
    }
  }
}
const sumsDoc = join(repoRoot, 'docs/release/SHA256SUMS.txt');
if (existsSync(sumsDoc)) {
  const docSums = readFileSync(sumsDoc, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const canonical = readFileSync(sumsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (docSums.join('\n') !== canonical.join('\n')) failures.push('docs/release/SHA256SUMS.txt does not match desktop/release/SHA256SUMS');
}
if (failures.length) {
  for (const failure of failures) console.error(`verify-doc-hashes: ${failure}`);
  console.error(`verify-doc-hashes: FAIL (${failures.length} issue(s))`);
  process.exit(1);
}
console.log(`verify-doc-hashes: PASS (${entries.length} artifacts checked in ${docsOnly ? 'committed docs mirror (release artifacts absent)' : 'release evidence'})`);
