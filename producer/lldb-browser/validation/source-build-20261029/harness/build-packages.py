#!/usr/bin/env python3
"""Build only isolated JavaScript/TypeScript package outputs, without a browser."""
import json
import os
from pathlib import Path
import subprocess
import sys
from prepare import BASE, FIXTURE, HEAD, inventory

os.umask(0o077)
status = BASE / 'package-build-status.json'
state = {'state': 'running', 'pid': os.getpid(), 'exitCode': None, 'consumerRevision': HEAD}
status.write_text(json.dumps(state) + '\n')
code = 1
try:
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=FIXTURE, text=True).strip()
    if not HEAD or actual != HEAD:
        raise RuntimeError('Consumer source identity is not frozen')
    code = subprocess.call(['node', 'scripts/workspace.mjs', 'run', 'build', '--group', 'packages', '--if-present'],
                           cwd=FIXTURE, env=dict(os.environ, TMPDIR='/dev/shm'))
    if code == 0:
        outputs = {str(package.relative_to(FIXTURE)): inventory(package / 'dist')
                   for package in (FIXTURE / 'packages').iterdir() if (package / 'dist').is_dir()}
        (BASE / 'package-build-identity.json').write_text(json.dumps(outputs, indent=2) + '\n')
finally:
    state.update(state='passed' if code == 0 else 'failed', exitCode=code)
    status.write_text(json.dumps(state) + '\n')
sys.exit(code)
