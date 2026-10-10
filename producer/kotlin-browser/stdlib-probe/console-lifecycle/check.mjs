import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, writeJson, assertNoSymlink } from '../../scripts/source.mjs';
import { observeLifecycle, verifyLifecycle } from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 3); const output = path.resolve(process.argv[2]);
assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(output); await mkdir(output, { mode: 0o700 });
// Verify the real compiled program, selected target, compiler, source and consumer
// ancestry before reusing its exact artifact. No new Kotlin compilation occurs.
const predecessorFile = path.join(HERE, '../console-runtime/evidence/receipt.json');
const predecessorBytes = await readRegular(predecessorFile), predecessor = JSON.parse(predecessorBytes);
const verified = await promisify(execFile)(process.execPath, [path.join(HERE, '../console-runtime/verify.mjs')], { cwd: REPO });
await writeJson(path.join(output, 'predecessor-verification.json'), { exitCode: 0, stdout: verified.stdout, stderr: verified.stderr });
const inputRoot = predecessor.outputRoot, modules = {};
for (const name of ['wasi', 'program', 'program.worker']) modules[name] = (await readRegular(path.join(inputRoot, 'consumer/' + name + '.js'))).toString();
const wasm = await readRegular(path.join(inputRoot, 'program/console-runtime.wasm'), 16 * 1024 * 1024);
const observation = await observeLifecycle({ modules, wasm });
await writeJson(path.join(output, 'chromium.json'), observation); verifyLifecycle(observation);
const artifacts = [];
for (const name of ['predecessor-verification.json', 'chromium.json']) {
    const bytes = await readRegular(path.join(output, name)); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const localTools = [];
for (const name of ['browser.mjs', 'check.mjs']) {
    const bytes = await readRegular(path.join(HERE, name)); localTools.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
await writeJson(path.join(output, 'receipt.json'), { schemaVersion: 1, kind: 'actual-kotlin-disposable-worker-lifecycle', status: 'pass', outputRoot: output,
    predecessor: { filename: predecessorFile, bytes: predecessorBytes.length, sha256: sha256(predecessorBytes) },
    program: predecessor.artifacts.find(pin => pin.path === 'program/console-runtime.wasm'), inputRoot,
    browser: observation.browser, artifacts, localTools, stoppedRequests: 3, observedLoopWrites: 2, freshRecoveries: 3,
    observation: 'two delegated fd_write observers, one unmodified deadline Worker, three unmodified recovery Workers',
    controller: 'test-only external AbortController/deadline calling Worker.terminate',
    fullWasiAcceptance: false, compilerR0R1: false, browserKotlinCompilation: false, languageReadiness: false,
    hardMemoryLimit: 'not-established', productionCancellationController: false });
console.log(JSON.stringify({ status: 'pass', stoppedRequests: 3, observedLoopWrites: 2, freshRecoveries: 3, outputRoot: output }));
