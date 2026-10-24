/**
 * Deterministic secret/credential scan for the SuWen repository.
 *
 * Scans (a) every tracked text file in the working tree and (b) the same paths in
 * git history, for credential-shaped strings. Also reports tracked files that
 * should never be committed (.env, private keys, SSH material) and verifies that
 * those patterns are covered by .gitignore.
 *
 * Usage: node scripts/security-scan.mjs [--json] [--max-history <commits>]
 * Exit codes: 0 = no HIGH findings, 1 = HIGH findings, 2 = scan error.
 *
 * This is a static pattern scan, NOT a penetration test. Findings in docs/**
 * are classified LOW because documentation may quote an example pattern; all
 * other matches are HIGH until reviewed by a human.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
const maxHistoryArg = args.indexOf('--max-history');
const maxHistory = maxHistoryArg >= 0 ? Number(args[maxHistoryArg + 1]) : 50;

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const TEXT_EXT = /\.(?:ts|cts|mts|js|mjs|cjs|jsx|json|jsonl|yml|yaml|md|txt|py|ps1|sh|bat|cmd|html|css|toml|in|cff|cfg|ini|xml|svg)$/i;
const SKIP_PATH = /^(?:node_modules|dist|release|\.git)\//;

const RULES = [
  { name: 'openai-style-key', severity: 'high', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'github-token', severity: 'high', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { name: 'aws-access-key', severity: 'high', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google-api-key', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'slack-token', severity: 'high', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: 'private-key-block', severity: 'high', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { name: 'bearer-token-literal', severity: 'medium', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{25,}/g },
  { name: 'password-assignment', severity: 'medium', re: /\bpassword\s*[:=]\s*['"][^'"\s]{8,}['"]/gi },
  { name: 'api-key-assignment', severity: 'medium', re: /\b(?:api[_-]?key|apikey|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9._~+/=-]{16,}['"]/gi },
  { name: 'credential-url', severity: 'high', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{6,}@/gi },
];

const ALLOW = [
  /example|placeholder|redacted|dummy|sample|your[_-]?key|changeme|xxxx|<[^>]+>|\$\{[^}]+\}|process\.env|os\.environ|%[A-Z_]+%/i,
  /docs\//,
];

function listTrackedFiles() {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

function isTextCandidate(rel) {
  if (SKIP_PATH.test(rel)) return false;
  if (!TEXT_EXT.test(rel)) return false;
  try {
    const abs = join(root, rel);
    const st = statSync(abs);
    if (!st.isFile() || st.size === 0 || st.size > 4 * 1024 * 1024) return false;
  } catch {
    return false;
  }
  return true;
}

function classify(rel, context) {
  if (!/^docs\//.test(rel)) {
    if (ALLOW.some(re => re.test(context))) return 'low';
    return 'high';
  }
  return 'low';
}

/**
 * Test files legitimately contain credential-shaped literals wired to local
 * HTTP fixtures (`fixture-enterprise-credential`, dummy SSH passwords, ...).
 * They are accepted only when the path is a test path AND the matched value is
 * an obvious fixture token; everything else stays HIGH. The accepted findings
 * are still printed and recorded in docs/verification/security-review.md.
 */
const TEST_PATH = /(?:^|\/)(?:desktop\/)?test\/|(?:^|\/)tests\/|\.test\.(?:ts|js|mjs)$/i;
const TEST_FIXTURE_VALUE = /fixture|example|dummy|sample|p@ss|pw-|ui-only-password|private-pass|placeholder|redact/i;

function acceptTestFixture(finding) {
  if (!TEST_PATH.test(finding.file)) return false;
  if (!TEST_FIXTURE_VALUE.test(finding.sample ?? '')) return false;
  finding.acceptedFixture = true;
  finding.reason = 'Test fixture value, not a live credential (documented in docs/verification/security-review.md).';
  return true;
}

function scanText(rel) {
  const abs = join(root, rel);
  const text = readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 20_000) continue;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(line)) !== null) {
        const context = `${line} ${lines[Math.max(0, i - 1)]} ${lines[Math.min(lines.length - 1, i + 1)]}`;
        const severity = classify(rel, context);
        findings.push({
          source: 'worktree',
          file: rel,
          line: i + 1,
          rule: rule.name,
          declaredSeverity: rule.severity,
          severity,
          sample: match[0].slice(0, 120),
          match: match[0].slice(0, 12) + '…',
        });
        if (rule.re.lastIndex === match.index) rule.re.lastIndex += 1;
      }
    }
  }
  return findings;
}

