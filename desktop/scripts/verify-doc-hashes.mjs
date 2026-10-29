// Verify that the hashes recorded in desktop/release/SHA256SUMS are quoted consistently in the
// release documentation and that no stale full-length spelling remains. Cheap guard against
// docs/artefact drift after a rebuild; reads committed files only (no build artifacts required).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repoRoot = resolve(root, '..');
const allowMissingRelease = process.argv.includes('--allow-missing-release');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if(pkg.build?.productName==='Eve'){
  const records={
    '1.0.0':'docs/verification/eve-1.0/installer.json',
    '1.1.0':'docs/verification/platform-upgrade/installer.json',
    '1.2.0':'docs/verification/wish-research-1.2.0/installer.json',
    '1.3.0':'docs/verification/eve-1.3.0/installer.json',
  };
  const record=records[pkg.version];
  if(!record)throw Error(`No installer manifest mapping for Eve ${pkg.version}`);
  const manifest=JSON.parse(readFileSync(join(repoRoot,record),'utf8'));
  const expected=`Eve-Setup-${pkg.version}-win-x64.exe`;
  if(manifest.file!==expected||manifest.version!==pkg.version||!/^[a-f0-9]{64}$/.test(manifest.sha256)||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<=0)throw Error('Invalid Eve installer manifest');
  const artifact=[join(root,'release',expected),join(root,'release/eve-v1.0.0',expected)].find(existsSync);
  if(artifact){
    const data=readFileSync(artifact);
    if(data.length!==manifest.bytes||createHash('sha256').update(data).digest('hex')!==manifest.sha256)throw Error('Eve installer differs from documented manifest');
  }else if(!allowMissingRelease)throw Error('Eve installer unavailable; build first or explicitly verify the committed manifest');
  console.log(`verify-doc-hashes: PASS Eve ${pkg.version} (${artifact?'actual installer bytes verified':'fresh checkout: committed manifest validated'})`);
  process.exit(0);
}
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
const version = String(pkg.version);
const entries = readFileSync(sumsPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => {
    const [hash, ...nameParts] = line.trim().split(/\s+/);
    return { hash: hash.toLowerCase(), name: nameParts.join(' ') };
  });
const installerName = `SuWen-Setup-${version}-win-x64.exe`;
const installer = entries.find(e => e.name === installerName);
const unpacked = entries.find(e => /(^|\/)SuWen\.exe$/.test(e.name) && !e.name.includes('Setup'));
const blockmap = entries.find(e => e.name === `${installerName}.blockmap`);
const failures = [];
if (!installer) failures.push(`SHA256SUMS has no entry for ${installerName}`);
if (!unpacked) failures.push('SHA256SUMS has no entry for win-unpacked/Eve.exe');
if (!blockmap) failures.push(`SHA256SUMS has no entry for ${installerName}.blockmap`);

const notesRel = `docs/release/release-notes-v${version}.md`;
const required = [
  [installer, ['docs/release/windows-installer-verification.md', 'docs/release/final-acceptance-report.md', notesRel]],
  [unpacked, ['docs/release/windows-installer-verification.md']],
  [blockmap, ['docs/release/windows-installer-verification.md']],
];
for (const [entry, docs] of required) {
  if (!entry) continue;
  for (const rel of docs) {
    const path = join(repoRoot, rel);
    if (!existsSync(path)) {
      failures.push(`${rel}: missing`);
      continue;
    }
    if (!readFileSync(path, 'utf8').toLowerCase().includes(entry.hash)) {
      failures.push(`${rel}: missing current SHA-256 for ${entry.name} (${entry.hash})`);
    }
  }
}

const docs = [
  'docs/release/windows-installer-verification.md',
  'docs/release/final-acceptance-report.md',
  'docs/release/release-gates.md',
  'docs/release/CHANGELOG.md',
  notesRel,
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
const known = new Set(entries.map(e => e.hash));
const currentPrefixes = new Map(entries.map(e => [e.hash.slice(0, 8), e.hash]));
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
    const current = currentPrefixes.get(lower.slice(0, 8));
    if (current && current !== lower) {
      failures.push(`${rel}: stale full hash ${run} (current ${current})`);
    }
  }
}

// The committed docs mirror must equal the build-time sums file byte-for-byte (line order included).
const mirrorPath = join(repoRoot, 'docs', 'release', 'SHA256SUMS.txt');
if (!docsOnly) {
  if (!existsSync(mirrorPath)) {
    failures.push('docs/release/SHA256SUMS.txt: missing');
  } else if (readFileSync(mirrorPath, 'utf8') !== readFileSync(sumsPath, 'utf8')) {
    failures.push('docs/release/SHA256SUMS.txt differs from desktop/release/SHA256SUMS');
  }
}

if (failures.length) {
  for (const f of failures) console.error(`verify-doc-hashes: ${f}`);
  console.error(`verify-doc-hashes: FAIL (${failures.length} issue(s))`);
  process.exit(1);
}
console.log(`verify-doc-hashes: PASS (${entries.length} artifacts checked: ${entries.map(e => e.name).join(', ')})`);
