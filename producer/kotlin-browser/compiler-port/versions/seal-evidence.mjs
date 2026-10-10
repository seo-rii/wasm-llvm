#!/usr/bin/env node
/** Seal real immutable leaf evidence, current source identity and failed attempts. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, relativePath, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);
const output = path.join(REPO, 'out/kotlin-versions-probe-public-api');
const buildBytes = await readRegular(path.join(output, 'differential-receipt.json'));
const browserBytes = await readRegular(path.join(output, 'browser-receipt.json'));
const build = JSON.parse(buildBytes), browser = JSON.parse(browserBytes);
assert.equal(build.result, 'pass'); assert.equal(browser.result, 'pass');
assert.equal(browser.buildReceiptSha256, sha256(buildBytes));
assert.equal(build.sourceLockSha256, sha256(await readRegular(path.join(HERE, 'sources.lock.json'))));
assert.equal(build.verificationToolSha256, sha256(await readRegular(path.join(HERE, 'build-probe.mjs'))));
assert.equal(build.preparation.preparationToolSha256, sha256(await readRegular(path.join(HERE, 'prepare.mjs'))));
assert.equal(browser.browserVerificationToolSha256, sha256(await readRegular(path.join(HERE, 'browser-probe.mjs'))));
for (const pin of build.observerSources) assert.equal(sha256(await readRegular(path.join(HERE, relativePath(pin.path)))), pin.sha256);
for (const pin of build.outputs) {
    const bytes = await readRegular(path.join(output, relativePath(pin.path)), 16 * 1024 * 1024);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
}
assert.equal(build.comparison.observations, 12315); assert.equal(build.comparison.realJavaApiObservations, 11);
assert.equal(browser.comparison.originalJvmEqualsChromiumWasm, true); assert.equal(browser.comparison.repeatedInvocationEqual, true);
assert.deepEqual(browser.network.requestsDuringProbe, []); assert.deepEqual(browser.network.externalRequests, []);
const integrity = await execute(process.execPath, ['--test', '--test-reporter=spec', path.join(HERE, 'integrity.test.mjs')],
    { cwd: REPO, timeout: 30000, maxBuffer: 65536 });
assert(/tests 11/.test(integrity.stdout) && /pass 11/.test(integrity.stdout) && /fail 0/.test(integrity.stdout));
const history = [];
for (const [directory, classification, reason] of [
    ['kotlin-versions-probe', 'semantic-gate-fail', 'Forward-only word boundaries differed from actual JDK isBoundary synchronization for supplementary + final Sigma; replaced with the actual backward/following path.'],
    ['kotlin-versions-probe-final', 'host-port-gate-fail', 'Actual Wasm variant rejected inheritance from final ArrayList; private item uses composition of its exact list operations.'],
    ['kotlin-versions-probe-common-list', 'pass-before-public-java-surface-restore', 'Core JVM/Wasm/Chromium comparisons passed; OptionalExpectation annotations and original overridable getter were subsequently restored and the whole unit replayed.'],
]) {
    const receiptBytes = await readRegular(path.join(REPO, 'out', directory, 'differential-receipt.json'));
    const receipt = JSON.parse(receiptBytes);
    history.push({ directory, classification, reason, receiptSha256: sha256(receiptBytes),
        recordedResult: receipt.result, sourceLockSha256: receipt.sourceLockSha256,
        comparison: receipt.comparison, commands: receipt.commands, outputs: receipt.outputs });
}
const licenses = [];
for (const [name, url] of [
    ['LICENSE-GPL2-with-classpath-exception.txt', 'https://raw.githubusercontent.com/openjdk/jdk17u/jdk-17.0.15%2B6/LICENSE'],
    ['OPENJDK-ADDITIONAL-LICENSE-INFO.txt', 'https://raw.githubusercontent.com/openjdk/jdk17u/jdk-17.0.15%2B6/ADDITIONAL_LICENSE_INFO'],
    ['LICENSES.md', null],
]) {
    const bytes = await readRegular(path.join(HERE, name)); licenses.push({ path: name, source: url, bytes: bytes.length, sha256: sha256(bytes) });
}
const processes = [
    { phase: 'final-policy-capture', wrapperPid: 3721587, childPid: 3721622, exitCode: 0, log: '/home/seorii/logs/kotlin-version-unicode-policy-final-xkrs_g_2.log' },
    { phase: 'failed-first-differential', wrapperPid: 3537934, childPid: 3537947, exitCode: 1, log: '/home/seorii/logs/kotlin-version-differential-dr_9our0.log' },
    { phase: 'failed-wasm-arraylist-variant', wrapperPid: 3872974, childPid: 3873019, exitCode: 1, log: '/home/seorii/logs/kotlin-version-differential-final-e5nzflnv.log' },
    { phase: 'passing-core-before-api-restore', wrapperPid: 464701, childPid: 464712, exitCode: 0, log: '/home/seorii/logs/kotlin-version-differential-common-list-bdr8qlyv.log' },
    { phase: 'final-public-api-and-complete-differential', wrapperPid: 2466172, childPid: 2466365, exitCode: 0, log: '/home/seorii/logs/kotlin-version-public-api-final-3qw6btff.log' },
    { phase: 'final-chromium-offline-repeat', wrapperPid: 3669954, childPid: 3670044, exitCode: 0, log: '/home/seorii/logs/kotlin-version-public-api-chromium-b94xbmp8.log' },
];
for (const process of processes) {
    const statusBytes = await readRegular(process.log + '.exit.json'); const status = JSON.parse(statusBytes);
    assert.equal(status.exitCode, process.exitCode); assert.equal(status.childPid, process.childPid);
    process.statusSha256 = sha256(statusBytes); process.logSha256 = sha256(await readRegular(process.log, 4 * 1024 * 1024));
}
const evidence = { schemaVersion: 1, kind: 'official-version-frozen-source-differential-evidence', result: 'pass',
    source: build.source, sourceLockSha256: build.sourceLockSha256,
    sourcePreparation: build.preparation, bootstrap: build.bootstrap,
    buildReceiptSha256: sha256(buildBytes), browserReceiptSha256: sha256(browserBytes),
    currentBuild: build, chromium: browser, integrity: { command: [process.execPath, '--test', '--test-reporter=spec', path.join(HERE, 'integrity.test.mjs')],
        exitCode: 0, required: 11, passed: 11, failed: 0, notRun: 0, skipped: 0,
        toolSha256: sha256(await readRegular(path.join(HERE, 'integrity.test.mjs'))), stdoutSha256: sha256(Buffer.from(integrity.stdout)) },
    history, processes, licenses,
    sealToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    limitations: [...browser.limitations, 'The first failed receipt accidentally labelled the unit not-run despite executed JVM observations; history preserves that raw receipt and classifies the actual semantic-gate failure explicitly.'],
    fullCompilerBuilt: false, freshBrowserSourceCompilation: 'not-run', acceptedCompilerTargetPair: false, readiness: false };
await mkdir(path.join(HERE, 'evidence'), { mode: 0o700, recursive: true });
const target = path.join(HERE, 'evidence/original-common-differential.json'); await writeJson(target, evidence);
const bytes = await readRegular(target);
console.log(JSON.stringify({ target, bytes: bytes.length, sha256: sha256(bytes), observations: 12315, javaApi: 11, integrity: 11, readiness: false }));
