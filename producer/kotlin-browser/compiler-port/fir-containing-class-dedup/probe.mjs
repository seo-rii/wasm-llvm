import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { loadRetainedBuild } from '../fir-navigation/probe.mjs';
import { prepareContainingClassDedup, verifyContainingClassDedup, verifyFinalContainingClassDedup } from './prepare.mjs';
import { DECLARATION, PROVIDER, RESOLVE } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3); const outputRoot = path.resolve(process.argv[2]);
assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const selected = await loadRetainedBuild(path.join(repository, 'out/kotlin-compiler-port/builds/consumer-bindings-whole-1791638978998014789'));
const prepared = await prepareContainingClassDedup({ sourceRoot, outputRoot: path.join(outputRoot, 'prepared'), retainedSources: selected.retainedSources });
const verified = await verifyContainingClassDedup(prepared.outputRoot), lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));
const originals = new Map(); for (const pin of lock.sources) originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(here, '../build-flags.json')), flags = JSON.parse(flagsBytes), commands = [], artifacts = [];
async function put(relative, bytes) { const filename = path.join(outputRoot, relative); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
async function run(phase, command, args, expected = 0) {
    console.log('phase: ' + phase); const start = performance.now(); let result;
    try { result = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(expected, 0, 'Expected diagnostic did not occur'); commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - start }); }
    catch (error) { if (error.code === expected && expected !== 0) { commands.push({ phase, command: [command, ...args], exitCode: error.code, expectedExitCode: expected,
            elapsedMs: performance.now() - start }); return String(error.stderr ?? ''); }
        await writeJson(path.join(outputRoot, 'failure.json'), { phase, code: error.code, commands, stderr: String(error.stderr ?? '').slice(-16384) });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-16384)); throw error; }
    if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
}
const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', bootstrap.classPath];
const header = originals.get(RESOLVE).toString().split('package ')[0], declarationSource = Buffer.from(header +
    'package org.jetbrains.kotlin.fir.resolve\n\nimport org.jetbrains.kotlin.fir.containingClassLookupTag\n' +
    'import org.jetbrains.kotlin.fir.declarations.FirCallableDeclaration\nimport org.jetbrains.kotlin.fir.declarations.FirRegularClass\n\n' + DECLARATION + '\n');
const originalDeclaration = await put('original/ResolveUtils.kt', declarationSource);
const provider = await put('retained/ContainingClassUtils.kt', originals.get(PROVIDER));
const genuineProbe = await put('JvmProbe.kt', await readRegular(path.join(here, 'JvmProbe.kt')));
const before = await run('before-flattened-duplicate-genuine-fir-typecheck', 'java', [...jvm, '-d', path.join(outputRoot, 'before.jar'), originalDeclaration, provider, genuineProbe], 1);
await put('before-duplicate-diagnostics.txt', Buffer.from(before));
const diagnostics = before.split('\n').filter(line => line.includes('error:')); assert(diagnostics.length >= 2);
assert(diagnostics.every(line => /conflicting overloads|overload resolution ambiguity/.test(line)), 'Unrelated type error in duplicate reproduction');
const actual = {};
for (const variant of ['original', 'common']) {
    const jar = path.join(outputRoot, variant + '-actual.jar');
    await run(variant + '-genuine-fir-receiver-helper-jvm-build', 'java', [...jvm, '-d', jar, variant === 'original' ? originalDeclaration : provider, genuineProbe]);
    actual[variant] = await run(variant + '-genuine-fir-receiver-helper-jvm-observe', 'java', ['-ea', '-Xmx768m', '-cp', jar + path.delimiter + bootstrap.classPath,
        'org.jetbrains.kotlin.portable.containingclass.actual.JvmProbeKt']);
    await put(variant + '-actual.txt', Buffer.from(actual[variant]));
}
assert.equal(actual.common, actual.original, 'Real FIR receiver behavior changed');
const template = await readRegular(path.join(here, 'ProjectionProbe.kt.in'));
assert.equal(template.toString().split('/*SELECTED_DECLARATION*/').length, 2);
const declaration = DECLARATION.replaceAll('FirCallableDeclaration', 'DeclarationPayload').replaceAll('FirRegularClass', 'ClassPayload');
const projectionBytes = Buffer.from(template.toString().replace('/*SELECTED_DECLARATION*/', declaration));
const projection = await put('ProjectionProbe.kt', projectionBytes), projectedJar = path.join(outputRoot, 'projection.jar');
await run('exact-helper-payload-boundary-jvm-build', 'java', [...jvm, '-d', projectedJar, projection, path.join(here, 'JvmEntry.kt')]);
const projectedJvm = await run('exact-helper-payload-boundary-jvm-observe', 'java', ['-ea', '-cp', projectedJar + path.delimiter + bootstrap.classPath,
    'org.jetbrains.kotlin.portable.containingclass.probe.JvmEntryKt']);
