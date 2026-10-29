#!/usr/bin/env python3
"""Launch the owned qualification with private persistent logs; monitor its status."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

base = Path(__file__).resolve().parent
if not sys.argv[1:] or '--help' in sys.argv or '--dry-run' in sys.argv:
    raise SystemExit('Use python3 run.py --help / --dry-run directly; launch.py requires actual artifact arguments.')
os.umask(0o077)
logs = Path.home() / 'logs'
logs.mkdir(mode=0o700, exist_ok=True)
stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
log = logs / ('wasm-debug-qualification-launch-' + stamp + '.log')
with log.open('xb') as stream:
    process = subprocess.Popen([sys.executable, str(base / 'run.py'), *sys.argv[1:]], cwd=base,
                               stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                               start_new_session=True)
record = {'pid': process.pid, 'log': str(log), 'argv': sys.argv[1:],
          'status': 'running', 'followUp': 'Read the supplied report JSON for stateFile and inspect it until exitCode is recorded.'}
record_path = base / ('launcher-' + stamp + '.json')
record_path.write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({**record, 'launcherRecord': str(record_path)}, indent=2))
