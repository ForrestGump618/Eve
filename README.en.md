# Eve 1.0.0

A Windows research agent with a light integrated workbench, durable tasks, local and SSH execution, tool traces, permissions, steering, MCP and progressively loaded skills.

Eve retains the existing TypeScript Harness and Python backends. The research workspace adapts 外部项目 stage and evidence mechanisms to that same loop. Seven stages expose comparator contracts, actual artifact hashes, metric deltas, findings and human-reviewed closure. Recording evidence does not establish scientific validity.

The shared library includes 278 licensed, deduplicated reference skills in addition to the eight existing basics. It uses metadata-only discovery, per-resource gzip loading and digest verification, and a bounded 4 MB decoded cache. Catalog pages display at most 32 skills. Upstream scripts are never executed on installation. Missing dependencies, external API accounts and restricted/unlicensed upstream entries are not claimed installed or verified.

## Run and build

```powershell
python -m pip install -e ".[dev]"
cd desktop
npm ci
npm run typecheck
npm test
npm start
npm run dist:win
```

Requires Node.js 24 and Python 3.10+. The unsigned installer does not bundle Python. Existing data, credentials and protocol/module names are preserved for compatibility.

See [Chinese documentation](README.md), [Eve verification](docs/verification/eve-1.0/REPORT.md) and [clean release boundaries](CLEAN-RELEASE.md). One real SSH/password host is covered; real key/agent login, long-duration endurance, OS-restart recovery and clean-VM installation remain unverified. Remote stdio MCP is unsupported. Subprocess isolation is not an OS security sandbox.

Electron/TypeScript: MIT. Python: Apache-2.0. Skill licenses and pinned origins are retained in the library and `desktop/NOTICE`.
