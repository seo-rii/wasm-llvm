#!/usr/bin/env python3
"""Recover the exact completed Clang source build into persistent storage."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile

REPOSITORY = 'seo-rii/wasm-llvm'
SOURCE = 'ff18b37c934f7526885f5a49d77698712615f23a'
RUN = 40811368673
JOB = 123242404833
ARTIFACT = 12878926055
DIGEST = 'sha256:7946033ebff4d384c51750d7140ed7b63b9860783808d611d39e17e0900e8aa3'
ROOT = Path(__file__).resolve().parent.parent / f'clang-{RUN}'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def api(endpoint):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{REPOSITORY}/{endpoint}']))


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')


def main():
    os.umask(0o077)
    run = api(f'actions/runs/{RUN}')
    require(run['status'] == 'completed' and run['id'] == RUN and run['head_sha'] == SOURCE
            and run['head_branch'] == 'perf/lldb-module-api-20261023'
            and run['event'] == 'workflow_dispatch' and run['path'] == '.github/workflows/lldb-browser.yml'
            and run['repository']['full_name'] == REPOSITORY
            and run['head_repository']['full_name'] == REPOSITORY, 'Source workflow identity differs')
    jobs = api(f'actions/runs/{RUN}/jobs?per_page=100&filter=latest')
    require(jobs['total_count'] == len(jobs['jobs']), 'Truncated jobs')
    for name in ['producer-contracts', 'build-clang']:
        matches = [job for job in jobs['jobs'] if job['name'] == name]
        require(len(matches) == 1, f'Missing or duplicate {name}')
        job = matches[0]
        require(job['head_sha'] == SOURCE and job['status'] == 'completed'
                and job['conclusion'] == 'success', f'Failed source build job: {name}')
        if name == 'build-clang':
            require(job['id'] == JOB, 'Clang job identity differs')
            for name in ['Build all pinned Clang producer outputs',
                         'Verify current build receipts and all packaged Wasm assets']:
                matches = [step for step in job['steps'] if step['name'] == name]
                require(len(matches) == 1 and matches[0]['conclusion'] == 'success', f'Incomplete {name}')
    for job in jobs['jobs']:
        require(job['conclusion'] in ('success', 'skipped') or
                (job['conclusion'] == 'failure' and job['name'] in
                 ('clang-artifact-provenance', 'runtime-source-provenance')),
                f'Unexpected failed job: {job["name"]}')
    artifact = api(f'actions/artifacts/{ARTIFACT}')
    require(artifact['id'] == ARTIFACT and artifact['digest'] == DIGEST
            and artifact['name'] == f'clang-browser-{SOURCE}' and not artifact['expired']
            and artifact['workflow_run']['id'] == RUN
            and artifact['workflow_run']['head_sha'] == SOURCE
            and artifact['size_in_bytes'] == 43274481, 'Artifact identity differs')
    ROOT.mkdir(mode=0o700)
    write_json(ROOT / 'github-source-build.json', {'run': run, 'jobs': jobs})
    write_json(ROOT / 'github-artifact.json', artifact)
    archive = ROOT / 'source-build.zip'
    with archive.open('xb') as output:
        subprocess.run(['gh', 'api', f'repos/{REPOSITORY}/actions/artifacts/{ARTIFACT}/zip'], stdout=output, check=True)
    require(archive.stat().st_size == artifact['size_in_bytes']
            and 'sha256:' + hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() == DIGEST,
            'Archive digest or size differs')
    products = ROOT / 'products'
    products.mkdir(mode=0o700)
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        require(len(entries) <= 2000 and sum(item.file_size for item in entries) <= 1024**3,
                'Archive extraction bounds exceeded')
        seen = set()
        for entry in entries:
            member = PurePosixPath(entry.filename)
            require(not member.is_absolute() and '..' not in member.parts
                    and '\\' not in entry.filename and str(member) not in seen
                    and not stat.S_ISLNK(entry.external_attr >> 16), 'Unsafe archive entry')
            seen.add(str(member))
            target = products.joinpath(*member.parts)
            if entry.is_dir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with source.open(entry) as data, target.open('xb') as output:
                    for chunk in iter(lambda: data.read(1024 * 1024), b''):
                        output.write(chunk)
    summary = {'component': 'clang', 'source': SOURCE, 'workflowRun': RUN,
               'artifactId': ARTIFACT, 'artifactDigest': DIGEST, 'products': str(products)}
    write_json(ROOT / 'collected.json', summary)
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
