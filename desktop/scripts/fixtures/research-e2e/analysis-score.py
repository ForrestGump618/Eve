"""Deterministic analysis script used by scripts/e2e-research.mjs.

The research worker executes this as the `analysis_run` step source. The
train/test files are copied into the sandbox by the worker as train.csv and
test.csv, so the script reads them and prints the JSON metric contract:

    {"metrics": {"score": <number>}}
"""
import json


def count_data_rows(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            rows = 0
            for index, line in enumerate(handle):
                if index == 0:
                    continue
                if line.strip():
                    rows += 1
            return rows
    except FileNotFoundError:
        return 0


def main():
    test_rows = count_data_rows("test.csv")
    train_rows = count_data_rows("train.csv")
    score = 0.5 if test_rows == 2 and train_rows == 4 else 0.25
    print(json.dumps({"metrics": {"score": score}, "trainRows": train_rows, "testRows": test_rows}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
