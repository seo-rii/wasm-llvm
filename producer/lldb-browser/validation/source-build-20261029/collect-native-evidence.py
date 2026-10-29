#!/usr/bin/env python3
"""Recover the exact completed native qualification archive through authenticated GitHub API."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
REPOSITORY = 'seo-rii/wasm-llvm'
SOURCE = '7bd1d38d61c6602fd05260f04af979abbfdc8e0f'
RUN = 40789115130
JOB = 123169617643
ARTIFACT = 12867233843
DIGEST = 'sha256:e5407fc6d994390870ccf0821fc98a8a872f189f766f0758a5879ffc74859ef5'
FILES = {'source-inputs.json', 'built-binaries.sha256', 'fixture-modules.sha256',
         'function-end.log', 'container-adaptors.log', 'hit-condition.json'}
REQUIRED_STEPS = [
    'Prepare clean pinned native feature sources',
    'Build patched native Clang and LLDB without cached objects',
    'Compile and verify debugger feature fixtures with patched Clang',
    'Run native function-end baseline with patched binaries',
    'Qualify native libc++ container adaptors with patched binaries',
    'Qualify DAP hit conditions and both clearing forms with patched LLDB',
    'Run native LLDB command baseline', 'Run native LLDB DAP baseline',
    'Run native LLDB DAP trap baseline', 'Run native LLDB DAP interrupt baseline',
]


def api(endpoint):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{REPOSITORY}/{endpoint}']))


def write_json(name, value):
    with (ROOT / name).open('x') as output:
        output.write(json.dumps(value, indent=2) + '\n')


def main():
    os.umask(0o077)
    run = api(f'actions/runs/{RUN}')
    jobs = api(f'actions/runs/{RUN}/jobs?per_page=100&filter=latest')
    artifact = api(f'actions/artifacts/{ARTIFACT}')
    assert run['id'] == RUN and run['head_sha'] == SOURCE
    assert run['repository']['full_name'] == REPOSITORY
    assert run['head_repository']['full_name'] == REPOSITORY
    assert run['event'] == 'workflow_dispatch' and run['path'] == '.github/workflows/lldb-browser.yml'
    assert run['head_branch'] == 'perf/lldb-module-api-20261023'
    assert jobs['total_count'] == len(jobs['jobs'])
    for name in ['producer-contracts', 'native-baseline']:
        matching = [job for job in jobs['jobs'] if job['name'] == name]
        assert len(matching) == 1
        job = matching[0]
        assert job['head_sha'] == SOURCE and job['status'] == 'completed' and job['conclusion'] == 'success'
        if name == 'native-baseline':
            assert job['id'] == JOB
            for step in REQUIRED_STEPS:
                matching_steps = [item for item in job['steps'] if item['name'] == step]
                assert len(matching_steps) == 1 and matching_steps[0]['conclusion'] == 'success', step
    assert artifact['id'] == ARTIFACT and artifact['digest'] == DIGEST and not artifact['expired']
    assert artifact['name'] == 'native-debugger-qualification-' + SOURCE
    assert artifact['workflow_run']['id'] == RUN and artifact['workflow_run']['head_sha'] == SOURCE
    assert 0 < artifact['size_in_bytes'] < 1024**2
    archive = ROOT / 'source-build.zip'
    with archive.open('xb') as output:
        subprocess.run(['gh', 'api', f'repos/{REPOSITORY}/actions/artifacts/{ARTIFACT}/zip'], stdout=output, check=True)
    contents = archive.read_bytes()
    assert len(contents) == artifact['size_in_bytes']
    assert 'sha256:' + hashlib.sha256(contents).hexdigest() == DIGEST
    products = ROOT / 'products'
    products.mkdir(mode=0o700)
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        assert len(entries) == 6 and sum(entry.file_size for entry in entries) < 2 * 1024**2
        assert {entry.filename for entry in entries} == FILES
        for entry in entries:
            member = PurePosixPath(entry.filename)
            assert not member.is_absolute() and '..' not in member.parts and '\\' not in entry.filename
            assert not stat.S_ISLNK(entry.external_attr >> 16) and not entry.is_dir()
            with source.open(entry) as data, (products / entry.filename).open('xb') as output:
                output.write(data.read())
    write_json('github-source-build.json', {'run': run, 'jobs': jobs})
    write_json('github-artifact.json', artifact)
    summary = {'component': 'native', 'source': SOURCE, 'workflowRun': RUN,
               'artifactId': ARTIFACT, 'artifactDigest': DIGEST, 'products': str(products)}
    write_json('collected.json', summary)
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
