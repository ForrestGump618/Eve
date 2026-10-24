import json
import sys


def main(argv=None):
    payload = {
        "ok": True,
        "skill": "e2e-fixture-skill",
        "argv": list(argv or []),
    }
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
