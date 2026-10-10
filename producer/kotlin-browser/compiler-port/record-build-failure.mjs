#!/usr/bin/env node
/** Records an exited real compiler build failure without turning probes into acceptance. */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, writeJson } from '../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    assert(['--build', '--log', '--exit-status', '--output'].includes(name) && args[index + 1] && !options[name], 'Invalid failure-record option');
    options[name] = args[index + 1];
}
assert(options['--build'] && options['--log'] && options['--exit-status'] && options['--output']);
const build = path.resolve(options['--build']), logPath = path.resolve(options['--log']);
const statusPath = path.resolve(options['--exit-status']), output = path.resolve(options['--output']);
assert(build.startsWith(path.join(repository, 'out') + path.sep), 'Compiler output must be under producer out/');
assert(logPath.startsWith(path.join(os.homedir(), 'logs') + path.sep));
assert(statusPath.startsWith(path.join(os.homedir(), 'logs') + path.sep));
assert(output.startsWith(path.join(here, 'evidence') + path.sep), 'Checked-in failure evidence must stay under compiler-port/evidence/');
for (const filename of [build, logPath, statusPath, output]) await assertNoSymlink(filename);
const statusBytes = await readRegular(statusPath);
const status = JSON.parse(statusBytes);
assert(Number.isSafeInteger(status.exitCode) && status.exitCode !== 0, 'Record only an exited failed build');
const receiptPath = path.join(build, 'compiler-build-receipt.json');
const receiptBytes = await readRegular(receiptPath, 16 * 1024 * 1024);
const receipt = JSON.parse(receiptBytes);
assert.equal(receipt.kind, 'official-kotlin-compiler-wasmjs-build');
assert.equal(receipt.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
assert.equal(receipt.status, 'failed');
assert.equal(receipt.compilerHost, 'wasmJs');
assert.equal(receipt.publicLanguageSupport, false);
assert.equal(receipt.buildToolSha256, sha256(await readRegular(path.join(here, 'build.mjs'))), 'Build tool changed after this attempt');
assert(Array.isArray(receipt.compileSources) && receipt.compileSources.length > 0, 'A preparation failure is not a compiler build attempt');
const command = receipt.commands.find((entry) => entry.phase === 'official-compiler-source-to-wasmjs-klib');
assert(command && (command.exitCode !== 0 || command.signal), 'Missing failed actual compiler invocation');
const argumentBytes = await readRegular(path.join(build, 'compiler-klib.args'), 8 * 1024 * 1024);
assert.equal(sha256(argumentBytes), command.argumentFileSha256);
const paths = new Set();
for (const pin of receipt.compileSources) {
    relativePath(pin.path); assert(!paths.has(pin.path)); paths.add(pin.path);
    assert(Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && /^[0-9a-f]{64}$/.test(pin.sha256));
}
const log = await readRegular(logPath, 64 * 1024 * 1024);
const errors = [], unresolved = new Map();
for (const line of log.toString('utf8').split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(\d+): error: (.*)$/.exec(line);
    if (!match) continue;
    const error = { path: match[1], line: Number(match[2]), column: Number(match[3]), message: match[4] };
    errors.push(error);
    const missing = /unresolved reference '([^']+)'/.exec(error.message);
    if (missing) unresolved.set(missing[1], (unresolved.get(missing[1]) ?? 0) + 1);
}
const components = Object.fromEntries(Object.entries(receipt)
    .filter(([name, value]) => name.endsWith('Receipt') && value && typeof value === 'object')
    .map(([name, value]) => [name, sha256(Buffer.from(JSON.stringify(value)))]));
const evidence = {
    schemaVersion: 1, kind: 'official-compiler-wasmjs-source-build-failure', source: receipt.source,
    status: 'failed', compilerHost: receipt.compilerHost, programTarget: receipt.programTarget, publicLanguageSupport: false,
    sourceBuildReceipt: { path: relativePath(path.relative(repository, receiptPath)), sha256: sha256(receiptBytes) },
    sourceLockSha256: receipt.lockSha256, buildToolSha256: receipt.buildToolSha256,
    evidenceToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    reproduceCommand: ['node', 'producer/kotlin-browser/compiler-port/build.mjs', '--protobuf-build', 'out/kotlin-compiler-serialization/probe-8/codec'],
    bootstrap: receipt.bootstrap, sourceBuildFlags: receipt.sourceBuildFlags, requiredHostFlags: receipt.requiredHostFlags,
    sourceInputs: { selectedKotlinSources: receipt.compileSources.length,
        sourceIndexSha256: sha256(Buffer.from(JSON.stringify(receipt.compileSources))),
        originalJavaInventoryCount: receipt.originalJavaInventoryCount,
        inventoryIsNotSymbolClosure: true },
    componentReceiptDigests: components, sourceProfile: receipt.sourceProfile, hostLibraries: receipt.hostLibraries,
    command, executionLog: { path: logPath, bytes: log.length, sha256: sha256(log),
        exitStatus: { path: statusPath, sha256: sha256(statusBytes), ...status } },
    diagnostics: { emittedErrorEntries: errors.length, interpretation: 'Cascading compiler diagnostics; not independent bugs, language features or progress percentage.',
        mostFrequentUnresolvedReferences: [...unresolved].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 20).map(([name, count]) => ({ name, count })),
        entryErrors: errors.filter((entry) => entry.path.startsWith('sources/compiler-port-entry/')).slice(0, 80),
        componentBoundaryErrors: errors.filter((entry) => entry.path.startsWith('components/')).slice(0, 80) },
    gates: { compilerKlib: 'failed', callableCompilerWasm: 'not-built', freshOfflineBrowserCompilation: 'not-run',
        generatedProgramBrowserExecution: 'not-run', publicKotlinSupport: false },
    limitations: ['This is an actual whole selected-source compiler build failure, not full upstream Gradle/variant closure.',
        'The bootstrap source commit is unknown. Its JVM helper comparisons are component results, not candidate R0/R1.',
        'Parser/codec/KLIB/writer tests and native-built user program fixtures cannot satisfy fresh browser compiler acceptance.',
        'No callable compiler binary or user-source browser compilation result is produced by this failed build.'],
};
await writeJson(output, evidence);
console.log(JSON.stringify({ output, sources: receipt.compileSources.length, emittedErrorEntries: errors.length, readiness: false }));
