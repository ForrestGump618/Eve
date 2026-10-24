# E2E Fixture Skill

Deterministic local fixture skill used by the SuWen research end-to-end harness.

## What it does

It declares a manifest and a tiny Python self-test. Nothing else: no network, no
filesystem access, no subprocesses. The end-to-end script installs this directory
and runs the declared test in the isolated research worker.

## Usage

- Run the declared test command through the skills RPC surface.
- Expect the test to print a JSON line and exit with code zero.
