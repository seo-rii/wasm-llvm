#!/usr/bin/env python3
"""Report build metadata without tailing an active compiler log."""

import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--exit-status", type=Path)
parser.add_argument("--queue-state", type=Path)
args = parser.parse_args()


def read_json(path):
    if path is None:
        return None
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        # A writer may currently be publishing a new metadata file.
        return None


receipt = read_json(args.output / "build-receipt.json") or {}
exit_code = None
if args.exit_status is not None:
    try:
        exit_code = int(args.exit_status.read_text().strip())
    except (FileNotFoundError, ValueError):
        pass
print(json.dumps({
    "output": str(args.output),
    "phase": read_json(args.output / "phase.json"),
    "queue": read_json(args.queue_state),
    "exitCode": exit_code,
    "receiptComplete": receipt.get("complete", False),
    "verifiedBuildComplete": exit_code == 0 and receipt.get("complete") is True,
    "modules": receipt.get("outputs", {}),
    "failure": receipt.get("failure"),
}, indent=2))
