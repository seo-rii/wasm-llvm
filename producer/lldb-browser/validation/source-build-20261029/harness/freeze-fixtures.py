#!/usr/bin/env python3
"""Freeze the exact final producer fixtures without changing the consumer checkout."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from prepare import BASE

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--producer-repository', type=Path, required=True)
parser.add_argument('--producer-revision', required=True)
options = parser.parse_args()
if not re.fullmatch('[0-9a-f]{40}', options.producer_revision):
    parser.error('Full producer revision is required')
os.umask(0o077)
with (BASE / 'fixture.lock').open('a+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    path = BASE / 'fixture-identity.json'
    identity = json.loads(path.read_bytes())
    records, payloads = {}, {}
    for name in identity['producerFiles']:
        data = subprocess.check_output(['git', 'show', f'{options.producer_revision}:{name}'], cwd=options.producer_repository)
        records[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        payloads[name] = data
    source = payloads['test/native-wasm-debug/container-adaptors.cpp'].decode()
    if 'block_deque' not in source or 'large_deque' not in source:
        raise RuntimeError('Final adaptor fixture must include the native deque boundary regressions')
    for name, data in payloads.items():
        (BASE / 'producer' / name).write_bytes(data)
    identity['producerRevision'] = options.producer_revision
    identity['producerFiles'] = records
    path.write_text(json.dumps(identity, indent=2) + '\n')
    print(json.dumps({'fixtureProducerRevision': options.producer_revision, 'files': records}, indent=2))
