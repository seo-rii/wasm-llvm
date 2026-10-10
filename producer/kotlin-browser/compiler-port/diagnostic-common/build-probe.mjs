import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareDiagnosticCommon, prepareDiagnosticCommonReferences, verifyDiagnosticCommon } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)); const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile); const options = {}; const args = process.argv.slice(2);
while (args.length) {
    const key = args.shift(); assert(key === '--output' && args[0] && !options[key]); options[key] = path.resolve(args.shift());
}
const output = options['--output']; assert(output?.startsWith(path.join(repository, 'out') + path.sep));
await assertNoSymlink(output); await mkdir(output, { mode: 0o700 });
const reference = await prepareDiagnosticCommonReferences();
const prepared = await prepareDiagnosticCommon({ sourceRoot: reference.sourceRoot, outputRoot: output });
await verifyDiagnosticCommon(path.dirname(prepared.receiptPath));
const bootstrap = await verifyBootstrap();
const commands = []; const observerPins = [];
async function run(phase, command, argv) {
    const begin = performance.now();
    const result = await execute(command, argv, { cwd: output, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    commands.push({ phase, command: [command, ...argv], exitCode: 0, elapsedMs: performance.now() - begin });
    if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
}
for (const name of ['TraceProbe.kt', 'JvmEntry.kt', 'WasmEntry.kt']) {
    const bytes = await readRegular(path.join(here, name));
    await writeFile(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 });
    observerPins.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const projections = {};
for (const [label, root] of [['original', path.join(reference.sourceRoot, prepared.receipt.originalInputs[0].path)], ['common', prepared.commonSources[0]]]) {
    const source = await readRegular(root); const code = source.toString();
    const body = /val THROWABLE = Renderer<Throwable> \{\n([\s\S]*?)\n    \}/.exec(code); assert(body);
    const imports = label === 'original' ? 'import java.io.StringWriter\nimport java.io.PrintWriter\nimport org.jetbrains.kotlin.com.intellij.openapi.util.text.StringUtil\n' : '';
    const bytes = Buffer.from('package org.jetbrains.kotlin.portable.diagnostics.probe\n' + imports + 'fun renderThrowable(it: Throwable) = run {\n' + body[1] + '\n}\n');
    const filename = path.join(output, label + '-projection.kt'); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    projections[label] = { filename, sourceSha256: sha256(source), bodySha256: sha256(Buffer.from(body[1])), bytes: bytes.length, sha256: sha256(bytes) };
}
for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(path.join(output, directory));
const jvm = ['-Xmx512m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17'];
const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const observed = {};
for (const label of ['original', 'common']) {
    const jar = path.join(output, 'jvm', label + '.jar');
    await run(label + '-jvm-build', 'java', [...jvm, '-classpath', bootstrap.classPath, '-d', jar,
        projections[label].filename, path.join(output, 'TraceProbe.kt'), path.join(output, 'JvmEntry.kt')]);
    observed[label] = await run(label + '-jvm-observe', 'java', ['-cp', jar + path.delimiter + (label === 'original' ? bootstrap.classPath : stdlib),
        'org.jetbrains.kotlin.portable.diagnostics.probe.JvmEntryKt']);
}
assert.equal(observed.original, observed.common, 'Original/common JVM raw trace rendering differs');
const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib];
const commonSources = [projections.common.filename, path.join(output, 'TraceProbe.kt')];
await run('wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + commonSources.join(','),
    '-Xir-produce-klib-file', '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'diagnostic-trace', ...commonSources, path.join(output, 'WasmEntry.kt')]);
await run('wasm-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/diagnostic-trace.klib'),
    '-ir-output-dir', path.join(output, 'wasm'), '-ir-output-name', 'diagnostic-trace', '-main', 'noCall']);
observed.wasm = await run('actual-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'process.stdout.write((await import(process.argv[1])).diagnosticTraceObservation())', pathToFileURL(path.join(output, 'wasm/diagnostic-trace.mjs')).href]);
const contracts = {};
for (const [label, text] of Object.entries(observed)) {
    const rows = text.trimEnd().split('\n'); assert.equal(rows.length, 7);
    contracts[label] = rows.map(row => { const fields = row.split('|'); assert.equal(fields[1], 'true'); return fields.slice(0, 2).join('|'); });
    await writeFile(path.join(output, label + '-observations.txt'), text, { flag: 'wx', mode: 0o600 });
}
assert.deepEqual(contracts.wasm, contracts.original);
const artifacts = [];
for (const directory of ['jvm', 'klib', 'wasm']) for (const name of await readdir(path.join(output, directory))) {
    const bytes = await readRegular(path.join(output, directory, name)); artifacts.push({ path: directory + '/' + name, bytes: bytes.length, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'actual-diagnostic-throwable-host-binding-projection', status: 'pass',
    source: prepared.receipt.source, preparation: prepared.receipt, projections, observerPins, commands, artifacts,
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    cases: 7, originalCommonJvmRawObservationsEqual: true, wasmPerHostRawTraceAndTruncationContractsEqual: true,
    observations: Object.fromEntries(Object.entries(observed).map(([label, text]) => [label, { bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) }])),
    limits: ['Exact original/CommonRenderers THROWABLE body projection only; whole CommonRenderers class and language-feature messages unrun.',
        'Platform stack frames intentionally differ; each actual raw trace is retained, not normalized into claimed byte equality.',
        'Original IntelliJ StringUtil comes from payload-verified bootstrap, whose source commit is unknown.'],
    fullDiagnosticTables: 'not-run', browserWorker: 'not-run', fullCompilerAcceptance: false };
await writeJson(path.join(output, 'trace-receipt.json'), receipt);
console.log(JSON.stringify({ output, cases: receipt.cases, fullCompilerAcceptance: false }));