const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib,
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
for (const name of ['klib', 'wasm']) await mkdir(path.join(outputRoot, name), { mode: 0o700 });
await run('exact-helper-payload-boundary-wasmjs-klib-build', 'java', [...wasm, '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'containing-class',
    projection, path.join(here, 'WasmEntry.kt')]);
await run('exact-helper-payload-boundary-wasmjs-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/containing-class.klib'),
    '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'containing-class', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const nodeWasm = await run('exact-helper-payload-boundary-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.containingClassProbe());', pathToFileURL(path.join(outputRoot, 'wasm/containing-class.mjs')).href]);
assert.equal(nodeWasm, projectedJvm, 'Exact helper body payload behavior changed on Wasm');
await put('projection-jvm.txt', Buffer.from(projectedJvm)); await put('projection-wasm.txt', Buffer.from(nodeWasm));
const finalSources = selected.retainedSources.map(item => item.path === RESOLVE ? { path: RESOLVE, filename: prepared.commonSources[0], ...lock.output } : item);
const finalGuard = await verifyFinalContainingClassDedup({ profileRoot: prepared.outputRoot, retainedSources: finalSources,
    allowedAddedImports: JSON.parse(await readRegular(path.join(selected.evidence.filename))).propertyImports.imports });
for (const relative of ['before-duplicate-diagnostics.txt', 'original/ResolveUtils.kt', 'retained/ContainingClassUtils.kt', 'JvmProbe.kt', 'ProjectionProbe.kt',
    'original-actual.jar', 'common-actual.jar', 'original-actual.txt', 'common-actual.txt', 'projection.jar', 'projection-jvm.txt', 'projection-wasm.txt',
    'klib/containing-class.klib', ...(await readdir(path.join(outputRoot, 'wasm'))).sort().map(name => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(outputRoot, relative)); artifacts.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'official-fir-containing-class-dedup-bounded-differential', result: 'pass', source: lock.source,
    preparation: prepared.receipt, preparationReceiptSha256: verified.receiptSha256, selectedFailureGraph: selected.evidence,
    beforeDuplicate: { expectedExitCode: 1, diagnostics: diagnostics.length, errorKinds: 'conflicting overloads and actual receiver ambiguity only' },
    originalSourceProjection: 'Exact193-byte ResolveUtils helper declaration and original imports required by that declaration; remaining ResolveUtils algorithms not executed',
    retainedSource: 'Complete original ContainingClassUtils source; no algorithm or return-nullability change',
    genuineJvm: { observations: actual.original.trimEnd().split('\n').length, originalSha256: sha256(Buffer.from(actual.original)),
        commonSha256: sha256(Buffer.from(actual.common)), receivers: 'Real FirNamedFunctionImpl/FirRegularClassImpl, FirBinaryDependenciesModuleData, real FirSession registration and bound ConeClassLikeLookupTagImpl',
        behavior: 'Canonical class identity, nullable missing result, rebinding, top-level lookup short circuit, required declaration-site module binding' },
    projected: { observations: projectedJvm.trimEnd().split('\n').length, jvmSha256: sha256(Buffer.from(projectedJvm)), nodeWasmSha256: sha256(Buffer.from(nodeWasm)),
        declarationSha256: sha256(Buffer.from(DECLARATION)), projectedDeclarationSha256: sha256(Buffer.from(declaration)), receiverTypes: 'Explicit payloads outside compiler package; no shipping FIR model' },
    normalizedText: false, finalGuard, commands, artifacts, flagsSha256: sha256(flagsBytes), observerPins: await Promise.all(
        ['probe.mjs', 'JvmProbe.kt', 'ProjectionProbe.kt.in', 'JvmEntry.kt', 'WasmEntry.kt'].map(async filename => {
            const bytes = await readRegular(path.join(here, filename)); return { path: filename, bytes: bytes.length, sha256: sha256(bytes) }; })),
    bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    fullFirWasmRuntime: false, browserExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
await writeJson(path.join(outputRoot, 'differential.json'), receipt);
console.log(JSON.stringify({ result: 'pass', outputRoot, genuineJvm: receipt.genuineJvm.observations, projected: receipt.projected.observations }));