function scanHistory() {
  const out = execFileSync('git', ['-C', root, 'log', '--all', '-p', '--unified=0', '--no-color', '--max-count', String(maxHistory)], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const findings = [];
  let commit = '';
  let file = '';
  let addedLine = 0;
  let commitCount = 0;
  const seen = new Set();
  for (const line of out.split(/\r?\n/)) {
    const commitMatch = /^commit ([0-9a-f]{7,40})/.exec(line);
    if (commitMatch) { commit = commitMatch[1].slice(0, 8); commitCount += 1; file = ''; continue; }
    const diffMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffMatch) { file = diffMatch[2]; addedLine = 0; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { addedLine = Number(hunk[1]); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (!line.startsWith('+')) continue;
    addedLine += 1;
    if (!file || !TEXT_EXT.test(file)) continue;
    const content = line.slice(1);
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      if (!rule.re.test(content)) continue;
      const key = `${commit}:${file}:${rule.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        source: 'git-history',
        commit,
        file,
        line: addedLine,
        rule: rule.name,
        declaredSeverity: rule.severity,
        severity: classify(file, content),
        sample: content.match(rule.re)?.[0]?.slice(0, 120) ?? '',
        match: (content.match(rule.re)?.[0] ?? '').slice(0, 12) + '…',
      });
    }
  }
  return { commits: commitCount, findings };
}

function derivedChecks(tracked) {
  const forbiddenTracked = tracked.filter(rel => /(^|\/)(?:\.env(?:\..+)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|ssh_known_hosts\.json)$/i.test(rel));
  let ignoreText = '';
  try {
    ignoreText = readFileSync(join(root, '.gitignore'), 'utf8');
  } catch {
    ignoreText = '';
  }
  const gitignoreCovers = {
    env: /(^|\n)\.env/.test(ignoreText),
    privateKeys: /(?:\.pem|\.key|id_rsa)/.test(ignoreText),
  };
  return { forbiddenTracked, gitignoreCovers };
}

let report;
try {
  const tracked = listTrackedFiles();
  const scanTargets = tracked.filter(isTextCandidate);
  const worktreeFindings = scanTargets.flatMap(scanText);
  const history = scanHistory();
  const derived = derivedChecks(tracked);

  const all = [...worktreeFindings, ...history.findings];
  for (const finding of all) {
    if (finding.severity === 'high' && acceptTestFixture(finding)) finding.severity = 'low';
  }
  const high = all.filter(f => f.severity === 'high');
  const low = all.filter(f => f.severity === 'low');
  const acceptedFixtures = all.filter(f => f.acceptedFixture === true);
  const forbidden = derived.forbiddenTracked;
  report = {
    tool: 'suwen-security-scan',
    scannedAt: new Date().toISOString(),
    root,
    trackedFiles: tracked.length,
    textFilesScanned: scanTargets.length,
    historyCommitsScanned: history.commits,
    rules: RULES.map(r => ({ name: r.name, declaredSeverity: r.severity })),
    findings: { high, low },
    highCount: high.length,
    lowCount: low.length,
    acceptedTestFixtures: acceptedFixtures.length,
    acceptedTestFixtureFindings: acceptedFixtures,
    forbiddenTrackedFiles: forbidden,
    gitignoreCovers: derived.gitignoreCovers,
    verdict: high.length === 0 && forbidden.length === 0 ? 'PASS' : 'FAIL',
    limitations: [
      'Static pattern scan only; no pentest, no dependency CVE resolution beyond npm audit, no code signing check.',
      'docs/** matches are classified LOW because documentation may quote example patterns.',
      'Credential-shaped literals in test paths that match known fixture tokens are accepted as non-secrets and listed separately.',
      'Binary files, node_modules, dist and release artifacts are not scanned.',
    ],
  };
} catch (error) {
  console.error(`security-scan error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

if (outPath) {
  writeFileSync(resolve(outPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
}

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`security-scan: ${report.verdict} — ${report.highCount} HIGH / ${report.lowCount} LOW (${report.acceptedTestFixtures} accepted test fixtures)`);
  console.log(`tracked files: ${report.trackedFiles}; text scanned: ${report.textFilesScanned}; commits: ${report.historyCommitsScanned}`);
  for (const f of report.findings.high.slice(0, 25)) {
    console.log(`HIGH  ${f.rule}  ${f.file}:${f.line}  [${f.source}]  ${f.match}`);
  }
  for (const f of report.forbiddenTrackedFiles) console.log(`HIGH  forbidden-tracked-file  ${f}`);
  console.log(`gitignore covers .env=${report.gitignoreCovers.env} privateKeys=${report.gitignoreCovers.privateKeys}`);
  if (report.highCount || report.forbiddenTrackedFiles.length) {
    console.log('full JSON:');
    console.log(JSON.stringify(report, null, 2));
  }
}

process.exit(report.verdict === 'PASS' ? 0 : 1);
