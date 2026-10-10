#!/usr/bin/env node
/** Replays actual exited compiler inputs as a source-selection check only. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareBinaryReaderProfile, verifyBinaryReaderProfile } from './prepare.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    assert(['--source-root', '--frozen-build-root', '--output'].includes(name) && process.argv[index + 1] && !options[name]);
    options[name] = path.resolve(process.argv[index + 1]);
}
assert(options['--source-root'] && options['--frozen-build-root'] && options['--output']);
const frozen = options['--frozen-build-root'];
const receiptBytes = await readRegular(path.join(frozen, 'compiler-build-receipt.json'), 32 * 1024 * 1024);
const build = JSON.parse(receiptBytes);
assert.equal(build.kind, 'official-kotlin-compiler-wasmjs-build');
assert.equal(build.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
assert(['failed', 'klib-built'].includes(build.status));
const command = build.commands.find(entry => entry.phase === 'official-compiler-source-to-wasmjs-klib');
assert(command && Number.isSafeInteger(command.exitCode), 'Actual compiler invocation did not exit');
assert(Array.isArray(build.compileSources) && build.compileSources.length > 0);
const argumentBytes = await readRegular(path.join(frozen, 'compiler-klib.args'), 8 * 1024 * 1024);
assert.equal(sha256(argumentBytes), command.argumentFileSha256);
const args = argumentBytes.toString().trimEnd().split('\n').map(line => JSON.parse(line));
const filenames = args.slice(-build.compileSources.length);
assert(filenames.every(filename => path.isAbsolute(filename) && filename.startsWith(frozen + path.sep) && filename.endsWith('.kt')));
const retainedSources = build.compileSources.map((pin, index) => ({ ...pin, filename: filenames[index] }));
const component = await prepareBinaryReaderProfile({ sourceRoot: options['--source-root'], outputRoot: options['--output'], retainedSources });
const verified = await verifyBinaryReaderProfile(path.dirname(component.receiptPath));
const receipt = { schemaVersion: 1, kind: 'official-wasm-emit-only-binary-reader-source-scan', result: 'pass',
    source: build.source, probeToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    frozenBuildReceipt: { path: path.join(frozen, 'compiler-build-receipt.json'), sha256: sha256(receiptBytes),
        status: build.status, compilerExitCode: command.exitCode },
    frozenArgumentFileSha256: sha256(argumentBytes), selectedKotlinInputs: retainedSources.length,
    preparation: verified.receipt, preparationReceiptSha256: verified.receiptSha256,
    selectionExecuted: true, compilerExecutedWithThisProfile: false, languageReadiness: false };
await writeJson(path.join(options['--output'], 'source-scan.json'), receipt);
console.log(JSON.stringify({ receiptPath: path.join(options['--output'], 'source-scan.json'), inspectedKotlinInputs: retainedSources.length,
    sourceSelection: 'pass', compilerAcceptance: false }));
