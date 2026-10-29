"""Scientific output read-back budgets; serialized to the selected execution host."""
OUTPUT_POLICY = {
    'stdout_bytes': 28000,
    'artifact_bytes': 2_000_000,
    'output_flags': ['--output', '-o'],
}
