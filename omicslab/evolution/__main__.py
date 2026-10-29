"""Run the optional Proteus adapter without importing it during Eve startup."""
import argparse
import json
from pathlib import Path

from .proteus_adapter import EveHarness, EvolutionPolicy, dependency_status


def main():
    parser = argparse.ArgumentParser(description='Eve run-local Proteus evolution')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--goal', default='Improve robustness while preserving public contracts.')
    parser.add_argument('--model', default='')
    parser.add_argument('--source', type=Path)
    parser.add_argument('--policy', type=Path)
    args = parser.parse_args()
    status = dependency_status()
    if args.status:
        print(json.dumps(status))
        return 0
    if not status['available']:
        parser.error(f"Proteus {status['required_version']} required; {status['install']}")
    if not args.out or not args.model:
        parser.error('--out and --model are required')
    policy = EvolutionPolicy(**json.loads(args.policy.read_text(encoding='utf-8'))) if args.policy else EvolutionPolicy()
    from proteus.core.disposition import NEUTRAL
    from proteus.core.goal import GoalConfig
    from proteus.sweep import SweepConfig, run_sweep
    factory = lambda: EveHarness(source=args.source, policy=policy)
    records = run_sweep(SweepConfig(name=args.out.name, adapter_factory=factory, arms=[NEUTRAL],
                                   seeds=policy.seeds, goal=GoalConfig(text=args.goal), root=args.out,
                                   model=args.model, episodes=policy.episodes, max_turns=policy.max_turns))
    progress = [json.loads(line) for path in (args.out / 'progress').glob('*.jsonl')
                for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    passed = (len(progress) == policy.episodes * policy.seeds
              and all(row.get('ok') is True and row.get('accepted') is True for row in progress))
    print(json.dumps({'runs': records, 'output': str(args.out), 'regression_passed': passed,
                      'scope': 'run-local Python harness; deployed Eve is unchanged'}))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
